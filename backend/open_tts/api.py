"""FastAPI routes."""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator, List, Optional, Sequence
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
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
from .runtime import ModelRuntime, FrameQueue, await_job, check_job, set_job_phase
from .config import (MAX_BODY_BYTES, MAX_TEXT_LENGTH, MAX_BATCH_TEXTS, MAX_BATCH_TOTAL_CHARS,
                     MAX_INSTRUCT_CHARS, MAX_FRAME_BYTES, GENERATION_PROFILES, STREAM_MAX_EMIT_SECONDS)
from .protocol import unpack_frames
from .errors import ErrorCode, http_exception
from .protocol import pack_frame, terminal_frame, validate_batch, validate_text, parse_audio_format
from .registry import MODEL_REGISTRY, voice_label
from .security import AuthAndRateLimitMiddleware, RateLimiter, build_cors_origins, get_or_create_token


_health_cache = {"data": None, "ts": 0.0}
_install_token = ""
# Long semantic units (especially non-native speed processing) can legitimately
# produce no output for more than the client's network-idle timeout.
STREAM_HEARTBEAT_SECONDS = 15.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _install_token
    _install_token = get_or_create_token()

    try:
        import os

        if os.getenv("OPEN_TTS_EAGER_LOAD", "0").lower() in ("1", "true", "yes"):
            await await_job(app.state.runtime.submit(lambda cancel: coordinator.load(DEFAULT_MODEL)))
    except HTTPException:
        pass

    try:
        yield
    finally:
        await asyncio.to_thread(app.state.runtime.shutdown)


LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def create_app(*, allowed_hosts_extra: Sequence[str] = ()) -> FastAPI:
    """Build the app. ``allowed_hosts_extra`` exists for tests (TestClient's "testserver"); production passes none."""
    app = FastAPI(title="Open TTS Server", version=VERSION, lifespan=lifespan)
    app.state.runtime = ModelRuntime(cleanup=coordinator.shutdown)
    origins = build_cors_origins()
    app.state.install_token = get_or_create_token()
    from .security import BoundedBodyMiddleware
    app.add_middleware(BoundedBodyMiddleware)
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

    # DNS-rebinding defence: a page on attacker.example rebound to 127.0.0.1 still sends
    # Host: attacker.example. Added last so it is outermost and rejects before auth/body work.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[*LOOPBACK_HOSTS, *allowed_hosts_extra])

    register_routes(app)
    return app


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = Field(None, max_length=MAX_INSTRUCT_CHARS)
    model: Optional[str] = None
    stream: bool = False
    protocol_version: int = Field(1, ge=1, le=2)
    format: str = "wav"


class BatchRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1, max_length=MAX_BATCH_TEXTS)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = Field(None, max_length=MAX_INSTRUCT_CHARS)
    model: Optional[str] = None
    format: str = "wav"


class StreamBatchRequest(BaseModel):
    protocol_version: int = Field(1, ge=1, le=2)
    texts: List[str] = Field(..., min_length=1, max_length=MAX_BATCH_TEXTS)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = Field(None, max_length=MAX_INSTRUCT_CHARS)
    model: Optional[str] = None


