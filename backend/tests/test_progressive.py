"""Regressions for progressive long-form production paths (offline)."""
import threading
from types import SimpleNamespace
import numpy as np
import pytest
from fastapi import HTTPException
from open_tts.coordinator import ModelCoordinator
from open_tts.audio import PhraseStreamPacker
from open_tts.protocol import unpack_frames


def test_cancel_before_advancing_model_again():
    calls = []
    cancelled = threading.Event()
    def generate(**kwargs):
        for i in range(3):
            calls.append(i)
            yield SimpleNamespace(audio=np.zeros(2400), sample_rate=24000)
    stream = ModelCoordinator()._iter_audio_results(SimpleNamespace(generate=generate), {}, "kokoro", cancel_check=cancelled.is_set)
    next(stream)
    cancelled.set()
    with pytest.raises(HTTPException):
        next(stream)
    assert calls == [0]


def test_default_packets_are_short_and_sample_preserving():
    source = np.arange(24000 * 21, dtype=np.float32)
    packer = PhraseStreamPacker(speed=1, native=True)
    first = packer.push(source, 24000)
    packets = ([first] if first is not None else []) + packer.drain()
    assert max(len(p) / 24000 for p in packets) <= 4
    np.testing.assert_array_equal(np.concatenate(packets), source)


@pytest.mark.parametrize("model", ["kokoro", "qwen3-tts", "fish-s2-pro"])
def test_planner_ten_thousand_words_exact(model):
    from open_tts.text import plan_generation_units
    text = " ".join(f"Word{i}." for i in range(10000))
    units = plan_generation_units(text, model)
    assert "".join(u.text for u in units) == text
    assert units[0].end <= 600
    assert all(u.text == text[u.start:u.end] and u.text.strip() for u in units)
    assert [u.unit_id for u in units] == list(range(len(units)))
    assert max(len(u.text) for u in units) <= 1200


def test_unit_ids_continue_across_transport_partitions():
    from open_tts.text import plan_generation_units
    first = plan_generation_units("Sentence. " * 200, "qwen3-tts")
    second = plan_generation_units("Sentence. " * 200, "qwen3-tts", transport_index=1, first_unit_id=len(first))
    assert second[0].unit_id == len(first)
    assert len(second[0].text) > len(first[0].text)
    assert second[0].transport_index == 1
