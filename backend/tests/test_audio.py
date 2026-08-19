from __future__ import annotations

import numpy as np

from open_tts.audio import time_stretch


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


def test_time_stretch_shortens_without_raising_pitch():
    sr = 24000
    t = np.arange(sr * 2, dtype=np.float32) / sr
    x = np.sin(2 * np.pi * 200.0 * t).astype(np.float32)
    y = time_stretch(x, 2.0, sr)

    assert y.size < x.size
    assert abs(y.size / x.size - 0.5) < 0.2

    def peak_hz(samples: np.ndarray) -> float:
        windowed = samples * np.hanning(samples.size)
        spec = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(samples.size, 1.0 / sr)
        return float(freqs[int(np.argmax(spec[1:])) + 1])

    pitched = peak_hz(y)
    assert abs(pitched - 200.0) < 40.0
    assert abs(pitched - 400.0) > 80.0
