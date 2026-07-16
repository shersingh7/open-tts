from __future__ import annotations

from open_tts.adapters import split_kokoro_chunks


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
