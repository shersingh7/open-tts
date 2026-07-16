from __future__ import annotations

import json
import struct

import pytest

from open_tts.protocol import pack_frame, unpack_frames, validate_batch, validate_text, parse_audio_format
from open_tts.config import AudioFormat


def test_stream_framing_fragmentation():
    frames = [
        pack_frame({"index": 0, "final": False}, b"abcd"),
        pack_frame({"index": 0, "final": True}),
        pack_frame({"done": True}),
    ]
    buf = b"".join(frames)
    parsed, rem = unpack_frames(buf)
    assert len(parsed) == 3
    assert rem == b""
    assert parsed[0][1] == b"abcd"


def test_validate_batch_limits():
    with pytest.raises(Exception):
        validate_batch([""])
    with pytest.raises(Exception):
        validate_batch(["x" * 60000])


def test_audio_format_enum():
    assert parse_audio_format("wav") == AudioFormat.WAV
    with pytest.raises(Exception):
        parse_audio_format("xyz")


def test_unpack_frames_rejects_oversized_header():
    from open_tts.protocol import MAX_FRAME_HEADER_BYTES

    buf = struct.pack("<I", MAX_FRAME_HEADER_BYTES + 1) + b"\x00" * 4
    with pytest.raises(ValueError, match="header is too large"):
        unpack_frames(buf)