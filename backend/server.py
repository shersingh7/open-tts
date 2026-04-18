import asyncio
import gc
import io
import os
import signal
import threading
import time as _time
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = os.getenv("OPEN_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPEN_TTS_PORT", "8000"))
WARMUP_TEXT = os.getenv("OPEN_TTS_WARMUP_TEXT", "Warmup")
DEFAULT_MODEL_ID = os.getenv("OPEN_TTS_DEFAULT_MODEL", "qwen3-tts")
DEFAULT_AUDIO_FORMAT = os.getenv("OPEN_TTS_AUDIO_FORMAT", "opus")
OPUS_BITRATE = os.getenv("OPEN_TTS_OPUS_BITRATE", "64k")
STREAMING_INTERVAL = float(os.getenv("OPEN_TTS_STREAMING_INTERVAL", "0.25"))

# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

MODEL_REGISTRY: Dict[str, dict] = {
    "qwen3-tts": {
        "hf_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        "local_dir": "models/qwen3-tts-8bit",
        "display_name": "Qwen3-TTS 1.7B",
        "description": "Fast multilingual TTS with preset voices",
        "tier": 1,
        "default_voice": "ryan",
        "supports_lang_code": True,
        "supports_instruct": True,
        "supports_ref_audio": True,
        "has_preset_voices": True,
        "default_voices": [
            "serena", "vivian", "uncle_fu", "dylan",
            "eric", "ryan", "aiden", "ono_anna", "sohee",
        ],
    },
    "fish-s2-pro": {
        "hf_id": "mlx-community/fish-audio-s2-pro-8bit",
        "local_dir": "models/fish-audio-s2-pro-8bit",
        "display_name": "Fish Audio S2 Pro",
        "description": "High-quality multilingual TTS with voice cloning",
        "tier": 1,
        "default_voice": None,
        "supports_lang_code": False,
        "supports_instruct": True,
        "supports_ref_audio": True,
        "has_preset_voices": False,
        "default_voices": [],
    },
}

FISH_VOICE_TAGS = [
    "pause", "emphasis", "laughing", "inhale", "chuckle", "tsk",
    "singing", "excited", "volume up", "echo", "angry", "whisper",
    "screaming", "sad", "shocked", "pitch up", "pitch down",
    "professional broadcast tone",
]

AUDIO_FORMATS = {
    "opus": "audio/ogg; codecs=opus",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
}

# ---------------------------------------------------------------------------
# GPU memory cleanup — call after model unload or between heavy operations
# ---------------------------------------------------------------------------

def _clear_gpu_memory():
    """Force Python GC + MLX Metal cache clear to free GPU memory."""
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Voice metadata
# ---------------------------------------------------------------------------

VOICE_LABELS = {
    "serena": "Serena",
    "vivian": "Vivian",
    "uncle_fu": "Uncle Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "ryan": "Ryan",
    "aiden": "Aiden",
    "ono_anna": "Ono Anna",
    "sohee": "Sohee",
}

VOICE_ALIASES = {
    "uncle fu": "uncle_fu",
    "uncle_fu": "uncle_fu",
    "ono anna": "ono_anna",
    "ono_anna": "ono_anna",
}

LANG_ALIASES = {
    "auto": "auto",
    "english": "en",
    "en": "en",
    "chinese": "zh",
    "zh": "zh",
    "japanese": "ja",
    "ja": "ja",
    "korean": "ko",
    "ko": "ko",
}

# ---------------------------------------------------------------------------
# GPU lock — serializes ALL model.generate() calls (streaming + non-streaming)
# ---------------------------------------------------------------------------

gpu_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize_voice(voice: str, supported_voices: List[str],
                     voice_lower_map: Dict[str, str] = None) -> str:
    raw = (voice or "").strip().lower()
    normalized = VOICE_ALIASES.get(raw, raw.replace(" ", "_"))
    if normalized in supported_voices:
        return normalized
    if voice_lower_map and raw in voice_lower_map:
        return voice_lower_map[raw]
    for v in supported_voices:
        if v.lower() == raw:
            return v
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported voice '{voice}'. Try one of: {', '.join(supported_voices)}",
    )


