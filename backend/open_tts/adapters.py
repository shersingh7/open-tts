"""Model adapter helpers and Kokoro-safe chunking."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .registry import FISH_VOICE_TAGS, MODEL_REGISTRY, normalize_lang


def normalize_voice(voice: str, supported: List[str]) -> str:
    raw = (voice or "").strip().lower().replace(" ", "_")
    if raw in supported:
        return raw
    for v in supported:
        if v.lower() == raw:
            return v
    from .errors import ErrorCode, http_exception

    raise http_exception(
        400,
        ErrorCode.VOICE_UNSUPPORTED,
        f"Voice '{voice}' not supported",
        supported=supported[:12],
    )


def get_model_voices(model_obj, model_id: str) -> List[str]:
    reg = MODEL_REGISTRY.get(model_id, {})
    if reg.get("has_preset_voices") and hasattr(model_obj, "get_supported_speakers"):
        try:
            return model_obj.get_supported_speakers()
        except Exception:
            pass
    return reg.get("default_voices", [])


def build_gen_kwargs(
    model_id: str,
    text: str,
    voice: str,
    speed: float,
    voices: List[str],
    *,
    language: str = "Auto",
    instruct: Optional[str] = None,
    stream: bool = False,
    streaming_interval: float = 1.0,
) -> Tuple[dict, str]:
    reg = MODEL_REGISTRY.get(model_id, {})
    kwargs: Dict[str, Any] = dict(text=text, verbose=False, max_tokens=4096)

    if reg.get("supports_native_speed", False):
        kwargs["speed"] = float(speed)
    else:
        kwargs["speed"] = 1.0

    if reg.get("has_preset_voices"):
        speaker = normalize_voice(voice, voices) if voices else voice
        kwargs["voice"] = speaker
        if reg.get("supports_lang_code"):
            kwargs["lang_code"] = normalize_lang(language)
        if instruct and reg.get("supports_instruct"):
            kwargs["instruct"] = instruct
    else:
        if voice and voice in FISH_VOICE_TAGS:
            kwargs["text"] = f"[{voice}] {text}"
        if instruct:
            kwargs["instruct"] = instruct

    if stream and reg.get("supports_streaming", True):
        kwargs["stream"] = True
        kwargs["streaming_interval"] = streaming_interval

    return kwargs, kwargs.get("lang_code", "auto")


def split_kokoro_chunks(text: str, max_chars: int = 400) -> List[str]:
    """Split text for Kokoro retries without rewriting spoken content.

    Chunks are exact substrings of the original input (no whitespace collapse
    or re-joining). That keeps the retry path free of text mutation.
    """
    if not (text or "").strip():
        return []
    if len(text) <= max_chars:
        return [text]

    parts: List[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= max_chars:
            parts.append(remaining)
            break

        window = remaining[:max_chars]
        split_at = window.rfind("\n\n")
        if split_at < max_chars // 4:
            split_at = -1
            for i in range(len(window) - 1, max_chars // 4, -1):
                if window[i - 1] in ".!?" and window[i].isspace():
                    split_at = i
                    break
            if split_at < 0:
                split_at = window.rfind(" ")
                if split_at < max_chars // 4:
                    split_at = max_chars

        chunk, remaining = remaining[:split_at], remaining[split_at:]
        if chunk.strip():
            parts.append(chunk)
        elif not remaining:
            break
        # Pure-whitespace slices are skipped; they carry no phonemes.
    return parts


def model_capabilities(model_id: str, voices: Optional[List[str]] = None) -> dict:
    reg = MODEL_REGISTRY.get(model_id, {})
    return {
        "id": model_id,
        "name": reg.get("display_name", model_id),
        "description": reg.get("description", ""),
        "supports_native_speed": reg.get("supports_native_speed", False),
        "supports_streaming": reg.get("supports_streaming", True),
        "supports_lang_code": reg.get("supports_lang_code", False),
        "supports_instruct": reg.get("supports_instruct", False),
        "has_preset_voices": reg.get("has_preset_voices", False),
        "default_voice": reg.get("default_voice"),
        "voices": voices or reg.get("default_voices", []),
    }