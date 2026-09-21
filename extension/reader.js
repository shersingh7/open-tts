// Reader UI is a host of the same offscreen.js engine, not a second pipeline.
globalThis.OpenTTSHostKind = "reader";
(() => {
  const node = id => document.getElementById(id);
  let identity = null, settings = {}, retryText = "", paused = false, parts = [];
  globalThis.OpenTTSHostPrepare = (text, selected, owner) => {
    identity = {runId:owner.runId,clientId:owner.clientId};
    settings = {model:selected.model,voice:selected.voice,speed:selected.speed,language:selected.language,instruct:selected.instruct};
    parts = OpenTTSPlayback.splitText(text,40000,40000);
    node("text").value = text; node("error").textContent = "";
    node("model").textContent = `${selected.model || "kokoro"} · ${selected.voice || "default voice"} · ${selected.speed || 1}×`;
    node("progress").value=0; node("pause").disabled=false; node("stop").disabled=false;
    node("retry").hidden=true; retryText=""; paused=false; node("pause").textContent="Pause";
  };
  globalThis.OpenTTSHostEvent = event => {
    if (event.runId !== identity?.runId) return;
    if (event.type === "TTS_STATUS") {
      paused=event.label === "Paused";
      node("status").textContent=event.label; node("pause").textContent=paused?"Resume":"Pause";
      if (event.bufferedSeconds !== undefined) node("detail").textContent=`${event.bufferedSeconds.toFixed(1)} seconds buffered ahead`;
    }
    if (event.type === "TTS_PROGRESS" && event.end !== undefined) {
      const total=parts.reduce((n,p)=>n+Array.from(p).length,0);
      const played=parts.slice(0,event.index).reduce((n,p)=>n+Array.from(p).length,0)+event.end;
      node("progress").value=total ? 100*played/total : 0;
      node("detail").textContent=`Passage ${event.unitId+1} fully played · ${Math.round(node("progress").value)}% of text`;
    }
    if (event.metrics) node("metrics").textContent=JSON.stringify(event.metrics,null,2);
    if (["TTS_DONE","TTS_ERROR"].includes(event.type)) {
      node("status").textContent=event.outcome || "failed";
      node("pause").disabled=true; node("stop").disabled=true;
      node("error").textContent=event.message || "";
      retryText=event.retryText || ""; node("retry").hidden=!retryText;
      if (event.outcome === "completed") node("progress").value=100;
    }
  };
  async function control(type) {
    const owner=identity;
    try {
      const result=OpenTTSProtocol.unwrap(await chrome.runtime.sendMessage({type,...owner}));
      if (identity !== owner) return;
      if (!result.ok) throw new Error(result.error || "Control failed");
    } catch(e) { node("error").textContent=e.message; }
  }
  chrome.runtime.onMessage.addListener(message=>{
    if (message._routedByBackground && message.type === "TTS_HISTORY_ERROR" && message.runId === identity?.runId) node("error").textContent=`Audio completed, but history could not be saved: ${message.message}`;
    return false;
  });
  node("pause").addEventListener("click",()=>control(paused?"RESUME":"PAUSE"));
  node("stop").addEventListener("click",()=>control("STOP"));
  node("retry").addEventListener("click",async()=>{
    if (!retryText) return;
    try {
      const result=OpenTTSProtocol.unwrap(await chrome.runtime.sendMessage({type:"SPEAK",text:retryText,settings,
        runId:crypto.randomUUID(),clientId:identity?.clientId || crypto.randomUUID(),source:"reader"}));
      if (!result.ok) throw new Error(result.error || "Retry failed");
    } catch(e) { node("error").textContent=e.message; }
  });
})();
