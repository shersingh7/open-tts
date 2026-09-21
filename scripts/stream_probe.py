"""Incremental, bounded framed-stream measurement; no model or server lifecycle."""
import io
import json
import struct
import time
import wave


def read_exact(stream, count, *, eof=False):
    chunks = bytearray()
    while len(chunks) < count:
        block = stream.read(count - len(chunks))
        if not block:
            if eof and not chunks:
                return None
            raise ValueError('Truncated frame')
        chunks.extend(block)
    return bytes(chunks)


def measure_stream(stream, *, started=None, version=2, source_lengths=None):
    started = time.perf_counter() if started is None else started
    first_audio = None
    frames = audio_bytes = sequence = index = unit_id = end = 0
    duration = generation = 0.0
    terminal = False
    has_audio = False
    unit = None
    sample_rate = None
    maximum_frame_bytes = 0
    while True:
        raw = read_exact(stream, 4, eof=True)
        if raw is None:
            break
        if terminal:
            raise ValueError('Payload after done')
        header_length = struct.unpack('<I', raw)[0]
        if not 0 < header_length <= 65536:
            raise ValueError('Header limit')
        header = json.loads(read_exact(stream, header_length))
        audio_length = struct.unpack('<I', read_exact(stream, 4))[0]
        if audio_length > 8*1024*1024:
            raise ValueError('Audio byte limit')
        audio = read_exact(stream, audio_length)
        maximum_frame_bytes = max(maximum_frame_bytes,header_length+audio_length+8)
        if not isinstance(header,dict):
            raise ValueError('Invalid header')
        if version == 2:
            if header.get('protocol_version') != 2 or header.get('sequence') != sequence:
                raise ValueError('Protocol sequence mismatch')
            sequence += 1
        if header.get('error'):
            raise RuntimeError('Backend stream failed: '+str(header.get('code','unknown')))
        if header.get('keepalive'):
            if audio:
                raise ValueError('Audio in keepalive')
            continue
        if header.get('done'):
            if audio or unit is not None or (version == 2 and header.get('outcome') != 'completed'):
                raise ValueError('Invalid terminal')
            terminal = True
            continue
        if header.get('index') != index:
            raise ValueError('Out of order index')
        if header.get('final'):
            if audio or not has_audio or unit is not None:
                raise ValueError('Invalid final')
            if source_lengths is not None and (index >= len(source_lengths) or end != source_lengths[index]):
                raise ValueError('Incomplete source coverage')
            index += 1
            has_audio = False
            end = 0
            continue
        if version == 2:
            bounds = (header.get('start'),header.get('end'))
            if header.get('unit_id') != unit_id or bounds[0] != end or not isinstance(bounds[1],int) or bounds[1] <= end:
                raise ValueError('Invalid unit coverage')
            if unit is not None and unit != bounds:
                raise ValueError('Changed unit bounds')
            if header.get('unit_final'):
                if unit is None or audio:
                    raise ValueError('Invalid unit final')
                generation += float(header.get('generation_seconds',0))
                unit_id += 1
                end = bounds[1]
                unit = None
                continue
            unit = bounds
        if not audio or header.get('apply_playback_rate') is not False or header.get('playback_rate') != 1:
            raise ValueError('Invalid audio/speed metadata')
        with wave.open(io.BytesIO(audio),'rb') as wav:
            count, rate = wav.getnframes(), wav.getframerate()
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 8000 <= rate <= 192000:
                raise ValueError('Unsupported PCM')
            if count <= 0 or count/rate > 4 or (sample_rate is not None and sample_rate != rate):
                raise ValueError('Invalid PCM rate/duration')
            if version == 2 and header.get('samples') != count:
                raise ValueError('Sample count mismatch')
            sample_rate = rate
            duration += count/rate
        if first_audio is None:
            first_audio = time.perf_counter()-started
        has_audio = True
        frames += 1
        audio_bytes += audio_length
    if not terminal or not frames or has_audio or (source_lengths is not None and index != len(source_lengths)):
        raise ValueError('Incomplete stream')
    return {'ok':True,'terminal':terminal,'frames':frames,'audio_bytes':audio_bytes,
            'processed_audio_seconds':duration,'active_generation_seconds':generation,
            'normalized_rtf':generation/duration if version == 2 else None,
            'first_audio_packet_seconds':first_audio,'wall_seconds':time.perf_counter()-started,
            'maximum_frame_bytes':maximum_frame_bytes,'units':unit_id,
            'audible_playback_verified':False}
