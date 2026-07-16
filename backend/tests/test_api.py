from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from open_tts.api import create_app
from open_tts.security import get_or_create_token


@pytest.fixture
def client(fake_loader, monkeypatch, tmp_path):
    token_file = tmp_path / ".open_tts_token"
    token_file.write_text("test-token-123")
    monkeypatch.setattr("open_tts.security.TOKEN_FILE", token_file)
    monkeypatch.setattr("open_tts.config.TOKEN_FILE", token_file)
    monkeypatch.setattr("open_tts.api.get_or_create_token", lambda: "test-token-123")
    app = create_app()
    app.state.install_token = "test-token-123"
    return TestClient(app)


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