def normalize_language(language: str) -> str:
    raw = (language or "auto").strip().lower()
    if not raw:
        return "auto"
    return LANG_ALIASES.get(raw, "auto")


def title_for_voice(voice_id: str) -> str:
    return VOICE_LABELS.get(voice_id, voice_id.replace("_", " ").title())


def get_model_voices(model_obj, model_id: str) -> List[str]:
    reg = MODEL_REGISTRY.get(model_id, {})
    if reg.get("has_preset_voices") and hasattr(model_obj, "get_supported_speakers"):
        try:
            return model_obj.get_supported_speakers()
        except Exception:
            pass
    return reg.get("default_voices", [])


def _encode_audio(audio: np.ndarray, sample_rate: int,
                  fmt: str = DEFAULT_AUDIO_FORMAT) -> tuple:
    """Encode audio array to bytes. Returns (bytes, mime_type)."""
    fmt = fmt if fmt in AUDIO_FORMATS else DEFAULT_AUDIO_FORMAT
    mime = AUDIO_FORMATS[fmt]

    try:
        buffer = io.BytesIO()
        audio_write(buffer, audio, sample_rate, format=fmt)
        buffer.seek(0)
        return buffer.read(), mime
    except Exception as exc:
        print(f"Warning: audio_write failed for format '{fmt}', falling back to WAV: {exc}")
        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        buffer.seek(0)
        return buffer.read(), AUDIO_FORMATS["wav"]


def _encode_wav_fast(audio: np.ndarray, sample_rate: int) -> bytes:
    """Fast WAV encoding via soundfile — no ffmpeg subprocess. ~4ms."""
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    buffer.seek(0)
    return buffer.read()


# ---------------------------------------------------------------------------
# Model manager — thread-safe model loading with lock + timeout
# ---------------------------------------------------------------------------

class ModelManager:
    def __init__(self):
        self.loaded_model = None
        self.loaded_model_id: Optional[str] = None
        self.load_error: Optional[str] = None
        self._loading_lock = threading.Lock()
        self._loading_timeout = 120  # seconds
        self._cached_voices: Dict[str, List[str]] = {}
        self._voice_lower_map: Dict[str, Dict[str, str]] = {}

    def is_loaded(self, model_id: str) -> bool:
        return self.loaded_model is not None and self.loaded_model_id == model_id

    def get_voices_cached(self, model_id: str) -> List[str]:
        return self._cached_voices.get(model_id, [])

    def get_voice_lower_map(self, model_id: str) -> Dict[str, str]:
        return self._voice_lower_map.get(model_id, {})

    def get_or_load(self, model_id: str):
        reg = MODEL_REGISTRY.get(model_id)
        if not reg:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

        # If already loaded, return immediately
        if self.is_loaded(model_id):
            return self.loaded_model

        # Acquire loading lock with timeout to prevent concurrent loads
        acquired = self._loading_lock.acquire(timeout=self._loading_timeout)
        if not acquired:
            raise HTTPException(
                status_code=503,
                detail=f"Model loading timed out after {self._loading_timeout}s. Please retry.",
            )

        try:
            # Double-check after acquiring lock (another thread may have loaded it)
            if self.is_loaded(model_id):
                return self.loaded_model

            # Unload previous model
            if self.loaded_model is not None:
                print(f"Unloading model: {self.loaded_model_id}")
                del self.loaded_model
                self.loaded_model = None
                self.loaded_model_id = None
                self.load_error = None
                _clear_gpu_memory()

            model_path = reg["local_dir"]
            if not os.path.isdir(model_path):
                model_path = reg["hf_id"]

            print(f"Loading model: {model_id} from {model_path}")
            self.loaded_model = load_model(model_path)
            self.loaded_model_id = model_id
            self.load_error = None

            voices = get_model_voices(self.loaded_model, model_id)
            self._cached_voices[model_id] = voices
            self._voice_lower_map[model_id] = {v.lower(): v for v in voices}

            # Clean caches for unloaded models
            for old_id in list(self._cached_voices.keys()):
                if old_id != model_id:
                    del self._cached_voices[old_id]
                    self._voice_lower_map.pop(old_id, None)

            # Warmup
            try:
                warmup_kwargs = dict(
                    text=WARMUP_TEXT, speed=1.0, verbose=False, max_tokens=128,
                )
                if reg.get("has_preset_voices"):
                    warmup_kwargs["voice"] = reg.get("default_voices", ["ryan"])[0]
                    warmup_kwargs["lang_code"] = "en"
                _ = next(self.loaded_model.generate(**warmup_kwargs))
                print(f"Warmup complete for {model_id}")
            except Exception as warmup_exc:
                print(f"Warmup skipped for {model_id}: {warmup_exc}")

            return self.loaded_model

        except HTTPException:
            raise
        except Exception as exc:
            self.load_error = str(exc)
            print(f"Failed to load model {model_id}: {exc}")
            raise HTTPException(status_code=500, detail=f"Failed to load model {model_id}: {exc}")
        finally:
            self._loading_lock.release()


