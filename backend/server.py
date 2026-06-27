#!/usr/bin/env python3
"""
Open TTS Server v3.0 — Clean rewrite.
FastAPI server for MLX-based TTS models (Kokoro, Qwen3-TTS, Fish S2 Pro).

Key improvements over v2:
  - Speed is applied exclusively via playbackRate in the browser (no ffmpeg post-processing)
    OR via the model's native speed param — never both. This fixes the "1.5x isn't 1.5x" bug.
  - Clean separation: model management, generation, encoding, HTTP endpoints.
  - Streaming uses chunked WAV frames with a simple length-prefixed protocol.
  - No dummy SynthesizeRequest hacks.
"""

from __future__ import annotations

import asyncio
import gc
import io
import json
import os
import signal
import struct
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, Generator, List, Optional, Tuple

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

# ─── MLX compile workaround ──────────────────────────────────────────────────
# MLX 0.31's mx.compile crashes on functions returning tuples (e.g. RoPE helpers
# in mlx-audio's qwen3_tts/talker.py). We wrap mx.compile to skip compilation only
# for functions that return tuples. Single-array-return functions (like Kokoro's
# decoder) are still compiled normally.
import mlx.core as _mx
_orig_mx_compile = _mx.compile

def _safe_compile(fn=None, **kwargs):
    # If called as decorator on a function, check if it returns tuples
    # by inspecting the return annotation. If we can't tell, compile normally.
    # The actual fix is in the qwen3_tts/talker.py where we removed @mx.compile
    # from tuple-returning functions. Here we just pass through.
    if fn is not None:
        return _orig_mx_compile(fn, **kwargs)
    # Called as partial(mx.compile, ...) — return a decorator
    def decorator(f):
        return _orig_mx_compile(f, **kwargs)
    return decorator

_mx.compile = _safe_compile

from mlx_audio.tts.utils import load_model
from pydantic import BaseModel, Field

# ─── Configuration ──────────────────────────────────────────────────────────

HOST = os.getenv("OPEN_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPEN_TTS_PORT", "8000"))
DEFAULT_MODEL = os.getenv("OPEN_TTS_DEFAULT_MODEL", "kokoro")
WARMUP_TEXT = os.getenv("OPEN_TTS_WARMUP_TEXT", "Warmup")
GEN_TIMEOUT = int(os.getenv("OPEN_TTS_GEN_TIMEOUT", "300"))

# ─── Model Registry ──────────────────────────────────────────────────────────

MODEL_REGISTRY: Dict[str, dict] = {
    "kokoro": {
        "hf_id": "mlx-community/Kokoro-82M-bf16",
        "local_dir": "models/kokoro-82M",
        "display_name": "Kokoro 82M",
        "description": "Ultra-fast lightweight TTS",
        "default_voice": "af_bella",
        "supports_native_speed": True,
        "supports_lang_code": False,
        "supports_instruct": False,
        "has_preset_voices": True,
        "default_voices": [
            "af_bella", "af_sarah", "af_nova", "af_heart", "af_jessica",
            "af_alloy", "af_sky", "af_river", "af_aoede", "af_kore",
            "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
            "am_michael", "am_onyx", "am_puck", "am_santa",
        ],
    },
    "qwen3-tts": {
        "hf_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        "local_dir": "models/qwen3-tts-8bit",
        "display_name": "Qwen3-TTS 1.7B",
        "description": "Multilingual TTS with preset voices",
        "default_voice": "ryan",
        "supports_native_speed": False,  # Qwen3 ignores speed param
        "supports_lang_code": True,
        "supports_instruct": True,
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
        "description": "High-quality TTS with voice cloning",
        "default_voice": None,
        "supports_native_speed": False,
        "supports_lang_code": False,
        "supports_instruct": True,
        "has_preset_voices": False,
        "default_voices": [],
    },
}

FISH_VOICE_TAGS = frozenset([
    "pause", "emphasis", "laughing", "inhale", "chuckle", "tsk",
    "singing", "excited", "volume up", "echo", "angry", "whisper",
    "screaming", "sad", "shocked", "pitch up", "pitch down",
    "professional broadcast tone",
])

