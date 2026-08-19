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
            n_samp = 2400
            if self.part_lengths:
                n_samp = int(self.part_lengths[min(i, len(self.part_lengths) - 1)])
            audio = np.zeros(max(n_samp, 1), dtype=np.float32)
            audio[0] = float(i + 1)
            self.parts_yielded += 1
            yield FakeResult(audio=audio, is_final_chunk=(i == n - 1))


@pytest.fixture
def fake_loader(monkeypatch):
    models = {}

    def load_model(path):
        mid = "kokoro"
        if "qwen" in str(path):
            mid = "qwen3-tts"
        if "fish" in str(path):
            mid = "fish-s2-pro"
        model = FakeModel(mid)
        models[mid] = model
        return model

    monkeypatch.setattr("mlx_audio.tts.utils.load_model", load_model)
    return models
