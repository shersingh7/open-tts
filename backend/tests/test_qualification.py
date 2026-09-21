"""Isolated script/fixture qualification; no live server or Chrome."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]
_SAFE_POPEN = subprocess.Popen
sys.path.insert(0, str(ROOT/'scripts'))
from stream_probe import measure_stream
from open_tts.coordinator import ModelCoordinator
from open_tts.protocol import unpack_frames, pack_frame
from open_tts.text import normalize_text


def module(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_ten_thousand_words_actual_v2_frames_and_incremental_probe(fake_loader):
    coord=ModelCoordinator();coord.load('kokoro')
    text=' '.join(f'Word{i}.' for i in range(10000))
    # Transport partitions only; preserve spaces and exact coverage per request text.
    texts=[normalize_text(text[i:i+40000]) for i in range(0,len(text),40000)]
    frames=list(coord.stream_batch_frames('kokoro',texts,'af_bella',1,protocol_version=2))
    wire=[]
    for sequence,raw in enumerate(frames):
        parsed,rest=unpack_frames(raw);assert not rest
        header,audio=parsed[0]
        assert not header.get('error')
        wire.append(pack_frame({**header,'sequence':sequence,'protocol_version':2},audio))
    wire.append(pack_frame({'protocol_version':2,'sequence':len(wire),'done':True,'outcome':'completed'}))
    class Fragmented(io.BytesIO):
        def read(self,n=-1):
            assert n >= 0, 'No unbounded whole-response read'
            return super().read(min(n,17))
    report=measure_stream(Fragmented(b''.join(wire)),source_lengths=list(map(len,texts)))
    assert report['ok'] and report['units']>50 and report['frames']>50
    assert report['first_audio_packet_seconds'] < report['wall_seconds']
    assert report['normalized_rtf'] >= 0
    assert report['maximum_frame_bytes'] < 200000
    assert report['audible_playback_verified'] is False


def test_nonnative_first_passage_escapes_before_next_generation(fake_loader):
    coord=ModelCoordinator();coord.load('qwen3-tts')
    model=fake_loader['qwen3-tts'];before=model.calls
    stream=coord.stream_batch_frames('qwen3-tts',['A clear sentence. '*500],'ryan',1.5,protocol_version=2)
    raw=next(stream)
    header,audio=unpack_frames(raw)[0][0]
    assert audio and header['end']<=320
    assert model.calls == before+1
    assert header['first_pcm_seconds']>=header['model_ready_seconds']>=0
    stream.close()


def test_launchagent_default_is_on_demand_in_fake_home(monkeypatch,tmp_path):
    if sys.platform != 'darwin': pytest.skip('macOS plist lint test')
    home=tmp_path/'home';home.mkdir()
    commands=tmp_path/'commands';commands.mkdir()
    trace=tmp_path/'launchctl-calls'
    stub=commands/'launchctl'
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\n')
    stub.chmod(0o700)
    env={**os.environ,'HOME':str(home),'PATH':str(commands)+os.pathsep+os.environ['PATH'],'TRACE':str(trace)}
    # Explicit exception for this one shell child; launchctl is a logging stub.
    with monkeypatch.context() as safe:
        safe.setattr(subprocess,'Popen',_SAFE_POPEN)
        subprocess.run(['/bin/bash',str(ROOT/'backend/install_launch_agent.sh')],env=env,check=True,capture_output=True)
    import plistlib
    plist=home/'Library/LaunchAgents/com.open-tts.server.plist'
    with plist.open('rb') as file: data=plistlib.load(file)
    assert data['RunAtLoad'] is False and data['KeepAlive'] is False
    assert 'kickstart' not in trace.read_text()
    assert 'bootstrap' in trace.read_text()


def test_qualification_scripts_refuse_without_opt_in(monkeypatch,tmp_path):
    import urllib.request
    def forbidden(*a,**kw): raise AssertionError('No network before opt-in')
    monkeypatch.setattr(urllib.request,'urlopen',forbidden)
    runner=module('verify_long_text',ROOT/'scripts/verify-long-text.py')
    with pytest.raises(SystemExit) as caught:
        runner.main(['--base-url','http://127.0.0.1:18001','--runtime-dir',str(tmp_path),
                     '--text-file',str(tmp_path/'input'),'--model','kokoro','--output',str(tmp_path/'output')])
    assert caught.value.code == 2
    with pytest.raises(ValueError): runner.validated_base('http://127.0.0.1:8000')
    with pytest.raises(ValueError): runner.validated_base('https://example.com:8080')
    assert runner.validated_base('http://127.0.0.1:18001') == 'http://127.0.0.1:18001'
    matrix=module('model_matrix',ROOT/'scripts/model-matrix.py')
    monkeypatch.setattr(sys,'argv',['model-matrix','--base-url','http://127.0.0.1:18001',
                                  '--runtime-dir',str(tmp_path),'--models','kokoro'])
    with pytest.raises(SystemExit) as caught: matrix.main()
    assert caught.value.code == 2
