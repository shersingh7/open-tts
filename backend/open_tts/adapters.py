"""Model adapter helpers and Kokoro-safe chunking."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .config import STREAMING_INTERVAL
from .registry import FISH_VOICE_TAGS, MODEL_REGISTRY, normalize_lang


def resolve_voice(model_id: str, voice: str, supported: List[str]) -> str:
    """Pick a voice the model can actually speak.

    The extension used to send the last global ``voice`` (often Kokoro's
    af_bella) after switching to Qwen, which made generate fail and the
    Speak button flash red with no audio.
    """
    if not supported:
        return (voice or "").strip()
    try:
        return normalize_voice(voice, supported)
    except Exception:
        pass
    default = MODEL_REGISTRY.get(model_id, {}).get("default_voice")
    if default:
        try:
            return normalize_voice(default, supported)
        except Exception:
            pass
    return supported[0]


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
    streaming_interval: Optional[float] = None,
) -> Tuple[dict, str]:
    reg = MODEL_REGISTRY.get(model_id, {})
    kwargs: Dict[str, Any] = dict(text=text, verbose=False, max_tokens=4096)

    if reg.get("supports_native_speed", False):
        kwargs["speed"] = float(speed)
    else:
        kwargs["speed"] = 1.0

    if reg.get("has_preset_voices"):
        speaker = resolve_voice(model_id, voice, voices) if voices else voice
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
        kwargs["streaming_interval"] = (
            STREAMING_INTERVAL if streaming_interval is None else float(streaming_interval)
        )

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


def split_stream_text(text: str, first_max: int = 400, rest_max: int = 2000) -> List[str]:
    """Split so the first generate() is small enough for early first audio.

    Slices are exact substrings of the original input. A short first slice
    keeps time-to-first-audio off an 8k-char generate() when the model
    yields only once per call.
    """
    if not text:
        return []
    if len(text) <= first_max:
        return [text]

    head = split_kokoro_chunks(text, max_chars=first_max)
    if not head:
        return [text]
    first = head[0]
    if text.startswith(first):
        remainder = text[len(first):]
    else:
        idx = text.find(first)
        remainder = text[idx + len(first):] if idx >= 0 else ""
    if not remainder:
        return [first]
    if len(remainder) <= rest_max:
        return [first, remainder]
    return [first, *split_kokoro_chunks(remainder, max_chars=rest_max)]


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