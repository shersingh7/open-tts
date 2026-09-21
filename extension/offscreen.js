// Shared playback engine for the offscreen document AND the visible Reader.
// One production pipeline, no duplicated fetch/decode/scheduling implementation.
const hostKind = globalThis.OpenTTSHostKind || "offscreen";
const { SERVER_URL } = OpenTTSConstants;
const { createPlaybackRun, readWithIdleTimeout } = OpenTTSPlaybackSession;
let session = null;

function current(run) { run.assertActive(); if (session !== run) throw Object.assign(new Error("Superseded"), { name: "AbortError" }); }
function emit(run, type, extra = {}) {
  if (session !== run) return;
  const {retryText, ...routed} = extra;
  chrome.runtime.sendMessage({ type, _fromOffscreen: true, clientId: run.clientId,
    runId: run.runId, source: run.source, sourceTabId: run.sourceTabId,
    sourceFrameId: run.sourceFrameId, hostKind, ...routed }).catch(() => {});
  globalThis.OpenTTSHostEvent?.({ type, runId: run.runId, clientId: run.clientId, ...extra });
}
function finish(run, error, outcome = error ? "failed" : "completed") {
  if (session !== run || !run.markTerminal()) return;
  clearTimeout(run.startMonitor);
  run.metrics.terminalAt = Date.now(); run.metrics.terminalOutcome = outcome;
  emit(run, error ? "TTS_ERROR" : "TTS_DONE", { outcome,
    ...(error ? {message:error.message,code:error.code} : {}),
    ...(outcome === "completed" ? {historyEntry:run.historyEntry} : {}),
    metrics:run.metrics, retryText:hostKind === "reader" && outcome !== "completed" ? remainingText(run) : "" });
  session = null;
  run.teardown();
}
function remainingText(run) {
  if (!run.texts) return "";
  const pos = run.playedPosition || {index:0,end:0};
  const first = Array.from(run.texts[pos.index] || "").slice(pos.end).join("");
  return [first, ...run.texts.slice(pos.index+1)].join("\n\n");
}
function unitPlayed(run, unit) {
  if (!unit.final || unit.pending) return;
  run.playedPosition = {index:unit.index,end:unit.end};
  run.units.delete(unit.id);
  emit(run, "TTS_PROGRESS", {played:run.endedCount, scheduled:run.scheduledCount,
    unitId:unit.id, index:unit.index, end:unit.end, bufferedSeconds:run.queuedSeconds});
}
function maybeFinish(run) { if (session === run && run.playbackDrained()) finish(run); }
function getContext(run) {
  current(run);
  if (!run.context) run.setContext(new (window.AudioContext || window.webkitAudioContext)());
  return run.context;
}

// Validate the actual PCM container before Chrome allocates/resamples it.
function wavInfo(bytes, advertisedRate) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || v.getUint32(4, true) + 8 !== bytes.length) throw new Error("Invalid WAV container");
  let format = null, data = null;
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = v.getUint32(p + 4, true), end = p + 8 + size;
    if (end > bytes.length) throw new Error("Truncated WAV chunk");
    if (tag(p) === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format");
      format = { codec: v.getUint16(p + 8, true), channels: v.getUint16(p + 10, true),
        rate: v.getUint32(p + 12, true), align: v.getUint16(p + 20, true), bits: v.getUint16(p + 22, true) };
    }
    if (tag(p) === "data") { if (data !== null) throw new Error("Duplicate WAV data"); data = size; }
    p = end + (size % 2);
  }
  if (!format || data === null || format.codec !== 1 || format.bits !== 16 || format.channels !== 1 ||
      format.align !== 2 || data % 2 || format.rate !== advertisedRate) throw new Error("Unsupported or inconsistent WAV audio");
  const duration = data / 2 / format.rate;
  if (!(duration > 0) || duration > 4) throw new Error("Audio frame exceeds duration budget");
  return { duration };
}

