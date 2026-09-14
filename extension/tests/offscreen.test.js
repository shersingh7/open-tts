import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { harness, deferred, flush, response, audioFrame, ending, frame } from './pipeline-harness.js';

const terminals = h => h.events.filter(e => ['TTS_DONE','TTS_ERROR'].includes(e.type));
describe('production offscreen pipeline', () => {
  it('accepts keepalive while awaiting real audio, but never treats it as completion', async () => {
    const h = harness({fetch: () => response([frame({keepalive:true}), audioFrame(), ...ending()])});
    await h.speak(); await flush(150);
    expect(terminals(h)).toHaveLength(0);
    expect(h.contexts[0].sources).toHaveLength(1);
    h.contexts[0].sources[0].end(); await flush();
    expect(terminals(h).map(e => e.type)).toEqual(['TTS_DONE']);
    const cursor = new h.context.OpenTTSStream.StreamCursor(1);
    cursor.accept({keepalive:true}, new Uint8Array());
    expect(() => cursor.finishEof()).toThrow();
    expect(() => cursor.accept({keepalive:true}, new Uint8Array([1]))).toThrow();
  });
  it('preserves paragraphs and completes only after sources end', async () => {
    const h=harness();await h.speak();await flush();
    expect(JSON.parse(h.requests[0].body).texts.join('')).toBe('Hello.\n\nNext paragraph.');
    expect(terminals(h)).toHaveLength(0);
    h.contexts[0].sources[0].end();await flush();
    expect(terminals(h).map(x=>x.type)).toEqual(['TTS_DONE']);
    expect(h.contexts[0].state).toBe('closed');
  });
  it('late decode cannot schedule or finish a replacement run', async () => {
    const gate=deferred();let first=true;
    const h=harness({decode:()=>{if(first){first=false;return gate.promise;}}});
    await h.speak('A');await flush();await h.speak('B');await flush();
    gate.resolve();await flush();
    expect(h.contexts[0].sources).toHaveLength(0);
    expect(h.contexts[1].sources).toHaveLength(1);
    expect(terminals(h).filter(e=>e.runId==='B')).toHaveLength(0);
    h.contexts[1].sources[0].end();await flush();
    expect(terminals(h).map(e=>e.runId)).toEqual(['A','B']);
  });
  it('stop during headers prevents a late response from creating audio', async () => {
    const gate=deferred();const h=harness({fetch:()=>gate.promise});
    await h.speak();await flush();await h.send({type:'STOP',runId:'A'});
    gate.resolve(response([audioFrame(),...ending()]));await flush();
    expect(h.contexts).toHaveLength(0);expect(terminals(h)).toHaveLength(1);
  });
  it('pause survives decode and EOF; resume drains once', async () => {
    const gate=deferred(),h=harness({decode:()=>gate.promise});
    await h.speak();await flush();await h.send({type:'PAUSE',runId:'A'});
    gate.resolve();await flush();expect(h.contexts[0].state).toBe('suspended');
    expect(terminals(h)).toHaveLength(0);
    await h.send({type:'RESUME',runId:'A'});h.contexts[0].sources[0].end();await flush();
    expect(terminals(h).map(e=>e.type)).toEqual(['TTS_DONE']);
  });
  it.each([
    [frame({error:'Broken passage',code:'generation_failed'})],
    [],
    [frame({index:0,final:true})],
    [frame({done:true})],
    [...ending(),audioFrame()],
    [frame({index:0,final:true}),frame({index:0,final:true}),frame({done:true})],
  ])('never retries or succeeds on partial/malformed stream %#', async (...tail) => {
    // it.each spreads array rows: normalize each row to its list of frames.
    const h=harness({fetch:()=>response([audioFrame(),...tail])});
    await h.speak();await flush(150);
    expect(h.requests).toHaveLength(1);
    expect(terminals(h).map(e=>e.type)).toEqual(['TTS_ERROR']);
    expect(h.contexts[0].sources[0].stopped).toBe(true);
  });
  it('rejects oversized WAV before decode', async () => {
    let decoded=false;const h=harness({fetch:()=>response([audioFrame(21),...ending()]),decode:()=>{decoded=true;}});
    await h.speak();await flush();expect(decoded).toBe(false);expect(terminals(h)[0].type).toBe('TTS_ERROR');
  });
  it('rebases after starvation, then abuts the next burst', async () => {
    const gate=deferred(),h=harness({fetch:()=>response([audioFrame(),gate.promise,audioFrame(),...ending()])});
    await h.speak();await flush();const ctx=h.contexts[0];ctx.sources[0].end();ctx.currentTime=10;
    gate.resolve(audioFrame());await flush(150);
    expect(ctx.sources[1].startAt).toBeGreaterThanOrEqual(10);
    expect(ctx.sources[2].startAt).toBeCloseTo(ctx.sources[1].endAt,8);
    await h.send({type:'STOP',runId:'A'});
  });
  it('bounds a 2000-frame production soak, including pause and cleanup', async () => {
    const count=2000;
    const sample=audioFrame(1);
    const h=harness({fetch:()=>response([...Array(count).fill(sample),...ending()])});
    await h.speak();await flush(1200);const ctx=h.contexts[0];
    const run=vm.runInContext('session',h.context);
    await h.send({type:'PAUSE',runId:'A'});await flush(40000);
    expect(ctx.sources.length).toBeLessThan(count);
    const pausedCount=ctx.sources.length;await flush(200);expect(ctx.sources.length).toBe(pausedCount);
    await h.send({type:'RESUME',runId:'A'});
    let ended=0;
    for(let i=0;i<10000 && terminals(h).length===0;i++) {
      while(ended<ctx.sources.length) ctx.sources[ended++].end();
      await flush(30);
    }
    expect(ended).toBe(count);expect(terminals(h).map(x=>x.type)).toEqual(['TTS_DONE']);
    for(let i=1;i<ctx.sources.length;i++) expect(ctx.sources[i].startAt).toBeGreaterThanOrEqual(ctx.sources[i-1].endAt-1e-8);
    expect(ctx.sources.every(s=>s.buffer===null && s.disconnected)).toBe(true);
    expect(run.peakHorizon).toBeLessThanOrEqual(20.25);
    expect(run.peakBytes).toBeLessThanOrEqual(16*1024*1024);
    console.log('FIXTURE_SOAK',JSON.stringify({frames:ended,simulatedAudioSeconds:count,peakScheduledSeconds:run.peakHorizon,peakDecodedBytes:run.peakBytes,terminalEvents:terminals(h).length}));
  });
});

