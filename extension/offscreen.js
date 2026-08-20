// Open TTS v3.4 — Offscreen synthesis + playback pipeline

const { SERVER_URL, CHUNK_TARGET, FIRST_CHUNK_TARGET } = OpenTTSConstants;
const { isStaleEvent, parseApiErrorBody } = OpenTTSProtocol;

const MAX_TIMEOUT = 600000;
const AUDIO_LEAD = 0.05;

let audioCtx = null;
let nextStartTime = 0;
let activeSources = new Set();
let scheduledCount = 0;
let endedCount = 0;
let generationComplete = false;
let abortCtl = null;
let session = null;
let sessionToken = "";
let playClock = OpenTTSPlayback.createPlaybackClock(AUDIO_LEAD);
let playGate = OpenTTSPlayback.createPlaybackGate();

function getAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (sessionToken) headers["X-Open-TTS-Token"] = sessionToken;
  return headers;
}

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function resetPlayback(keepContext = true) {
  abortCtl?.abort();
  abortCtl = null;
  for (const s of activeSources) {
    s.onended = null;
    try { s.stop(0); } catch (_) {}
  }
  activeSources.clear();
  scheduledCount = 0;
  endedCount = 0;
  generationComplete = false;
  nextStartTime = 0;
  playClock = OpenTTSPlayback.createPlaybackClock(AUDIO_LEAD);
  playGate = OpenTTSPlayback.createPlaybackGate();
  if (!keepContext && audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

function emit(type, extra = {}) {
  if (isStaleEvent(session, extra)) return;
  chrome.runtime.sendMessage({
    type,
    _fromOffscreen: true,
    clientId: session?.clientId,
    runId: session?.runId,
    sourceTabId: session?.sourceTabId,
    sourceFrameId: session?.sourceFrameId,
    ...extra,
  }).catch(() => {});
}

function splitText(text, max = CHUNK_TARGET, firstMax = FIRST_CHUNK_TARGET || 400) {
  return OpenTTSPlayback.splitText(text, max, firstMax);
}

async function ensureServer() {
  try {
    const headers = await getAuthHeaders();
    delete headers["Content-Type"];
    const r = await fetch(`${SERVER_URL}/health`, { headers, signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      return d.status === "ok";
    }
  } catch (_) {}
  return false;
}

async function* streamBatch(texts, settings, signal) {
  const headers = await getAuthHeaders();
  const body = {
    texts,
    voice: settings.voice || "af_bella",
    speed: Number(settings.speed) || 1.5,
    language: settings.language || "Auto",
  };
  if (settings.model) body.model = settings.model;
  if (settings.instruct) body.instruct = settings.instruct;

  const r = await fetch(`${SERVER_URL}/v1/synthesize-stream-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(MAX_TIMEOUT),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const { message, code } = parseApiErrorBody(err, r.status);
    throw Object.assign(new Error(message), { code });
  }

  const reader = r.body.getReader();
  const decoder = new OpenTTSStream.FrameDecoder();
  while (true) {
    const { value, done: rd } = await reader.read();
    const frames = value ? decoder.push(value) : [];
    for (const { header: hdr, audio: audioData } of frames) {
      if (hdr.done) { reader.cancel().catch(() => {}); return; }
      if (hdr.error) {
        yield { error: hdr.error, code: hdr.code, index: hdr.index };
        continue;
      }
      if (audioData.length > 0) {
        yield {
          audio: audioData,
          index: hdr.index,
          sampleRate: hdr.sample_rate,
          applyPlaybackRate: hdr.apply_playback_rate || false,
          playbackRate: hdr.playback_rate || 1.0,
        };
      }
    }
    if (rd) {
      decoder.finish();
      break;
    }
  }
}

async function decodeWav(bytes) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return getAudioCtx().decodeAudioData(ab);
}

function maybeFinish(runId) {
  if (!generationComplete || scheduledCount === 0 || endedCount < scheduledCount) return;
  if (!session || (runId && session.runId !== runId)) return;
  emit("TTS_DONE");
  sessionToken = "";
  session = null;
}

async function scheduleBuffer(buf, playbackRate = 1.0) {
  const ctx = getAudioCtx();
  if (playGate.shouldResumeContext(ctx.state)) await ctx.resume();
  if (!playGate.canStart(ctx.state)) throw new Error("Audio playback is blocked by Chrome");
  const startAt = playClock.schedule(buf.duration / playbackRate, ctx.currentTime);
  nextStartTime = startAt + (buf.duration / playbackRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = playbackRate;
  src.connect(ctx.destination);
  src.start(startAt);
  activeSources.add(src);
  scheduledCount++;
  const sourceRunId = session?.runId;

  src.onended = () => {
    activeSources.delete(src);
    if (!session || session.runId !== sourceRunId) return;
    endedCount++;
    emit("TTS_PROGRESS", { played: endedCount, scheduled: scheduledCount });
    maybeFinish(sourceRunId);
  };
}

async function doSpeak(text, settings) {
  emit("TTS_STATUS", { label: OpenTTSPlayback.speakStatus("prepare") });
  const chunks = splitText(text, CHUNK_TARGET);
  if (!chunks.length) throw new Error("Nothing to read");
  if (!await ensureServer()) throw new Error("Server not running");

  emit("TTS_STATUS", { label: OpenTTSPlayback.speakStatus("generate") });
  const result = await OpenTTSPlayback.consumePlaybackStream(
    streamBatch(chunks, settings, abortCtl?.signal),
    {
      schedule: async (frame) => {
        const audioBuf = await decodeWav(frame.audio);
        const rate = frame.applyPlaybackRate ? (frame.playbackRate || 1.0) : 1.0;
        await scheduleBuffer(audioBuf, rate);
      },
      onStatus: () => {
        if (!playGate.isPaused()) {
          emit("TTS_STATUS", { label: OpenTTSPlayback.speakStatus("read") });
        }
      },
    },
  );

  if (!result.decoded) throw new Error("No playable audio generated");
  generationComplete = true;
  maybeFinish(session?.runId);
}

async function doSpeakFallback(text, settings) {
  emit("TTS_STATUS", { label: OpenTTSPlayback.speakStatus("retry") });
  const chunks = splitText(text, CHUNK_TARGET);
  if (!chunks.length) throw new Error("Nothing to read");
  if (!await ensureServer()) throw new Error("Server not running");

  const headers = await getAuthHeaders();
  const body = {
    texts: chunks,
    voice: settings.voice || "af_bella",
    speed: Number(settings.speed) || 1.5,
    language: settings.language || "Auto",
    format: "wav",
  };
  if (settings.model) body.model = settings.model;
  if (settings.instruct) body.instruct = settings.instruct;

  const r = await fetch(`${SERVER_URL}/v1/synthesize-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: abortCtl?.signal || AbortSignal.timeout(MAX_TIMEOUT),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const { message, code } = parseApiErrorBody(e, r.status);
    throw Object.assign(new Error(message), { code });
  }

  const batch = await r.json();
  const results = batch.results || [];
  if (!results.length) throw new Error("No audio returned");

  // Speed is applied server-side (native or time-stretch). Do not also
  // change playbackRate here — that raises pitch and makes Qwen cartoonish.

  let started = false;
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (res.error) throw new Error(res.error);
    if (!res.audio_base64) throw new Error(`Chunk ${i + 1} returned no audio`);
    const decoded = await decodeChunk(res.audio_base64);
    if (decoded) {
      if (!started) {
        started = true;
        emit("TTS_STATUS", { label: OpenTTSPlayback.speakStatus("read") });
      }
      await scheduleBuffer(decoded, 1.0);
    }
  }
  if (!started) throw new Error("No playable audio");
  generationComplete = true;
  maybeFinish(session?.runId);
}

async function decodeChunk(b64) {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return getAudioCtx().decodeAudioData(bytes.buffer.slice(0));
}

async function runSpeak(text, settings, ctx) {
  resetPlayback(true);
  session = { ...ctx, state: "speaking" };
  sessionToken = settings.authToken || "";
  settings = { ...settings };
  delete settings.authToken;
  const runId = ctx.runId;
  abortCtl = new AbortController();
  try {
    await doSpeak(text, settings);
  } catch (err) {
    // A replacement SPEAK may already own the global playback state. Never let
    // the aborted run tear down or complete its successor.
    if (!session || session.runId !== runId) return;
    if (err.name === "AbortError") {
      emit("TTS_DONE");
      sessionToken = "";
      session = null;
      return;
    }
    console.warn("[TTS] Stream failed, trying fallback:", err);
    resetPlayback(true);
    abortCtl = new AbortController();
    try {
      await doSpeakFallback(text, settings);
    } catch (fallbackErr) {
      if (!session || session.runId !== runId) return;
      if (fallbackErr.name === "AbortError") {
        emit("TTS_DONE");
      } else {
        emit("TTS_ERROR", {
          message: fallbackErr.message || "Generation failed",
          code: fallbackErr.code,
        });
      }
      sessionToken = "";
      session = null;
      resetPlayback(true);
      if (fallbackErr.name !== "AbortError") throw fallbackErr;
    }
  }
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (!req._fromBackground) return false;
  const t = req.type;

  if (t === "SPEAK") {
    runSpeak(req.text, req.settings || {}, req)
      .catch(() => {})
      .finally(() => {});
    sendResponse({ success: true, started: true, runId: req.runId });
    return true;
  }

  if (t === "STOP") {
    if (req.runId && session?.runId && req.runId !== session.runId) {
      sendResponse({ success: true, ignored: true });
      return true;
    }
    abortCtl?.abort();
    resetPlayback(true);
    emit("TTS_DONE");
    sessionToken = "";
    session = null;
    sendResponse({ success: true, stopped: true });
    return true;
  }

  if (t === "PAUSE") {
    if (req.runId && session?.runId && req.runId !== session.runId) {
      sendResponse({ success: true, ignored: true });
      return true;
    }
    playGate.pause();
    const ctx = audioCtx;
    Promise.resolve(ctx && ctx.state === "running" ? ctx.suspend() : null)
      .then(() => {
        emit("TTS_STATUS", { label: "Paused" });
        sendResponse({ success: true, paused: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (t === "RESUME") {
    if (req.runId && session?.runId && req.runId !== session.runId) {
      sendResponse({ success: true, ignored: true });
      return true;
    }
    playGate.resume();
    const ctx = audioCtx;
    Promise.resolve(ctx && ctx.state === "suspended" ? ctx.resume() : null)
      .then(() => {
        emit("TTS_STATUS", { label: "Reading..." });
        sendResponse({ success: true, resumed: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  sendResponse({ success: false, error: `Unknown offscreen message: ${t}` });
  return true;
});