VOICE_LABELS = {
    "serena": "Serena", "vivian": "Vivian", "uncle_fu": "Uncle Fu",
    "dylan": "Dylan", "eric": "Eric", "ryan": "Ryan", "aiden": "Aiden",
    "ono_anna": "Ono Anna", "sohee": "Sohee",
    "af_heart": "Heart", "af_bella": "Bella", "af_sarah": "Sarah",
    "af_nova": "Nova", "af_jessica": "Jessica", "af_kore": "Kore",
    "af_sky": "Sky", "af_alloy": "Alloy", "af_aoede": "Aoede",
    "af_river": "River", "am_adam": "Adam", "am_echo": "Echo",
    "am_eric": "Eric (M)", "am_fenrir": "Fenrir", "am_liam": "Liam",
    "am_michael": "Michael", "am_onyx": "Onyx", "am_puck": "Puck",
    "am_santa": "Santa",
}

LANG_ALIASES = {
    "auto": "auto", "english": "en", "en": "en",
    "chinese": "zh", "zh": "zh", "japanese": "ja", "ja": "ja",
    "korean": "ko", "ko": "ko", "spanish": "es", "es": "es",
    "french": "fr", "fr": "fr", "german": "de", "de": "de",
}

# ─── GPU Lock ──────────────────────────────────────────────────────────────

gpu_lock = threading.Lock()


def _clear_gpu_memory():
    """Force GC + MLX cache clear."""
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:
        pass


# ─── Audio Helpers ──────────────────────────────────────────────────────────

def _to_f32(arr) -> np.ndarray:
    if hasattr(arr, 'dtype') and arr.dtype == np.float32 and isinstance(arr, np.ndarray):
        return arr
    return np.asarray(arr, dtype=np.float32)


def _encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    """Fast WAV encoding via soundfile."""
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _encode_audio(audio: np.ndarray, sample_rate: int, fmt: str = "wav") -> Tuple[bytes, str]:
    """Encode audio to requested format. Returns (bytes, mime_type)."""
    if fmt == "wav":
        return _encode_wav(audio, sample_rate), "audio/wav"
    
    # Opus/MP3 via mlx_audio
    try:
        from mlx_audio.audio_io import write as audio_write
        buf = io.BytesIO()
        audio_write(buf, audio, sample_rate, format=fmt)
        mime = {"opus": "audio/ogg; codecs=opus", "mp3": "audio/mpeg"}.get(fmt, "audio/octet-stream")
        return buf.getvalue(), mime
    except Exception:
        return _encode_wav(audio, sample_rate), "audio/wav"


# ─── Voice / Language Normalization ──────────────────────────────────────────

def _normalize_voice(voice: str, supported: List[str]) -> str:
    raw = (voice or "").strip().lower().replace(" ", "_")
    if raw in supported:
        return raw
    for v in supported:
        if v.lower() == raw:
            return v
    raise HTTPException(400, f"Voice '{voice}' not supported. Try: {', '.join(supported[:10])}")


def _normalize_lang(lang: str) -> str:
    raw = (lang or "auto").strip().lower()
    return LANG_ALIASES.get(raw, "auto")


def _voice_label(voice_id: str) -> str:
    return VOICE_LABELS.get(voice_id, voice_id.replace("_", " ").title())


def _get_model_voices(model_obj, model_id: str) -> List[str]:
    reg = MODEL_REGISTRY.get(model_id, {})
    if reg.get("has_preset_voices") and hasattr(model_obj, "get_supported_speakers"):
        try:
            return model_obj.get_supported_speakers()
        except Exception:
            pass
    return reg.get("default_voices", [])


# ─── Model Manager ──────────────────────────────────────────────────────────

