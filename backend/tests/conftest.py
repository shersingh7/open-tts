"""Pytest fixtures with fake MLX adapters."""

from __future__ import annotations

import numpy as np
import pytest


class FakeResult:
    def __init__(self, audio=None, sample_rate=24000, is_final_chunk=False):
        self.audio = audio if audio is not None else np.zeros(2400, dtype=np.float32)
        self.sample_rate = sample_rate
        self.real_time_factor = 0.1
        self.is_final_chunk = is_final_chunk


class FakeModel:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.calls = 0
        self.fail_warm = False
        self.fail_generate = False
        self.stream_supported = model_id != "fish-s2-pro"

    def get_supported_speakers(self):
        return ["af_bella", "ryan"]

    def generate(self, **kwargs):
        self.calls += 1
        if self.fail_generate:
            raise RuntimeError("generate failed")
        if kwargs.get("stream"):
            yield FakeResult(is_final_chunk=True)
            return
        yield FakeResult()


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