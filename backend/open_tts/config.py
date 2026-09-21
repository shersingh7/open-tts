"""Configuration and version constants."""

from __future__ import annotations

import os
from enum import Enum
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
RUNTIME_DIR = Path(os.getenv("OPEN_TTS_RUNTIME_DIR", str(BACKEND_DIR))).expanduser().resolve()
TOKEN_FILE = RUNTIME_DIR / ".open_tts_token"
LOCK_FILE = RUNTIME_DIR / ".open_tts.lock"

HOST = os.getenv("OPEN_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("OPEN_TTS_PORT", "8000"))
DEFAULT_MODEL = os.getenv("OPEN_TTS_DEFAULT_MODEL", "kokoro")
WARMUP_TEXT = os.getenv("OPEN_TTS_WARMUP_TEXT", "Warmup")
GEN_TIMEOUT = int(os.getenv("OPEN_TTS_GEN_TIMEOUT", "300"))
MAX_TEXT_LENGTH = int(os.getenv("OPEN_TTS_MAX_TEXT", "50000"))
MAX_BATCH_TEXTS = int(os.getenv("OPEN_TTS_MAX_BATCH", "50"))
MAX_BATCH_TOTAL_CHARS = int(os.getenv("OPEN_TTS_MAX_BATCH_CHARS", "200000"))
STREAM_QUEUE_MAX = int(os.getenv("OPEN_TTS_STREAM_QUEUE_MAX", "32"))
STREAM_FRAME_TIMEOUT = float(os.getenv("OPEN_TTS_STREAM_FRAME_TIMEOUT", "60"))
STREAMING_INTERVAL = float(os.getenv("OPEN_TTS_STREAMING_INTERVAL", "1.0"))
STREAM_FIRST_CHUNK_CHARS = int(os.getenv("OPEN_TTS_STREAM_FIRST_CHARS", "4000"))
STREAM_REST_CHUNK_CHARS = int(os.getenv("OPEN_TTS_STREAM_REST_CHARS", "4000"))
STREAM_PHRASE_SECONDS = float(os.getenv("OPEN_TTS_STREAM_PHRASE_SECONDS", "1.2"))
STREAM_XFADE_SECONDS = float(os.getenv("OPEN_TTS_STREAM_XFADE_SECONDS", "0.02"))
STREAM_MAX_EMIT_SECONDS = float(os.getenv("OPEN_TTS_STREAM_MAX_EMIT_SECONDS", "2"))
CLIENT_DECODED_BYTE_CAP = int(os.getenv("OPEN_TTS_CLIENT_DECODED_BYTE_CAP", str(16 * 1024 * 1024)))
RATE_LIMIT_PER_MIN = int(os.getenv("OPEN_TTS_RATE_LIMIT", "120"))

VERSION = "3.5.0"
ENGINE_ID = "open-tts"
STREAM_QUEUE_BYTES = 8 * 1024 * 1024
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_INSTRUCT_CHARS = 2000
MAX_FULL_PCM_BYTES = 128 * 1024 * 1024
MAX_BATCH_OUTPUT_BYTES = 128 * 1024 * 1024
MAX_FRAME_BYTES = 8 * 1024 * 1024
GENERATION_PROFILES = {
    "kokoro": (300, 600, 900, 1200),
    "qwen3-tts": (160, 320, 480, 720),
    "fish-s2-pro": (160, 300, 300, 500),
}


def validate_config():
    import math
    for name in ("GEN_TIMEOUT", "MAX_TEXT_LENGTH", "MAX_BATCH_TEXTS", "MAX_BATCH_TOTAL_CHARS",
                 "STREAM_QUEUE_MAX", "STREAM_FRAME_TIMEOUT", "STREAMING_INTERVAL",
                 "STREAM_PHRASE_SECONDS", "CLIENT_DECODED_BYTE_CAP"):
        value = globals()[name]
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be finite and positive")
    if not 0 < STREAM_MAX_EMIT_SECONDS <= 4:
        raise ValueError("OPEN_TTS_STREAM_MAX_EMIT_SECONDS must be in (0, 4]")
    if not 1 <= PORT <= 65535:
        raise ValueError("OPEN_TTS_PORT out of range")


validate_config()


class AudioFormat(str, Enum):
    WAV = "wav"
    MP3 = "mp3"
    OPUS = "opus"
    FLAC = "flac"
    AAC = "aac"
    PCM = "pcm"

    @classmethod
    def from_value(cls, value: str) -> "AudioFormat":
        raw = (value or "wav").strip().lower()
        aliases = {"pcm": cls.WAV}
        if raw in aliases:
            return aliases[raw]
        try:
            return cls(raw)
        except ValueError:
            raise ValueError(f"Unsupported audio format: {value}")

    @property
    def mime_type(self) -> str:
        return {
            AudioFormat.WAV: "audio/wav",
            AudioFormat.MP3: "audio/mpeg",
            AudioFormat.OPUS: "audio/ogg; codecs=opus",
            AudioFormat.FLAC: "audio/flac",
            AudioFormat.AAC: "audio/aac",
            AudioFormat.PCM: "audio/wav",
        }[self]