from __future__ import annotations

import threading
import time

import numpy as np
import pytest
from fastapi import HTTPException

from open_tts.config import STREAMING_INTERVAL, AudioFormat
from open_tts.coordinator import ModelCoordinator, ModelState
from open_tts.errors import ErrorCode, http_exception


def test_serialized_load_warm_generate(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    assert coord.state == ModelState.READY
    audio, mime, meta = coord.generate_full("kokoro", "Hello", "af_bella", 1.0)
    assert audio
    assert mime == "audio/wav"
    assert coord.state == ModelState.READY


def test_model_switch_serializes(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    coord.load("qwen3-tts")
    assert coord.model_id == "qwen3-tts"
    assert coord.state == ModelState.READY


def test_warm_failure_state(monkeypatch):
    from tests.conftest import FakeModel

    class WarmFail(FakeModel):
        def generate(self, **kwargs):
            if kwargs.get("text") == "Warmup":
                raise RuntimeError("warm failed")
            return super().generate(**kwargs)

    monkeypatch.setattr("mlx_audio.tts.utils.load_model", lambda path: WarmFail("kokoro"))
    coord = ModelCoordinator()
    with pytest.raises(Exception):
        coord.load("kokoro")
    assert coord.state == ModelState.FAILED


def test_force_reload(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    fake_loader["kokoro"].fail_generate = True
    with pytest.raises(Exception):
        coord.generate_full("kokoro", "Hello", "af_bella", 1.0)
    result = coord.force_reload("kokoro")
    assert result["success"] is True
    assert coord.state == ModelState.READY


def test_concurrent_generate_is_serial(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    results = []

    def worker():
        audio, _, _ = coord.generate_full("kokoro", "Hello", "af_bella", 1.0)
        results.append(len(audio))

    threads = [threading.Thread(target=worker) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert len(results) == 3


def test_health_snapshot_never_waits_for_generation_lock():
    coord = ModelCoordinator()
    assert coord._operation_lock.acquire(timeout=1)
    try:
        started = time.perf_counter()
        snapshot = coord.snapshot()
        assert time.perf_counter() - started < 0.05
        assert snapshot["state"] == ModelState.UNLOADED.value
    finally:
        coord._operation_lock.release()


def test_generation_runtime_error_restores_ready_state(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    fake_loader["kokoro"].fail_generate = True
    with pytest.raises(HTTPException) as caught:
        coord.generate_full("kokoro", "Hello", "af_bella", 1.0)
    assert isinstance(caught.value.detail, dict)
    assert caught.value.detail["code"] == "generation_failed"
    assert coord.state == ModelState.READY


def test_pcm_mime_type_is_wav():
    assert AudioFormat.PCM.mime_type == "audio/wav"


def test_cancel_flag_is_cleared_for_next_generation(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    coord._cancel.set()
    audio, _, _ = coord.generate_full("kokoro", "Hello", "af_bella", 1.0)
    assert audio
    assert not coord._cancel.is_set()


def test_stream_load_failure_yields_error_frame_not_exception(monkeypatch):
    coord = ModelCoordinator()

    def boom(_model_id, **_kwargs):
        raise http_exception(503, ErrorCode.MODEL_NOT_READY, "Model not ready")

    monkeypatch.setattr(coord, "load", boom)
    frames = list(coord.stream_batch_frames("kokoro", ["Hello"], "af_bella", 1.0))
    assert frames
    from open_tts.protocol import unpack_frames

    parsed, _ = unpack_frames(frames[0])
    header, _audio = parsed[0]
    assert "error" in header
    assert header["code"] == "model_not_ready"
    assert coord.state != ModelState.GENERATING


def test_batch_restores_ready_after_generation(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    results = coord.generate_batch("kokoro", ["Hello", "World"], "af_bella", 1.0)
    assert len(results) == 2
    assert coord.state == ModelState.READY


def test_stream_batch_emits_first_frame_before_later_parts(fake_loader):
    """First playable frame is emitted before the remaining grains finish."""
    from open_tts.protocol import unpack_frames

    coord = ModelCoordinator()
    coord.load("kokoro")
    model = fake_loader["kokoro"]
    model.stream_parts = 20
    model.part_lengths = [2400] * 20

    first_audio = None
    later_at_first = None
    seen_final = False
    for raw in coord.stream_batch_frames("kokoro", ["Hello there streaming world."], "af_bella", 1.0):
        frames, _ = unpack_frames(raw)
        for header, audio in frames:
            if audio and first_audio is None:
                first_audio = audio
                later_at_first = model.parts_yielded
            if header.get("final"):
                seen_final = True

    assert first_audio, "expected an audio-bearing frame"
    assert first_audio[:4] == b"RIFF"
    assert later_at_first < 20, f"first frame waited for all grains: {later_at_first}"
    assert model.parts_yielded == 20
    assert seen_final


def test_non_streaming_model_yields_one_fallback_frame(fake_loader):
    from open_tts.protocol import unpack_frames

    coord = ModelCoordinator()
    coord.load("fish-s2-pro")
    fake_loader["fish-s2-pro"].stream_parts = 5
    frames = []
    for raw in coord.stream_batch_frames("fish-s2-pro", ["Hello from fish."], "whisper", 1.0):
        parsed, _ = unpack_frames(raw)
        frames.extend(parsed)

    audio_frames = [(h, a) for h, a in frames if a]
    assert len(audio_frames) == 1
    header, audio = audio_frames[0]
    assert audio[:4] == b"RIFF"
    assert header.get("fallback") == "non-streaming"
    assert header.get("sample_rate")
    assert any(h.get("final") for h, _ in frames)


def test_stream_does_not_gc_collect_on_hot_path(fake_loader, monkeypatch):
    import gc

    calls = {"n": 0}
    real = gc.collect

    def wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(gc, "collect", wrapped)
    coord = ModelCoordinator()
    coord.load("kokoro")
    list(coord.stream_batch_frames("kokoro", ["Hello"], "af_bella", 1.0))
    assert calls["n"] == 0


def test_qwen_stream_does_not_ask_client_to_shift_pitch(fake_loader):
    from open_tts.protocol import unpack_frames

    coord = ModelCoordinator()
    coord.load("qwen3-tts")
    audio_headers = []
    for raw in coord.stream_batch_frames("qwen3-tts", ["Hello Ryan."], "ryan", 2.0):
        frames, _ = unpack_frames(raw)
        audio_headers.extend(h for h, a in frames if a)
    assert audio_headers
    assert all(h.get("apply_playback_rate") is False for h in audio_headers)
    assert all(float(h.get("playback_rate") or 1.0) == 1.0 for h in audio_headers)


def _stream_pcm_parts(coord, model_id, text, voice, speed):
    import io

    import soundfile as sf

    from open_tts.protocol import unpack_frames

    pcm = []
    sample_rate = None
    for raw in coord.stream_batch_frames(model_id, [text], voice, speed):
        frames, _ = unpack_frames(raw)
        for header, audio in frames:
            if not audio:
                continue
            data, sr = sf.read(io.BytesIO(audio))
            sample_rate = sr
            pcm.append(np.asarray(data, dtype=np.float32).reshape(-1))
    joined = np.concatenate(pcm) if pcm else np.zeros(0, dtype=np.float32)
    return joined, pcm, sample_rate


def _stream_pcm(coord, model_id, text, voice, speed):
    joined, _parts, sr = _stream_pcm_parts(coord, model_id, text, voice, speed)
    return joined, sr


def test_stream_short_grains_do_not_cut_off_at_joins(fake_loader):
    coord = ModelCoordinator()
    coord.load("qwen3-tts")
    model = fake_loader["qwen3-tts"]
    n_grains = 48
    grain = np.full(800, 0.45, dtype=np.float32)
    model.stream_parts = n_grains
    model.part_signals = [grain.copy() for _ in range(n_grains)]
    joined, parts, _ = _stream_pcm_parts(coord, "qwen3-tts", "Word word word word.", "ryan", 2.0)
    assert joined.size > 0
    interior = joined[400 : max(401, joined.size - 400)]
    zeros = np.abs(interior) < 0.05
    longest = 0
    run = 0
    for z in zeros:
        if z:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    assert longest < 80, f"join hole of {longest} near-silent samples"
    if len(parts) > 1:
        jumps = []
        pos = 0
        for part in parts[:-1]:
            pos += part.size
            if 0 < pos < joined.size:
                jumps.append(abs(float(joined[pos]) - float(joined[pos - 1])))
        assert jumps
        assert max(jumps) < 0.15, f"join click {max(jumps):.3f}"


def test_stream_emits_held_tail_when_last_grain_shorter_than_xfade(fake_loader):
    from open_tts.config import STREAM_PHRASE_SECONDS, STREAM_XFADE_SECONDS

    coord = ModelCoordinator()
    coord.load("kokoro")
    model = fake_loader["kokoro"]
    sr = 24000
    phrase = max(int(sr * STREAM_PHRASE_SECONDS), 64)
    short = max(8, int(sr * STREAM_XFADE_SECONDS) // 4)
    assert short < int(sr * STREAM_XFADE_SECONDS)
    model.stream_parts = 2
    model.part_signals = [
        np.linspace(0.1, 0.9, phrase, dtype=np.float32),
        np.linspace(0.2, 0.35, short, dtype=np.float32),
    ]
    joined, _ = _stream_pcm(coord, "kokoro", "Tail must not vanish.", "af_bella", 1.0)
    overlap = short
    expected = phrase + short - overlap
    assert joined.size > 0
    assert abs(joined.size - expected) <= 8, f"got {joined.size} expected ~{expected} (discarded tail)"
    assert float(np.max(np.abs(np.diff(joined)))) < 0.15


def test_stream_3x_keeps_joins_continuous(fake_loader):
    coord = ModelCoordinator()
    coord.load("qwen3-tts")
    model = fake_loader["qwen3-tts"]
    n_grains = 160
    grain = np.full(800, 0.4, dtype=np.float32)
    model.stream_parts = n_grains
    model.part_signals = [grain.copy() for _ in range(n_grains)]
    joined, parts, _ = _stream_pcm_parts(
        coord, "qwen3-tts", "Three times speed must not pause after chunks.", "ryan", 3.0,
    )
    assert joined.size > 0
    interior = joined[400 : max(401, joined.size - 400)]
    zeros = np.abs(interior) < 0.05
    longest = 0
    run = 0
    for z in zeros:
        if z:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    assert longest < 80, f"3x join hole of {longest} samples"
    if len(parts) > 1:
        jumps = []
        pos = 0
        for part in parts[:-1]:
            pos += part.size
            if 0 < pos < joined.size:
                jumps.append(abs(float(joined[pos]) - float(joined[pos - 1])))
        assert max(jumps) < 0.15, f"3x join click {max(jumps):.3f}"
    one_x = 800 * n_grains
    ratio = joined.size / one_x
    assert abs(ratio - 1 / 3.0) < 0.12, f"3x ratio {ratio:.3f} not ~0.33"


def test_stream_duration_scales_with_speed(fake_loader):
    coord = ModelCoordinator()
    coord.load("qwen3-tts")
    model = fake_loader["qwen3-tts"]
    n_grains = 12
    grain = np.full(800, 0.3, dtype=np.float32)
    model.stream_parts = n_grains
    model.part_signals = [grain.copy() for _ in range(n_grains)]
    slow, _ = _stream_pcm(coord, "qwen3-tts", "Scale this utterance.", "ryan", 1.0)
    model.parts_yielded = 0
    model.part_signals = [grain.copy() for _ in range(n_grains)]
    fast, _ = _stream_pcm(coord, "qwen3-tts", "Scale this utterance.", "ryan", 2.5)
    assert slow.size > 0 and fast.size > 0
    ratio = fast.size / slow.size
    assert abs(ratio - 1 / 2.5) < 0.12, f"2.5x ratio {ratio:.3f} not ~0.4"


def test_qwen_stream_speeds_up_short_middle_grains(fake_loader):
    import io

    import soundfile as sf

    from open_tts.protocol import unpack_frames

    coord = ModelCoordinator()
    coord.load("qwen3-tts")
    fake_loader["qwen3-tts"].stream_parts = 3
    fake_loader["qwen3-tts"].part_lengths = [2400, 80, 2400]
    input_samples = 2400 + 80 + 2400
    out_samples = 0
    for raw in coord.stream_batch_frames("qwen3-tts", ["Longer text with a tiny grain."], "ryan", 2.0):
        frames, _ = unpack_frames(raw)
        for header, audio in frames:
            if not audio:
                continue
            data, _sr = sf.read(io.BytesIO(audio))
            out_samples += len(data)
            assert header.get("apply_playback_rate") is False
    assert out_samples > 0
    assert out_samples < input_samples * 0.7


def test_qwen_generate_full_time_stretches_faster_speech(fake_loader):
    coord = ModelCoordinator()
    coord.load("qwen3-tts")
    slow, _, _ = coord.generate_full("qwen3-tts", "Hello", "ryan", 1.0)
    fast, _, _ = coord.generate_full("qwen3-tts", "Hello", "ryan", 2.0)
    assert slow[:4] == b"RIFF"
    assert fast[:4] == b"RIFF"
    assert len(fast) < len(slow)


def test_stream_uses_documented_streaming_interval(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    list(coord.stream_batch_frames("kokoro", ["Hello"], "af_bella", 1.0))
    kwargs = fake_loader["kokoro"].last_kwargs
    assert kwargs.get("stream") is True
    assert kwargs.get("streaming_interval") == STREAMING_INTERVAL


def test_generate_serialized_while_health_snapshot_stays_unlocked(fake_loader):
    coord = ModelCoordinator()
    coord.load("kokoro")
    model = fake_loader["kokoro"]
    hold = threading.Event()
    model.hold_generate = hold
    model.generate_started.clear()

    errors = []

    def worker():
        try:
            coord.generate_full("kokoro", "Hello", "af_bella", 1.0)
        except Exception as exc:
            errors.append(exc)

    t = threading.Thread(target=worker)
    t.start()
    assert model.generate_started.wait(timeout=5)
    started = time.perf_counter()
    snap = coord.snapshot()
    assert time.perf_counter() - started < 0.05
    assert snap["gpu_busy"] is True
    hold.set()
    t.join(timeout=10)
    assert not errors
    assert coord.state == ModelState.READY