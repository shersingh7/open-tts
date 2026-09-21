import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { deferred, flush } from './pipeline-harness.js';

function popupHarness() {
  const nodes = new Map(), pending = []; let listener, settings = {};
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {value: id==='previewText'?'Fixture paragraph.':'',textContent:'',dataset:{},
      classList:{add(){},remove(){},toggle(){return false;}},addEventListener(){},setAttribute(){},replaceChildren(){}});
    return nodes.get(id);
  };
  let firstSettings=true;
  const context=vm.createContext({console,performance,crypto:{randomUUID:()=> 'fixture-id'},setTimeout,clearTimeout,
    document:{getElementById:node,createElement:()=>node('created')},navigator:{},
    chrome:{runtime:{getManifest:()=>({version:'test'}),onMessage:{addListener(fn){listener=fn;}},
      sendMessage(req,cb){pending.push({req,cb});}}},
    OpenTTSStorage:{syncGet:()=>{if(firstSettings){firstSettings=false;return new Promise(()=>{});}return Promise.resolve(settings);},
      syncSet:async()=>{},localGet:async()=>({}),localSet:async()=>{},debouncedSyncSet(){},debouncedLocalSet(){}},
  });
  for (const f of ['shared/constants-umd.js','shared/protocol-umd.js','popup.js'])
    vm.runInContext(readFileSync('extension/'+f,'utf8'),context);
  vm.runInContext('wireEvents()',context);
  return {nodes,pending,context,settings(v){settings=v;},invoke:name=>vm.runInContext(name+'()',context),
    state:()=>vm.runInContext('({activeRun,playbackState,pendingHistory})',context),
    respond(type,value={success:true}){const i=pending.findIndex(p=>p.req.type===type);expect(i).toBeGreaterThanOrEqual(0);pending.splice(i,1)[0].cb(value);},
    deliver(msg){listener({_routedByBackground:true,...msg});}};
}
it('late popup state restoration cannot replace a newly started run', async () => {
  const h = popupHarness();
  const restore = h.invoke('restorePlaybackState'); await flush();
  const speak = h.invoke('handleSpeak'); await flush();
  const current = h.state().activeRun.runId;
  h.respond('GET_PLAYBACK_STATE', {success:true, data:{active:true, clientId:'old-client', runId:'old-run'}});
  await restore;
  expect(h.state().activeRun.runId).toBe(current);
  h.respond('SPEAK'); await speak;
});
it('late popup state restoration cannot resurrect a stopped startup', async () => {
  const h = popupHarness();
  const restore = h.invoke('restorePlaybackState'); await flush();
  const speak = h.invoke('handleSpeak'); await flush();
  const stop = h.invoke('handleStopPlayback'); await flush(); h.respond('STOP'); await stop;
  h.respond('GET_PLAYBACK_STATE', {success:true, data:{active:true, clientId:'old-client', runId:'old-run'}});
  await restore;
  expect(h.state().activeRun).toBe(null);
  h.respond('SPEAK'); await speak;
});

it('popup stop during settings cannot dispatch SPEAK',async()=>{
  const h=popupHarness(),gate=deferred();h.settings(gate.promise);
  const start=h.invoke('handleSpeak');await flush();const stop=h.invoke('handleStopPlayback');await flush();h.respond('STOP');await stop;
  gate.resolve({});await flush();
  expect(h.pending.filter(p=>p.req.type==='SPEAK')).toHaveLength(0);
  await start;
});
it('popup old completion response cannot resurrect history or replacement UI',async()=>{
  const h=popupHarness();const a=h.invoke('handleSpeak');await flush();
  const old=h.state().activeRun.runId;
  const b=h.invoke('handleSpeak');await flush();h.respond('STOP_TTS');await flush();
  const replacement=h.state().activeRun.runId;expect(replacement).not.toBe(old);
  h.respond('SPEAK',{success:false,error:'obsolete'});await a;
  expect(h.state().activeRun?.runId).toBe(replacement);
  h.respond('SPEAK');await b;
});
it('popup applies authoritative pause state rather than the requested state', async () => {
  const h=popupHarness(); const speak=h.invoke('handleSpeak'); await flush(); h.respond('SPEAK'); await speak;
  const control=h.invoke('handlePauseResume'); await flush();
  // Another controller resumed before this response was delivered.
  h.respond('PAUSE',{success:true,paused:false}); await control;
  expect(h.state().playbackState).toBe('playing');
});
it('popup rejects late status after terminal error',async()=>{
  const h=popupHarness();const a=h.invoke('handleSpeak');await flush();h.respond('SPEAK');await a;
  const runId=h.state().activeRun.runId;h.deliver({type:'TTS_ERROR',runId,message:'Interrupted'});
  h.deliver({type:'TTS_STATUS',runId,label:'Reading...'});
  expect(h.state().playbackState).toBe('idle');expect(h.nodes.get('progress').textContent).toBe('Error');
});
it('Speak snapshots current controls rather than stale debounced preferences',async()=>{
  const h=popupHarness(),gate=deferred();h.settings(gate.promise);
  h.nodes.get('speed').value='2.5';h.nodes.get('model').value='kokoro';
  h.nodes.get('voice').value='af_bella';h.nodes.get('instruct').value='';
  const speaking=h.invoke('handleSpeak');h.nodes.get('speed').value='3';
  gate.resolve({speed:1,instruct:'stale synced instruction'});await flush();
  const request=h.pending.find(p=>p.req.type==='SPEAK').req;
  expect(request.settings.speed).toBe(2.5);expect(request.settings.instruct).toBe('');
  h.respond('SPEAK');await speaking;
});
