"""Audio encoding helpers.

Native-speed PCM is sample-preserving concatenation. Non-native speed uses a
single WSOLA time-stretch on a bounded semantic unit. Speed=1 is identity.
This module does not insert silence, fades, overlap-add, or amplitude
normalization at transport or generation-unit boundaries.
"""

from __future__ import annotations

import io
from typing import List, Optional, Tuple

import numpy as np
import soundfile as sf

from .config import CLIENT_DECODED_BYTE_CAP, STREAM_MAX_EMIT_SECONDS, STREAM_PHRASE_SECONDS, AudioFormat
from .errors import AudioValidationError, ErrorCode, http_exception


def to_f32(arr) -> np.ndarray:
    if hasattr(arr, "dtype") and arr.dtype == np.float32 and isinstance(arr, np.ndarray):
        return arr
    return np.asarray(arr, dtype=np.float32)


def as_mono_pcm(arr) -> np.ndarray:
    """Return 1-D finite float32 PCM. Stereo is rejected, not interleaved."""
    x = to_f32(arr)
    if x.size == 0:
        return np.zeros(0, dtype=np.float32)
    if x.ndim == 0:
        raise AudioValidationError("PCM must be an array of samples")
    if x.ndim == 2:
        if 1 in x.shape:
            x = x.reshape(-1)
        else:
            raise AudioValidationError("multi-channel PCM is not supported")
    elif x.ndim != 1:
        raise AudioValidationError(f"invalid PCM shape {x.shape}")
    if not np.isfinite(x).all():
        raise AudioValidationError("PCM contains nonfinite samples")
    return np.ascontiguousarray(x, dtype=np.float32)


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def time_stretch(audio: np.ndarray, speed: float, sample_rate: int = 24000) -> np.ndarray:
    """Change duration by ``speed`` without changing pitch (WSOLA).

    Output length is ``round(N / speed)``. Speed=1 is an exact identity.
    Short crumbs reduce the analysis window rather than using linear
    interpolation, which would pitch-shift speech.
    """
    x = as_mono_pcm(audio)
    rate = float(speed)
    if x.size < 2 or abs(rate - 1.0) < 1e-3:
        return x
    if not np.isfinite(rate) or not 0.5 <= rate <= 3.0:
        raise AudioValidationError("invalid speed")
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
        win = max(8, (min(x.size, expected) // 2) * 2)
        if win % 2:
            win += 1
    if x.size < win or expected < win:
        # Sub-millisecond crumbs have no meaningful pitch period; nearest-sample
        # resampling is limited to this exceptional short-input case.
        idx = np.round(np.linspace(0, x.size - 1, expected)).astype(np.int64)
        return x[idx]

    hop_out = max(1, win // 2)
    n_win = max(2, int(np.ceil((expected - win) / hop_out)) + 1)
    hann = np.hanning(win).astype(np.float32)
    out = np.zeros(expected, dtype=np.float32)
    weight = np.zeros(expected, dtype=np.float32)
    max_in = max(0, x.size - win)
    search = max(hop_out // 2, 4)
    prev = None
    prev_write = 0

    for i in range(n_win):
        frac = i / (n_win - 1)
        in_pos = int(round(frac * max_in))
        write = min(i * hop_out, expected - win)
        actual_hop = write - prev_write if prev is not None else hop_out
        if prev is not None:
            target = prev[actual_hop:]
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
        prev_write = write

    nz = weight > 1e-6
    out[nz] /= weight[nz]
    return out


class PhraseStreamPacker:
    """Accumulate 1x PCM to a phrase-sized unit, then emit processed audio.

    Native speed and speed=1 concatenate input samples exactly. Non-native
    speed runs one WSOLA pass on the accumulated unit. Adjacent units are
    concatenated with no overlap, fade, or amplitude normalization.
    """

    def __init__(
        self,
        *,
        speed: float,
        native: bool,
        phrase_seconds: float = STREAM_PHRASE_SECONDS,
        xfade_seconds: float = 0.0,
        max_emit_seconds: float = STREAM_MAX_EMIT_SECONDS,
        max_decoded_bytes: int = CLIENT_DECODED_BYTE_CAP,
    ):
        self.speed = float(speed)
        self.native = bool(native)
        self.phrase_seconds = float(phrase_seconds)
        self.xfade_seconds = float(xfade_seconds)  # retained for callers; unused
        self.max_emit_seconds = float(max_emit_seconds)
        self.max_decoded_bytes = int(max_decoded_bytes)
        self._parts: List[np.ndarray] = []
        self._sr: Optional[int] = None
        self._part_samples = 0
        self._pending: List[np.ndarray] = []

    def _min_samples(self) -> int:
        sr = self._sr or 24000
        seconds = self.phrase_seconds
        if not self.native and self.speed > 1.0:
            seconds = self.phrase_seconds * self.speed
        return max(int(sr * seconds), 64)

    def _max_emit_samples(self) -> int:
        sr = self._sr or 24000
        by_time = max(int(sr * self.max_emit_seconds), 64)
        by_bytes = max(self.max_decoded_bytes // 4, 64)
        return min(by_time, by_bytes)

    def _identity(self) -> bool:
        return self.native or abs(self.speed - 1.0) < 1e-3

    def _process(self, audio: np.ndarray) -> np.ndarray:
        if audio.size == 0 or self._identity():
            return audio
        return time_stretch(audio, self.speed, self._sr or 24000)

    def _accept_rate(self, sample_rate: int) -> int:
        sr = int(sample_rate)
        if sr < 8000 or sr > 192000:
            raise AudioValidationError("invalid sample rate")
        if self._sr is None:
            self._sr = sr
        elif sr != self._sr:
            raise AudioValidationError("mid-stream sample rate change")
        return sr

    def _queue_processed(self, processed: np.ndarray) -> None:
        if processed.size == 0:
            return
        cap = self._max_emit_samples()
        if processed.size <= cap:
            self._pending.append(processed)
            return
        for i in range(0, processed.size, cap):
            piece = processed[i : i + cap]
            if piece.size:
                self._pending.append(piece)

    def take(self) -> Optional[np.ndarray]:
        if not self._pending:
            return None
        return self._pending.pop(0)

    def take_all(self) -> List[np.ndarray]:
        out = self._pending
        self._pending = []
        return out

    def push(self, audio: np.ndarray, sample_rate: int) -> Optional[np.ndarray]:
        chunk = as_mono_pcm(audio)
        if chunk.size == 0:
            return self.take()
        self._accept_rate(sample_rate)
        self._part_samples += chunk.size
        if not self._identity() and self._part_samples * 4 > 32 * 1024 * 1024:
            raise AudioValidationError("semantic audio unit exceeds 32 MiB; use shorter text units")
        self._parts.append(chunk)
        if self._identity() and self._part_samples >= self._min_samples():
            merged = np.concatenate(self._parts) if len(self._parts) > 1 else self._parts[0]
            self._parts = []
            self._part_samples = 0
            self._queue_processed(self._process(merged))
        return self.take()

    def flush(self, final: bool = True) -> Optional[np.ndarray]:
        if self._parts:
            merged = np.concatenate(self._parts) if len(self._parts) > 1 else self._parts[0]
            self._parts = []
            self._part_samples = 0
            self._queue_processed(self._process(merged))
        return self.take()

    def drain(self) -> List[np.ndarray]:
        first = self.flush(final=True)
        rest = self.take_all()
        if first is None:
            return rest
        return [first, *rest]


def encode_audio(audio: np.ndarray, sample_rate: int, fmt: AudioFormat) -> Tuple[bytes, str]:
    if fmt == AudioFormat.WAV:
        return encode_wav(as_mono_pcm(audio), sample_rate), fmt.mime_type

    try:
        from mlx_audio.audio_io import write as audio_write

        buf = io.BytesIO()
        audio_write(buf, as_mono_pcm(audio), sample_rate, format=fmt.value)
        return buf.getvalue(), fmt.mime_type
    except AudioValidationError:
        raise
    except Exception as exc:
        raise http_exception(
            500,
            ErrorCode.FORMAT_ENCODE_FAILED,
            f"Failed to encode audio as {fmt.value}",
            format=fmt.value,
            detail=str(exc),
        )