manager = ModelManager()

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=10000)
    voice: str = "ryan"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None
    stream: bool = False
    format: str = "opus"

# ---------------------------------------------------------------------------
# Sync synthesis helpers — both use gpu_lock for serialized GPU access
# ---------------------------------------------------------------------------

def _synthesize_sync(model, gen_kwargs, model_id, request_voice, lang_code,
                     audio_format: str = DEFAULT_AUDIO_FORMAT) -> tuple:
    """Blocking synthesize — acquires gpu_lock, runs generation, returns audio.
    Uses iterative consumption to avoid materializing all chunks in RAM at once."""
    acquired = gpu_lock.acquire(timeout=30)
    if not acquired:
        raise HTTPException(status_code=503, detail="GPU busy — all inference slots taken. Please retry.")

    try:
        gen_start = _time.perf_counter()
        audio_parts = []
        first_sample_rate = None
        first_rtf = 0
        for result in model.generate(**gen_kwargs):
            if first_sample_rate is None:
                first_sample_rate = result.sample_rate
                first_rtf = getattr(result, 'real_time_factor', 0)
            audio_parts.append(np.asarray(result.audio, dtype=np.float32))
        if not audio_parts:
            raise ValueError("No audio generated")
        gen_elapsed = _time.perf_counter() - gen_start

        sample_rate = first_sample_rate
        audio = np.concatenate(audio_parts, axis=0) if len(audio_parts) > 1 else audio_parts[0]
        # Free intermediate list before encoding to reduce peak RAM
        del audio_parts

        encode_start = _time.perf_counter()
        audio_bytes, mime_type = _encode_audio(audio, sample_rate, fmt=audio_format)
        encode_elapsed = _time.perf_counter() - encode_start

        headers = {
            "X-TTS-Engine": "open-tts",
            "X-TTS-Model": model_id,
            "X-TTS-Voice": request_voice,
            "X-TTS-Lang": lang_code or "auto",
            "X-TTS-RTF": f"{first_rtf:.3f}",
            "X-TTS-Gen-Time": f"{gen_elapsed:.3f}",
            "X-TTS-Encode-Time": f"{encode_elapsed:.3f}",
        }
        return audio_bytes, mime_type, headers
    except Exception as exc:
        # Only null the model on generation-level errors (bad state, corrupt output).
        # Transient errors (GPU lock timeout, client disconnect) should NOT force a reload.
        error_str = str(exc)
        is_transient = (
            "GPU busy" in error_str
            or "timed out" in error_str.lower()
            or "cancel" in error_str.lower()
        )
        if not is_transient:
            manager.load_error = str(exc)
            manager.loaded_model = None
            manager.loaded_model_id = None
            print(f"[Synthesize] Generation failed (non-transient), clearing model: {exc}")
        else:
            print(f"[Synthesize] Transient error, keeping model loaded: {exc}")
        raise
    finally:
        gpu_lock.release()
        gc.collect()  # Clean up intermediate tensors between requests


