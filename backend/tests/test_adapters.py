from __future__ import annotations

from open_tts.adapters import build_gen_kwargs, resolve_voice, split_kokoro_chunks, split_stream_text
from open_tts.config import STREAMING_INTERVAL


def test_split_kokoro_chunks_preserves_original_substrings():
    text = "Hello world.\n\nSecond paragraph has more words for splitting."
    parts = split_kokoro_chunks(text, max_chars=20)
    assert parts
    assert "".join(parts) == text or all(part in text for part in parts)
    # Every chunk must appear as an exact contiguous slice of the input.
    cursor = 0
    for part in parts:
        idx = text.find(part, cursor)
        assert idx >= 0
        cursor = idx + len(part)


def test_split_kokoro_chunks_short_text_is_identity():
    text = "Keep me intact."
    assert split_kokoro_chunks(text, max_chars=400) == [text]


def test_build_gen_kwargs_uses_configured_streaming_interval():
    kwargs, _ = build_gen_kwargs(
        "qwen3-tts",
        "Hello",
        "ryan",
        1.0,
        ["ryan"],
        stream=True,
    )
    assert kwargs["stream"] is True
    assert kwargs["streaming_interval"] == STREAMING_INTERVAL


def test_qwen_falls_back_when_kokoro_voice_is_sent():
    assert resolve_voice("qwen3-tts", "af_bella", ["ryan", "serena"]) == "ryan"
    kwargs, _ = build_gen_kwargs(
        "qwen3-tts",
        "Hello",
        "af_bella",
        1.5,
        ["ryan", "serena"],
    )
    assert kwargs["voice"] == "ryan"
    assert kwargs["speed"] == 1.0


def test_split_stream_text_keeps_first_slice_small():
    text = (
        "First sentence is reasonably long and should land in the opening slice. "
        "Second sentence continues the paragraph with more words. "
        "Third sentence is extra padding so the remainder exceeds the first cap. "
        "Fourth sentence keeps going so rest splitting is exercised as well."
    )
    parts = split_stream_text(text, first_max=80, rest_max=120)
    assert parts
    assert len(parts[0]) <= 80
    assert "".join(parts) == text or text.startswith(parts[0])
    cursor = 0
    for part in parts:
        idx = text.find(part, cursor)
        assert idx >= 0
        cursor = idx + len(part)
