#!/usr/bin/env python3
"""Real-model verification harness (requires downloaded models)."""

from __future__ import annotations

import argparse
import sys
import wave
import io
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILE = ROOT / ".open_tts_token"


def token() -> str:
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    return ""


def synth(client: httpx.Client, model: str, text: str, speed: float, voice: str) -> bytes:
    r = client.post(
        "/v1/synthesize",
        json={"text": text, "model": model, "voice": voice, "speed": speed, "format": "wav"},
        timeout=600,
    )
    r.raise_for_status()
    assert r.headers.get("content-type", "").startswith("audio/")
    assert len(r.content) > 44
    with wave.open(io.BytesIO(r.content), "rb") as wf:
        assert wf.getnframes() > 0
    return r.content


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--models", default="kokoro,qwen3-tts,fish-s2-pro")
    args = parser.parse_args()

    headers = {"X-Open-TTS-Token": token()} if token() else {}
    client = httpx.Client(base_url=args.base, headers=headers, timeout=600)

    health = client.get("/health")
    health.raise_for_status()
    print("health:", health.json())

    voices = {
        "kokoro": "af_bella",
        "qwen3-tts": "ryan",
        "fish-s2-pro": "whisper",
    }
    speeds = [0.5, 1.0, 1.5, 2.0, 3.0]
    texts = [
        "Short.",
        "Hello — punctuation test!",
        "This is a longer passage meant to exercise chunking behavior across sentence boundaries without changing semantics.",
    ]

    for model in [m.strip() for m in args.models.split(",") if m.strip()]:
        print(f"\n=== {model} ===")
        try:
            lr = client.post(f"/v1/load-model?model_id={model}")
            lr.raise_for_status()
        except Exception as exc:
            print(f"SKIP {model}: load failed ({exc})")
            continue
        voice = voices.get(model, "af_bella")
        for speed in speeds:
            try:
                audio = synth(client, model, texts[0], speed, voice)
                print(f"  speed {speed}: OK ({len(audio)} bytes)")
            except Exception as exc:
                print(f"  speed {speed}: FAIL ({exc})")
        for text in texts[1:]:
            try:
                audio = synth(client, model, text, 1.0, voice)
                print(f"  text chunk: OK ({len(audio)} bytes)")
            except Exception as exc:
                print(f"  text chunk: FAIL ({exc})")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())