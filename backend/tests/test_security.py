from __future__ import annotations

from open_tts.security import validate_token


def test_validate_token_rejects_length_mismatch():
    assert validate_token("short", "a" * 32) is False
    assert validate_token("a" * 32, "b" * 32) is False
    assert validate_token("same-token-value-012345678901", "same-token-value-012345678901") is True


def test_validate_token_strips_whitespace():
    token = "token-with-fixed-length-abcde"
    assert validate_token(f"  {token}  ", token) is True
