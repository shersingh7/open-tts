import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it, expect } from 'vitest';
import { deferred, flush } from './pipeline-harness.js';
function background({health, existing=true, playback=null, createError=null, createGate=null, readerPlayback=null, nativeResponse=null}={}) {
  let listener,context,hasDoc=existing,creates=0;const forwarded=[],local={installToken:"fixture-token"};
  const chrome={runtime:{onMessage:{addListener(fn){listener=fn;}},getURL:p=>'chrome-extension://test/'+p,getContexts:async options=>options.documentUrls[0].endsWith('reader.html') && readerPlayback ? [{tabId:8}] : [],
    sendNativeMessage(name,request,callback){callback(nativeResponse || {success:false,message:'fixture native failure'});},
    sendMessage(req,cb){forwarded.push(req);const selected=req.hostKind==='reader'?readerPlayback:playback;const result=req.type==='GET_PLAYBACK_STATE'?(typeof selected === 'function' ? selected() : (selected||{active:false})):{success:true,ready:true};cb?.(result);return Promise.resolve(result);}},
    storage:{local:{get(_keys,cb){cb({...local});},set(value,cb){Object.assign(local,value);cb?.();}}},
    tabs:{sendMessage(){return Promise.resolve();},create:async()=>{readerPlayback={active:false};return {id:8};}},
    offscreen:{hasDocument:async()=>hasDoc,createDocument:async()=>{creates++;if(createGate)await createGate;if(createError)throw createError;hasDoc=true;}}};
  context=vm.createContext({chrome,console,setTimeout,clearTimeout,AbortSignal,AbortController,
    fetch:async url=>({ok:true,json:async()=>url.endsWith('/health') ? {engine:'open-tts',version:'3.5.0',...(health?await health():{status:'ok'})} : {engine:'open-tts',protocol_versions:[1,2]}}),
    importScripts(...files){for(const f of files)vm.runInContext(readFileSync(resolve('extension',f),'utf8'),context);}});
  vm.runInContext(readFileSync('extension/background.js','utf8'),context);
  const send=req=>new Promise(resolve=>listener(req,{url:req._fromOffscreen?'chrome-extension://test/'+(req.hostKind==='reader'?'reader.html':'offscreen.html'):'https://example.com',tab:{id:5},frameId:0},resolve));
  const speak=runId=>send({type:'SPEAK',runId,clientId:'c',text:'Hello',settings:{}});
  return {send,speak,forwarded,context,local,setReader:value=>{readerPlayback=value;},get creates(){return creates;}};
}
it('late backend readiness cannot dispatch obsolete SPEAK',async()=>{
  const gate=deferred();let n=0;const h=background({health:()=>++n===1?gate.promise:Promise.resolve({status:'ok'})});
  const a=h.speak('A');await flush();await h.speak('B');gate.resolve({status:'ok'});await a;
  expect(h.forwarded.filter(e=>e.type==='SPEAK').map(e=>e.runId)).toEqual(['B']);
});
it('STOP invalidates pending startup immediately',async()=>{
  const gate=deferred(),h=background({health:()=>gate.promise});const a=h.speak('A');await flush();
  await h.send({type:'STOP',runId:'A',clientId:'c'});gate.resolve({status:'ok'});await a;
  expect(h.forwarded.filter(e=>e.type==='SPEAK')).toHaveLength(0);
});
it('restarted worker recovers offscreen owner for status and controls',async()=>{
  const h=background({playback:{active:true,runId:'A',clientId:'c',paused:true,source:'content',sourceTabId:5}});
  const result=await h.send({type:'GET_STATUS'});expect(result.data.active).toBe(true);expect(result.data.paused).toBe(true);
  await h.send({type:'RESUME',runId:'A',clientId:'c'});
  expect(h.forwarded.some(e=>e.type==='RESUME'&&e.runId==='A')).toBe(true);
  expect(h.creates).toBe(0);
});
it('late recovery cannot resurrect a run after its terminal event', async () => {
  const gate=deferred(), h=background({playback:()=>gate.promise});
  const status=h.send({type:'GET_STATUS'}); await flush();
  await h.send({_fromOffscreen:true,type:'TTS_DONE',runId:'A',clientId:'c'});
  gate.resolve({active:true,runId:'A',clientId:'c',source:'content'});
  const result=await status;
  expect(result.data.active).toBe(false);
  expect(vm.runInContext('activeSession',h.context)).toBe(null);
});
it('status probe never creates an absent offscreen document',async()=>{
  const h=background({existing:false});const r=await h.send({type:'GET_STATUS'});
  expect(r.data.active).toBe(false);expect(h.creates).toBe(0);
});
it('offscreen creation errors are not mistaken for success',async()=>{
  const h=background({existing:false,createError:new Error('offscreen permission denied')});
  const r=await h.speak('A');expect(r.success).toBe(false);expect(r.error).toContain('offscreen permission denied');
  expect(h.forwarded.filter(e=>e.type==='SPEAK')).toHaveLength(0);
});
it('offscreen creation is single-flight',async()=>{
  const gate=deferred(),h=background({existing:false,createGate:gate.promise});
  const a=h.speak('A');for(let i=0;i<20&&h.creates===0;i++)await flush();
  expect(h.creates).toBe(1);
  const b=h.speak('B');await flush();await flush();await flush();
  gate.resolve();await Promise.all([a,b]);
  expect(h.creates).toBe(1);
  expect(h.forwarded.filter(e=>e.type==='SPEAK').map(e=>e.runId)).toEqual(['B']);
});
it.each(['ENSURE_SERVER','ENSURE_OFFSCREEN','GET_VOICES'])('dead route %s is an unknown message type',async type=>{
  const h=background({existing:false});const r=await h.send({type});
  expect(r.success).toBe(false);expect(r.error).toBe(`Unknown message type: ${type}`);
  expect(h.creates).toBe(0);
});

