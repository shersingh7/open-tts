"""Configuration and version constants."""

from __future__ import annotations

import os
from enum import Enum
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
TOKEN_FILE = BACKEND_DIR / ".open_tts_token"
LOCK_FILE = BACKEND_DIR / ".open_tts.lock"

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
RATE_LIMIT_PER_MIN = int(os.getenv("OPEN_TTS_RATE_LIMIT", "120"))

VERSION = "3.2.0"
ENGINE_ID = "open-tts"


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