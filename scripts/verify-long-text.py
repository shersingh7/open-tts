#!/usr/bin/env python3
"""Explicitly authorized HTTP-only qualification; never launches/switches servers.

Run --help first. The default invocation performs no network or inference.
Real Chrome playback and listening remain separate manual qualification gates.
"""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

from stream_probe import measure_stream


def validated_base(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1','::1') or
        not parsed.port or parsed.port == 8000 or parsed.username or parsed.password or
        parsed.path not in ('','/') or parsed.query or parsed.fragment):
        raise ValueError('Use an explicit isolated loopback HTTP port other than production port 8000')
    return value.rstrip('/')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--authorize-real-audio', action='store_true', help='Explicitly permit inference on the already-running isolated instance')
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--runtime-dir', type=Path, required=True, help='Isolated server runtime directory containing its token')
    parser.add_argument('--text-file', type=Path, required=True)
    parser.add_argument('--model', choices=['kokoro','qwen3-tts','fish-s2-pro'], required=True)
    parser.add_argument('--voice')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    if not args.authorize_real_audio:
        parser.error('Refusing network/inference without --authorize-real-audio')
    try:
        base = validated_base(args.base_url)
    except ValueError as error:
        parser.error(str(error))
    backend = Path(__file__).resolve().parents[1]/'backend'
    runtime = args.runtime_dir.resolve()
    if runtime == backend.resolve() or not runtime.is_dir():
        parser.error('An existing isolated runtime directory is required; production directory refused')
    if not 0.5 <= args.speed <= 3 or not 1 <= args.timeout <= 1800:
        parser.error('Invalid speed or timeout')
    token = (runtime/'.open_tts_token').read_text().strip()
    if not token or not token.isascii():
        parser.error('Isolated token is invalid')
    headers = {'Content-Type':'application/json','X-Open-TTS-Token':token,
               'Origin':'chrome-extension://'+'a'*32}
    def get(path):
        request = urllib.request.Request(base+path,headers=headers)
        with urllib.request.urlopen(request,timeout=10) as response:
            return json.load(response)
    health = get('/health')
    if health.get('engine') != 'open-tts' or health.get('gpu_busy') or health.get('state') in ('loading','warming','generating'):
        parser.error('Target is not an idle Open TTS instance')
    if health.get('model_loaded') and health.get('model') != args.model:
        parser.error('Refusing to switch another loaded model')
    caps = get('/v1/capabilities')
    if 2 not in caps.get('protocol_versions',[]) or caps.get('runtime',{}).get('jobs'):
        parser.error('Target is busy or lacks v2')
    sys.path.insert(0,str(backend))
    from open_tts.text import normalize_text
    text = normalize_text(args.text_file.read_text())
    if not text or len(text)>200000:
        parser.error('Input must be 1–200,000 normalized characters')
    parts=[]
    while text:
        cut=min(40000,len(text))
        if cut<len(text):
            boundary=text.rfind(' ',0,cut)
            if boundary>cut//2: cut=boundary
        parts.append(text[:cut].strip())
        text=text[cut:].strip()
    body={'texts':parts,'protocol_version':2,'model':args.model,'voice':args.voice or
          {'kokoro':'af_bella','qwen3-tts':'ryan','fish-s2-pro':'whisper'}[args.model], 'speed':args.speed}
    started=time.perf_counter()
    request=urllib.request.Request(base+'/v1/synthesize-stream-batch',data=json.dumps(body).encode(),headers=headers,method='POST')
    with urllib.request.urlopen(request,timeout=args.timeout) as response:
        if response.headers.get('X-TTS-Protocol-Version') != '2':
            raise ValueError('Unexpected protocol')
        report=measure_stream(response,started=started,source_lengths=list(map(len,parts)))
    report.update(model=args.model,speed=args.speed,backend_version=health.get('version'),
                  source_characters=sum(map(len,parts)),mode='authorized-isolated-http',
                  cold_start=not health.get('model_loaded'))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