it('run queue enforces exact byte and duration budgets and abort releases waits', async () => {
  const h=harness(), create=h.context.OpenTTSPlaybackSession.createPlaybackRun;
  const run=create({highWaterSeconds:2,lowWaterSeconds:1,maxDecodedBytes:192000,startupLead:0.25});
  const ctx=new h.Context();run.setContext(ctx);
  const buf={duration:1,length:24000,numberOfChannels:1};
  await run.scheduleBuffer(ctx,buf);await run.scheduleBuffer(ctx,buf);
  let resolved=false;const waiting=run.scheduleBuffer(ctx,buf).then(()=>{resolved=true;});await flush();expect(resolved).toBe(false);
  ctx.sources[0].end();await waiting;expect(run.peakBytes).toBeLessThanOrEqual(192000);
  expect(run.peakHorizon).toBeLessThanOrEqual(2.25);
  const blocked=run.scheduleBuffer(ctx,buf);const rejected=expect(blocked).rejects.toMatchObject({name:'AbortError'});
  run.teardown();await rejected;
});

it('reader idle timeout cancels promptly and removes waits', async () => {
  const h=harness(), read=h.context.OpenTTSPlaybackSession.readWithIdleTimeout;
  await expect(read({read:()=>new Promise(()=>{})},new AbortController().signal,5)).rejects.toMatchObject({code:'stream_timeout'});
});

it('duplicate delivery is idempotent for the current run', async()=>{
  const h=harness();await h.speak();await flush();await h.speak();await flush();
  expect(h.requests).toHaveLength(1);expect(h.contexts).toHaveLength(1);
  await h.send({type:'STOP',runId:'A'});
});
it.each(['PAUSE', 'RESUME'])('failed %s terminates and releases the run instead of leaving a stuck session', async (control) => {
  const failure = () => Promise.reject(new Error('Audio device unavailable'));
  const h = harness(control === 'PAUSE' ? {suspend: failure} : {resume: failure});
  await h.speak(); await flush();
  const result = await h.send({type: control, runId: 'A'}); await flush();
  expect(result.success).toBe(false);
  expect(terminals(h).map(e => e.type)).toEqual(['TTS_ERROR']);
  expect(terminals(h)[0].message).toBe('Audio device unavailable');
  expect(h.contexts[0].state).toBe('closed');
  expect((await h.send({type:'GET_STATUS'})).active).toBe(false);
});

it('late resume cannot revive a stopped context',async()=>{
  const gate=deferred(),h=harness({resume:()=>gate.promise});
  await h.speak();await flush();await h.send({type:'PAUSE',runId:'A'});
  const resuming=h.send({type:'RESUME',runId:'A'});await flush();
  await h.send({type:'STOP',runId:'A'});gate.resolve();await resuming;await flush();
  expect(terminals(h)).toHaveLength(1);expect(h.contexts[0].state).toBe('closed');
});
