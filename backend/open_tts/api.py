"""FastAPI routes."""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator, List, Optional
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .adapters import model_capabilities
from .config import (
    DEFAULT_MODEL,
    GEN_TIMEOUT,
    STREAM_FRAME_TIMEOUT,
    STREAM_QUEUE_MAX,
    VERSION,
    AudioFormat,
)
from .coordinator import coordinator
from .errors import ErrorCode, http_exception
from .protocol import pack_frame, terminal_frame, validate_batch, validate_text, parse_audio_format
from .registry import MODEL_REGISTRY, voice_label
from .security import AuthAndRateLimitMiddleware, RateLimiter, build_cors_origins, get_or_create_token


_health_cache = {"data": None, "ts": 0.0}
_install_token = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _install_token
    _install_token = get_or_create_token()

    try:
        import os

        if os.getenv("OPEN_TTS_EAGER_LOAD", "0").lower() in ("1", "true", "yes"):
            coordinator.load(DEFAULT_MODEL)
    except HTTPException:
        pass

    yield
    coordinator.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="Open TTS Server", version=VERSION, lifespan=lifespan)
    origins = build_cors_origins()
    app.state.install_token = get_or_create_token()
    app.add_middleware(AuthAndRateLimitMiddleware, rate_limiter=RateLimiter())
    # Added last so CORS is outermost and decorates authentication failures.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Open-TTS-Token"],
    )

    @app.middleware("http")
    async def attach_token_and_log(request: Request, call_next):
        global _install_token
        if not _install_token:
            _install_token = request.app.state.install_token
        if request.url.path.startswith("/v1/") or request.url.path == "/health":
            start = time.perf_counter()
            resp = await call_next(request)
            print(f"[HTTP] {request.method} {request.url.path} {resp.status_code} {time.perf_counter() - start:.3f}s")
            return resp
        return await call_next(request)

    register_routes(app)
    return app


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None
    stream: bool = False
    format: str = "wav"


class BatchRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None
    format: str = "wav"


class StreamBatchRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None


class SpeechRequest(BaseModel):
    model: str = DEFAULT_MODEL
    input: str = Field(..., min_length=1)
    voice: str = "af_bella"
    response_format: str = "wav"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None


def _health_data() -> dict:
    snap = coordinator.snapshot()
    return {
        "status": "ok",
        "engine": "open-tts",
        "version": VERSION,
        "model": coordinator.model_id or DEFAULT_MODEL,
        "model_loaded": snap["model_loaded"],
        "model_warm": snap["model_warm"],
        "state": snap["state"],
        "load_error": snap["load_error"],
        "warm_error": snap["warm_error"],
        "gpu_busy": snap["gpu_busy"],
        "voices": coordinator.voices(coordinator.model_id),
    }