class ModelManager:
    def __init__(self):
        self.model = None
        self.model_id: Optional[str] = None
        self.load_error: Optional[str] = None
        self._lock = threading.Lock()
        self._lock_timeout = 120
        self._voices: Dict[str, List[str]] = {}
        self._warm = threading.Event()

    def is_loaded(self, model_id: str) -> bool:
        return self.model is not None and self.model_id == model_id

    def is_warm(self) -> bool:
        return self._warm.is_set()

    def voices(self, model_id: str) -> List[str]:
        return self._voices.get(model_id, [])

    def get_or_load(self, model_id: str):
        reg = MODEL_REGISTRY.get(model_id)
        if not reg:
            raise HTTPException(404, f"Unknown model: {model_id}")

        if self.is_loaded(model_id):
            return self.model

        acquired = self._lock.acquire(timeout=self._lock_timeout)
        if not acquired:
            raise HTTPException(503, "Model loading timed out. Please retry.")

        try:
            if self.is_loaded(model_id):
                return self.model

            # Unload previous
            if self.model is not None:
                print(f"Unloading {self.model_id}...")
                del self.model
                self.model = None
                self.model_id = None
                self.load_error = None
                self._warm.clear()
                _clear_gpu_memory()

            # Load
            model_path = reg["local_dir"]
            if not os.path.isdir(model_path):
                model_path = reg["hf_id"]

            print(f"Loading {model_id} from {model_path}...")
            self.model = load_model(model_path)
            self.model_id = model_id
            self.load_error = None

            # Cache voices
            voices = _get_model_voices(self.model, model_id)
            self._voices = {model_id: voices}

            # Warmup in background
            self._warm.clear()
            threading.Thread(target=self._do_warmup, args=(self.model, model_id), daemon=True).start()

            return self.model
        except HTTPException:
            raise
        except Exception as exc:
            self.load_error = str(exc)
            print(f"Failed to load {model_id}: {exc}")
            raise HTTPException(500, f"Failed to load model {model_id}: {exc}")
        finally:
            self._lock.release()

    def _do_warmup(self, model, model_id: str):
        reg = MODEL_REGISTRY.get(model_id, {})
        try:
            kwargs = dict(text=WARMUP_TEXT, speed=1.0, verbose=False, max_tokens=128)
            if reg.get("has_preset_voices"):
                kwargs["voice"] = reg.get("default_voices", ["ryan"])[0]
                kwargs["lang_code"] = "en"
            next(model.generate(**kwargs))
            print(f"Warmup complete: {model_id}")
        except Exception as e:
            print(f"Warmup skipped: {model_id}: {e}")
        finally:
            self._warm.set()


manager = ModelManager()

# ─── Build Generation Kwargs ────────────────────────────────────────────────

def _build_gen_kwargs(
    model_id: str, text: str, voice: str, speed: float,
    language: str = "Auto", instruct: Optional[str] = None,
) -> Tuple[dict, str]:
    """Build kwargs for model.generate(). Returns (kwargs, lang_code)."""
    reg = MODEL_REGISTRY.get(model_id, {})
    voices = manager.voices(model_id)

    kwargs: Dict[str, Any] = dict(
        text=text,
        verbose=False,
        max_tokens=4096,
    )

    # Speed: only pass to model if it supports native speed.
    # For models that don't (Qwen3, Fish), speed is handled by browser playbackRate.
    if reg.get("supports_native_speed", False):
        kwargs["speed"] = float(speed)
    else:
        kwargs["speed"] = 1.0  # Generate at 1x; browser speeds up playback

    if reg.get("has_preset_voices"):
        speaker = _normalize_voice(voice, voices) if voices else voice
        kwargs["voice"] = speaker
        if reg.get("supports_lang_code"):
            kwargs["lang_code"] = _normalize_lang(language)
        if instruct and reg.get("supports_instruct"):
            kwargs["instruct"] = instruct
    else:
        # Fish S2 Pro — voice tags injected into text
        if voice and voice in FISH_VOICE_TAGS:
            kwargs["text"] = f"[{voice}] {text}"
        if instruct:
            kwargs["instruct"] = instruct

    lang_code = kwargs.get("lang_code", "auto")
    return kwargs, lang_code


# ─── Core Generation ────────────────────────────────────────────────────────

def _generate_full(model, gen_kwargs: dict) -> Tuple[np.ndarray, int, float]:
    """Run full generation, return concatenated audio, sample_rate, rtf.
    Retries with slight text modification if Kokoro's broadcast_shapes bug triggers."""
    acquired = gpu_lock.acquire(timeout=30)
    if not acquired:
        raise HTTPException(503, "GPU busy. Please retry.")

    try:
        parts = []
        sr = None
        rtf = 0.0
        deadline = time.perf_counter() + GEN_TIMEOUT

        try:
            for result in model.generate(**gen_kwargs):
                if time.perf_counter() > deadline:
                    raise TimeoutError(f"Generation exceeded {GEN_TIMEOUT}s")
                if sr is None:
                    sr = result.sample_rate
                    rtf = getattr(result, 'real_time_factor', 0)
                parts.append(_to_f32(result.audio))
        except Exception as e:
            if "broadcast_shapes" in str(e) and "text" in gen_kwargs:
                # Kokoro bug: specific phoneme counts cause shape mismatch.
                # Try different text modifications to change phoneme count.
                for mod_text in [
                    gen_kwargs["text"] + ".",  # add period
                    gen_kwargs["text"].replace(",", ""),  # remove commas
                    gen_kwargs["text"] + " Continue.",  # add words
                ]:
                    try:
                        gen_kwargs = {**gen_kwargs, "text": mod_text}
                        parts = []
                        for result in model.generate(**gen_kwargs):
                            if time.perf_counter() > deadline:
                                raise TimeoutError(f"Generation exceeded {GEN_TIMEOUT}s")
                            if sr is None:
                                sr = result.sample_rate
                                rtf = getattr(result, 'real_time_factor', 0)
                            parts.append(_to_f32(result.audio))
                        if parts:
                            break
                    except Exception as e2:
                        if "broadcast_shapes" in str(e2):
                            continue
                        raise
                if not parts:
                    raise ValueError(f"Kokoro broadcast_shapes bug — text modification retries all failed: {gen_kwargs['text'][:50]}")
            else:
                raise

        if not parts:
            raise ValueError("No audio generated")

        audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
        del parts
        return audio, sr or 24000, rtf
    finally:
        gpu_lock.release()


