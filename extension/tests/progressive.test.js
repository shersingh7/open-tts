import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {it, expect} from 'vitest';
import {harness,frame,wav,response,flush,deferred,audioFrame} from './pipeline-harness.js';

function v2(text='Hello',seconds=1) {
  const unit={protocol_version:2,index:0,unit_id:0,start:0,end:Array.from(text).length};
  return [frame({...unit,sequence:0,samples:Math.round(seconds*24000),sample_rate:24000,speed:1,apply_playback_rate:false,playback_rate:1},wav(seconds)),
    frame({...unit,sequence:1,unit_final:true}),frame({protocol_version:2,sequence:2,index:0,final:true}),
    frame({protocol_version:2,sequence:3,done:true,outcome:'completed'})];
}
function v2response(parts) {return {...response(parts),headers:{get:()=> '2'}};}
function speak(h,text='Hello') {return h.send({type:'SPEAK',runId:'A',clientId:'c',text,settings:{speed:1,protocolVersion:2},historyEntry:{id:'A',text}});}

it.each(['reader','offscreen'])('%s uses the v2 pipeline and waits for audible-source drain',async hostKind=>{
  const h=harness({hostKind,fetch:async()=>v2response(v2('Hi 😀'))});
  await speak(h,'Hi 😀');await flush();
  expect(h.events.some(e=>e.type==='TTS_DONE')).toBe(false);
  h.contexts[0].sources[0].end();await flush();
  const terminal=h.events.filter(e=>e.type==='TTS_DONE');
  expect(terminal).toHaveLength(1);expect(terminal[0].outcome).toBe('completed');
  expect(terminal[0].hostKind).toBe(hostKind);
  expect(terminal[0].historyEntry.id).toBe('A');
  expect(h.events.find(e=>e.type==='TTS_PROGRESS'&&e.end).end).toBe(4);
});

it('Reader retry begins at the first not-fully-played passage',async()=>{
  const gate=deferred(),local=[];
  const unit={protocol_version:2,index:0,unit_id:0,start:0,end:6};
  const h=harness({hostKind:'reader',onEvent:e=>local.push(e),fetch:async()=>v2response([
    frame({...unit,sequence:0,samples:2400,sample_rate:24000,speed:1,apply_playback_rate:false,playback_rate:1},wav(.1)),
    frame({...unit,sequence:1,unit_final:true}),gate.promise])});
  await speak(h,'First. Second.');await flush();h.contexts[0].sources[0].end();await flush();
  await h.send({type:'STOP',runId:'A'});
  expect(local.find(e=>e.type==='TTS_DONE').retryText).toBe(' Second.');
  expect(h.events.every(e=>e.retryText===undefined)).toBe(true);
  gate.resolve(frame({error:'cancelled'}));await flush();
});

it('v2 refuses missing trailing source coverage',async()=>{
  const h=harness({fetch:async()=>v2response(v2('Hi'))});
  await speak(h,'Hi plus omitted text');await flush();
  expect(h.events.find(e=>e.type==='TTS_ERROR').message).toMatch(/coverage/);
  expect(h.events.some(e=>e.outcome==='completed')).toBe(false);
});

it('v2 refuses duplicate sequences',async()=>{
  const parts=v2(),h=harness({fetch:async()=>v2response([parts[0],parts[0],...parts.slice(1)])});
  await speak(h);await flush();
  expect(h.events.find(e=>e.type==='TTS_ERROR').message).toMatch(/sequence/);
});

it('legacy oversized packets fail explicitly before decode',async()=>{
  let decoded=false;
  const h=harness({decode:async()=>{decoded=true;},fetch:async()=>response([audioFrame(20)])});
  await h.speak();await flush();
  expect(decoded).toBe(false);expect(h.events.find(e=>e.type==='TTS_ERROR').message).toMatch(/duration budget/);
});

it('rolling horizon admits a packet before the current long node ends',async()=>{
  const h=harness();const run=h.context.OpenTTSPlaybackSession.createPlaybackRun({highWaterSeconds:4,lowWaterSeconds:2});
  const ctx=new h.Context();run.setContext(ctx);
  await run.scheduleBuffer(ctx,{duration:4,length:96000,numberOfChannels:1});
  const pending=run.scheduleBuffer(ctx,{duration:2,length:48000,numberOfChannels:1});
  ctx.currentTime=2.25;
  await pending;
  expect(ctx.sources).toHaveLength(2);
  expect(ctx.sources[1].startAt).toBe(ctx.sources[0].endAt);
  expect(run.endedCount).toBe(0);run.teardown();
});

it('coalesced frames are yielded lazily, not collected into an audio list',()=>{
  const h=harness(),a=audioFrame(),all=new Uint8Array(a.length*10);
  for(let i=0;i<10;i++)all.set(a,i*a.length);
  const decoder=new h.context.OpenTTSStream.FrameDecoder(), iterator=decoder.frames(all);
  expect(iterator.next().value.audio.length).toBeGreaterThan(0);
  expect(decoder.kind).toBe('headerLength');
  expect([...iterator]).toHaveLength(9);decoder.finish();
});

function storage({failure=false}={}) {
  const local={},sync={instruct:'Private direction'},runtime={},events=[];
  const api=(data,name)=>({get(keys,cb){cb({...data});},set(value,cb){
    events.push(name+'Set');if(failure&&name==='local')runtime.lastError={message:'quota'};
    else Object.assign(data,value);cb();delete runtime.lastError;
  },remove(key,cb){events.push(name+'Remove');delete data[key];cb();}});
  const context=vm.createContext({console,setTimeout,clearTimeout,chrome:{runtime,storage:{local:api(local,'local'),sync:api(sync,'sync')}}});
  vm.runInContext(readFileSync('extension/shared/storage-umd.js','utf8'),context);
  return {store:context.OpenTTSStorage,local,sync,events};
}
it('instruction migration verifies local copy before deleting synced source',async()=>{
  const h=storage();expect(await h.store.localInstruction()).toBe('Private direction');
  expect(h.local.instruct).toBe('Private direction');expect(h.sync.instruct).toBeUndefined();
  expect(h.events).toEqual(['localSet','syncRemove']);
});
it('failed local migration retains the synced value and reports failure',async()=>{
  const h=storage({failure:true});await expect(h.store.localInstruction()).rejects.toThrow('quota');
  expect(h.sync.instruct).toBe('Private direction');expect(h.events).toEqual(['localSet']);
});
