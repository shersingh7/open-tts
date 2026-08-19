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


def time_stretch(audio: np.ndarray, speed: float, sample_rate: int = 24000) -> np.ndarray:
    """Change duration by ``speed`` without changing pitch (WSOLA).

    ``playbackRate`` in Web Audio speeds *and* raises pitch, which makes
    Qwen/Fish voices cartoonish at 1.5x–2x. This keeps formants in place.

    Short stream grains used to return identity (1x). Window size now shrinks
    so every non-unity request still changes duration.
    """
    x = to_f32(audio).reshape(-1)
    rate = float(speed)
    if x.size < 2 or abs(rate - 1.0) < 1e-3:
        return x
    rate = min(max(rate, 0.5), 3.0)

    win = int(round(sample_rate * 0.02)) or 16
    if win % 2:
        win += 1
    max_win = max(8, x.size // 2)
    if max_win % 2:
        max_win -= 1
    win = min(win, max(8, max_win))
    if win % 2:
        win += 1
    if x.size < win:
        pad = np.pad(x, (0, win - x.size))
        stretched = time_stretch(pad, rate, sample_rate)
        expected = max(1, int(round(x.size / rate)))
        return stretched[:expected]

    hop_out = max(1, win // 2)
    hop_in = max(1, int(round(hop_out * rate)))
    search = max(hop_in // 2, 4)
    window = np.hanning(win).astype(np.float32)

    n_frames = 1 + max(0, (x.size - win) // hop_in)
    out = np.zeros(hop_out * n_frames + win, dtype=np.float32)
    weight = np.zeros_like(out)

    write = 0
    read = 0
    prev = x[:win]
    out[:win] += prev * window
    weight[:win] += window
    write += hop_out
    read += hop_in

    for _ in range(1, n_frames):
        target = prev[hop_out:]
        lo = max(0, read - search)
        hi = min(x.size - win, read + search)
        if hi < lo:
            break
        region = x[lo : hi + hop_out]
        if region.size < target.size:
            best = min(max(read, 0), max(0, x.size - win))
        else:
            corr = np.correlate(region, target, mode="valid")
            best = lo + int(np.argmax(corr))
        frame = x[best : best + win]
        if frame.size < win:
            frame = np.pad(frame, (0, win - frame.size))
        out[write : write + win] += frame * window
        weight[write : write + win] += window
        prev = frame
        write += hop_out
        read += hop_in

    nz = weight > 1e-6
    out[nz] /= weight[nz]
    expected = max(1, int(round(x.size / rate)))
    if out.size > expected:
        return out[:expected]
    if out.size < expected:
        return np.pad(out, (0, expected - out.size))
    return out


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