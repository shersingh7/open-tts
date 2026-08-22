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

    Output length is ``round(N / speed)`` so 2.5x is ~1/2.5 of 1x. First and
    last windows are not faded to silence, which was causing sentence clicks.
    """
    x = to_f32(audio).reshape(-1)
    rate = float(speed)
    if x.size < 2 or abs(rate - 1.0) < 1e-3:
        return x
    rate = min(max(rate, 0.5), 3.0)
    expected = max(1, int(round(x.size / rate)))
    if expected == x.size:
        return x.copy()

    win = int(round(sample_rate * 0.02)) or 32
    if win % 2:
        win += 1
    max_win = max(8, (min(x.size, expected) // 2) & ~1)
    win = min(win, max(8, max_win))
    if win % 2:
        win += 1
    if x.size < win or expected < win:
        idx = np.linspace(0, x.size - 1, expected)
        return np.interp(idx, np.arange(x.size, dtype=np.float64), x).astype(np.float32)

    hop_out = max(1, win // 2)
    n_win = max(2, int(round((expected - win) / hop_out)) + 1)
    hann = np.hanning(win).astype(np.float32)
    out = np.zeros(expected, dtype=np.float32)
    weight = np.zeros(expected, dtype=np.float32)
    max_in = max(0, x.size - win)
    search = max(hop_out // 2, 4)
    prev = None

    for i in range(n_win):
        frac = i / (n_win - 1)
        in_pos = int(round(frac * max_in))
        write = min(int(round(frac * (expected - win))), expected - win)
        if prev is not None:
            target = prev[hop_out:]
            lo = max(0, in_pos - search)
            hi = min(max_in, in_pos + search)
            if hi >= lo and target.size:
                region = x[lo : hi + target.size]
                if region.size >= target.size:
                    corr = np.correlate(region, target, mode="valid")
                    in_pos = lo + int(np.argmax(corr))
        frame = x[in_pos : in_pos + win]
        if frame.size < win:
            frame = np.pad(frame, (0, win - frame.size))
        w = hann.copy()
        if i == 0:
            w[:hop_out] = 1.0
        if i == n_win - 1:
            w[hop_out:] = 1.0
        sl = slice(write, write + win)
        out[sl] += frame * w
        weight[sl] += w
        prev = frame

    nz = weight > 1e-6
    out[nz] /= weight[nz]
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
        self._carry_1x: Optional[np.ndarray] = None

    def _min_samples(self) -> int:
        # At 3x, 1.2s of 1x PCM is only 0.4s of playback and the next
        # generate overruns. Pack enough 1x so each emitted frame is about
        # phrase_seconds of listening time.
        seconds = self.phrase_seconds
        if not self.native and self.speed > 1.0:
            seconds = self.phrase_seconds * self.speed
        return max(int(self._sr * seconds), 64)

    def _speed(self, audio: np.ndarray) -> np.ndarray:
        if self.native or audio.size == 0 or abs(self.speed - 1.0) < 1e-3:
            return audio
        carry = self._carry_1x
        if carry is not None and carry.size:
            stretched = time_stretch(np.concatenate([carry, audio]), self.speed, self._sr)
            skip = min(stretched.size, max(0, int(round(carry.size / self.speed))))
            return stretched[skip:] if skip < stretched.size else stretched[-1:]
        return time_stretch(audio, self.speed, self._sr)

    def _crossfade(self, audio: np.ndarray, *, final: bool) -> Optional[np.ndarray]:
        xfade_s = self.xfade_seconds
        if not self.native and self.speed > 1.0:
            xfade_s = max(self.xfade_seconds, 0.015 * self.speed)
        n = max(1, int(round(self._sr * xfade_s)))
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
            carry_s = 0.03 * (self.speed if not self.native and self.speed > 1.0 else 1.0)
            n_carry = max(int(self._sr * carry_s), 1)
            self._carry_1x = merged[-n_carry:].copy() if merged.size else None
            if final:
                self._carry_1x = None
            return self._crossfade(stretched, final=final)
        if final and self._tail is not None:
            tail, self._tail = self._tail, None
            self._carry_1x = None
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