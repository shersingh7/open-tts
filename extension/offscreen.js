// Open TTS v3.0 — Offscreen Document
// Audio playback + server streaming. Runs at chrome-extension:// origin.

const SERVER_URL = "http://127.0.0.1:8000";
const CHUNK_TARGET = 8000;
const AUDIO_LEAD = 0.05;
const MAX_TIMEOUT = 600000;

let audioCtx = null;
let nextStartTime = 0;
let activeSources = new Set();
let scheduledCount = 0;
let endedCount = 0;
let abortCtl = null;
let isSpeaking = false;

// ─── Audio ───────────────────────────────────────────

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === "closed")
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function resetPlayback() {
  abortCtl?.abort();
  abortCtl = null;
  for (const s of activeSources) { try { s.stop(0); } catch (_) {} }
  activeSources.clear();
  scheduledCount = 0;
  endedCount = 0;
  nextStartTime = 0;
}

// ─── Messaging ───────────────────────────────────────

const notify = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});

// ─── Text chunking ───────────────────────────────────

function norm(t) { return (t || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim(); }

function splitText(text, max = CHUNK_TARGET) {
  const clean = norm(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out = [];
  const flush = c => { if (c.trim()) out.push(c.trim()); };

  for (const para of clean.split(/\n\n+/)) {
    if (!para.trim()) continue;
    if (para.length > max) {
      for (const sent of para.split(/(?<=[.!?])\s+/)) {
        if (!sent) continue;
        if (sent.length > max) {
          let buf = "";
          for (const w of sent.split(" ")) {
            if (!w) continue;
            const next = buf ? `${buf} ${w}` : w;
            if (next.length > max && buf) { flush(buf); buf = w; }
            else buf = next;
          }
          if (buf) flush(buf);
        } else {
          const last = out[out.length - 1];
          const cand = last ? `${last} ${sent}` : sent;
          if (cand.length <= max) out[out.length - 1] = cand;
          else out.push(sent);
        }
      }
    } else {
      const last = out[out.length - 1];
      const cand = last ? `${last}\n\n${para}` : para;
      if (cand.length <= max) out[out.length - 1] = cand;
      else out.push(para);
    }
  }
  return out;
}

// ─── Server health ───────────────────────────────────

let _serverOk = false, _serverAt = 0;
const SERVER_TTL = 5 * 60 * 1000;

async function ensureServer() {
  if (_serverOk && Date.now() - _serverAt < SERVER_TTL) return true;
  try {
    const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) { const d = await r.json(); if (d.model_loaded) { _serverOk = true; _serverAt = Date.now(); return true; } }
  } catch (_) {}
  try {
    const startResult = await new Promise(resolve => chrome.runtime.sendMessage({ type: "ENSURE_SERVER" }, resolve));
    if (startResult?.success) {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) { const d = await r.json(); if (d.model_loaded) { _serverOk = true; _serverAt = Date.now(); return true; } }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return false;
}

// ─── Streaming batch protocol ─────────────────────────
// Frame: [4-byte header-len][JSON header][4-byte audio-len][audio bytes]
// Terminal frame: header {done: true}

async function* streamBatch(texts, settings, signal) {
  const body = {
    texts,
    voice: settings.voice || "af_bella",
    speed: Number(settings.speed) || 1.5,
    language: settings.language || "Auto",
  };
  if (settings.model) body.model = settings.model;

  const r = await fetch(`${SERVER_URL}/v1/synthesize-stream-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(MAX_TIMEOUT),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail || `Server error ${r.status}`);
  }

  const reader = r.body.getReader();
  let buf = new Uint8Array(0);

  while (true) {
    const { value, done: rd } = await reader.read();
    if (value) {
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
    }
    if (rd && buf.length === 0) break;

    while (buf.length >= 4) {
      const hdrLen = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
      if (buf.length < 4 + hdrLen + 4) break;

      const hdr = JSON.parse(new TextDecoder().decode(buf.slice(4, 4 + hdrLen)));
      const audioLenOff = 4 + hdrLen;
      const audioLen = new DataView(buf.buffer, buf.byteOffset + audioLenOff, 4).getUint32(0, true);
      const audioOff = audioLenOff + 4;

      if (buf.length < audioOff + audioLen) break;
      const audioData = buf.slice(audioOff, audioOff + audioLen);
      buf = buf.slice(audioOff + audioLen);

      if (hdr.done) { reader.cancel().catch(() => {}); return; }
      if (hdr.error) { yield { error: hdr.error, index: hdr.index }; continue; }
      if (audioLen > 0) {
        yield {
          audio: audioData,
          index: hdr.index,
          sampleRate: hdr.sample_rate,
          applyPlaybackRate: hdr.apply_playback_rate || false,
          playbackRate: hdr.playback_rate || 1.0,
        };
      }
    }

    if (rd) break;
  }
}

// ─── Decode + schedule ───────────────────────────────

async function decodeWav(bytes) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return getAudioCtx().decodeAudioData(ab);
}

function scheduleBuffer(buf, playbackRate = 1.0) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended") ctx.resume();

  const startAt = Math.max(nextStartTime, ctx.currentTime + AUDIO_LEAD);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = playbackRate;
  src.connect(ctx.destination);
  src.start(startAt);
  nextStartTime = startAt + (buf.duration / playbackRate);
  activeSources.add(src);
  scheduledCount++;

  src.onended = () => {
    activeSources.delete(src);
    endedCount++;
    if (endedCount >= scheduledCount) { isSpeaking = false; notify("TTS_DONE"); }
  };
}

// ─── Main pipeline ────────────────────────────────────

async function doSpeak(text, settings) {
  isSpeaking = true;
  resetPlayback();
  abortCtl = new AbortController();

  try {
    notify("TTS_STATUS", { label: "Preparing..." });
    const chunks = splitText(text, CHUNK_TARGET);
    if (!chunks.length) throw new Error("Nothing to read");

    if (!await ensureServer()) throw new Error("Server not running");

    notify("TTS_STATUS", { label: `Generating ${chunks.length} chunk(s)...` });

    let decoded = 0;
    let started = false;
    let totalChunks = chunks.length;

    for await (const frame of streamBatch(chunks, settings, abortCtl.signal)) {
      if (frame.error) { console.error("[TTS]", frame.index, frame.error); continue; }
      if (!frame.audio) continue;

      try {
        const audioBuf = await decodeWav(frame.audio);
        decoded++;

        if (!started) {
          started = true;
          notify("TTS_STATUS", { label: totalChunks > 1 ? `Reading 1/${totalChunks}... tap to stop` : "Reading... tap to stop" });
        }

        // Apply playback rate from the frame header
        // Kokoro: server already applied speed natively, playbackRate = 1.0
        // Qwen3/Fish: server generated at 1x, we speed up playback
        const rate = frame.applyPlaybackRate ? (frame.playbackRate || 1.0) : 1.0;
        scheduleBuffer(audioBuf, rate);
      } catch (e) {
        console.error("[TTS] Decode error:", e);
      }
    }

    if (!decoded) throw new Error("No playable audio generated");
    _serverOk = true; _serverAt = Date.now();

  } catch (err) {
    if (err.name === "AbortError") { notify("TTS_DONE"); return; }
    console.error("[TTS] Pipeline:", err);
    isSpeaking = false; resetPlayback();
    notify("TTS_ERROR", { message: err.message || "Generation failed" });
  }
}

// ─── Fallback: non-streaming batch ───────────────────

async function doSpeakFallback(text, settings) {
  isSpeaking = true;
  resetPlayback();
  abortCtl = new AbortController();

  try {
    notify("TTS_STATUS", { label: "Preparing..." });
    const chunks = splitText(text, CHUNK_TARGET);
    if (!chunks.length) throw new Error("Nothing to read");

    if (!await ensureServer()) throw new Error("Server not running");

    const body = {
      texts: chunks,
      voice: settings.voice || "af_bella",
      speed: Number(settings.speed) || 1.5,
      language: settings.language || "Auto",
      format: "wav",
    };
    if (settings.model) body.model = settings.model;

    const r = await fetch(`${SERVER_URL}/v1/synthesize-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortCtl.signal || AbortSignal.timeout(MAX_TIMEOUT),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `Server error ${r.status}`); }

    const batch = await r.json();
    const results = batch.results || [];
    if (!results.length) throw new Error("No audio returned");

    notify("TTS_STATUS", { label: "Loading audio..." });

    // Determine playback rate
    const modelId = settings.model || "kokoro";
    const modelInfo = await getModelInfo(modelId);
    const applyRate = modelInfo && !modelInfo.supports_native_speed;
    const rate = applyRate ? (Number(settings.speed) || 1.5) : 1.0;

    let started = false;
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.error || !res.audio_base64) continue;
      try {
        const decoded = await decodeChunk(res.audio_base64);
        if (decoded) {
          if (!started) { started = true; notify("TTS_STATUS", { label: results.length > 1 ? `Reading 1/${results.length}... tap to stop` : "Reading... tap to stop" }); }
          scheduleBuffer(decoded, rate);
        }
      } catch (e) { console.error("[TTS] Decode:", i, e); }
    }

    if (!started) throw new Error("No playable audio");
  } catch (err) {
    if (err.name === "AbortError") { notify("TTS_DONE"); return; }
    console.error("[TTS] Fallback:", err);
    isSpeaking = false; resetPlayback();
    notify("TTS_ERROR", { message: err.message || "Generation failed" });
  }
}

