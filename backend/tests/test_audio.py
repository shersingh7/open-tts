from __future__ import annotations

import numpy as np

from open_tts.audio import PhraseStreamPacker, time_stretch


def test_time_stretch_short_grain_still_changes_duration():
    sr = 24000
    x = np.sin(2 * np.pi * 200.0 * np.arange(80, dtype=np.float32) / sr)
    y = time_stretch(x, 2.0, sr)
    assert y.size < x.size
    assert abs(y.size / x.size - 0.5) < 0.3


def test_time_stretch_identity_at_unity_speed():
    x = np.linspace(-0.4, 0.4, 2400, dtype=np.float32)
    y = time_stretch(x, 1.0, 24000)
    assert np.allclose(x, y)


def test_time_stretch_does_not_truncate_grain_tail():
    sr = 24000
    x = np.zeros(sr, dtype=np.float32)
    x[-1200:] = 0.85
    y = time_stretch(x, 2.0, sr)
    assert y.size > 0
    tail = y[int(y.size * 0.7) :]
    assert float(np.max(np.abs(tail))) > 0.2


def test_packer_emits_held_tail_when_next_phrase_shorter_than_xfade():
    sr = 24000
    xfade = 0.02
    packer = PhraseStreamPacker(
        speed=1.0, native=True, phrase_seconds=0.05, xfade_seconds=xfade,
    )
    first = np.linspace(0.1, 0.9, 2400, dtype=np.float32)
    short = np.linspace(0.2, 0.35, 100, dtype=np.float32)
    frames = []
    out = packer.push(first, sr)
    if out is not None:
        frames.append(out)
    out = packer.push(short, sr)
    if out is not None:
        frames.append(out)
    leftover = packer.flush(final=True)
    if leftover is not None:
        frames.append(leftover)
    joined = np.concatenate(frames)
    overlap = min(int(round(sr * xfade)), short.size)
    expected = first.size + short.size - overlap
    assert abs(joined.size - expected) <= 2, f"got {joined.size} expected ~{expected}"
    assert float(np.max(np.abs(np.diff(joined)))) < 0.15


def test_packer_3x_phrase_is_long_enough_to_avoid_underrun():
    sr = 24000
    packer = PhraseStreamPacker(speed=3.0, native=False, phrase_seconds=1.2, xfade_seconds=0.02)
    grain = np.full(800, 0.35, dtype=np.float32)
    frames = []
    for _ in range(160):
        out = packer.push(grain, sr)
        if out is not None:
            frames.append(out)
    leftover = packer.flush(final=True)
    if leftover is not None:
        frames.append(leftover)
    assert frames
    # Each non-final frame should be ~phrase_seconds of playback, not 1.2s/3.
    playback = frames[0].size / sr
    assert playback > 0.7, f"3x frame only {playback:.3f}s of playback"


def test_phrase_packer_constant_signal_has_no_join_holes():
    sr = 24000
    grain = np.full(400, 0.4, dtype=np.float32)
    packer = PhraseStreamPacker(speed=2.0, native=False, phrase_seconds=0.4, xfade_seconds=0.01)
    frames = []
    for _ in range(24):
        out = packer.push(grain, sr)
        if out is not None:
            frames.append(out)
    leftover = packer.flush(final=True)
    if leftover is not None:
        frames.append(leftover)
    joined = np.concatenate(frames)
    interior = joined[int(0.02 * sr) : max(int(0.02 * sr) + 1, joined.size - int(0.02 * sr))]
    zeros = np.abs(interior) < 0.05
    longest = 0
    run = 0
    for z in zeros:
        if z:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    assert longest < int(0.008 * (sr / 2.0) + 8)


def test_time_stretch_duration_tracks_speed_ratio():
    sr = 24000
    x = np.sin(2 * np.pi * 200.0 * np.arange(sr * 2, dtype=np.float32) / sr)
    for speed in (1.5, 2.0, 2.5, 3.0):
        y = time_stretch(x, speed, sr)
        expected = int(round(x.size / speed))
        assert y.size == expected, f"{speed}x got {y.size} expected {expected}"


def test_time_stretch_shortens_without_raising_pitch():
    sr = 24000
    t = np.arange(sr * 2, dtype=np.float32) / sr
    x = np.sin(2 * np.pi * 200.0 * t).astype(np.float32)
    y = time_stretch(x, 2.5, sr)

    assert y.size == int(round(x.size / 2.5))
    assert abs(y.size / x.size - 1 / 2.5) < 0.02

    def peak_hz(samples: np.ndarray) -> float:
        windowed = samples * np.hanning(samples.size)
        spec = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(samples.size, 1.0 / sr)
        return float(freqs[int(np.argmax(spec[1:])) + 1])

    pitched = peak_hz(y)
    assert abs(pitched - 200.0) < 40.0
    assert abs(pitched - 400.0) > 80.0