class SpeechRequest(BaseModel):
    stream: bool = False
    model: str = DEFAULT_MODEL
    input: str = Field(..., min_length=1)
    voice: str = "af_bella"
    response_format: str = "wav"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = Field(None, max_length=MAX_INSTRUCT_CHARS)


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

    @app.get("/v1/capabilities")
    async def capabilities():
        return {"engine": "open-tts", "version": VERSION, "protocol_versions": [1, 2],
                "limits": {"body_bytes": MAX_BODY_BYTES, "text_chars": MAX_TEXT_LENGTH,
                           "batch_chars": MAX_BATCH_TOTAL_CHARS, "batch_texts": MAX_BATCH_TEXTS,
                           "frame_bytes": MAX_FRAME_BYTES, "frame_seconds": STREAM_MAX_EMIT_SECONDS},
                "generation_profiles": GENERATION_PROFILES,
                "speed_policy": "server_only", "runtime": app.state.runtime.snapshot()}

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
        req: Request,
        model_id: str = Query(default=DEFAULT_MODEL),
        force: bool = Query(default=False),
    ):
        if model_id not in MODEL_REGISTRY:
            raise http_exception(404, ErrorCode.MODEL_NOT_FOUND, f"Unknown model: {model_id}")
        # Model load/warmup is multi-second and must not block the event loop
        # (health checks and concurrent requests would hang otherwise).
        if not force and coordinator.model_id == model_id and coordinator.snapshot()["model_warm"]:
            return {"success": True, "model": model_id, "state": coordinator.state.value, "voices": coordinator.voices(model_id)}
        result = await await_job(app.state.runtime.submit(
            lambda cancel: coordinator.load(model_id, force=force), require_idle=True), req, timeout=GEN_TIMEOUT)
        _health_cache["data"] = None
        return {"success": True, **result}

    def _framed_stream(req: Request, model_id: str, texts: List[str], request, extra_headers: dict):
        q = FrameQueue(STREAM_QUEUE_MAX)
        cancelled = threading.Event()
        runtime = app.state.runtime

        def offer(item):
            while not cancelled.is_set():
                check_job()
                try:
                    q.put(item, timeout=0.1)
                    set_job_phase("active")
                    return True
                except queue.Full:
                    set_job_phase("backpressure")
                    continue
            return False

        def worker(job_cancel):
            gen = coordinator.stream_batch_frames(
                model_id, texts, request.voice, request.speed, language=request.language,
                instruct=request.instruct, cancel_check=lambda: cancelled.is_set() or job_cancel.is_set(),
                protocol_version=request.protocol_version)
            try:
                for frame in gen:
                    if not offer(frame):
                        break
            finally:
                gen.close()

        job = runtime.submit(worker, size=sum(len(t.encode("utf-8")) for t in texts))

        async def response():
            sequence = 0
            started = time.monotonic()
            last_frame = started
            last_keepalive = started
            failed = False

            def wire(frame):
                nonlocal sequence
                if request.protocol_version == 1:
                    return frame
                parsed, remaining = unpack_frames(frame)
                if remaining or len(parsed) != 1:
                    raise ValueError("Invalid internal frame")
                header, audio = parsed[0]
                header.update(protocol_version=2, sequence=sequence)
                sequence += 1
                return pack_frame(header, audio)

            def error_frame(exc):
                detail = exc.detail if isinstance(exc, HTTPException) else {}
                if not isinstance(detail, dict):
                    detail = {}
                return pack_frame({"error": detail.get("message", "Generation failed"),
                                   "code": detail.get("code", ErrorCode.GENERATION_FAILED.value),
                                   "outcome": "failed"})

            try:
                while True:
                    if await req.is_disconnected():
                        cancelled.set()
                        return
                    try:
                        frame = q.get_nowait()
                    except queue.Empty:
                        if job.future.done():
                            try:
                                job.future.result()
                            except Exception as exc:
                                failed = True
                                yield wire(error_frame(exc))
                            break
                        now = time.monotonic()
                        if now - last_frame > max(GEN_TIMEOUT, STREAM_FRAME_TIMEOUT):
                            failed = True
                            job.cancel.set()
                            yield wire(pack_frame({"error": "Stream timed out waiting for audio",
                                                   "code": ErrorCode.STREAM_TIMEOUT.value, "outcome": "failed"}))
                            break
                        if now - last_keepalive >= STREAM_HEARTBEAT_SECONDS:
                            yield wire(pack_frame({"keepalive": True}))
                            resumed = time.monotonic()
                            last_frame += resumed - now
                            last_keepalive = resumed
                        await asyncio.sleep(0.02)
                        continue
                    parsed, _ = unpack_frames(frame)
                    failed = bool(parsed[0][0].get("error"))
                    yield wire(frame)
                    last_frame = time.monotonic()  # consumer backpressure is not inference idle
                    if failed:
                        break
                if not failed and not cancelled.is_set():
                    done = {"done": True}
                    if request.protocol_version == 2:
                        done.update(outcome="completed", stream_seconds=time.monotonic()-started,
                                    queue_peak_bytes=q.peak_bytes, queue_wait_seconds=max(0,job.started-job.accepted))
                    yield wire(pack_frame(done))
            finally:
                cancelled.set()
                job.cancel.set()

        from starlette.background import BackgroundTask
        return StreamingResponse(response(), media_type="application/octet-stream",
            background=BackgroundTask(job.cancel.set), headers={
                "X-TTS-Model": model_id, "X-TTS-Protocol-Version": str(request.protocol_version),
                "Cache-Control": "no-store", **extra_headers})

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

        audio_bytes, mime, meta = await await_job(app.state.runtime.submit(
            lambda cancel: coordinator.generate_full(model_id, text, request.voice, request.speed,
                language=request.language, instruct=request.instruct, fmt=fmt),
            size=len(text.encode("utf-8"))), req, timeout=GEN_TIMEOUT)
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
    async def synthesize_batch(request: BatchRequest, req: Request):
        t0 = time.perf_counter()
        texts = validate_batch(request.texts)
        model_id = request.model or coordinator.model_id or DEFAULT_MODEL
        fmt = parse_audio_format(request.format)
        results = await await_job(app.state.runtime.submit(
            lambda cancel: coordinator.generate_batch(model_id, texts, request.voice, request.speed,
                language=request.language, instruct=request.instruct, fmt=fmt),
            size=sum(len(t.encode("utf-8")) for t in texts)), req, timeout=GEN_TIMEOUT)
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
        if request.stream:
            raise http_exception(400, ErrorCode.VALIDATION, "Use /v1/synthesize-stream-batch for framed streaming; speech endpoints return complete files")
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