def _streaming_wav_generator_sync(model, gen_kwargs, model_id, request_voice, lang_code):
    """Sync generator — yields (wav_bytes, sample_rate, headers_dict, is_final).
    Acquires gpu_lock for the ENTIRE streaming duration so no concurrent inference runs."""
    # gpu_lock is acquired by the caller (_async_wav_stream_wrapper's worker thread)
    # BEFORE this function is called. The caller releases it when done.
    gen_start = _time.perf_counter()
    first_chunk_time = None
    total_audio_samples = 0

    stream_kwargs = {**gen_kwargs, "stream": True, "streaming_interval": STREAMING_INTERVAL}

    for result in model.generate(**stream_kwargs):
        if first_chunk_time is None:
            first_chunk_time = _time.perf_counter()

        audio = np.asarray(result.audio, dtype=np.float32)
        total_audio_samples += audio.shape[0]

        # Fast WAV encode — no ffmpeg subprocess
        wav_bytes = _encode_wav_fast(audio, result.sample_rate)

        chunk_audio_dur = audio.shape[0] / result.sample_rate
        rtf = result.real_time_factor if hasattr(result, 'real_time_factor') else 0

        headers = {
            "X-Sample-Rate": str(result.sample_rate),
            "X-Audio-Duration-Ms": str(int(chunk_audio_dur * 1000)),
            "X-TTS-Model": model_id,
            "X-TTS-Voice": request_voice,
            "X-TTS-Lang": lang_code or "auto",
            "X-TTS-RTF": f"{rtf:.3f}",
        }

        is_final = getattr(result, 'is_final_chunk', False)
        yield wav_bytes, result.sample_rate, headers, is_final

    if first_chunk_time is not None:
        total_elapsed = _time.perf_counter() - gen_start
        total_audio_dur = total_audio_samples / result.sample_rate
        overall_rtf = total_audio_dur / total_elapsed if total_elapsed > 0 else 0
        print(f"[Stream] Complete: {total_audio_dur:.1f}s audio in {total_elapsed:.1f}s (RTF {overall_rtf:.2f})")


# ---------------------------------------------------------------------------
# Build generation kwargs
# ---------------------------------------------------------------------------

def _build_gen_kwargs(request: SynthesizeRequest) -> tuple:
    model_id = request.model or DEFAULT_MODEL_ID
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")
    try:
        model = manager.get_or_load(model_id)
    except HTTPException:
        raise

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    reg = MODEL_REGISTRY.get(model_id, {})
    voices = manager.get_voices_cached(model_id)
    voice_lower_map = manager.get_voice_lower_map(model_id)

    gen_kwargs = dict(
        text=text,
        speed=float(request.speed),
        verbose=False,
        max_tokens=4096,
    )

    if reg.get("has_preset_voices"):
        speaker = normalize_voice(request.voice, voices, voice_lower_map) if voices else request.voice
        gen_kwargs["voice"] = speaker
        if reg.get("supports_lang_code"):
            gen_kwargs["lang_code"] = normalize_language(request.language)
        if request.instruct and reg.get("supports_instruct"):
            gen_kwargs["instruct"] = request.instruct
    else:
        if request.voice and voices:
            if request.voice in FISH_VOICE_TAGS:
                text = f"[{request.voice}] {text}"
                gen_kwargs["text"] = text
        if request.instruct:
            gen_kwargs["instruct"] = request.instruct

    lang_code = gen_kwargs.get("lang_code", "auto")
    return gen_kwargs, model_id, lang_code


# ---------------------------------------------------------------------------
# App lifespan
# ---------------------------------------------------------------------------

