"""Authoritative MLX model coordinator with explicit state machine."""

from __future__ import annotations

import base64
import gc
import os
import threading
import time
from enum import Enum
from typing import Any, Callable, Dict, Generator, List, Optional, Tuple

import numpy as np
from fastapi import HTTPException

from .adapters import build_gen_kwargs, get_model_voices, split_kokoro_chunks, split_stream_text
from .audio import encode_audio, encode_wav, time_stretch, to_f32
from .config import (
    BACKEND_DIR,
    DEFAULT_MODEL,
    GEN_TIMEOUT,
    STREAM_FIRST_CHUNK_CHARS,
    STREAM_REST_CHUNK_CHARS,
    STREAMING_INTERVAL,
    WARMUP_TEXT,
    AudioFormat,
)
from .errors import ErrorCode, http_exception
from .protocol import pack_frame
from .registry import MODEL_REGISTRY


class ModelState(str, Enum):
    UNLOADED = "unloaded"
    LOADING = "loading"
    LOADED = "loaded"
    WARMING = "warming"
    READY = "ready"
    FAILED = "failed"
    GENERATING = "generating"


def _clear_gpu_memory() -> None:
    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        pass


class ModelCoordinator:
    """Serializes load, unload, warmup, and all generate activity."""

    def __init__(self):
        self.model = None
        self.model_id: Optional[str] = None
        self.state = ModelState.UNLOADED
        self.load_error: Optional[str] = None
        self.warm_error: Optional[str] = None
        # Serialize destructive MLX operations, but never make health snapshots
        # wait behind a multi-minute generation.
        self._operation_lock = threading.RLock()
        self._operation_lock_timeout = 120
        self._voices: Dict[str, List[str]] = {}
        self._cancel = threading.Event()

    # ── State helpers ────────────────────────────────────────────────

    def snapshot(self) -> dict:
        # A snapshot may briefly straddle a transition. That is preferable to
        # blocking /health for the entire duration of inference.
        state = self.state
        model = self.model
        return {
            "state": state.value,
            "model_id": self.model_id,
            "model_loaded": model is not None,
            "model_warm": state == ModelState.READY,
            "load_error": self.load_error,
            "warm_error": self.warm_error,
            "gpu_busy": state == ModelState.GENERATING,
        }

    def voices(self, model_id: Optional[str] = None) -> List[str]:
        mid = model_id or self.model_id
        if not mid:
            return []
        return self._voices.get(mid, MODEL_REGISTRY.get(mid, {}).get("default_voices", []))

    def is_ready(self) -> bool:
        return self.state == ModelState.READY

    def ensure_ready(self) -> None:
        if self.state == ModelState.FAILED:
            raise http_exception(
                503,
                ErrorCode.MODEL_WARM_FAILED,
                self.warm_error or self.load_error or "Model failed",
            )
        if self.state in (ModelState.LOADING, ModelState.WARMING):
            raise http_exception(503, ErrorCode.MODEL_NOT_READY, "Model is still warming up")
        if self.state != ModelState.READY or self.model is None:
            raise http_exception(503, ErrorCode.MODEL_NOT_READY, "Model not ready")

    # ── Load / unload ────────────────────────────────────────────────

    def _unload_locked(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
        self.model_id = None
        self.load_error = None
        self.warm_error = None
        self.state = ModelState.UNLOADED
        _clear_gpu_memory()

    def load(self, model_id: str, *, force: bool = False) -> dict:
        if model_id not in MODEL_REGISTRY:
            raise http_exception(404, ErrorCode.MODEL_NOT_FOUND, f"Unknown model: {model_id}")

        acquired = self._operation_lock.acquire(timeout=self._operation_lock_timeout)
        if not acquired:
            raise http_exception(503, ErrorCode.GPU_BUSY, "Coordinator busy")

        try:
            if (
                not force
                and self.model_id == model_id
                and self.state in (ModelState.READY, ModelState.WARMING, ModelState.LOADED)
                and not self.load_error
            ):
                return {"model": model_id, "state": self.state.value, "voices": self.voices(model_id)}

            self.state = ModelState.LOADING
            self._cancel.clear()

            if self.model is not None:
                self._unload_locked()

            reg = MODEL_REGISTRY[model_id]
            model_path: Any = BACKEND_DIR / reg["local_dir"]
            if not os.path.isdir(model_path):
                model_path = reg["hf_id"]

            try:
                from mlx_audio.tts.utils import load_model

                self.model = load_model(model_path)
                self.model_id = model_id
                self.load_error = None
                self.warm_error = None
                voices = get_model_voices(self.model, model_id)
                self._voices = {model_id: voices}
                self.state = ModelState.LOADED
            except HTTPException:
                raise
            except Exception as exc:
                self.load_error = str(exc)
                self.state = ModelState.FAILED
                self.model = None
                self.model_id = None
                raise http_exception(500, ErrorCode.MODEL_LOAD_FAILED, str(exc))

            self._warmup_locked()
            return {
                "success": True,
                "model": model_id,
                "state": self.state.value,
                "voices": self.voices(model_id),
            }
        finally:
            self._operation_lock.release()

    def _warmup_locked(self) -> None:
        assert self.model is not None and self.model_id is not None
        self.state = ModelState.WARMING
        reg = MODEL_REGISTRY[self.model_id]
        try:
            kwargs = dict(text=WARMUP_TEXT, speed=1.0, verbose=False, max_tokens=128)
            if reg.get("has_preset_voices"):
                default = reg.get("default_voice") or reg.get("default_voices", ["ryan"])[0]
                kwargs["voice"] = default
                if reg.get("supports_lang_code"):
                    kwargs["lang_code"] = "en"
            next(self.model.generate(**kwargs))
            self.warm_error = None
            self.state = ModelState.READY
        except Exception as exc:
            self.warm_error = str(exc)
            self.state = ModelState.FAILED
            raise http_exception(503, ErrorCode.MODEL_WARM_FAILED, str(exc))

    def force_reload(self, model_id: Optional[str] = None) -> dict:
        mid = model_id or self.model_id or DEFAULT_MODEL
        return self.load(mid, force=True)

    def shutdown(self) -> None:
        self._cancel.set()
        acquired = self._operation_lock.acquire(timeout=self._operation_lock_timeout)
        if not acquired:
            return
        try:
            self._unload_locked()
        finally:
            self._operation_lock.release()

    # ── Generation ───────────────────────────────────────────────────

    def _iter_audio_results(
        self,
        model,
        gen_kwargs: dict,
        model_id: str,
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
        deadline: Optional[float] = None,
    ) -> Generator[Tuple[np.ndarray, int, float], None, None]:
        """Yield each generate() part as soon as it exists. Do not concatenate."""
        stop_at = deadline if deadline is not None else time.perf_counter() + GEN_TIMEOUT

        def _consume(kwargs: dict) -> Generator[Tuple[np.ndarray, int, float], None, None]:
            for result in model.generate(**kwargs):
                if self._cancel.is_set() or (cancel_check and cancel_check()):
                    raise http_exception(499, ErrorCode.STREAM_CANCELLED, "Generation cancelled")
                if time.perf_counter() > stop_at:
                    raise http_exception(504, ErrorCode.GENERATION_TIMEOUT, f"Exceeded {GEN_TIMEOUT}s")
                audio = to_f32(result.audio)
                if audio.size == 0:
                    continue
                yield (
                    audio,
                    int(result.sample_rate),
                    float(getattr(result, "real_time_factor", 0.0) or 0.0),
                )

        try:
            yield from _consume(gen_kwargs)
        except HTTPException:
            raise
        except Exception as exc:
            if model_id == "kokoro" and "broadcast_shapes" in str(exc):
                chunks = split_kokoro_chunks(gen_kwargs.get("text", ""))
                if len(chunks) > 1:
                    for chunk in chunks:
                        yield from _consume({**gen_kwargs, "text": chunk})
                else:
                    raise http_exception(500, ErrorCode.GENERATION_FAILED, str(exc))
            else:
                raise http_exception(500, ErrorCode.GENERATION_FAILED, str(exc))

    def _generate_parts(self, model, gen_kwargs: dict, model_id: str) -> Tuple[np.ndarray, int, float]:
        parts: List[np.ndarray] = []
        sr: Optional[int] = None
        rtf = 0.0
        for audio, part_sr, part_rtf in self._iter_audio_results(model, gen_kwargs, model_id):
            if sr is None:
                sr = part_sr
                rtf = part_rtf
            parts.append(audio)

        if not parts:
            raise http_exception(500, ErrorCode.GENERATION_FAILED, "No audio generated")

        audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
        return audio, sr or 24000, rtf

    def _apply_requested_speed(self, audio: np.ndarray, speed: float, sample_rate: int, *, native: bool) -> np.ndarray:
        if native or audio.size == 0 or abs(float(speed) - 1.0) < 1e-3:
            return audio
        return time_stretch(audio, speed, sample_rate)

    def _pack_audio_frame(self, idx: int, audio: np.ndarray, sr: int, speed: float, **extra) -> bytes:
        wav = encode_wav(audio, sr)
        return pack_frame({
            "index": idx,
            "sample_rate": sr,
            "speed": speed,
            "apply_playback_rate": False,
            "playback_rate": 1.0,
            "final": False,
            **extra,
        }, wav)

    def generate_full(
        self,
        model_id: str,
        text: str,
        voice: str,
        speed: float,
        *,
        language: str = "Auto",
        instruct: Optional[str] = None,
        fmt: AudioFormat = AudioFormat.WAV,
    ) -> Tuple[bytes, str, dict]:
        acquired = self._operation_lock.acquire(timeout=self._operation_lock_timeout)
        if not acquired:
            raise http_exception(503, ErrorCode.GPU_BUSY, "GPU busy")

        try:
            self._cancel.clear()
            if self.model_id != model_id or self.model is None:
                self.load(model_id)
            self.ensure_ready()

            self.state = ModelState.GENERATING
            gen_kwargs, _ = build_gen_kwargs(
                model_id, text, voice, speed, self.voices(model_id),
                language=language, instruct=instruct,
            )
            audio, sr, rtf = self._generate_parts(self.model, gen_kwargs, model_id)
            audio = self._apply_requested_speed(
                audio, speed, sr,
                native=MODEL_REGISTRY.get(model_id, {}).get("supports_native_speed", False),
            )
            audio_bytes, mime = encode_audio(audio, sr, fmt)
            self.state = ModelState.READY
            meta = {"sample_rate": sr, "rtf": rtf, "model_id": model_id}
            return audio_bytes, mime, meta
        finally:
            if self.state == ModelState.GENERATING:
                self.state = ModelState.READY if self.model else ModelState.FAILED
            self._operation_lock.release()

    def generate_batch(
        self,
        model_id: str,
        texts: List[str],
        voice: str,
        speed: float,
        *,
        language: str = "Auto",
        instruct: Optional[str] = None,
        fmt: AudioFormat = AudioFormat.WAV,
    ) -> List[dict]:
        acquired = self._operation_lock.acquire(
            timeout=min(self._operation_lock_timeout, max(60, len(texts) * 10))
        )
        if not acquired:
            raise http_exception(503, ErrorCode.GPU_BUSY, "GPU busy")

        results: List[dict] = []
        try:
            self._cancel.clear()
            if self.model_id != model_id or self.model is None:
                self.load(model_id)

            self.ensure_ready()
            self.state = ModelState.GENERATING

            for idx, text in enumerate(texts):
                try:
                    gen_kwargs, _ = build_gen_kwargs(
                        model_id, text, voice, speed, self.voices(model_id),
                        language=language, instruct=instruct,
                    )
                    audio, sr, rtf = self._generate_parts(self.model, gen_kwargs, model_id)
                    audio = self._apply_requested_speed(
                        audio, speed, sr,
                        native=MODEL_REGISTRY.get(model_id, {}).get("supports_native_speed", False),
                    )
                    audio_bytes, _ = encode_audio(audio, sr, fmt)
                    results.append({
                        "index": idx,
                        "audio_base64": base64.b64encode(audio_bytes).decode(),
                        "rtf": rtf,
                    })
                except HTTPException as exc:
                    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                    results.append({"index": idx, "error": detail.get("message", str(exc.detail)), "code": detail.get("code")})
                except Exception as exc:
                    results.append({"index": idx, "error": str(exc), "code": ErrorCode.GENERATION_FAILED.value})

            self.state = ModelState.READY
            return results
        finally:
            # Never leave the coordinator stuck in GENERATING after an unexpected
            # failure (for example encode errors outside the per-item handlers).
            if self.state == ModelState.GENERATING:
                self.state = ModelState.READY if self.model else ModelState.FAILED
            self._operation_lock.release()

    def stream_batch_frames(
        self,
        model_id: str,
        texts: List[str],
        voice: str,
        speed: float,
        *,
        language: str = "Auto",
        instruct: Optional[str] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Generator[bytes, None, None]:
        reg = MODEL_REGISTRY.get(model_id, {})
        supports_stream = reg.get("supports_streaming", True)
        supports_native = reg.get("supports_native_speed", False)

        acquired = self._operation_lock.acquire(timeout=120)
        if not acquired:
            yield pack_frame({"index": 0, "error": "GPU busy", "code": ErrorCode.GPU_BUSY.value})
            return

        try:
            self._cancel.clear()
            try:
                if self.model_id != model_id or self.model is None:
                    self.load(model_id)
                self.ensure_ready()
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                yield pack_frame({
                    "index": 0,
                    "error": detail.get("message", str(exc.detail)),
                    "code": detail.get("code", ErrorCode.MODEL_NOT_READY.value),
                })
                return

            self.state = ModelState.GENERATING

            for idx, text in enumerate(texts):
                if cancel_check and cancel_check():
                    self._cancel.set()
                    yield pack_frame({"index": idx, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
                    return

                deadline = time.perf_counter() + GEN_TIMEOUT
                slices = (
                    split_stream_text(text, STREAM_FIRST_CHUNK_CHARS, STREAM_REST_CHUNK_CHARS)
                    if supports_stream
                    else [text]
                )

                try:
                    if supports_stream:
                        for slice_text in slices:
                            gen_kwargs, _ = build_gen_kwargs(
                                model_id, slice_text, voice, speed, self.voices(model_id),
                                language=language, instruct=instruct,
                                stream=True,
                                streaming_interval=STREAMING_INTERVAL,
                            )
                            if not supports_native:
                                gen_kwargs["speed"] = 1.0
                            pending: List[np.ndarray] = []
                            pending_sr = 24000
                            min_samples = 0
                            for audio, sr, _rtf in self._iter_audio_results(
                                self.model,
                                gen_kwargs,
                                model_id,
                                cancel_check=cancel_check,
                                deadline=deadline,
                            ):
                                pending.append(audio)
                                pending_sr = sr
                                if min_samples == 0:
                                    min_samples = max(int(sr * 0.05), 64)
                                if sum(part.size for part in pending) < min_samples:
                                    continue
                                merged = np.concatenate(pending) if len(pending) > 1 else pending[0]
                                pending = []
                                yield self._pack_audio_frame(
                                    idx,
                                    self._apply_requested_speed(merged, speed, pending_sr, native=supports_native),
                                    pending_sr,
                                    speed,
                                )
                            if pending:
                                merged = np.concatenate(pending) if len(pending) > 1 else pending[0]
                                yield self._pack_audio_frame(
                                    idx,
                                    self._apply_requested_speed(merged, speed, pending_sr, native=supports_native),
                                    pending_sr,
                                    speed,
                                )
                    else:
                        gen_kwargs, _ = build_gen_kwargs(
                            model_id, text, voice, speed, self.voices(model_id),
                            language=language, instruct=instruct,
                            stream=False,
                        )
                        if not supports_native:
                            gen_kwargs["speed"] = 1.0
                        audio, sr, _ = self._generate_parts(self.model, gen_kwargs, model_id)
                        audio = self._apply_requested_speed(audio, speed, sr, native=supports_native)
                        yield self._pack_audio_frame(idx, audio, sr, speed, fallback="non-streaming")

                    yield pack_frame({"index": idx, "final": True})
                except HTTPException as exc:
                    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                    yield pack_frame({
                        "index": idx,
                        "error": detail.get("message", str(exc.detail)),
                        "code": detail.get("code", ErrorCode.GENERATION_FAILED.value),
                    })
                except Exception as exc:
                    yield pack_frame({"index": idx, "error": str(exc), "code": ErrorCode.GENERATION_FAILED.value})

            self.state = ModelState.READY
        finally:
            if self.state == ModelState.GENERATING:
                self.state = ModelState.READY if self.model else ModelState.FAILED
            self._operation_lock.release()


coordinator = ModelCoordinator()