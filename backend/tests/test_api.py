from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from open_tts.api import create_app
from open_tts.coordinator import ModelState, coordinator
from open_tts.protocol import unpack_frames
from open_tts.security import get_or_create_token


def _reset_coordinator() -> None:
    coordinator._cancel.set()
    acquired = coordinator._operation_lock.acquire(timeout=2)
    if not acquired:
        return
    try:
        coordinator.model = None
        coordinator.model_id = None
        coordinator.state = ModelState.UNLOADED
        coordinator.load_error = None
        coordinator.warm_error = None
        coordinator._voices = {}
        coordinator._cancel.clear()
    finally:
        coordinator._operation_lock.release()


@pytest.fixture
def client(fake_loader, monkeypatch, tmp_path):
    token_file = tmp_path / ".open_tts_token"
    token_file.write_text("test-token-123")
    monkeypatch.setattr("open_tts.security.TOKEN_FILE", token_file)
    monkeypatch.setattr("open_tts.config.TOKEN_FILE", token_file)
    monkeypatch.setattr("open_tts.api.get_or_create_token", lambda: "test-token-123")
    _reset_coordinator()
    app = create_app()
    app.state.install_token = "test-token-123"
    try:
        yield TestClient(app)
    finally:
        assert app.state.runtime.shutdown(timeout=5)
        _reset_coordinator()


def test_slow_semantic_generation_sends_keepalive_without_false_idle_timeout(client, fake_loader, monkeypatch):
    monkeypatch.setattr("open_tts.api.STREAM_FRAME_TIMEOUT", 0.05)
    monkeypatch.setattr("open_tts.api.GEN_TIMEOUT", 2)
    monkeypatch.setattr("open_tts.api.STREAM_HEARTBEAT_SECONDS", 0.02, raising=False)
    assert client.post("/v1/load-model?model_id=qwen3-tts").status_code == 200
    fake_loader["qwen3-tts"].part_delay = 0.35
    r = client.post("/v1/synthesize-stream-batch", json={
        "texts": ["Slow semantic unit."], "model": "qwen3-tts", "voice": "ryan", "speed": 1.5,
    })
    frames = _parse_frames(r.content)
    assert any(h.get("keepalive") is True and not audio for h, audio in frames)
    assert any(audio for _, audio in frames)
    assert not any(h.get("error") for h, _ in frames)
    assert frames[-1][0] == {"done": True}


def test_keepalive_does_not_extend_inference_deadline(client, fake_loader, monkeypatch):
    monkeypatch.setattr("open_tts.api.STREAM_FRAME_TIMEOUT", 0.05)
    monkeypatch.setattr("open_tts.api.GEN_TIMEOUT", 0.4)
    monkeypatch.setattr("open_tts.api.STREAM_HEARTBEAT_SECONDS", 0.02)
    assert client.post("/v1/load-model?model_id=qwen3-tts").status_code == 200
    fake_loader["qwen3-tts"].part_delay = 0.35
    r = client.post("/v1/synthesize-stream-batch", json={
        "texts": ["Over-budget semantic unit."], "model": "qwen3-tts", "voice": "ryan", "speed": 1.5,
    })
    frames = _parse_frames(r.content)
    assert any(h.get("keepalive") for h, _ in frames)
    assert any(h.get("code") == "stream_timeout" for h, _ in frames)
    assert not any(h.get("done") or audio for h, audio in frames)


