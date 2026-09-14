import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it, expect } from 'vitest';
import { deferred, flush } from './pipeline-harness.js';
function background({health, existing=true, playback=null, createError=null}={}) {
  let listener,context,hasDoc=existing,creates=0;const forwarded=[];
  const chrome={runtime:{onMessage:{addListener(fn){listener=fn;}},getURL:p=>'chrome-extension://test/'+p,
    sendMessage(req,cb){forwarded.push(req);const result=req.type==='GET_PLAYBACK_STATE'?(typeof playback === 'function' ? playback() : (playback||{active:false})):{success:true};cb?.(result);return Promise.resolve(result);}},
    storage:{local:{get(_keys,cb){cb({installToken:'fixture-token'});},set(_v,cb){cb?.();}}},
    tabs:{sendMessage(){return Promise.resolve();}},
    offscreen:{hasDocument:async()=>hasDoc,createDocument:async()=>{creates++;if(createError)throw createError;hasDoc=true;}}};
  context=vm.createContext({chrome,console,setTimeout,clearTimeout,AbortSignal,AbortController,
    fetch:async()=>({ok:true,json:()=>health?health():Promise.resolve({status:'ok'})}),
    importScripts(...files){for(const f of files)vm.runInContext(readFileSync(resolve('extension',f),'utf8'),context);}});
  vm.runInContext(readFileSync('extension/background.js','utf8'),context);
  const send=req=>new Promise(resolve=>listener(req,{tab:{id:5},frameId:0},resolve));
  const speak=runId=>send({type:'SPEAK',runId,clientId:'c',text:'Hello',settings:{}});
  return {send,speak,forwarded,context,get creates(){return creates;}};
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
  const r=await h.send({type:'ENSURE_OFFSCREEN'});expect(r.success).toBe(false);
});
it('offscreen creation is single-flight',async()=>{
  const h=background({existing:false});await Promise.all([h.send({type:'ENSURE_OFFSCREEN'}),h.send({type:'ENSURE_OFFSCREEN'})]);
  expect(h.creates).toBe(1);
});
