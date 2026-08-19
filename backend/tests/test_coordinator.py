from __future__ import annotations

import threading
import time

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
    """Drive the shipped coordinator: first audio frame arrives before part 2 is yielded."""
    from open_tts.protocol import unpack_frames

    coord = ModelCoordinator()
    coord.load("kokoro")
    model = fake_loader["kokoro"]
    gate = threading.Event()
    model.part_gate = gate
    model.stream_parts = 3

    first_audio = None
    later_at_first = None
    seen_final = False
    for raw in coord.stream_batch_frames("kokoro", ["Hello there streaming world."], "af_bella", 1.0):
        frames, _ = unpack_frames(raw)
        for header, audio in frames:
            if audio and first_audio is None:
                first_audio = audio
                later_at_first = model.parts_yielded
                gate.set()
            if header.get("final"):
                seen_final = True

    assert first_audio, "expected an audio-bearing frame"
    assert first_audio[:4] == b"RIFF"
    assert later_at_first == 1, f"later parts already produced at first frame: {later_at_first}"
    assert model.parts_yielded == 3
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