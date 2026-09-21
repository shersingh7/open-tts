#!/usr/bin/env python3
"""Run real-model Open TTS synthesis checks and emit a machine-readable report."""

from __future__ import annotations

import argparse
import io
import json
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import soundfile as sf
from stream_probe import measure_stream

AUTH_HEADERS = {}

DEFAULT_SPEEDS = (0.5, 1.0, 1.5, 2.0, 3.0)
VOICES = {"kokoro": "af_bella", "qwen3-tts": "ryan", "fish-s2-pro": "whisper"}
SHORT_TEXT = "Open TTS is testing punctuation: commas, pauses, and a final question?"
LONG_TEXT = " ".join(
    [
        "This is a deliberately long multi-chunk verification passage for Open TTS.",
        "It checks sentence boundaries, punctuation, queueing, and gapless playback behavior.",
        "No words are appended or changed by retry logic, because spoken semantics must remain intact.",
    ]
    * 8
)


def request_json(url: str, *, method: str = "GET", body=None, timeout: int = 900):
    payload = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=payload, method=method, headers=AUTH_HEADERS)
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read()), dict(response.headers)


def synthesize(base: str, model: str, speed: float, text: str, timeout: int):
    body = {
        "text": text,
        "model": model,
        "voice": VOICES[model],
        "speed": speed,
        "format": "wav",
    }
    started = time.perf_counter()
    req = urllib.request.Request(
        f"{base}/v1/synthesize",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", **AUTH_HEADERS},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        audio = response.read()
        headers = dict(response.headers)
        status = response.status
    with sf.SoundFile(io.BytesIO(audio)) as wav:
        frames, sample_rate, channels = len(wav), wav.samplerate, wav.channels
    if frames <= 0 or sample_rate <= 0:
        raise ValueError("Decoded WAV is empty")
    return {
        "ok": True,
        "status": status,
        "bytes": len(audio),
        "sample_rate": sample_rate,
        "channels": channels,
        "duration_seconds": round(frames / sample_rate, 4),
        "wall_seconds": round(time.perf_counter() - started, 4),
        "content_type": headers.get("Content-Type"),
        "apply_playback_rate": headers.get("X-TTS-Apply-Playback-Rate"),
        "playback_rate": headers.get("X-TTS-Playback-Rate"),
    }


def synthesize_stream(base: str, model: str, speed: float, text: str, timeout: int):
    body = {"texts":[text], "model":model, "voice":VOICES[model], "speed":speed, "protocol_version":2}
    req = urllib.request.Request(f"{base}/v1/synthesize-stream-batch",data=json.dumps(body).encode(),
                                 method="POST",headers={"Content-Type":"application/json",**AUTH_HEADERS})
    started=time.perf_counter()
    with urllib.request.urlopen(req,timeout=timeout) as response:
        return measure_stream(response,started=started,version=2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--authorize-real-audio", action="store_true")
    parser.add_argument("--authorize-model-switches", action="store_true")
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--models", nargs="+", choices=list(VOICES), required=True)
    parser.add_argument("--speeds", nargs="+", type=float, default=list(DEFAULT_SPEEDS))
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--output", type=Path, default=Path("artifacts/model-matrix.json"))
    parser.add_argument("--skip-long", action="store_true")
    args = parser.parse_args()
    if not args.authorize_real_audio:
        parser.error("Explicit --authorize-real-audio is required")
    parsed=urllib.parse.urlsplit(args.base_url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1","::1") or not parsed.port or parsed.port == 8000 or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        parser.error("An isolated loopback URL/port is required; production port 8000 refused")
    if len(args.models)>1 and not args.authorize_model_switches:
        parser.error("Multiple models require --authorize-model-switches")
    runtime=args.runtime_dir.resolve()
    if runtime == (Path(__file__).resolve().parents[1]/"backend").resolve():
        parser.error("Production runtime directory refused")
    global AUTH_HEADERS
    AUTH_HEADERS={"X-Open-TTS-Token":(runtime/".open_tts_token").read_text().strip(),
                  "Origin":"chrome-extension://"+"a"*32}
    base = args.base_url.rstrip("/")
    report = {"base_url": base, "models": {}, "started_at": time.time()}

    health, _ = request_json(f"{base}/health", timeout=10)
    if health.get("gpu_busy") or health.get("state") in ("loading","warming","generating"):
        parser.error("Target is busy; refusing model matrix")
    if health.get("model_loaded") and health.get("model") != args.models[0] and not args.authorize_model_switches:
        parser.error("Refusing to switch the loaded model without --authorize-model-switches")
    if health.get("engine") != "open-tts":
        raise RuntimeError("Endpoint is not Open TTS")

    for model in args.models:
        model_report = {"load": None, "speeds": {}, "streaming": {}, "long_text": None}
        report["models"][model] = model_report
        try:
            load, _ = request_json(
                f"{base}/v1/load-model?{urllib.parse.urlencode({'model_id': model, 'force': 'false'})}",
                method="POST",
                timeout=args.timeout,
            )
            model_report["load"] = {"ok": True, "response": load}
            for speed in args.speeds:
                try:
                    model_report["speeds"][str(speed)] = synthesize(
                        base, model, speed, SHORT_TEXT, args.timeout
                    )
                except Exception as exc:  # keep the complete matrix
                    model_report["speeds"][str(speed)] = {"ok": False, "error": repr(exc)}
                try:
                    model_report["streaming"][str(speed)] = synthesize_stream(
                        base, model, speed, SHORT_TEXT, args.timeout
                    )
                except Exception as exc:
                    model_report["streaming"][str(speed)] = {"ok": False, "error": repr(exc)}
            if not args.skip_long:
                try:
                    model_report["long_text"] = synthesize(base, model, 1.5, LONG_TEXT, args.timeout)
                except Exception as exc:
                    model_report["long_text"] = {"ok": False, "error": repr(exc)}
        except Exception as exc:
            model_report["load"] = {"ok": False, "error": repr(exc)}

    report["finished_at"] = time.time()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    all_ok = all(
        data.get("load", {}).get("ok")
        and all(item.get("ok") for item in data.get("speeds", {}).values())
        and all(item.get("ok") for item in data.get("streaming", {}).values())
        and (args.skip_long or data.get("long_text", {}).get("ok"))
        for data in report["models"].values()
    )
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
