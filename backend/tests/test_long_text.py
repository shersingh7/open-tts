from __future__ import annotations

import threading
import numpy as np
import pytest
from fastapi import HTTPException
from open_tts.audio import PhraseStreamPacker, as_mono_pcm, time_stretch
from open_tts.coordinator import ModelCoordinator
from open_tts.errors import AudioValidationError
from open_tts.protocol import unpack_frames
from open_tts.text import normalize_text, pack_generation_units, sentence_units
from tests.conftest import FakeResult


def pack(signal, cuts, speed=1.0, native=True):
    p = PhraseStreamPacker(speed=speed, native=native, phrase_seconds=0.01, max_emit_seconds=0.1)
    out=[]
    for piece in np.split(signal, cuts):
        emitted=p.push(piece,24000)
        if emitted is not None:
            out.append(emitted)
        out.extend(p.take_all())
    out.extend(p.drain())
    return np.concatenate(out)


def test_native_packetization_preserves_every_sample():
    rng=np.random.default_rng(5)
    x=rng.uniform(-0.5,0.5,100000).astype(np.float32)
    for cuts in ([1,7,500,30000,99999], list(range(1000,100000,1000))):
        np.testing.assert_array_equal(pack(x,cuts),x)


@pytest.mark.parametrize('speed',[0.5,1,1.5,2,3])
def test_nonnative_transform_independent_of_model_packets(speed):
    x=(0.4*np.sin(2*np.pi*220*np.arange(48000)/24000)).astype(np.float32)
    y=pack(x,[1,100,999,24000,47000],speed,False)
    z=pack(x,[6000,18000],speed,False)
    np.testing.assert_array_equal(y,z)
    assert len(y)==round(len(x)/speed)
    freq=np.fft.rfftfreq(len(y),1/24000)[np.argmax(np.abs(np.fft.rfft(y*np.hanning(len(y)))))]
    assert abs(freq-220)<15
    assert np.max(np.abs(y))<=0.401


@pytest.mark.parametrize('signal',[np.array([float('nan')]),np.ones((2,20)),np.array([float('inf')])])
def test_rejects_invalid_pcm(signal):
    with pytest.raises(AudioValidationError):
        as_mono_pcm(signal)


def test_rate_change_rejected_and_singleton_mono_supported():
    np.testing.assert_array_equal(as_mono_pcm(np.ones((1,1))),np.ones(1))
    p=PhraseStreamPacker(speed=1,native=True)
    p.push(np.ones(20),24000)
    with pytest.raises(AudioValidationError,match='rate change'):
        p.push(np.ones(20),48000)


def test_structural_text_and_abbreviation_preserved():
    text='Dr. Smith paid 3.50. “Really?” she asked.\n\nNext paragraph.\n- One\n- Two'
    normalized=normalize_text(text)
    assert '\n\n' in normalized and '\n- Two' in normalized
    assert sentence_units(text)[0]=='Dr. Smith paid 3.50. '
    assert ''.join(pack_generation_units(text,40,100))==text
    assert max(map(len,pack_generation_units('x'*1000,100,200)))<=200


def test_no_retry_after_first_yield(fake_loader):
    coord=ModelCoordinator();coord.load('kokoro');calls=[]
    def generate(**kwargs):
        calls.append(kwargs['text'])
        yield FakeResult(np.ones(100))
        raise ValueError('broadcast_shapes')
    model=fake_loader['kokoro'];model.generate=generate
    stream=coord._iter_audio_results(model,{'text':'Long sentence. '*100},'kokoro')
    assert next(stream)[0].size==100
    with pytest.raises(HTTPException):
        next(stream)
    assert len(calls)==1


def test_cancelled_lock_wait_never_enters_model(fake_loader):
    coord=ModelCoordinator();coord.load('kokoro');cancel=threading.Event();started=threading.Event();result=[]
    model=fake_loader['kokoro'];before=model.calls
    def run():
        started.set()
        result.extend(coord.stream_batch_frames('kokoro',['Hello'],'af_bella',1,cancel_check=cancel.is_set))
    with coord._operation_lock:
        worker=threading.Thread(target=run);worker.start();assert started.wait(1);cancel.set()
    worker.join(2);assert not worker.is_alive();assert model.calls==before
    assert unpack_frames(b''.join(result))[0][0][0]['code']=='stream_cancelled'


def test_error_stops_before_later_passages(fake_loader):
    coord=ModelCoordinator();coord.load('kokoro');model=fake_loader['kokoro'];model.fail_generate=True
    before=model.calls
    frames=list(coord.stream_batch_frames('kokoro',['Bad first.','Never read.'],'af_bella',1))
    headers=[x[0] for x in unpack_frames(b''.join(frames))[0]]
    assert headers[0]['error'];assert not any(h.get('final') for h in headers)
    assert model.calls==before+1


def test_semantic_audio_memory_limit_is_explicit():
    p=PhraseStreamPacker(speed=2,native=False)
    with pytest.raises(AudioValidationError,match='32 MiB'):
        p.push(np.zeros(8*1024*1024+1,dtype=np.float32),24000)


@pytest.mark.parametrize("model_id", ["kokoro", "qwen3-tts", "fish-s2-pro"])
def test_empty_semantic_unit_is_not_silently_skipped(fake_loader, monkeypatch, model_id):
    coord = ModelCoordinator()
    coord.load(model_id)
    from open_tts.text import GenerationUnit
    monkeypatch.setattr("open_tts.coordinator.plan_generation_units", lambda *args, **kw: [GenerationUnit(i, 0, i*10, i*10+len(t), t, "sentence") for i,t in enumerate(["First.", "Missing.", "Last."])])
    calls = []
    def generate(**kwargs):
        calls.append(kwargs["text"])
        if kwargs["text"] != "Missing.":
            yield FakeResult(np.ones(30000, dtype=np.float32) * 0.1)
    fake_loader[model_id].generate = generate
    frames = list(coord.stream_batch_frames(model_id, ["Fixture"], "af_bella", 1))
    headers = [h for h, _ in unpack_frames(b"".join(frames))[0]]
    assert any(h.get("error") for h in headers)
    assert not any(h.get("final") for h in headers)
    assert calls == ["First.", "Missing."]
