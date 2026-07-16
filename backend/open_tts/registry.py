"""Model registry and voice metadata."""

from __future__ import annotations

from typing import Dict, List, Optional

MODEL_REGISTRY: Dict[str, dict] = {
    "kokoro": {
        "hf_id": "mlx-community/Kokoro-82M-bf16",
        "local_dir": "models/kokoro-82M",
        "display_name": "Kokoro 82M",
        "description": "Ultra-fast lightweight TTS",
        "default_voice": "af_bella",
        "supports_native_speed": True,
        "supports_streaming": True,
        "supports_lang_code": False,
        "supports_instruct": False,
        "has_preset_voices": True,
        "default_voices": [
            "af_bella", "af_sarah", "af_nova", "af_heart", "af_jessica",
            "af_alloy", "af_sky", "af_river", "af_aoede", "af_kore",
            "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
            "am_michael", "am_onyx", "am_puck", "am_santa",
        ],
    },
    "qwen3-tts": {
        "hf_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        "local_dir": "models/qwen3-tts-8bit",
        "display_name": "Qwen3-TTS 1.7B",
        "description": "Multilingual TTS with preset voices",
        "default_voice": "ryan",
        "supports_native_speed": False,
        "supports_streaming": True,
        "supports_lang_code": True,
        "supports_instruct": True,
        "has_preset_voices": True,
        "default_voices": [
            "serena", "vivian", "uncle_fu", "dylan",
            "eric", "ryan", "aiden", "ono_anna", "sohee",
        ],
    },
    "fish-s2-pro": {
        "hf_id": "mlx-community/fish-audio-s2-pro-8bit",
        "local_dir": "models/fish-audio-s2-pro-8bit",
        "display_name": "Fish Audio S2 Pro",
        "description": "High-quality TTS with voice cloning",
        "default_voice": None,
        "supports_native_speed": False,
        "supports_streaming": False,
        "supports_lang_code": False,
        "supports_instruct": True,
        "has_preset_voices": False,
        "default_voices": [],
    },
}

FISH_VOICE_TAGS = frozenset([
    "pause", "emphasis", "laughing", "inhale", "chuckle", "tsk",
    "singing", "excited", "volume up", "echo", "angry", "whisper",
    "screaming", "sad", "shocked", "pitch up", "pitch down",
    "professional broadcast tone",
])

VOICE_LABELS = {
    "serena": "Serena", "vivian": "Vivian", "uncle_fu": "Uncle Fu",
    "dylan": "Dylan", "eric": "Eric", "ryan": "Ryan", "aiden": "Aiden",
    "ono_anna": "Ono Anna", "sohee": "Sohee",
    "af_heart": "Heart", "af_bella": "Bella", "af_sarah": "Sarah",
    "af_nova": "Nova", "af_jessica": "Jessica", "af_kore": "Kore",
    "af_sky": "Sky", "af_alloy": "Alloy", "af_aoede": "Aoede",
    "af_river": "River", "am_adam": "Adam", "am_echo": "Echo",
    "am_eric": "Eric (M)", "am_fenrir": "Fenrir", "am_liam": "Liam",
    "am_michael": "Michael", "am_onyx": "Onyx", "am_puck": "Puck",
    "am_santa": "Santa",
}

LANG_ALIASES = {
    "auto": "auto", "english": "en", "en": "en",
    "chinese": "zh", "zh": "zh", "japanese": "ja", "ja": "ja",
    "korean": "ko", "ko": "ko", "spanish": "es", "es": "es",
    "french": "fr", "fr": "fr", "german": "de", "de": "de",
}


def voice_label(voice_id: str) -> str:
    return VOICE_LABELS.get(voice_id, voice_id.replace("_", " ").title())


def normalize_lang(lang: str) -> str:
    raw = (lang or "auto").strip().lower()
    return LANG_ALIASES.get(raw, "auto")