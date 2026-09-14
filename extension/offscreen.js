// Open TTS — run-scoped streaming and bounded Web Audio playback.
const { SERVER_URL } = OpenTTSConstants;
const { createPlaybackRun, readWithIdleTimeout } = OpenTTSPlaybackSession;
let session = null;

function current(run) { run.assertActive(); if (session !== run) throw Object.assign(new Error("Superseded"), { name: "AbortError" }); }
function emit(run, type, extra = {}) {
  if (session !== run) return;
  chrome.runtime.sendMessage({ type, _fromOffscreen: true, clientId: run.clientId,
    runId: run.runId, source: run.source, sourceTabId: run.sourceTabId,
    sourceFrameId: run.sourceFrameId, ...extra }).catch(() => {});
}
function finish(run, error) {
  if (session !== run || !run.markTerminal()) return;
  emit(run, error ? "TTS_ERROR" : "TTS_DONE", error ? { message: error.message, code: error.code } : {});
  session = null;
  run.teardown();
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
  if (!(duration > 0) || duration > 20) throw new Error("Audio frame exceeds duration budget");
  return { duration };
}

async function* streamBatch(run, texts, settings) {
  const headers = { "Content-Type": "application/json" };
  if (run.authToken) headers["X-Open-TTS-Token"] = run.authToken;
  const response = await readWithIdleTimeout({ read: () => fetch(`${SERVER_URL}/v1/synthesize-stream-batch`, {
    method: "POST", headers, signal: run.signal,
    body: JSON.stringify({ texts, voice: settings.voice || "af_bella",
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
  const reader = response.body.getReader();
  const decoder = new OpenTTSStream.FrameDecoder();
  const cursor = new OpenTTSStream.StreamCursor(texts.length);
  try {
    while (true) {
      current(run);
      // Intentional backpressure is not a server idle timeout.
      await run.waitForBudget();
      current(run);
      const { value, done } = await readWithIdleTimeout(reader, run.signal);
      current(run);
      for (const frame of value ? decoder.push(value) : []) {
        current(run);
        cursor.accept(frame.header, frame.audio);
        if (frame.audio.length) yield frame;
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
  if (session) finish(session);
  const run = createPlaybackRun({ ...identity, authToken: settings.authToken || "" });
  session = run;
  try {
    emit(run, "TTS_STATUS", { label: "Preparing..." });
    // Transport partitions are large; backend alone selects generation units.
    const texts = OpenTTSPlayback.splitText(text, 40000, 40000);
    if (!texts.length) throw new Error("Nothing to read");
    emit(run, "TTS_STATUS", { label: "Generating..." });
    for await (const frame of streamBatch(run, texts, settings)) {
      current(run);
      const { duration } = wavInfo(frame.audio, frame.header.sample_rate);
      const ctx = getContext(run);
      const estimate = (Math.ceil(duration * ctx.sampleRate) + 128) * 4;
      await run.waitForBudget(duration, estimate);
      current(run);
      const bytes = frame.audio;
      const buffer = await run.decode(() => ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), estimate);
      current(run);
      await run.scheduleBuffer(ctx, buffer, 1, { onEnded: () => {
        if (session !== run) return;
        emit(run, "TTS_PROGRESS", { played: run.endedCount, scheduled: run.scheduledCount });
        if (!run.gate.isPaused() && !run.playbackDrained() && run.sources.size === 0) emit(run, "TTS_STATUS", { label: "Buffering..." });
        maybeFinish(run);
      } });
      current(run);
      emit(run, "TTS_STATUS", { label: run.gate.isPaused() ? "Paused" : "Reading..." });
    }
    current(run);
    if (!run.scheduledAny) throw new Error("No playable audio generated");
    run.markGenerationComplete();
    maybeFinish(run);
  } catch (error) {
    if (session !== run) return;
    // Never replay a whole passage or silently skip missing audio. Explicit
    // user retry starts a new run; no RAM-heavy whole-document batch fallback.
    finish(run, error.name === "AbortError" ? null : error);
  }
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (!req._fromBackground) return false;
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
      sourceTabId: session?.sourceTabId ?? null, sourceFrameId: session?.sourceFrameId ?? 0 }); return true;
  }
  const run = session;
  if (!run || (req.runId && req.runId !== run.runId) || (req.clientId && req.clientId !== run.clientId)) {
    sendResponse({ success: true, ignored: true }); return true;
  }
  if (req.type === "STOP") { finish(run); sendResponse({ success: true, stopped: true }); return true; }
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
