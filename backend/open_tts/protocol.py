"""Stream framing and request validation."""

from __future__ import annotations

import json
import struct
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .config import MAX_BATCH_TEXTS, MAX_BATCH_TOTAL_CHARS, MAX_TEXT_LENGTH, AudioFormat
from .errors import ErrorCode, http_exception


def validate_text(text: str, *, field: str = "text") -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        raise http_exception(400, ErrorCode.VALIDATION, f"{field} must not be empty")
    if len(cleaned) > MAX_TEXT_LENGTH:
        raise http_exception(
            400,
            ErrorCode.VALIDATION,
            f"{field} exceeds maximum length of {MAX_TEXT_LENGTH}",
        )
    return cleaned


def validate_batch(texts: List[str]) -> List[str]:
    if not texts:
        raise http_exception(400, ErrorCode.VALIDATION, "texts must not be empty")
    if len(texts) > MAX_BATCH_TEXTS:
        raise http_exception(
            400,
            ErrorCode.BATCH_TOO_LARGE,
            f"Maximum {MAX_BATCH_TEXTS} texts per batch",
        )
    cleaned = [validate_text(t, field=f"texts[{i}]") for i, t in enumerate(texts)]
    total = sum(len(t) for t in cleaned)
    if total > MAX_BATCH_TOTAL_CHARS:
        raise http_exception(
            400,
            ErrorCode.BATCH_TOO_LARGE,
            f"Total batch character count {total} exceeds {MAX_BATCH_TOTAL_CHARS}",
        )
    return cleaned


def parse_audio_format(value: str) -> AudioFormat:
    try:
        return AudioFormat.from_value(value)
    except ValueError as exc:
        raise http_exception(400, ErrorCode.FORMAT_UNSUPPORTED, str(exc))


def pack_frame(header: Dict[str, Any], audio: bytes = b"") -> bytes:
    hdr = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(hdr)) + hdr + struct.pack("<I", len(audio)) + audio


MAX_FRAME_HEADER_BYTES = 64 * 1024
MAX_FRAME_AUDIO_BYTES = 64 * 1024 * 1024


def unpack_frames(buffer: bytes) -> Tuple[List[Tuple[Dict[str, Any], bytes]], bytes]:
    """Parse as many complete frames as possible from buffer."""
    frames: List[Tuple[Dict[str, Any], bytes]] = []
    offset = 0
    while offset + 8 <= len(buffer):
        hdr_len = struct.unpack_from("<I", buffer, offset)[0]
        if hdr_len > MAX_FRAME_HEADER_BYTES:
            raise ValueError("Stream frame header is too large")
        if offset + 4 + hdr_len + 4 > len(buffer):
            break
        audio_len = struct.unpack_from("<I", buffer, offset + 4 + hdr_len)[0]
        if audio_len > MAX_FRAME_AUDIO_BYTES:
            raise ValueError("Stream frame audio is too large")
        end = offset + 4 + hdr_len + 4 + audio_len
        if end > len(buffer):
            break
        hdr = json.loads(buffer[offset + 4 : offset + 4 + hdr_len].decode("utf-8"))
        audio = buffer[offset + 4 + hdr_len + 4 : end]
        frames.append((hdr, audio))
        offset = end
    return frames, buffer[offset:]


def terminal_frame() -> bytes:
    return pack_frame({"done": True})