def register_routes(app: FastAPI) -> None:
    @app.get("/health")
    async def health():
        now = time.monotonic()
        if _health_cache["data"] and (now - _health_cache["ts"]) < 0.5:
            return _health_cache["data"]
        data = _health_data()
        _health_cache["data"] = data
        _health_cache["ts"] = now
        return data

    @app.get("/v1/models")
    async def list_models():
        models = []
        for mid in MODEL_REGISTRY:
            loaded = coordinator.model_id == mid and coordinator.model is not None
            voices = coordinator.voices(mid) if loaded else MODEL_REGISTRY[mid].get("default_voices", [])
            cap = model_capabilities(mid, voices)
            models.append({
                **cap,
                "loaded": loaded,
                "active": coordinator.model_id == mid,
                "voices": [{"id": v, "name": voice_label(v)} for v in cap["voices"]],
            })
        return {"models": models}

    @app.get("/v1/voices")
    async def get_voices():
        mid = coordinator.model_id
        if not mid:
            return {"model": None, "voices": []}
        voices = coordinator.voices(mid)
        return {"model": mid, "voices": [{"id": v, "name": voice_label(v)} for v in voices]}

    @app.post("/v1/load-model")
    async def load_model_endpoint(
        model_id: str = Query(default=DEFAULT_MODEL),
        force: bool = Query(default=False),
    ):
        if model_id not in MODEL_REGISTRY:
            raise http_exception(404, ErrorCode.MODEL_NOT_FOUND, f"Unknown model: {model_id}")
        # Model load/warmup is multi-second and must not block the event loop
        # (health checks and concurrent requests would hang otherwise).
        if force:
            result = await asyncio.to_thread(coordinator.force_reload, model_id)
        else:
            result = await asyncio.to_thread(coordinator.load, model_id)
        _health_cache["data"] = None
        return {"success": True, **result}

    def _framed_stream(req: Request, model_id: str, texts: List[str], request, extra_headers: dict):
        disconnected = False

        async def _response() -> AsyncGenerator[bytes, None]:
            nonlocal disconnected
            q: queue.Queue = queue.Queue(maxsize=STREAM_QUEUE_MAX)
            done = threading.Event()

            def _offer(item) -> bool:
                while not disconnected:
                    try:
                        q.put(item, timeout=0.5)
                        return True
                    except queue.Full:
                        continue
                return False

            def _worker():
                try:
                    for frame in coordinator.stream_batch_frames(
                        model_id,
                        texts,
                        request.voice,
                        request.speed,
                        language=request.language,
                        instruct=request.instruct,
                        cancel_check=lambda: disconnected,
                    ):
                        if not _offer(frame):
                            return
                except Exception as exc:
                    _offer(("error", exc))
                finally:
                    _offer(None)
                    done.set()

            threading.Thread(target=_worker, daemon=True).start()
            loop = asyncio.get_running_loop()
            started = time.monotonic()
            absolute_deadline = started + max(GEN_TIMEOUT, len(texts) * STREAM_FRAME_TIMEOUT)

            while True:
                if await req.is_disconnected():
                    disconnected = True
                    break
                if time.monotonic() > absolute_deadline:
                    disconnected = True
                    yield pack_frame({
                        "error": "Generation exceeded the absolute timeout",
                        "code": ErrorCode.GENERATION_TIMEOUT.value,
                    })
                    break
                try:
                    frame = await loop.run_in_executor(None, lambda: q.get(timeout=STREAM_FRAME_TIMEOUT))
                except queue.Empty:
                    if done.is_set() and q.empty():
                        break
                    continue
                if frame is None:
                    break
                if isinstance(frame, tuple) and frame[0] == "error":
                    # Keep the stream contract intact: never raise mid-body after
                    # headers are sent. Encode failures as a terminal error frame.
                    exc = frame[1]
                    if isinstance(exc, HTTPException):
                        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                        yield pack_frame({
                            "error": detail.get("message", str(exc.detail)),
                            "code": detail.get("code", ErrorCode.INTERNAL.value),
                        })
                    else:
                        yield pack_frame({
                            "error": str(exc),
                            "code": ErrorCode.GENERATION_FAILED.value,
                        })
                    break
                yield frame

            yield terminal_frame()

        return StreamingResponse(
            _response(),
            media_type="application/octet-stream",
            headers={
                "X-TTS-Model": model_id,
                "Cache-Control": "no-cache",
                **extra_headers,
            },
        )

    @app.post("/v1/synthesize")
    async def synthesize(request: SynthesizeRequest, req: Request):
        t0 = time.perf_counter()
        text = validate_text(request.text)
        model_id = request.model or coordinator.model_id or DEFAULT_MODEL
        if model_id not in MODEL_REGISTRY:
            raise http_exception(404, ErrorCode.MODEL_NOT_FOUND, f"Unknown model: {model_id}")
        fmt = parse_audio_format(request.format)

        if request.stream:
            return _framed_stream(
                req,
                model_id,
                [text],
                request,
                {
                    "X-TTS-Voice": request.voice,
                    "X-TTS-Stream": "true",
                    "X-TTS-Speed": f"{request.speed}",
                },
            )

        audio_bytes, mime, meta = await asyncio.to_thread(
            coordinator.generate_full,
            model_id,
            text,
            request.voice,
            request.speed,
            language=request.language,
            instruct=request.instruct,
            fmt=fmt,
        )
        gen_time = time.perf_counter() - t0
        headers = {
            "X-TTS-Model": model_id,
            "X-TTS-Voice": request.voice,
            "X-TTS-RTF": f"{meta.get('rtf', 0):.3f}",
            "X-TTS-Gen-Time": f"{gen_time:.3f}",
            "X-TTS-Speed": f"{request.speed}",
            "X-TTS-Apply-Playback-Rate": "false",
            "X-TTS-Playback-Rate": "1.0",
        }
        return Response(content=audio_bytes, media_type=mime, headers=headers)

    @app.post("/v1/synthesize-batch")
    async def synthesize_batch(request: BatchRequest):
        t0 = time.perf_counter()
        texts = validate_batch(request.texts)
        model_id = request.model or coordinator.model_id or DEFAULT_MODEL
        fmt = parse_audio_format(request.format)
        results = await asyncio.to_thread(
            coordinator.generate_batch,
            model_id,
            texts,
            request.voice,
            request.speed,
            language=request.language,
            instruct=request.instruct,
            fmt=fmt,
        )
        return {
            "results": results,
            "model": model_id,
            "total_time": round(time.perf_counter() - t0, 3),
            "error_count": sum(1 for r in results if "error" in r),
        }

    @app.post("/v1/synthesize-stream-batch")
    async def synthesize_stream_batch(request: StreamBatchRequest, req: Request):
        texts = validate_batch(request.texts)
        model_id = request.model or coordinator.model_id or DEFAULT_MODEL
        if model_id not in MODEL_REGISTRY:
            raise http_exception(404, ErrorCode.MODEL_NOT_FOUND, f"Unknown model: {model_id}")
        return _framed_stream(
            req,
            model_id,
            texts,
            request,
            {"X-TTS-Stream-Batch": "true"},
        )

    @app.post("/v1/audio/speech")
    async def openai_speech(request: SpeechRequest, req: Request):
        fmt = parse_audio_format(request.response_format)
        synth = SynthesizeRequest(
            text=request.input,
            voice=request.voice,
            speed=request.speed,
            language=request.language,
            instruct=request.instruct,
            model=request.model if request.model != "tts-1" else None,
            format=fmt.value,
        )
        return await synthesize(synth, req)

    @app.post("/v1/speech")
    async def openai_speech_alt(request: SpeechRequest, req: Request):
        return await openai_speech(request, req)