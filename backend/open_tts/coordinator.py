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

from .adapters import build_gen_kwargs, get_model_voices, split_kokoro_chunks
from .audio import PhraseStreamPacker, as_mono_pcm, encode_audio, encode_wav, time_stretch
from .errors import AudioValidationError, ErrorCode, http_exception
from .config import (
    BACKEND_DIR,
    DEFAULT_MODEL,
    GEN_TIMEOUT,
    STREAMING_INTERVAL,
    WARMUP_TEXT,
    AudioFormat,
)
from .protocol import pack_frame
from .text import plan_generation_units
from .runtime import check_job
from .config import MAX_BATCH_OUTPUT_BYTES, MAX_FULL_PCM_BYTES
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
            "model_warm": state in (ModelState.READY, ModelState.GENERATING),
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
        check_job()
        if model_id not in MODEL_REGISTRY:
            raise http_exception(404, ErrorCode.MODEL_NOT_FOUND, f"Unknown model: {model_id}")

        acquired = self._operation_lock.acquire(blocking=False)
        if not acquired:
            if (
                not force
                and self.model_id == model_id
                and self.model is not None
                and not self.load_error
                and self.state in (ModelState.READY, ModelState.GENERATING, ModelState.WARMING, ModelState.LOADED)
            ):
                return {"model": model_id, "state": self.state.value, "voices": self.voices(model_id)}

            acquired = self._operation_lock.acquire(timeout=self._operation_lock_timeout)
            if not acquired:
                raise http_exception(503, ErrorCode.GPU_BUSY, "Coordinator busy")

        try:
            if (
                not force
                and self.model_id == model_id
                and self.model is not None
                and not self.load_error
                and self.state in (ModelState.READY, ModelState.GENERATING, ModelState.WARMING, ModelState.LOADED)
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
            check_job()
            warmup = self.model.generate(**kwargs)
            try:
                next(warmup)
            finally:
                warmup.close()
            check_job()
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
            if self._cancel.is_set() or (cancel_check and cancel_check()):
                raise http_exception(499, ErrorCode.STREAM_CANCELLED, "Generation cancelled")
            nonlocal stop_at
            def check():
                check_job()
                if self._cancel.is_set() or (cancel_check and cancel_check()):
                    raise http_exception(499, ErrorCode.STREAM_CANCELLED, "Generation cancelled")
                if time.perf_counter() > stop_at:
                    raise http_exception(504, ErrorCode.GENERATION_TIMEOUT, f"Exceeded {GEN_TIMEOUT}s")

            check()
            iterator = iter(model.generate(**kwargs))
            try:
                while True:
                    check()
                    started = time.perf_counter()
                    try:
                        result = next(iterator)
                    except StopIteration:
                        check()
                        return
                    check()
                    count = getattr(result, "token_count", 0) or 0
                    if getattr(result, "finish_reason", None) in ("length", "max_tokens") or (
                        kwargs.get("max_tokens") and count >= kwargs["max_tokens"]
                    ):
                        raise http_exception(422, ErrorCode.GENERATION_FAILED, "Output token limit reached; passage may be incomplete")
                    audio = as_mono_pcm(result.audio)
                    if audio.size == 0:
                        continue
                    sr = int(result.sample_rate)
                    if sr < 8000 or sr > 192000:
                        raise http_exception(500, ErrorCode.AUDIO_INVALID, "invalid sample rate")
                    rtf = (time.perf_counter() - started) / (audio.size / sr)
                    paused_at = time.perf_counter()
                    yield audio, sr, rtf
                    # Time blocked by HTTP/playback backpressure is not inference.
                    stop_at += time.perf_counter() - paused_at
            finally:
                close = getattr(iterator, "close", None)
                if close:
                    close()

        yielded = False
        try:
            for item in _consume(gen_kwargs):
                yielded = True
                yield item
        except HTTPException:
            raise
        except AudioValidationError as exc:
            raise http_exception(500, ErrorCode.AUDIO_INVALID, str(exc))
        except Exception as exc:
            if (
                model_id == "kokoro"
                and "broadcast_shapes" in str(exc)
                and not yielded
            ):
                chunks = split_kokoro_chunks(gen_kwargs.get("text", ""))
                if len(chunks) > 1:
                    for chunk in chunks:
                        yield from _consume({**gen_kwargs, "text": chunk})
                    return
            raise http_exception(500, ErrorCode.GENERATION_FAILED, str(exc))

    def _generate_parts(self, model, gen_kwargs: dict, model_id: str) -> Tuple[np.ndarray, int, float]:
        parts: List[np.ndarray] = []
        sr: Optional[int] = None
        rtf = 0.0
        sample_bytes = 0
        generation_seconds = audio_seconds = 0.0
        for audio, part_sr, part_rtf in self._iter_audio_results(model, gen_kwargs, model_id):
            if sr is None:
                sr = part_sr
                rtf = part_rtf
            elif int(part_sr) != int(sr):
                raise http_exception(500, ErrorCode.AUDIO_INVALID, "mid-stream sample rate change")
            generation_seconds += part_rtf * audio.size / part_sr
            audio_seconds += audio.size / part_sr
            sample_bytes += audio.nbytes
            if sample_bytes > 32 * 1024 * 1024:
                raise http_exception(500, ErrorCode.AUDIO_INVALID, "Semantic audio exceeds 32 MiB")
            parts.append(as_mono_pcm(audio))

        if not parts:
            raise http_exception(500, ErrorCode.GENERATION_FAILED, "No audio generated")

        audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
        return audio, sr or 24000, generation_seconds / audio_seconds

    def _synthesize_pcm(self, model, gen_kwargs: dict, model_id: str, speed: float):
        """Full responses use the same bounded semantic/speed units as streaming."""
        outputs = []
        sr = None
        total_bytes = 0
        generation_seconds = audio_seconds = 0.0
        rtf = 0.0
        native = MODEL_REGISTRY.get(model_id, {}).get("supports_native_speed", False)
        for unit in plan_generation_units(gen_kwargs["text"], model_id):
            check_job()
            pcm, rate, rtf = self._generate_parts(model, {**gen_kwargs, "text": unit.text}, model_id)
            if sr is not None and sr != rate:
                raise http_exception(500, ErrorCode.AUDIO_INVALID, "mid-stream sample rate change")
            sr = rate
            generation_seconds += rtf * pcm.size / rate
            pcm = self._apply_requested_speed(pcm, speed, rate, native=native)
            audio_seconds += pcm.size / rate
            total_bytes += pcm.nbytes
            if total_bytes > MAX_FULL_PCM_BYTES:
                raise http_exception(413, ErrorCode.AUDIO_INVALID, "Full audio exceeds 128 MiB; use streaming")
            outputs.append(pcm)
        if not outputs:
            raise http_exception(500, ErrorCode.GENERATION_FAILED, "No audio generated")
        assert sr is not None
        return np.concatenate(outputs) if len(outputs) > 1 else outputs[0], sr, generation_seconds / audio_seconds

    def _apply_requested_speed(self, audio: np.ndarray, speed: float, sample_rate: int, *, native: bool) -> np.ndarray:
        pcm = as_mono_pcm(audio)
        if native or pcm.size == 0 or abs(float(speed) - 1.0) < 1e-3:
            return pcm
        return time_stretch(pcm, speed, sample_rate)

    def _pack_audio_frame(self, idx: int, audio: np.ndarray, sr: int, speed: float, **extra) -> bytes:
        wav = encode_wav(audio, sr)
        return pack_frame({
            "index": idx,
            "sample_rate": sr,
            "speed": speed,
            "apply_playback_rate": False,
            "playback_rate": 1.0,
            "final": False,
            "samples": int(audio.size),
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
            audio, sr, rtf = self._synthesize_pcm(self.model, gen_kwargs, model_id, speed)
            audio_bytes, mime = encode_audio(audio, sr, fmt)
            self.state = ModelState.READY
            meta = {"sample_rate": sr, "rtf": rtf, "model_id": model_id}
            return audio_bytes, mime, meta
        except AudioValidationError as exc:
            raise http_exception(500, ErrorCode.AUDIO_INVALID, str(exc))
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
        output_bytes = 0
        try:
            self._cancel.clear()
            if self.model_id != model_id or self.model is None:
                self.load(model_id)

            self.ensure_ready()
            self.state = ModelState.GENERATING

            for idx, text in enumerate(texts):
                check_job()
                try:
                    gen_kwargs, _ = build_gen_kwargs(
                        model_id, text, voice, speed, self.voices(model_id),
                        language=language, instruct=instruct,
                    )
                    audio, sr, rtf = self._synthesize_pcm(self.model, gen_kwargs, model_id, speed)
                    audio_bytes, _ = encode_audio(audio, sr, fmt)
                    output_bytes += ((len(audio_bytes) + 2) // 3) * 4
                    if output_bytes > MAX_BATCH_OUTPUT_BYTES:
                        raise http_exception(413, ErrorCode.BATCH_TOO_LARGE, "Batch audio exceeds memory budget; use streaming")
                    results.append({
                        "index": idx,
                        "audio_base64": base64.b64encode(audio_bytes).decode(),
                        "rtf": rtf,
                    })
                except HTTPException as exc:
                    if exc.status_code in (413, 499, 504):
                        raise
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
        protocol_version: int = 1,
    ) -> Generator[bytes, None, None]:
        stream_started = time.perf_counter()
        first_pcm_seconds = None
        reg = MODEL_REGISTRY.get(model_id, {})
        supports_stream = reg.get("supports_streaming", True)
        supports_native = reg.get("supports_native_speed", False)
        frame_meta = {} if supports_stream else {"fallback": "non-streaming"}

        if cancel_check and cancel_check():
            yield pack_frame({"index": 0, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
            return

        lock_deadline = time.monotonic() + self._operation_lock_timeout
        acquired = False
        while not acquired and time.monotonic() < lock_deadline:
            if cancel_check and cancel_check():
                yield pack_frame({"index": 0, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
                return
            acquired = self._operation_lock.acquire(timeout=min(0.1, max(0, lock_deadline - time.monotonic())))
        if not acquired:
            yield pack_frame({"index": 0, "error": "GPU busy", "code": ErrorCode.GPU_BUSY.value})
            return

        try:
            if cancel_check and cancel_check():
                yield pack_frame({"index": 0, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
                return
            self._cancel.clear()
            try:
                if cancel_check and cancel_check():
                    yield pack_frame({"index": 0, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
                    return
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

            if cancel_check and cancel_check():
                yield pack_frame({"index": 0, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
                return
            self.state = ModelState.GENERATING

            model_ready_seconds = time.perf_counter() - stream_started
            next_unit_id = 0
            for idx, text in enumerate(texts):
                if cancel_check and cancel_check():
                    self._cancel.set()
                    yield pack_frame({"index": idx, "error": "cancelled", "code": ErrorCode.STREAM_CANCELLED.value})
                    return

                units = plan_generation_units(text, model_id, transport_index=idx, first_unit_id=next_unit_id)
                next_unit_id += len(units)
                try:
                    packer = PhraseStreamPacker(speed=speed, native=supports_native)
                    packer_sr = 24000
                    emitted_any = False
                    for unit in units:
                        check_job()
                        frame_meta = ({} if supports_stream else {"fallback": "non-streaming"})
                        if protocol_version == 2:
                            frame_meta.update(unit_id=unit.unit_id, start=unit.start, end=unit.end)
                        gen_kwargs, _ = build_gen_kwargs(
                            model_id, unit.text, voice, speed, self.voices(model_id),
                            language=language, instruct=instruct,
                            stream=supports_stream, streaming_interval=STREAMING_INTERVAL,
                        )
                        unit_had_audio = False
                        unit_generation_seconds = 0.0
                        unit_processed_seconds = 0.0
                        for audio, sr, _rtf in self._iter_audio_results(
                            self.model, gen_kwargs, model_id, cancel_check=cancel_check,
                        ):
                            unit_had_audio = True
                            if first_pcm_seconds is None:
                                first_pcm_seconds = time.perf_counter() - stream_started
                            unit_generation_seconds += _rtf * audio.size / sr
                            if protocol_version == 2:
                                frame_meta.update(model_ready_seconds=model_ready_seconds, first_pcm_seconds=first_pcm_seconds)
                            packer_sr = sr
                            emitted = packer.push(audio, sr)
                            if emitted is not None:
                                emitted_any = True
                                unit_processed_seconds += emitted.size / sr
                                yield self._pack_audio_frame(idx, emitted, sr, speed, **frame_meta)
                            for extra in packer.take_all():
                                emitted_any = True
                                unit_processed_seconds += extra.size / sr
                                yield self._pack_audio_frame(idx, extra, sr, speed, **frame_meta)
                        if not unit_had_audio:
                            raise http_exception(500, ErrorCode.GENERATION_FAILED, "No audio generated for a text unit")
                        # Non-native speed is transformed once per semantic unit,
                        # independent of the model's transport packetization.
                        for emitted in packer.drain():
                            emitted_any = True
                            unit_processed_seconds += emitted.size / packer_sr
                            yield self._pack_audio_frame(idx, emitted, packer_sr, speed, **frame_meta)
                        if protocol_version == 2:
                            yield pack_frame({"index": idx, "unit_final": True, **frame_meta,
                                              "generation_seconds": unit_generation_seconds,
                                              "processed_audio_seconds": unit_processed_seconds,
                                              "normalized_rtf": unit_generation_seconds / unit_processed_seconds})
                    for emitted in packer.drain():
                        emitted_any = True
                        yield self._pack_audio_frame(idx, emitted, packer_sr, speed, **frame_meta)
                    if not emitted_any:
                        raise http_exception(500, ErrorCode.GENERATION_FAILED, "No audio generated")
                    yield pack_frame({"index": idx, "final": True})
                except HTTPException as exc:
                    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                    yield pack_frame({
                        "index": idx,
                        "error": detail.get("message", str(exc.detail)),
                        "code": detail.get("code", ErrorCode.GENERATION_FAILED.value),
                    })
                    return
                except AudioValidationError as exc:
                    yield pack_frame({"index": idx, "error": str(exc), "code": ErrorCode.AUDIO_INVALID.value})
                    return
                except Exception as exc:
                    yield pack_frame({"index": idx, "error": str(exc), "code": ErrorCode.GENERATION_FAILED.value})
                    return

            self.state = ModelState.READY
        finally:
            if self.state == ModelState.GENERATING:
                self.state = ModelState.READY if self.model else ModelState.FAILED
            self._operation_lock.release()


coordinator = ModelCoordinator()