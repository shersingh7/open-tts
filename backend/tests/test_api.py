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
        _reset_coordinator()


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
    assert len(audio_idxs) == 3
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
    assert len(audio_idxs) == 3


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
    hold.set()
    t.join(timeout=10)

    assert not errors
    assert health.status_code == 200
    assert elapsed < 0.5
    body = health.json()
    assert body["status"] == "ok"
    assert body.get("gpu_busy") is True
    assert coordinator.state == ModelState.READY