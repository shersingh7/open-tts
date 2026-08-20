"""Audio encoding helpers."""

from __future__ import annotations

import io
from typing import List, Optional, Tuple

import numpy as np
import soundfile as sf

from .config import STREAM_PHRASE_SECONDS, STREAM_XFADE_SECONDS, AudioFormat
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
    used = np.flatnonzero(weight > 1e-6)
    if used.size:
        return out[int(used[0]) : int(used[-1]) + 1]
    return out


class PhraseStreamPacker:
    """Accumulate 1x PCM to a phrase, apply speed once, crossfade joins.

    Independent WSOLA on word-sized grains fades every edge to silence.
    This packer is the single stretch/join path the stream coordinator uses.
    """

    def __init__(
        self,
        *,
        speed: float,
        native: bool,
        phrase_seconds: float = STREAM_PHRASE_SECONDS,
        xfade_seconds: float = STREAM_XFADE_SECONDS,
    ):
        self.speed = float(speed)
        self.native = bool(native)
        self.phrase_seconds = float(phrase_seconds)
        self.xfade_seconds = float(xfade_seconds)
        self._parts: List[np.ndarray] = []
        self._sr = 24000
        self._tail: Optional[np.ndarray] = None

    def _min_samples(self) -> int:
        return max(int(self._sr * self.phrase_seconds), 64)

    def _speed(self, audio: np.ndarray) -> np.ndarray:
        if self.native or audio.size == 0 or abs(self.speed - 1.0) < 1e-3:
            return audio
        return time_stretch(audio, self.speed, self._sr)

    def _crossfade(self, audio: np.ndarray, *, final: bool) -> Optional[np.ndarray]:
        n = max(1, int(round(self._sr * self.xfade_seconds)))
        if self._tail is None:
            if final or audio.size <= n:
                return audio
            self._tail = audio[-n:].copy()
            return audio[:-n]
        xfade = min(n, self._tail.size, audio.size)
        t = np.linspace(0.0, 1.0, xfade, dtype=np.float32)
        fade_out = np.cos(t * np.pi / 2.0)
        fade_in = np.sin(t * np.pi / 2.0)
        prefix = self._tail[:-xfade] if xfade < self._tail.size else self._tail[:0]
        overlap = self._tail[-xfade:]
        mixed = overlap * fade_out + audio[:xfade] * fade_in
        rest_audio = audio[xfade:]
        pieces = []
        if prefix.size:
            pieces.append(prefix)
        pieces.append(mixed)
        if rest_audio.size:
            pieces.append(rest_audio)
        body = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
        self._tail = None
        if final or body.size <= n:
            return body
        self._tail = body[-n:].copy()
        return body[:-n]

    def push(self, audio: np.ndarray, sample_rate: int) -> Optional[np.ndarray]:
        chunk = to_f32(audio).reshape(-1)
        if chunk.size == 0:
            return None
        self._sr = int(sample_rate) or 24000
        self._parts.append(chunk)
        if sum(part.size for part in self._parts) < self._min_samples():
            return None
        return self.flush(final=False)

    def flush(self, final: bool = True) -> Optional[np.ndarray]:
        if self._parts:
            merged = np.concatenate(self._parts) if len(self._parts) > 1 else self._parts[0]
            self._parts = []
            stretched = self._speed(merged)
            return self._crossfade(stretched, final=final)
        if final and self._tail is not None:
            tail, self._tail = self._tail, None
            return tail
        return None


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