_shutdown_event = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _shutdown_event
    _shutdown_event = asyncio.Event()

    # Graceful signal handling
    def _signal_handler(sig, frame):
        print(f"Received signal {sig}, shutting down...")
        if _shutdown_event:
            _shutdown_event.set()

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    try:
        manager.get_or_load(DEFAULT_MODEL_ID)
    except HTTPException:
        pass

    yield

    # Cleanup
    if manager.loaded_model is not None:
        del manager.loaded_model
        manager.loaded_model = None
        manager.loaded_model_id = None
        _clear_gpu_memory()


app = FastAPI(title="Open TTS Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request logging middleware
# ---------------------------------------------------------------------------

@app.middleware("http")
async def log_requests(request, call_next):
    if request.url.path.startswith("/v1/") or request.url.path == "/health":
        start = _time.perf_counter()
        response = await call_next(request)
        duration = _time.perf_counter() - start
        print(f"[HTTP] {request.method} {request.url.path} {response.status_code} {duration:.3f}s")
        return response
    return await call_next(request)

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    model = manager.loaded_model
    model_id = manager.loaded_model_id
    supported = manager.get_voices_cached(model_id) if model else []
    return {
        "status": "ok",
        "engine": "open-tts",
        "model": model_id or DEFAULT_MODEL_ID,
        "model_loaded": model is not None,
        "load_error": manager.load_error,
        "gpu_lock_held": gpu_lock.locked(),
        "voices": supported,
    }


@app.get("/v1/models")
async def list_models():
    models = []
    for mid, reg in MODEL_REGISTRY.items():
        voices = manager.get_voices_cached(mid) if manager.is_loaded(mid) else reg.get("default_voices", [])
        models.append({
            "id": mid,
            "name": reg["display_name"],
            "description": reg["description"],
            "loaded": manager.is_loaded(mid),
            "active": manager.loaded_model_id == mid,
            "supports_lang_code": reg.get("supports_lang_code", False),
            "supports_ref_audio": reg.get("supports_ref_audio", False),
            "voices": [
                {"id": v, "name": title_for_voice(v), "language": "Multilingual"}
                for v in voices
            ],
        })
    return {"models": models}


@app.get("/v1/voices")
async def get_voices():
    model = manager.loaded_model
    model_id = manager.loaded_model_id
    if not model or not model_id:
        return {
            "model": None,
            "voices": [
                {"id": v, "name": title_for_voice(v), "language": "Multilingual"}
                for v in MODEL_REGISTRY["qwen3-tts"]["default_voices"]
            ],
        }
    voices = manager.get_voices_cached(model_id)
    reg = MODEL_REGISTRY.get(model_id, {})
    if not reg.get("has_preset_voices") and not voices:
        voices = FISH_VOICE_TAGS
    return {
        "model": model_id,
        "voices": [
            {"id": v, "name": title_for_voice(v), "language": "Multilingual"}
            for v in voices
        ],
    }


@app.post("/v1/load-model")
async def load_model_endpoint(model_id: str = DEFAULT_MODEL_ID, force: bool = False):
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    # Allow reload if previous load failed or force flag is set
    if model_id == manager.loaded_model_id and not manager.load_error and not force:
        # Already loaded successfully — return info
        voices = manager.get_voices_cached(model_id)
        return {
            "success": True,
            "model": model_id,
            "name": MODEL_REGISTRY[model_id]["display_name"],
            "voices": voices,
        }

    try:
        manager.get_or_load(model_id)
        voices = manager.get_voices_cached(model_id)
        return {
            "success": True,
            "model": model_id,
            "name": MODEL_REGISTRY[model_id]["display_name"],
            "voices": voices,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Streaming endpoint — sends WAV segments as they generate
# ---------------------------------------------------------------------------

async def _async_wav_stream_wrapper(model, gen_kwargs, model_id, request_voice, lang_code):
    """Wraps the sync streaming generator.
    Acquires gpu_lock in the worker thread for the ENTIRE generation duration,
    so no other generate() can run concurrently."""
    import queue as _queue
    result_queue = _queue.Queue()

    def _worker():
        # Acquire gpu_lock for the entire streaming duration
        acquired = gpu_lock.acquire(timeout=120)
        if not acquired:
            result_queue.put(("error", RuntimeError("GPU busy — timed out waiting for GPU lock"), None, None, None))
            return
        try:
            for wav_bytes, sr, headers, is_final in _streaming_wav_generator_sync(
                model, gen_kwargs, model_id, request_voice, lang_code
            ):
                result_queue.put(("audio", wav_bytes, sr, headers, is_final))
            result_queue.put(("done", None, None, None, None))
        except Exception as e:
            result_queue.put(("error", e, None, None, None))
        finally:
            gpu_lock.release()

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    loop = asyncio.get_running_loop()

    while True:
        try:
            msg_type, wav_bytes, sr, headers, is_final = await loop.run_in_executor(
                None, result_queue.get, True, 2.0  # block up to 2s per get
            )
        except _queue.Empty:
            # Timeout — check if thread died unexpectedly
            if not thread.is_alive():
                raise RuntimeError("Streaming generation thread died unexpectedly")
            continue

        if msg_type == "done":
            break
        elif msg_type == "error":
            raise wav_bytes  # The exception object
        elif msg_type == "audio":
            yield wav_bytes, sr, headers, is_final


@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    request_start = _time.perf_counter()

    # Fish S2 Pro does NOT support streaming — force non-streaming fallback
    stream_requested = request.stream
    stream_fallback = False
    if stream_requested:
        effective_model = request.model or DEFAULT_MODEL_ID
        if effective_model == "fish-s2-pro":
            stream_fallback = True
            stream_requested = False
            print(f"[Stream] Fish S2 Pro doesn't support streaming — falling back to non-streaming")

    # Streaming mode — send WAV segments as they generate
    if stream_requested:
        gen_kwargs, model_id, lang_code = _build_gen_kwargs(request)
        model = manager.loaded_model

        async def _stream_response():
            async for wav_bytes, sr, headers, is_final in _async_wav_stream_wrapper(
                model, gen_kwargs, model_id, request.voice, lang_code
            ):
                yield wav_bytes

        return StreamingResponse(
            _stream_response(),
            media_type="audio/wav",
            headers={
                "X-TTS-Engine": "open-tts",
                "X-TTS-Model": model_id,
                "X-TTS-Voice": request.voice,
                "X-TTS-Lang": lang_code or "auto",
                "X-TTS-Stream": "true",
                "X-Transfer-Format": "concatenated-wav",
                "Cache-Control": "no-cache",
            },
        )

    # Non-streaming mode — gpu_lock is acquired inside _synthesize_sync
    gen_kwargs, model_id, lang_code = _build_gen_kwargs(request)
    model = manager.loaded_model

    try:
        audio_bytes, mime_type, headers = await asyncio.to_thread(
            _synthesize_sync, model, gen_kwargs, model_id, request.voice,
            lang_code, request.format,
        )
        headers["X-TTS-Total-Time"] = f"{_time.perf_counter() - request_start:.3f}"
        if stream_fallback:
            headers["X-TTS-Fallback"] = "non-streaming"
            headers["X-TTS-Stream"] = "false"
        return Response(content=audio_bytes, media_type=mime_type, headers=headers)

    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        # Only mark load_error for non-transient failures — keep model for retries
        error_str = str(exc)
        is_transient = (
            "GPU busy" in error_str
            or "timed out" in error_str.lower()
            or "cancel" in error_str.lower()
        )
        if not is_transient:
            manager.load_error = str(exc)
            print(f"[Synthesize] Generation failed (non-transient): {exc}")
        else:
            print(f"[Synthesize] Transient error, not clearing model: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        timeout_keep_alive=75,
    )