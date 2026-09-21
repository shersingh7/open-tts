"""Offline acceptance tests for ownership, admission, byte caps and v2."""
import asyncio
import queue
import threading
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from open_tts.api import create_app
from open_tts.runtime import ModelRuntime, FrameQueue, check_job
from open_tts.coordinator import ModelCoordinator, coordinator
from open_tts.protocol import unpack_frames
from open_tts.security import BoundedBodyMiddleware
from open_tts.config import MAX_BODY_BYTES


def test_owner_serializes_and_cancellation_does_not_release_live_call():
    gate, started = threading.Event(), threading.Event()
    calls, cleanup = [], []
    runtime = ModelRuntime(cleanup=lambda: cleanup.append(threading.get_ident()))
    def stubborn(cancel):
        calls.append(threading.get_ident()); started.set(); gate.wait(2); check_job()
    first = runtime.submit(stubborn)
    assert started.wait(1)
    second = runtime.submit(lambda cancel: calls.append(threading.get_ident()))
    first.cancel.set()
    with pytest.raises(HTTPException) as caught:
        runtime.submit(lambda cancel: None)
    assert caught.value.status_code == 503
    assert runtime.snapshot()['jobs'] == 2
    second.cancel.set()
    assert not runtime.shutdown(timeout=0.01)
    assert cleanup == []
    gate.set()
    assert runtime.shutdown(timeout=2)
    assert len(calls) == 1 and cleanup == calls
    assert first.future.exception().status_code == 499
    assert second.future.exception().status_code == 499
    assert runtime.snapshot()['jobs'] == 0


def test_frame_queue_bounds_bytes_not_just_count():
    q = FrameQueue(4, max_bytes=7)
    q.put(b'1234')
    with pytest.raises(queue.Full): q.put(b'5678', block=False)
    assert q.bytes == 4
    assert q.get_nowait() == b'1234'
    q.put(b'5678', block=False)
    assert q.peak_bytes == 4
    with pytest.raises(ValueError): q.put(b'x'*8)


def test_preparse_body_limit_without_content_length():
    called, sent = [], []
    async def downstream(*args): called.append(True)
    parts = iter([{'type':'http.request','body':b'x'*(MAX_BODY_BYTES//2),'more_body':True}]*3)
    async def receive(): return next(parts)
    async def send(message): sent.append(message)
    middleware = BoundedBodyMiddleware(downstream)
    asyncio.run(middleware({'type':'http','method':'POST','path':'/v1/synthesize','headers':[]},receive,send))
    assert not called
    assert sent[0]['status'] == 413
    assert middleware._reading == 0


def test_v2_audio_units_cover_normalized_unicode_source(fake_loader):
    coordinator.shutdown()
    text = 'Dr. Smith said “bonjour 😀”.\n\n' + 'Une phrase française. ' * 50
    from open_tts.text import normalize_text
    with TestClient(create_app()) as client:
        result = client.post('/v1/synthesize-stream-batch', json={
            'texts':[text], 'model':'kokoro', 'voice':'af_bella', 'protocol_version':2})
        assert result.status_code == 200
        frames, rest = unpack_frames(result.content)
        assert not rest
        headers = [h for h,_ in frames]
        assert [h['sequence'] for h in headers] == list(range(len(headers)))
        assert all(h['protocol_version'] == 2 for h in headers)
        units = [h for h in headers if h.get('unit_final')]
        assert units[0]['start'] == 0
        assert units[-1]['end'] == len(normalize_text(text))
        assert all(a['end'] == b['start'] for a,b in zip(units,units[1:]))
        assert headers[-1]['outcome'] == 'completed'
        assert sum(bool(h.get('done')) for h in headers) == 1
        assert max(len(audio) for _,audio in frames) < 200000


def test_reported_token_exhaustion_is_not_completed():
    model = SimpleNamespace(generate=lambda **kwargs: iter([
        SimpleNamespace(audio=np.zeros(10),sample_rate=24000,token_count=8)]))
    with pytest.raises(HTTPException, match='token limit'):
        list(ModelCoordinator()._iter_audio_results(model, {'max_tokens':8}, 'qwen3-tts'))


def test_full_response_memory_limit_is_explicit(fake_loader, monkeypatch):
    import open_tts.coordinator as module
    monkeypatch.setattr(module, 'MAX_FULL_PCM_BYTES', 4)
    coord = ModelCoordinator(); coord.load('kokoro')
    with pytest.raises(HTTPException) as caught: coord.generate_full('kokoro','Hello','af_bella',1)
    assert caught.value.status_code == 413


def test_batch_response_memory_limit_is_explicit(fake_loader, monkeypatch):
    import open_tts.coordinator as module
    monkeypatch.setattr(module, 'MAX_BATCH_OUTPUT_BYTES', 4)
    coord = ModelCoordinator(); coord.load('kokoro')
    with pytest.raises(HTTPException) as caught: coord.generate_batch('kokoro',['Hello'],'af_bella',1)
    assert caught.value.status_code == 413


def test_capabilities_and_legacy_speech_contract(fake_loader):
    coordinator.shutdown()
    with TestClient(create_app()) as client:
        caps = client.get('/v1/capabilities').json()
        assert caps['protocol_versions'] == [1,2]
        assert caps['limits']['frame_seconds'] <= 4
        for route in ['/v1/audio/speech','/v1/speech']:
            response = client.post(route,json={'input':'Hello','stream':True})
            assert response.status_code == 400
        bad = client.post('/v1/synthesize',json={'text':'hello','instruct':'a'*2001})
        assert bad.status_code == 422


def test_native_group_signal_requires_isolated_session(monkeypatch):
    import native_host as host
    calls=[]
    monkeypatch.setattr(host.os,'getpgid',lambda pid:100)
    monkeypatch.setattr(host.os,'getsid',lambda pid:100)
    monkeypatch.setattr(host.os,'kill',lambda pid,sig:calls.append(('pid',pid)))
    monkeypatch.setattr(host.os,'killpg',lambda pid,sig:calls.append(('group',pid)))
    host._kill_process_group(200,15)
    assert calls == [('pid',200)]
    host._kill_process_group(100,15)
    assert calls[-1] == ('group',100)


def test_native_stop_keeps_pid_until_exit(monkeypatch):
    import native_host as host
    host.PID_FILE.write_text('200')
    monkeypatch.setattr(host,'get_pid_on_port',lambda:200)
    monkeypatch.setattr(host,'_is_open_tts_process',lambda pid:True)
    monkeypatch.setattr(host,'_kill_process_group',lambda *args:None)
    monkeypatch.setattr(host,'_wait_for_exit',lambda *args,**kwargs:False)
    success, message = host.kill_owned_server()
    assert not success and 'pending' in message
    assert host.PID_FILE.read_text() == '200'


def test_native_exited_child_is_not_reported_as_starting(monkeypatch):
    import native_host as host
    monkeypatch.setattr(host, 'is_port_in_use', lambda *a: False)
    monkeypatch.setattr(host, '_read_pid_file', lambda: None)
    monkeypatch.setattr(host.subprocess, 'Popen', lambda *a, **kw: SimpleNamespace(pid=200, poll=lambda: 1))
    monkeypatch.setattr(host.time, 'sleep', lambda value: None)
    success, message, token = host.start_server()
    assert not success and 'failed' in message.lower() and token is None
    assert not host.PID_FILE.exists()