def _generate_stream(model, gen_kwargs: dict, interval: float = 1.0
    ) -> Generator[Tuple[np.ndarray, int, bool], None, None]:
    """Stream generation — yields (audio_chunk, sample_rate, is_final)."""
    for result in model.generate(**gen_kwargs, stream=True, streaming_interval=interval):
        audio = _to_f32(result.audio)
        is_final = getattr(result, 'is_final_chunk', False)
        yield audio, result.sample_rate, is_final


# ─── Pydantic Request Models ────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=50000)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None
    stream: bool = False
    format: str = "wav"


class BatchRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1, max_length=50)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None
    format: str = "wav"


class StreamBatchRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1, max_length=50)
    voice: str = "af_bella"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None
    model: Optional[str] = None


class SpeechRequest(BaseModel):
    model: str = DEFAULT_MODEL
    input: str = Field(..., min_length=1, max_length=50000)
    voice: str = "af_bella"
    response_format: str = "wav"
    speed: float = Field(1.0, ge=0.5, le=3.0)
    language: str = "Auto"
    instruct: Optional[str] = None


# ─── Lifespan ──────────────────────────────────────────────────────────────

_shutdown = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _shutdown
    _shutdown = asyncio.Event()

    def _handler(sig, frame):
        _shutdown.set()
    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)

    try:
        manager.get_or_load(DEFAULT_MODEL)
    except HTTPException:
        pass

    yield

    if manager.model is not None:
        del manager.model
        manager.model = None
        _clear_gpu_memory()


