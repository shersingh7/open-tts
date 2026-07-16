"""Audio encoding helpers."""

from __future__ import annotations

import io
from typing import Tuple

import numpy as np
import soundfile as sf

from .config import AudioFormat
from .errors import ErrorCode, http_exception


def to_f32(arr) -> np.ndarray:
    if hasattr(arr, "dtype") and arr.dtype == np.float32 and isinstance(arr, np.ndarray):
        return arr
    return np.asarray(arr, dtype=np.float32)


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def encode_audio(audio: np.ndarray, sample_rate: int, fmt: AudioFormat) -> Tuple[bytes, str]:
    if fmt == AudioFormat.WAV:
        return encode_wav(audio, sample_rate), fmt.mime_type

    try:
        from mlx_audio.audio_io import write as audio_write

        buf = io.BytesIO()
        audio_write(buf, audio, sample_rate, format=fmt.value)
        return buf.getvalue(), fmt.mime_type
    except Exception as exc:
        raise http_exception(
            500,
            ErrorCode.FORMAT_ENCODE_FAILED,
            f"Failed to encode audio as {fmt.value}",
            format=fmt.value,
            detail=str(exc),
        )