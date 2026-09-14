import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { deferred, flush } from './pipeline-harness.js';

function contentHarness() {
  let listener, settingsCallback;
  const pending = [], sent = [];
  const label = { textContent: '' };
  const widget = { querySelector: () => label, classList: { add(){}, remove(){}, toggle(){} } };
  const context = vm.createContext({
    console, setTimeout: () => 1, clearTimeout(){},
    OpenTTSConstants: { MAX_CHARS: 200000, resolveVoice: () => 'af_bella', resolveSpeed: () => 1 },
    MutationObserver: class { observe(){} },
    document: { querySelectorAll: () => [], documentElement: {}, addEventListener(){} },
    window: { getSelection: () => ({ toString: () => 'Selected text.' }) },
    chrome: {
      storage: { sync: { get(_keys, cb){ settingsCallback = cb; } } },
      runtime: { onMessage: { addListener(fn){ listener = fn; } },
        sendMessage(req, cb) { sent.push(req); pending.push({ req, cb }); } },
    },
  });
  vm.runInContext(readFileSync('extension/content.js', 'utf8'), context);
  context.fixtureWidget = widget;
  vm.runInContext('widget = fixtureWidget', context);
  const invoke = name => vm.runInContext(`${name}({preventDefault(){},stopPropagation(){}})`, context);
  const state = () => vm.runInContext('({currentRunId,isSpeaking,isPaused})', context);
  const deliver = msg => listener({ _routedByBackground: true, ...msg }, {}, () => {});
  const respond = (type, value={success:true}) => { const i=pending.findIndex(p=>p.req.type===type); expect(i).toBeGreaterThanOrEqual(0); pending.splice(i,1)[0].cb(value); };
  return {context,sent,pending,label,invoke,state,deliver,respond,settings:()=>settingsCallback({})};
}

it('stop while settings load cannot dispatch a ghost SPEAK', async()=>{
  const h=contentHarness();const start=h.invoke('onClick');await flush();
  const stop=h.invoke('onStop');await flush();h.respond('STOP');await stop;
  h.settings();await start;
  expect(h.sent.filter(r=>r.type==='SPEAK')).toHaveLength(0);
  expect(h.state().isSpeaking).toBe(false);
});
it('old SPEAK rejection cannot reset the replacement selection run',async()=>{
  const h=contentHarness();const a=h.invoke('onClick');h.settings();await flush();
  const old=h.state().currentRunId;
  const stop=h.invoke('onStop');await flush();h.respond('STOP');await stop;
  const b=h.invoke('onClick');h.settings();await flush();
  const replacement=h.state().currentRunId;expect(replacement).not.toBe(old);
  h.respond('SPEAK',{success:false,error:'Obsolete request'});await a;
  expect(h.state().currentRunId).toBe(replacement);expect(h.state().isSpeaking).toBe(true);
  h.respond('SPEAK');await b;
});
it('interruption error remains visible and late events are ignored',async()=>{
  const h=contentHarness();const start=h.invoke('onClick');h.settings();await flush();h.respond('SPEAK');await start;
  const runId=h.state().currentRunId;
  h.deliver({type:'TTS_ERROR',runId,message:'Interrupted: missing audio'});
  expect(h.label.textContent).toBe('Interrupted: missing audio');
  h.deliver({type:'TTS_STATUS',runId,label:'Reading...'});
  expect(h.label.textContent).toBe('Interrupted: missing audio');
});
it('failed pause does not claim audio is paused',async()=>{
  const h=contentHarness();const start=h.invoke('onClick');h.settings();await flush();h.respond('SPEAK');await start;
  const pause=h.invoke('onClick');await flush();h.respond('PAUSE',{success:false,error:'Context unavailable'});await pause;
  expect(h.state().isPaused).toBe(false);
  expect(h.label.textContent).toBe('Context unavailable');
});
