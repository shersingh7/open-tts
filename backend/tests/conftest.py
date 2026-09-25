"""Pytest fixtures with fake MLX adapters."""

from __future__ import annotations

import threading
import time

import numpy as np
import pytest


class FakeResult:
    def __init__(self, audio=None, sample_rate=24000, is_final_chunk=False):
        self.audio = audio if audio is not None else np.zeros(2400, dtype=np.float32)
        self.sample_rate = sample_rate
        self.real_time_factor = 0.1
        self.is_final_chunk = is_final_chunk


class FakeModel:
    """Fake mlx-audio model.

    Streaming generate() yields multiple delayed parts so tests can observe
    the first audio frame *before* later parts are produced.
    """

    def __init__(self, model_id: str):
        self.model_id = model_id
        self.calls = 0
        self.fail_warm = False
        self.fail_generate = False
        self.stream_supported = model_id != "fish-s2-pro"
        self.stream_parts = 3
        self.part_lengths = None
        self.part_signals = None
        self.part_delay = 0.0
        self.part_gate: threading.Event | None = None
        self.hold_generate: threading.Event | None = None
        self.generate_started = threading.Event()
        self.parts_yielded = 0
        self.last_kwargs: dict = {}

    def get_supported_speakers(self):
        return ["af_bella", "ryan"]

    def _is_warmup(self, kwargs: dict) -> bool:
        return kwargs.get("text") == "Warmup" or kwargs.get("max_tokens") == 128

    def generate(self, **kwargs):
        self.calls += 1
        self.last_kwargs = dict(kwargs)
        if self.fail_generate and not self._is_warmup(kwargs):
            raise RuntimeError("generate failed")

        if self._is_warmup(kwargs):
            yield FakeResult()
            return

        self.generate_started.set()
        if self.hold_generate is not None:
            self.hold_generate.wait(timeout=15)

        streaming = bool(kwargs.get("stream"))
        n = self.stream_parts if streaming else 1
        self.parts_yielded = 0
        for i in range(n):
            if i > 0:
                if self.part_gate is not None:
                    self.part_gate.wait(timeout=15)
                if self.part_delay:
                    time.sleep(self.part_delay)
            if self.part_signals is not None:
                audio = np.asarray(self.part_signals[min(i, len(self.part_signals) - 1)], dtype=np.float32)
            else:
                n_samp = 2400
                if self.part_lengths:
                    n_samp = int(self.part_lengths[min(i, len(self.part_lengths) - 1)])
                audio = np.zeros(max(n_samp, 1), dtype=np.float32)
                audio[0] = float(i + 1)
            self.parts_yielded += 1
            yield FakeResult(audio=audio, is_final_chunk=(i == n - 1))


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    """Ordinary tests must never sign, signal, launch or load production assets."""
    import native_host
    import open_tts.security as security
    import open_tts.coordinator as coordinator_module
    import mlx_audio.tts.utils as utils

    def forbidden(*args, **kwargs):
        raise AssertionError("Live runtime operation forbidden in offline tests")

    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")
    monkeypatch.setenv("OPEN_TTS_EAGER_LOAD", "0")
    monkeypatch.setattr(utils, "load_model", forbidden)
    monkeypatch.setattr(coordinator_module, "_clear_gpu_memory", lambda: None)
    monkeypatch.setattr(native_host, "_sign_native_dylibs_if_darwin", lambda: None)
    monkeypatch.setattr(native_host.subprocess, "Popen", forbidden)
    monkeypatch.setattr(native_host.os, "kill", forbidden)
    monkeypatch.setattr(native_host.os, "killpg", forbidden)
    monkeypatch.setattr(native_host, "is_port_in_use", forbidden)
    monkeypatch.setattr(native_host, "get_pid_on_port", forbidden)
    monkeypatch.setattr(native_host, "_fetch_health", forbidden)
    monkeypatch.setattr(native_host, "RUNTIME_DIR", tmp_path)
    for name in ("PID_FILE", "LOG_FILE", "LOCK_FILE", "TOKEN_FILE"):
        monkeypatch.setattr(native_host, name, tmp_path / name.lower())
    monkeypatch.setattr(security, "TOKEN_FILE", tmp_path / "token")


@pytest.fixture
def fake_loader(monkeypatch):
    models = {}

    def load_model(path):
        mid, p = "kokoro", str(path).lower()  # CI has no local models: path is the HF id ("Qwen3-TTS-...")
        if "qwen" in p:
            mid = "qwen3-tts"
        if "fish" in p:
            mid = "fish-s2-pro"
        model = FakeModel(mid)
        models[mid] = model
        return model

    monkeypatch.setattr("mlx_audio.tts.utils.load_model", load_model)
    return models
