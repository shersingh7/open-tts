from __future__ import annotations

import threading
import time

import pytest
from fastapi import HTTPException

from open_tts.config import AudioFormat
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