def test_health_readiness(client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["engine"] == "open-tts"
    assert "install_token" not in data


def test_cors_and_token(client):
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    r = client.get("/v1/models", headers={"Origin": origin})
    assert r.status_code == 401
    assert r.headers["access-control-allow-origin"] == origin
    r = client.get(
        "/v1/models",
        headers={"Origin": origin, "X-Open-TTS-Token": "test-token-123"},
    )
    assert r.status_code == 200


def test_local_cli_without_origin_is_allowed(client):
    assert client.get("/v1/models").status_code == 200


def test_cors_preflight_is_not_rejected_by_auth(client):
    r = client.options(
        "/v1/models",
        headers={
            "Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-open-tts-token",
        },
    )
    assert r.status_code == 200


def test_load_and_synthesize(client):
    headers = {"X-Open-TTS-Token": "test-token-123"}
    r = client.post("/v1/load-model?model_id=kokoro", headers=headers)
    assert r.status_code == 200
    r = client.post(
        "/v1/synthesize",
        headers=headers,
        json={"text": "Hello", "voice": "af_bella", "model": "kokoro", "format": "wav"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/")
    assert len(r.content) > 44


def test_openai_compat_speech_endpoints_return_complete_audio(client):
    headers = {"X-Open-TTS-Token": "test-token-123"}
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    body = {
        "model": "kokoro",
        "input": "Hello from the speech endpoint.",
        "voice": "af_bella",
        "response_format": "wav",
    }
    for path in ("/v1/audio/speech", "/v1/speech"):
        r = client.post(path, headers=headers, json=body)
        assert r.status_code == 200, path
        assert r.headers["content-type"].startswith("audio/"), path
        assert r.content[:4] == b"RIFF", path
        assert len(r.content) > 44, path


def test_force_reload_query(client):
    headers = {"X-Open-TTS-Token": "test-token-123"}
    r = client.post("/v1/load-model?model_id=kokoro&force=true", headers=headers)
    assert r.status_code == 200
    assert r.json()["success"] is True


def test_stream_batch_rejects_unknown_model(client):
    headers = {"X-Open-TTS-Token": "test-token-123"}
    r = client.post(
        "/v1/synthesize-stream-batch",
        headers=headers,
        json={"texts": ["Hello"], "model": "not-a-model"},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "model_not_found"


def test_auth_middleware_flat_error_envelope(client):
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    r = client.get("/v1/models", headers={"Origin": origin, "X-Open-TTS-Token": "wrong-token"})
    assert r.status_code == 401
    body = r.json()
    assert body["code"] == "unauthorized"
    assert "message" in body
    assert "detail" not in body


def _auth():
    return {"X-Open-TTS-Token": "test-token-123"}


def _parse_frames(body: bytes):
    frames, rem = unpack_frames(body)
    assert rem == b"", "stream ended with a truncated frame"
    return frames


def test_synthesize_default_is_complete_audio_body(client):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    r = client.post(
        "/v1/synthesize",
        headers=headers,
        json={"text": "Hello complete body", "voice": "af_bella", "model": "kokoro"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/")
    assert r.content[:4] == b"RIFF"
    assert len(r.content) > 44


def test_synthesize_stream_completes_without_waiting_for_frame_timeout(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    started = time.perf_counter()
    r = client.post(
        "/v1/synthesize",
        headers=headers,
        json={"text": "Should finish immediately.", "model": "kokoro", "stream": True},
    )
    elapsed = time.perf_counter() - started
    assert r.status_code == 200
    assert elapsed < 5, f"stream stalled after last frame: {elapsed:.2f}s"


def test_synthesize_stream_true_preserves_selected_speed(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=qwen3-tts", headers=headers).status_code == 200
    fake_loader["qwen3-tts"].stream_parts = 8
    r = client.post(
        "/v1/synthesize",
        headers=headers,
        json={
            "text": "Speed must stay at two point five.",
            "voice": "ryan",
            "model": "qwen3-tts",
            "stream": True,
            "speed": 2.5,
        },
    )
    assert r.status_code == 200
    assert r.headers.get("x-tts-speed") == "2.5"
    frames = _parse_frames(r.content)
    audio_frames = [(h, a) for h, a in frames if a]
    assert audio_frames
    assert audio_frames[0][0].get("speed") == 2.5
    assert any(h.get("done") for h, _ in frames)


def test_synthesize_stream_true_first_audio_before_body_ends(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    fake_loader["kokoro"].stream_parts = 3
    r = client.post(
        "/v1/synthesize",
        headers=headers,
        json={
            "text": "Hello streaming synthesize path.",
            "voice": "af_bella",
            "model": "kokoro",
            "stream": True,
        },
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/octet-stream")
    assert r.headers.get("x-tts-stream") == "true"
    frames = _parse_frames(r.content)
    audio_idxs = [i for i, (h, a) in enumerate(frames) if a]
    done_idxs = [i for i, (h, a) in enumerate(frames) if h.get("done")]
    assert audio_idxs, "expected a playable audio frame"
    assert frames[audio_idxs[0]][1][:4] == b"RIFF"
    assert frames[audio_idxs[0]][0].get("sample_rate")
    assert done_idxs
    assert audio_idxs[0] < done_idxs[0]
    assert len(audio_idxs) >= 1
    assert fake_loader["kokoro"].parts_yielded == 3


def test_stream_batch_first_audio_before_later_parts(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    fake_loader["kokoro"].stream_parts = 3
    r = client.post(
        "/v1/synthesize-stream-batch",
        headers=headers,
        json={"texts": ["First item for incremental stream."], "voice": "af_bella", "model": "kokoro"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/octet-stream")
    frames = _parse_frames(r.content)
    audio_idxs = [i for i, (h, a) in enumerate(frames) if a]
    done_idxs = [i for i, (h, a) in enumerate(frames) if h.get("done")]
    assert audio_idxs and frames[audio_idxs[0]][1][:4] == b"RIFF"
    assert done_idxs and audio_idxs[0] < done_idxs[0]
    assert len(audio_idxs) >= 1


def test_synthesize_stream_true_non_streaming_model_one_fallback_frame(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=fish-s2-pro", headers=headers).status_code == 200
    fake_loader["fish-s2-pro"].stream_parts = 5
    r = client.post(
        "/v1/synthesize",
        headers=headers,
        json={"text": "Fish fallback should be one frame.", "model": "fish-s2-pro", "stream": True},
    )
    assert r.status_code == 200
    frames = _parse_frames(r.content)
    audio_frames = [(h, a) for h, a in frames if a]
    assert len(audio_frames) == 1
    header, audio = audio_frames[0]
    assert audio[:4] == b"RIFF"
    assert header.get("fallback") == "non-streaming"
    assert header.get("sample_rate")
    assert any(h.get("done") for h, _ in frames)


def test_health_returns_while_generate_in_flight(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    model = fake_loader["kokoro"]
    hold = threading.Event()
    model.hold_generate = hold
    model.generate_started.clear()
    errors = []

    def worker():
        try:
            coordinator.generate_full("kokoro", "Hold this generate", "af_bella", 1.0)
        except Exception as exc:
            errors.append(exc)

    t = threading.Thread(target=worker)
    t.start()
    assert model.generate_started.wait(timeout=5)
    started = time.perf_counter()
    health = client.get("/health")
    elapsed = time.perf_counter() - started
    body = health.json()
    hold.set()
    t.join(timeout=10)

    assert not errors
    assert health.status_code == 200
    assert elapsed < 0.5
    assert body["status"] == "ok"
    assert body.get("gpu_busy") is True
    assert body.get("model_warm") is True
    assert body.get("state") == "generating"
    assert coordinator.state == ModelState.READY


def test_load_same_model_endpoint_during_generate_returns_immediately(client, fake_loader):
    headers = _auth()
    assert client.post("/v1/load-model?model_id=kokoro", headers=headers).status_code == 200
    model = fake_loader["kokoro"]
    hold = threading.Event()
    model.hold_generate = hold
    model.generate_started.clear()
    errors = []

    def worker():
        try:
            coordinator.generate_full("kokoro", "Hold this generate", "af_bella", 1.0)
        except Exception as exc:
            errors.append(exc)

    t = threading.Thread(target=worker)
    t.start()
    assert model.generate_started.wait(timeout=5)
    started = time.perf_counter()
    resp = client.post("/v1/load-model?model_id=kokoro", headers=headers)
    elapsed = time.perf_counter() - started
    hold.set()
    t.join(timeout=10)

    assert not errors
    assert resp.status_code == 200
    assert elapsed < 0.5
    data = resp.json()
    assert data["success"] is True
    assert data["model"] == "kokoro"

@pytest.mark.parametrize("cancel_mode", ["close", "task_cancel"])
def test_response_cancellation_closes_worker_on_owner_thread(client, monkeypatch, cancel_mode):
    import asyncio
    from open_tts.api import StreamBatchRequest
    from open_tts.protocol import pack_frame
    closed = threading.Event()
    entered = threading.Event()
    ids = []
    monkeypatch.setattr("open_tts.api.STREAM_QUEUE_MAX", 1)

    def stream(*args, **kwargs):
        ids.append(threading.get_ident())
        try:
            entered.set()
            if cancel_mode == "task_cancel":
                while not kwargs["cancel_check"]():
                    time.sleep(0.005)
                return
            for _ in range(1000):
                if kwargs["cancel_check"]():
                    return
                yield pack_frame({"index": 0}, b"fixture")
        finally:
            ids.append(threading.get_ident())
            closed.set()

    monkeypatch.setattr(coordinator, "stream_batch_frames", stream)
    endpoint = next(r.endpoint for r in client.app.routes if r.path == "/v1/synthesize-stream-batch")
    class Request:
        async def is_disconnected(self):
            return False
    async def check():
        response = await endpoint(StreamBatchRequest(texts=["Fixture"], model="kokoro"), Request())
        iterator = response.body_iterator
        if cancel_mode == "close":
            assert await iterator.__anext__()
            await iterator.aclose()
        else:
            pending = asyncio.create_task(iterator.__anext__())
            assert await asyncio.to_thread(entered.wait, 2)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
        assert await asyncio.to_thread(closed.wait, 2)
        assert ids[0] == ids[1] != threading.get_ident()
    asyncio.run(check())