async function getModelInfo(modelId) {
  try {
    const r = await fetch(`${SERVER_URL}/v1/models`);
    const d = await r.json();
    return d.models?.find(m => m.id === modelId);
  } catch (e) { return null; }
}

async function decodeChunk(b64) {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return getAudioCtx().decodeAudioData(bytes.buffer.slice(0));
}

// ─── Router ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  const t = req.type;

  if (t === "SPEAK") {
    doSpeak(req.text, req.settings || {})
      .catch(err => {
        console.warn("[TTS] Stream failed, fallback:", err);
        return doSpeakFallback(req.text, req.settings || {});
      });
    sendResponse({ started: true });
    return true;
  }

  if (t === "STOP") {
    isSpeaking = false; resetPlayback(); notify("TTS_DONE");
    sendResponse({ stopped: true });
    return true;
  }

  if (t === "PAUSE") {
    if (audioCtx?.state === "running") { audioCtx.suspend(); notify("TTS_STATUS", { label: "Paused — tap to resume" }); }
    sendResponse({ paused: true });
    return true;
  }

  if (t === "RESUME") {
    if (audioCtx?.state === "suspended") { audioCtx.resume(); notify("TTS_STATUS", { label: "Reading... tap to stop" }); }
    sendResponse({ resumed: true });
    return true;
  }
});