app = FastAPI(title="Open TTS Server", version="3.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Request Logging ───────────────────────────────────────────────────────

@app.middleware("http")
async def log_requests(request, call_next):
    if request.url.path.startswith("/v1/") or request.url.path == "/health":
        start = time.perf_counter()
        resp = await call_next(request)
        dur = time.perf_counter() - start
        print(f"[HTTP] {request.method} {request.url.path} {resp.status_code} {dur:.3f}s")
        return resp
    return await call_next(request)


# ─── Health Cache ───────────────────────────────────────────────────────────

_health_cache = {"data": None, "ts": 0.0}


def _health_data():
    return {
        "status": "ok",
        "engine": "open-tts",
        "version": "3.1.0",
        "model": manager.model_id or DEFAULT_MODEL,
        "model_loaded": manager.model is not None,
        "model_warm": manager.is_warm(),
        "load_error": manager.load_error,
        "gpu_busy": gpu_lock.locked(),
        "voices": manager.voices(manager.model_id) if manager.model else [],
    }


# ─── Endpoints ─────────────────────────────────────────────────────────────

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
    for mid, reg in MODEL_REGISTRY.items():
        voices = manager.voices(mid) if manager.is_loaded(mid) else reg.get("default_voices", [])
        models.append({
            "id": mid,
            "name": reg["display_name"],
            "description": reg["description"],
            "loaded": manager.is_loaded(mid),
            "active": manager.model_id == mid,
            "supports_native_speed": reg.get("supports_native_speed", False),
            "voices": [{"id": v, "name": _voice_label(v)} for v in voices],
        })
    return {"models": models}


@app.get("/v1/voices")
async def get_voices():
    mid = manager.model_id
    if not mid:
        return {"model": None, "voices": []}
    voices = manager.voices(mid)
    return {"model": mid, "voices": [{"id": v, "name": _voice_label(v)} for v in voices]}


@app.post("/v1/load-model")
async def load_model_endpoint(model_id: str = Query(default=DEFAULT_MODEL)):
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(404, f"Unknown model: {model_id}")
    if model_id == manager.model_id and not manager.load_error:
        return {"success": True, "model": model_id, "voices": manager.voices(model_id)}
    manager.get_or_load(model_id)
    _health_cache["data"] = None
    return {"success": True, "model": model_id, "voices": manager.voices(model_id)}


# ─── Non-streaming Synthesize ──────────────────────────────────────────────

@app.post("/v1/synthesize")
async def synthesize(request: SynthesizeRequest):
    t0 = time.perf_counter()
    model_id = request.model or DEFAULT_MODEL
    if model_id not in MODEL_REGISTRY:
        raise HTTPException(404, f"Unknown model: {model_id}")

    model = manager.get_or_load(model_id)
    gen_kwargs, lang_code = _build_gen_kwargs(
        model_id, request.text, request.voice, request.speed,
        request.language, request.instruct,
    )

    try:
        audio, sr, rtf = await asyncio.to_thread(_generate_full, model, gen_kwargs)
        encode_start = time.perf_counter()
        audio_bytes, mime = _encode_audio(audio, sr, request.format)
        encode_time = time.perf_counter() - encode_start
        gen_time = time.perf_counter() - t0 - encode_time

        headers = {
            "X-TTS-Model": model_id,
            "X-TTS-Voice": request.voice,
            "X-TTS-RTF": f"{rtf:.3f}",
            "X-TTS-Gen-Time": f"{gen_time:.3f}",
            "X-TTS-Encode-Time": f"{encode_time:.3f}",
            "X-TTS-Speed": f"{request.speed}",
            # Tell the client whether to apply playbackRate
            "X-TTS-Apply-Playback-Rate": "false" if MODEL_REGISTRY[model_id].get("supports_native_speed") else "true",
            "X-TTS-Playback-Rate": f"{request.speed}",
        }
        return Response(content=audio_bytes, media_type=mime, headers=headers)
    except TimeoutError as e:
        raise HTTPException(504, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ─── Non-streaming Batch ───────────────────────────────────────────────────

@app.post("/v1/synthesize-batch")
async def synthesize_batch(request: BatchRequest):
    if len(request.texts) > 50:
        raise HTTPException(400, "Maximum 50 texts per batch")

    t0 = time.perf_counter()
    model_id = request.model or DEFAULT_MODEL
    model = manager.get_or_load(model_id)

    def _run_batch():
        acquired = gpu_lock.acquire(timeout=max(60, len(request.texts) * 30))
        if not acquired:
            raise HTTPException(503, "GPU busy")
        results = []
        try:
            for idx, text in enumerate(request.texts):
                gen_kwargs, _ = _build_gen_kwargs(
                    model_id, text, request.voice, request.speed,
                    request.language, request.instruct,
                )
                try:
                    parts = []
                    sr = None
                    for result in model.generate(**gen_kwargs):
                        if sr is None:
                            sr = result.sample_rate
                        parts.append(_to_f32(result.audio))
                    if not parts:
                        raise ValueError("No audio")
                    audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
                    del parts
                    audio_bytes, _ = _encode_audio(audio, sr, request.format)
                    results.append({
                        "index": idx,
                        "audio_base64": __import__("base64").b64encode(audio_bytes).decode(),
                        "gen_time": round(time.perf_counter() - t0, 3),
                    })
                    gc.collect()
                except Exception as e:
                    results.append({"index": idx, "error": str(e)})
        finally:
            gpu_lock.release()
        return results

    results = await asyncio.to_thread(_run_batch)
    return {
        "results": results,
        "model": model_id,
        "total_time": round(time.perf_counter() - t0, 3),
        "error_count": sum(1 for r in results if "error" in r),
    }


# ─── Streaming Batch (binary frames) ────────────────────────────────────────
# Frame format:
#   [4 bytes: header JSON length N, little-endian uint32]
#   [N bytes: UTF-8 JSON header]
#   [4 bytes: audio data length M, little-endian uint32]
#   [M bytes: WAV audio (or 0 if error/final marker)]
# Terminal frame: header has {"done": true}

def _streaming_batch_sync(model, base_kwargs, texts, model_id, speed):
    """Yield binary frames. Acquires gpu_lock once for all texts."""
    acquired = gpu_lock.acquire(timeout=120)
    if not acquired:
        hdr = json.dumps({"index": 0, "error": "GPU busy"}).encode()
        yield struct.pack("<I", len(hdr)) + hdr + struct.pack("<I", 0)
        return

    try:
        reg = MODEL_REGISTRY.get(model_id, {})
        supports_native = reg.get("supports_native_speed", False)

        for idx, text in enumerate(texts):
            gen_kwargs = {**base_kwargs, "text": text}
            # Override speed to 1.0 for streaming — browser applies playbackRate
            if not supports_native:
                gen_kwargs["speed"] = 1.0

            deadline = time.perf_counter() + GEN_TIMEOUT

            try:
                for result in model.generate(**gen_kwargs, stream=True, streaming_interval=1.0):
                    if time.perf_counter() > deadline:
                        raise TimeoutError(f"Chunk {idx} exceeded {GEN_TIMEOUT}s")

                    audio = _to_f32(result.audio)
                    sr = result.sample_rate
                    wav = _encode_wav(audio, sr)

                    hdr = json.dumps({
                        "index": idx,
                        "sample_rate": sr,
                        "speed": speed,
                        "apply_playback_rate": not supports_native,
                        "playback_rate": speed,
                        "final": False,
                    }).encode()
                    yield struct.pack("<I", len(hdr)) + hdr + struct.pack("<I", len(wav)) + wav

                # Final marker for this index
                final_hdr = json.dumps({"index": idx, "final": True}).encode()
                yield struct.pack("<I", len(final_hdr)) + final_hdr + struct.pack("<I", 0)
                gc.collect()

            except Exception as e:
                print(f"[StreamBatch] Chunk {idx} error: {e}")
                hdr = json.dumps({"index": idx, "error": str(e)}).encode()
                yield struct.pack("<I", len(hdr)) + hdr + struct.pack("<I", 0)

    finally:
        gpu_lock.release()


@app.post("/v1/synthesize-stream-batch")
async def synthesize_stream_batch(request: StreamBatchRequest):
    if len(request.texts) > 50:
        raise HTTPException(400, "Maximum 50 texts per batch")

    model_id = request.model or DEFAULT_MODEL
    model = manager.get_or_load(model_id)
    base_kwargs, lang_code = _build_gen_kwargs(
        model_id, request.texts[0], request.voice, request.speed,
        request.language, request.instruct,
    )

    # For streaming, always generate at 1x if model doesn't support native speed
    reg = MODEL_REGISTRY.get(model_id, {})
    if not reg.get("supports_native_speed", False):
        base_kwargs["speed"] = 1.0

    async def _response():
        import queue as _queue
        q: _queue.Queue = _queue.Queue()
        gen = _streaming_batch_sync(model, base_kwargs, request.texts, model_id, request.speed)

        def _worker():
            try:
                for frame in gen:
                    q.put(frame)
                q.put(None)
            except Exception as e:
                q.put(("error", e))

        threading.Thread(target=_worker, daemon=True).start()
        loop = asyncio.get_running_loop()

        while True:
            try:
                frame = await loop.run_in_executor(None, q.get, True, 30.0)
            except _queue.Empty:
                continue
            if frame is None:
                break
            if isinstance(frame, tuple) and frame[0] == "error":
                raise frame[1]
            yield frame

        # Terminal frame
        hdr = json.dumps({"done": True}).encode()
        yield struct.pack("<I", len(hdr)) + hdr + struct.pack("<I", 0)

    return StreamingResponse(
        _response(),
        media_type="application/octet-stream",
        headers={
            "X-TTS-Model": model_id,
            "X-TTS-Stream-Batch": "true",
            "Cache-Control": "no-cache",
        },
    )


# ─── OpenAI-Compatible Endpoint ─────────────────────────────────────────────

FORMAT_MAP = {"mp3": "mp3", "opus": "opus", "aac": "aac", "flac": "flac", "wav": "wav", "pcm": "wav"}
MIME_MAP = {"mp3": "audio/mpeg", "opus": "audio/opus", "aac": "audio/aac",
            "flac": "audio/flac", "wav": "audio/wav"}


@app.post("/v1/audio/speech")
async def openai_speech(request: SpeechRequest):
    fmt = FORMAT_MAP.get(request.response_format, "wav")
    synth_req = SynthesizeRequest(
        text=request.input,
        voice=request.voice,
        speed=request.speed,
        language=request.language,
        instruct=request.instruct,
        model=request.model if request.model != "tts-1" else None,
        stream=False,
        format=fmt,
    )
    return await synthesize(synth_req)


@app.post("/v1/speech")
async def openai_speech_alt(request: SpeechRequest):
    return await openai_speech(request)


# ─── Main ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, timeout_keep_alive=75)