async function* streamBatch(run, texts, settings) {
  const headers = { "Content-Type": "application/json" };
  if (run.authToken) headers["X-Open-TTS-Token"] = run.authToken;
  const response = await readWithIdleTimeout({ read: () => fetch(`${SERVER_URL}/v1/synthesize-stream-batch`, {
    method: "POST", headers, signal: run.signal,
    body: JSON.stringify({ texts, protocol_version:settings.protocolVersion || 1, voice: settings.voice || "af_bella",
      speed: OpenTTSConstants.resolveSpeed(settings.speed), language: settings.language || "Auto",
      ...(settings.model ? { model: settings.model } : {}), ...(settings.instruct ? { instruct: settings.instruct } : {}) }),
  }) }, run.signal);
  current(run);
  if (!response.ok) {
    const body = await readWithIdleTimeout({ read: () => response.json() }, run.signal);
    current(run);
    const error = OpenTTSProtocol.parseApiErrorBody(body, response.status);
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  if (settings.protocolVersion === 2 && response.headers?.get("X-TTS-Protocol-Version") !== "2") throw new Error("Backend streaming protocol mismatch; update backend and extension together");
  const reader = response.body.getReader();
  const decoder = new OpenTTSStream.FrameDecoder();
  const cursor = new OpenTTSStream.StreamCursor(texts.length, settings.protocolVersion || 1, texts.map(t=>Array.from(t).length));
  try {
    while (true) {
      current(run);
      // Intentional backpressure is not a server idle timeout.
      await run.waitForBudget();
      current(run);
      const { value, done } = await readWithIdleTimeout(reader, run.signal);
      current(run);
      for (const frame of value ? decoder.frames(value) : []) {
        current(run);
        cursor.accept(frame.header, frame.audio);
        run.metrics.peakEncodedBytes = decoder.peakBytes;
        if (frame.header.done) Object.assign(run.metrics,{serverQueuePeakBytes:frame.header.queue_peak_bytes,queueWaitSeconds:frame.header.queue_wait_seconds});
        if (frame.audio.length || frame.header.unit_final) yield frame;
      }
      if (done) { decoder.finish(); cursor.finishEof(); return; }
    }
  } finally {
    // Do not await a noncooperative cancel promise before releasing the run.
    Promise.resolve(reader.cancel()).catch(() => {});
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function runSpeak(text, settings, identity) {
  if (session) finish(session, null, "superseded");
  const run = createPlaybackRun({ ...identity, authToken: settings.authToken || "" });
  session = run;
  run.units = new Map(); run.metrics = {acceptedAt:Date.now(), underflows:0};
  globalThis.OpenTTSHostPrepare?.(text, settings, identity);
  try {
    emit(run, "TTS_STATUS", { label: "Preparing..." });
    // Transport partitions are large; backend alone selects generation units.
    const texts = OpenTTSPlayback.splitText(text, 40000, 40000).map(OpenTTSPlayback.normalizeText);
    if (!texts.length) throw new Error("Nothing to read");
    if (texts.join("").length > 200000 || texts.length > 50) throw new Error("Text exceeds the 200,000-character reading limit");
    run.texts = texts;
    emit(run, "TTS_STATUS", { label: "Generating..." });
    for await (const frame of streamBatch(run, texts, settings)) {
      current(run);
      const h = frame.header;
      if (h.unit_final) {
        const unit = run.units.get(h.unit_id);
        if (!unit) throw new Error("Missing playback unit");
        run.metrics.generationSeconds = (run.metrics.generationSeconds || 0) + (h.generation_seconds || 0);
        run.metrics.processedAudioSeconds = (run.metrics.processedAudioSeconds || 0) + (h.processed_audio_seconds || 0);
        if (run.metrics.processedAudioSeconds) run.metrics.normalizedRTF = run.metrics.generationSeconds/run.metrics.processedAudioSeconds;
        unit.final = true; unitPlayed(run, unit); continue;
      }
      run.metrics.firstPacketAt ??= Date.now();
      run.metrics.modelReadySeconds ??= h.model_ready_seconds;
      run.metrics.firstModelPCMSeconds ??= h.first_pcm_seconds;
      const { duration } = wavInfo(frame.audio, h.sample_rate);
      if (settings.protocolVersion === 2 && Math.round(duration*h.sample_rate) !== h.samples) throw new Error("PCM sample count mismatch");
      let unit = null;
      if (settings.protocolVersion === 2) {
        unit = run.units.get(h.unit_id);
        if (!unit) { unit = {id:h.unit_id,index:h.index,end:h.end,pending:0,final:false}; run.units.set(h.unit_id,unit); }
        unit.pending++;
      }
      const ctx = getContext(run);
      const estimate = (Math.ceil(duration * ctx.sampleRate) + 128) * 4;
      await run.waitForBudget(duration, estimate);
      current(run);
      const bytes = frame.audio;
      const buffer = await run.decode(() => ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), estimate);
      current(run);
      const scheduled = await run.scheduleBuffer(ctx, buffer, 1, { onEnded: () => {
        if (session !== run) return;
        if (unit) { unit.pending--; unitPlayed(run, unit); }
        emit(run, "TTS_PROGRESS", { played: run.endedCount, scheduled: run.scheduledCount });
        if (!run.gate.isPaused() && !run.playbackDrained() && run.sources.size === 0) { run.underflowStarted = ctx.currentTime; emit(run, "TTS_STATUS", { label: "Buffering..." }); }
        maybeFinish(run);
      } });
      current(run);
      if (!run.metrics.firstScheduledAt) {
        run.metrics.firstScheduledAt = Date.now();
        const observeStart = () => {
          if (session !== run) return;
          if (ctx.currentTime >= scheduled.startAt && ctx.state === "running") run.metrics.firstAudioClockStartedAt = Date.now();
          else run.startMonitor = setTimeout(observeStart, 30);
        };
        observeStart();
      }
      if (scheduled.rebuffered && run.underflowStarted !== undefined) {
        run.metrics.underflowSeconds = (run.metrics.underflowSeconds || 0) + Math.max(0,scheduled.startAt-run.underflowStarted);
        delete run.underflowStarted;
      }
      run.metrics.underflows += scheduled.rebuffered ? 1 : 0;
      run.metrics.peakDecodedBytes = run.peakBytes;
      run.metrics.peakBufferedSeconds = run.peakHorizon;
      emit(run, "TTS_STATUS", { label: run.gate.isPaused() ? "Paused" : "Reading...", bufferedSeconds:run.queuedSeconds, metrics:run.metrics });
    }
    current(run);
    if (!run.scheduledAny) throw new Error("No playable audio generated");
    run.metrics.generationFinishedAt = Date.now();
    run.markGenerationComplete();
    maybeFinish(run);
  } catch (error) {
    if (session !== run) return;
    // Never replay a whole passage or silently skip missing audio. Explicit
    // user retry starts a new run; no RAM-heavy whole-document batch fallback.
    finish(run, error.name === "AbortError" ? null : error, error.name === "AbortError" ? "stopped" : "failed");
  }
}

globalThis.addEventListener?.("pagehide", () => { if (session) finish(session, Object.assign(new Error("Playback host closed"),{code:"owner_lost"}), "owner_lost"); });

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (!req._fromBackground || _sender.tab || (req.hostKind || "offscreen") !== hostKind) return false;
  if (req.type === "PING_HOST") { sendResponse({success:true, ready:true, hostKind}); return true; }
  if (req.type === "SPEAK") {
    if (session?.runId === req.runId && session?.clientId === req.clientId) {
      sendResponse({ success: true, started: true, runId: req.runId }); return true;
    }
    runSpeak(req.text, req.settings || {}, req).catch(() => {});
    sendResponse({ success: true, started: true, runId: req.runId }); return true;
  }
  if (req.type === "GET_PLAYBACK_STATE" || req.type === "GET_STATUS") {
    sendResponse({ success: true, active: !!session, paused: session?.gate.isPaused() || false,
      runId: session?.runId || null, clientId: session?.clientId || null, source: session?.source || null,
      sourceTabId: session?.sourceTabId ?? null, sourceFrameId: session?.sourceFrameId ?? 0, hostKind,
      state:session ? (session.gate.isPaused() ? "paused" : (session.sources.size ? "playing" : "buffering")) : "idle" }); return true;
  }
  const run = session;
  if (!run || (req.runId && req.runId !== run.runId) || (req.clientId && req.clientId !== run.clientId)) {
    sendResponse({ success: true, ignored: true }); return true;
  }
  if (req.type === "STOP") { finish(run, null, req.outcome || "stopped"); sendResponse({ success: true, stopped: true }); return true; }
  if (req.type === "PAUSE" || req.type === "RESUME") {
    const pause = req.type === "PAUSE";
    pause ? run.gate.pause() : run.gate.resume();
    const ctx = run.context;
    Promise.resolve(ctx ? (pause ? ctx.suspend() : ctx.resume()) : null).then(async () => {
      current(run);
      // Latest control wins even if context promises resolve out of order.
      if (ctx && run.gate.isPaused() && ctx.state === "running") await ctx.suspend();
      if (ctx && !run.gate.isPaused() && ctx.state === "suspended") await ctx.resume();
      current(run);
      emit(run, "TTS_STATUS", { label: run.gate.isPaused() ? "Paused" : (run.sources.size ? "Reading..." : "Buffering...") });
      sendResponse({ success: true, paused: run.gate.isPaused() });
    }).catch(e => {
      // A device/context failure must not leave the UI believing this run is
      // paused or reading forever. Late controls never tear down a successor.
      if (session === run && e.name !== "AbortError") finish(run, e);
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }
  sendResponse({ success: false, error: `Unknown offscreen message: ${req.type}` }); return true;
});
