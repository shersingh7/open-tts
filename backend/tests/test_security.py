from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from open_tts.api import create_app
from open_tts.security import validate_token


def test_validate_token_rejects_non_ascii_without_exception():
    assert validate_token("é" * 32, "a" * 32) is False


def test_validate_token_rejects_length_mismatch():
    assert validate_token("short", "a" * 32) is False
    assert validate_token("a" * 32, "b" * 32) is False
    assert validate_token("same-token-value-012345678901", "same-token-value-012345678901") is True


def test_validate_token_strips_whitespace():
    token = "token-with-fixed-length-abcde"
    assert validate_token(f"  {token}  ", token) is True


# --- DNS-rebinding defence (finding #14) -------------------------------------

@pytest.fixture
def production_app():
    """App built exactly as server.py builds it: no extra allowed hosts."""
    app = create_app()
    try:
        yield app
    finally:
        assert app.state.runtime.shutdown(timeout=5)


def _client(app, host):
    return TestClient(app, base_url=f"http://{host}")


def test_create_app_allowed_hosts_extra_defaults_to_empty():
    param = inspect.signature(create_app).parameters["allowed_hosts_extra"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    assert tuple(param.default) == ()


def test_server_entry_builds_app_without_extra_hosts():
    source = (Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8")
    calls = [node for node in ast.walk(ast.parse(source))
             if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "create_app"]
    assert len(calls) == 1
    assert calls[0].args == [] and calls[0].keywords == []


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000", "127.0.0.1", "localhost"])
def test_loopback_host_headers_are_accepted(production_app, host):
    response = _client(production_app, host).get("/health")
    assert response.status_code == 200
    assert response.json()["engine"] == "open-tts"


@pytest.mark.parametrize("path", ["/health", "/v1/models", "/v1/voices", "/v1/capabilities"])
def test_foreign_host_header_is_rejected(production_app, path):
    response = _client(production_app, "evil.example").get(path)
    assert response.status_code == 400


@pytest.mark.parametrize("path", ["/v1/models", "/v1/voices"])
def test_dns_rebinding_request_without_origin_is_rejected(production_app, path):
    # After rebinding attacker.example → 127.0.0.1, a same-origin GET arrives from a
    # loopback client with no Origin header: exactly the token-free local CLI path.
    rebound = _client(production_app, "attacker.example:8000").get(path)
    assert rebound.status_code == 400
    assert "models" not in rebound.text and "voices" not in rebound.text
    # The genuine local CLI path (loopback Host, no Origin) keeps working.
    assert _client(production_app, "127.0.0.1:8000").get(path).status_code == 200


def test_foreign_host_post_is_rejected_before_model_work(production_app):
    response = _client(production_app, "attacker.example:8000").post("/v1/load-model?model_id=kokoro")
    assert response.status_code == 400


def test_testserver_host_is_rejected_unless_explicitly_allowed(production_app):
    assert _client(production_app, "testserver").get("/health").status_code == 400
    app = create_app(allowed_hosts_extra=["testserver"])
    try:
        assert TestClient(app).get("/health").status_code == 200
    finally:
        assert app.state.runtime.shutdown(timeout=5)