it('new Speak after worker restart stops an existing Reader before dispatch',async()=>{
  const h=background({readerPlayback:{active:true,runId:'old',clientId:'c',hostKind:'reader'}});
  await h.speak('new');
  const stop=h.forwarded.findIndex(e=>e.type==='STOP'&&e.runId==='old'&&e.hostKind==='reader');
  const start=h.forwarded.findIndex(e=>e.type==='SPEAK'&&e.runId==='new');
  expect(stop).toBeGreaterThanOrEqual(0);expect(start).toBeGreaterThan(stop);
});
it('completion history survives a closed popup and ignores later false completion',async()=>{
  const h=background();
  const event={_fromOffscreen:true,type:'TTS_DONE',clientId:'c'};
  await h.send({...event,runId:'A',outcome:'completed',historyEntry:{id:'A',text:'finished'}});
  await h.send({...event,runId:'A',outcome:'completed',historyEntry:{id:'A',text:'finished'}});
  await h.send({...event,runId:'B',outcome:'stopped'});
  await h.send({...event,runId:'B',outcome:'completed',historyEntry:{id:'B',text:'interrupted'}});
  expect(h.local.ttsHistory.map(e=>e.id)).toEqual(['A']);
});
it('lost Reader cannot report successful resume',async()=>{
  const h=background({readerPlayback:{active:true,runId:'A',clientId:'c',paused:true,hostKind:'reader'}});
  await h.send({type:'GET_STATUS'});h.setReader(null);
  const r=await h.send({type:'RESUME',runId:'A',clientId:'c'});
  expect(r.success).toBe(false);
  expect(h.forwarded.some(e=>e.outcome==='owner_lost')).toBe(true);
});
it('native stop failure stays a failure',async()=>{
  const h=background({nativeResponse:{success:false,message:'cleanup pending'}});
  const r=await h.send({type:'STOP_SERVER'});
  expect(r.success).toBe(false);expect(r.error).toContain('cleanup pending');
});
it('long selections select a Reader host',async()=>{
  const h=background();
  await h.send({type:'SPEAK',runId:'A',clientId:'c',text:'Sentence. '.repeat(500),settings:{model:'kokoro'}});
  expect(h.forwarded.find(e=>e.type==='SPEAK').hostKind).toBe('reader');
});
