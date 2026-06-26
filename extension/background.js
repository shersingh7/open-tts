// Open TTS v3.0 — Background Service Worker
const SERVER_URL = "http://127.0.0.1:8000";
const NATIVE_HOST = "com.open_tts.native_host";

let _serverKnown = false;
let _serverKnownAt = 0;
const SERVER_TTL = 5 * 60 * 1000;

function isServerKnown() { return _serverKnown && (Date.now() - _serverKnownAt < SERVER_TTL); }
function markServerKnown() { _serverKnown = true; _serverKnownAt = Date.now(); }
function markServerUnknown() { _serverKnown = false; }

// ─── Offscreen lifecycle ─────────────────────────────
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.().catch(() => null);
  if (exists) return true;
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Local TTS audio playback",
    });
    return true;
  } catch (e) {
    if (e.message?.includes("already") || e.message?.includes("offscreen")) return true;
    console.error("[Open TTS] Offscreen:", e);
    return false;
  }
}

async function sendToOffscreen(payload) {
  if (!await ensureOffscreen()) throw new Error("Offscreen unavailable");
  return chrome.runtime.sendMessage(payload);
}

// ─── Native messaging ─────────────────────────────────
function nativeMsg(command) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { command }, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(resp);
    });
  });
}

// ─── Fetch helpers ────────────────────────────────────
async function fetchJson(path, opts = {}) {
  const timeout = opts.timeoutMs ?? 10000;
  const r = await fetch(`${SERVER_URL}${path}`, { ...opts, signal: opts.signal ?? AbortSignal.timeout(timeout) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { markServerUnknown(); throw new Error(data?.detail || `${r.status}`); }
  markServerKnown();
  return data;
}

// ─── Message handler ─────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req._fromBackground) return false;

  const type = req.type;

  if (["SPEAK", "STOP", "PAUSE", "RESUME"].includes(type)) {
    sendToOffscreen({ ...req, _fromBackground: true })
      .then(r => sendResponse(r || { started: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (type === "STOP_TTS") {
    sendToOffscreen({ type: "STOP", _fromBackground: true }).catch(() => {});
    chrome.tabs.query({}).then(tabs => tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: "STOP_TTS" }).catch(() => {}))).catch(() => {});
    sendResponse({ stopped: true });
    return true;
  }

  if (type === "ENSURE_OFFSCREEN") {
    ensureOffscreen().then(ok => sendResponse({ success: ok })).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (type === "TTS_REQUEST") { handleTTS(req, sendResponse); return true; }
  if (type === "GET_HEALTH") { handleHealth(sendResponse); return true; }
  if (type === "GET_MODELS") { handleModels(sendResponse); return true; }
  if (type === "LOAD_MODEL") { handleLoadModel(req, sendResponse); return true; }
  if (type === "GET_VOICES") { handleVoices(sendResponse); return true; }
  if (type === "ENSURE_SERVER") { ensureServer().then(ok => sendResponse({ success: ok })).catch(() => sendResponse({ success: false })); return true; }
  if (type === "START_SERVER") { handleStart(sendResponse); return true; }
  if (type === "STOP_SERVER") { handleStop(sendResponse); return true; }
});

// ─── Handlers ─────────────────────────────────────────
async function handleHealth(sendResponse) {
  try { const data = await fetchJson("/health"); sendResponse({ success: true, data }); }
  catch (e) { markServerUnknown(); sendResponse({ success: false, error: e.message }); }
}

async function handleModels(sendResponse) {
  try { const data = await fetchJson("/v1/models"); sendResponse({ success: true, data }); }
  catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function handleLoadModel(req, sendResponse) {
  try {
    const data = await fetchJson(`/v1/load-model?model_id=${encodeURIComponent(req.modelId || "kokoro")}`, { method: "POST" });
    sendResponse({ success: true, data });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function handleVoices(sendResponse) {
  try { const data = await fetchJson("/v1/voices"); sendResponse({ success: true, data }); }
  catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function handleStart(sendResponse) {
  try {
    markServerUnknown();
    const resp = await nativeMsg("start");
    sendResponse({ success: resp?.success ?? true, message: resp?.message });
  } catch (e) { sendResponse({ success: false, error: `Native messaging: ${e.message}` }); }
}

async function handleStop(sendResponse) {
  try {
    markServerUnknown();
    const resp = await nativeMsg("stop");
    sendResponse({ success: resp?.success ?? true, message: resp?.message });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function ensureServer() {
  if (isServerKnown()) return true;
  const h = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (h?.ok) { const d = await h.json(); if (d.model_loaded) { markServerKnown(); return true; } }
  markServerUnknown();
  try {
    const resp = await nativeMsg("start");
    if (resp?.success === false) return false;
  } catch (e) { return false; }
  // Poll
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { const d = await r.json(); if (d.model_loaded) { markServerKnown(); return true; } }
    } catch (e) {}
  }
  return false;
}

async function handleTTS(req, sendResponse) {
  try {
    if (!await ensureServer()) { sendResponse({ success: false, error: "Server not running" }); return; }
    const body = {
      text: req.text, voice: req.voice, speed: req.speed,
      language: req.language || "Auto", format: "wav",
    };
    if (req.model) body.model = req.model;

    const r = await fetch(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err?.detail || `Server error ${r.status}`);
    }
    markServerKnown();
    const buf = await r.arrayBuffer();
    const ct = r.headers.get("content-type") || "audio/wav";

    // Get speed info from headers
    const applyPlaybackRate = r.headers.get("X-TTS-Apply-Playback-Rate") === "true";
    const playbackRate = parseFloat(r.headers.get("X-TTS-Playback-Rate") || "1.0");

    const b64 = arrayBufferToBase64(buf);
    sendResponse({
      success: true,
      audioData: `data:${ct};base64,${b64}`,
      applyPlaybackRate,
      playbackRate,
    });
  } catch (e) {
    markServerUnknown();
    sendResponse({ success: false, error: e.message });
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(bin);
}