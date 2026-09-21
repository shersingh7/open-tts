import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
export async function flush(n = 60) { for (let i=0;i<n;i++) await Promise.resolve(); }
export function wav(seconds = 0.1, sr = 24000) {
  const n = Math.round(seconds*sr), b = new Uint8Array(44+n*2), v=new DataView(b.buffer);
  const tag=(p,s)=>b.set(new TextEncoder().encode(s),p);
  tag(0,"RIFF");v.setUint32(4,b.length-8,true);tag(8,"WAVE");tag(12,"fmt ");v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);tag(36,"data");v.setUint32(40,n*2,true);return b;
}
export function frame(h, audio = new Uint8Array()) {
  const a=new TextEncoder().encode(JSON.stringify(h)), b=new Uint8Array(a.length+audio.length+8),v=new DataView(b.buffer);
  v.setUint32(0,a.length,true);b.set(a,4);v.setUint32(a.length+4,audio.length,true);b.set(audio,a.length+8);return b;
}
export const audioFrame = (seconds=0.1,index=0) => frame({index,sample_rate:24000,speed:1,apply_playback_rate:false,playback_rate:1,final:false},wav(seconds));
export const ending = (index=0) => [frame({index,final:true}),frame({done:true})];
export function response(parts) {
  let i=0;
  const reader={cancelled:false,released:false, async read(){return i<parts.length?{value:await parts[i++],done:false}:{done:true};},cancel(){this.cancelled=true;return Promise.resolve();},releaseLock(){this.released=true;}};
  return {ok:true,body:{getReader:()=>reader},reader};
}
export function harness(opts = {}) {
  const events=[],contexts=[],requests=[];let listener;
  class Context {
    constructor(){this.state="running";this.currentTime=0;this.sampleRate=24000;this.destination={};this.sources=[];contexts.push(this);}
    resume(){this.state="running";return opts.resume ? opts.resume(this) : Promise.resolve();}
    suspend(){this.state="suspended";return opts.suspend ? opts.suspend(this) : Promise.resolve();}
    close(){this.state="closed";return Promise.resolve();}
    async decodeAudioData(ab){
      if(opts.decode) await opts.decode(this);
      const length=(ab.byteLength-44)/2;
      return {duration:length/24000,length,numberOfChannels:1,sampleRate:24000};
    }
    createBufferSource(){
      const c=this, s={buffer:null,playbackRate:{value:1},connect(){},disconnect(){this.disconnected=true;},
        start(t){this.startAt=t;this.endAt=t+this.buffer.duration;c.sources.push(this);},stop(){this.stopped=true;},
        end(){c.currentTime=Math.max(c.currentTime,this.endAt);this.onended?.();}};return s;
    }
  }
  const sandbox={OpenTTSHostKind:opts.hostKind || "offscreen",OpenTTSHostEvent:opts.onEvent,console,AbortController,AbortSignal,setTimeout,clearTimeout,TextEncoder,TextDecoder,Uint8Array,DataView,
    window:{AudioContext:Context},chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}},sendMessage(e){events.push(e);return Promise.resolve();}}},
    fetch:async(url,req)=>{requests.push({url,...req});return opts.fetch ? opts.fetch(url,req) : response([audioFrame(),...ending()]);}};
  const context=vm.createContext(sandbox);
  const load=(name)=>vm.runInContext(readFileSync(resolve('extension',name),'utf8'),context,{filename:name});
  for(const f of ['shared/constants-umd.js','shared/protocol-umd.js','shared/playback-umd.js','shared/playback-session-umd.js','shared/stream-decoder-umd.js','offscreen.js'])load(f);
  const send=(req)=>new Promise(resolve=>listener({_fromBackground:true,hostKind:opts.hostKind || "offscreen",...req},{},resolve));
  const speak=(id='A',text='Hello.\n\nNext paragraph.')=>send({type:'SPEAK',runId:id,clientId:'client',text,settings:{speed:1}});
  return {context,events,contexts,requests,send,speak,load,Context};
}
