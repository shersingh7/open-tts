// Open TTS v3.1 — Background Service Worker
const SERVER_URL = "http://127.0.0.1:8000";
const NATIVE_HOST = "com.open_tts.native_host";

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
    const timeout = setTimeout(() => reject(new Error("Native host timeout")), 30000);
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { command }, (resp) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(resp);
    });
  });
}

// ─── Server health ────────────────────────────────────

async function fetchHealth(timeoutMs = 3000) {
  try {
    const r = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function isServerAlive() {
  const h = await fetchHealth();
  return h && h.model_loaded;
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
  const data = await fetchHealth(5000);
  if (data) sendResponse({ success: true, data });
  else sendResponse({ success: false, error: "Server not reachable" });
}

async function handleModels(sendResponse) {
  try {
    const r = await fetch(`${SERVER_URL}/v1/models`, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    sendResponse({ success: true, data });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function handleLoadModel(req, sendResponse) {
  try {
    const r = await fetch(`${SERVER_URL}/v1/load-model?model_id=${encodeURIComponent(req.modelId || "kokoro")}`, { method: "POST", signal: AbortSignal.timeout(30000) });
    const data = await r.json();
    sendResponse({ success: true, data });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function handleVoices(sendResponse) {
  try {
    const r = await fetch(`${SERVER_URL}/v1/voices`, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    sendResponse({ success: true, data });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function handleStart(sendResponse) {
  try {
    // First check if server is already running
    const existing = await fetchHealth(2000);
    if (existing?.model_loaded) {
      sendResponse({ success: true, message: "Already running", alreadyRunning: true });
      return;
    }

    // Try native messaging to start the server
    let resp;
    try {
      resp = await nativeMsg("start");
    } catch (e) {
      sendResponse({ success: false, error: `Cannot start server: ${e.message}. Make sure the native host is installed.` });
      return;
    }

    if (resp?.success === false) {
      sendResponse({ success: false, message: resp?.message || "Start failed" });
      return;
    }

    // Now poll for server to be fully ready (model_warm, not just model_loaded)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const h = await fetchHealth(3000);
      if (h?.model_warm) {
        sendResponse({ success: true, message: `Server ready — ${h.model}`, model: h.model, voices: h.voices });
        return;
      }
      if (h?.model_loaded && i > 30) {
        // Model loaded but not warm after 30s — probably stuck
        sendResponse({ success: true, message: `Server ready (warming) — ${h.model}`, model: h.model, voices: h.voices });
        return;
      }
    }
    sendResponse({ success: false, error: "Server started but model didn't warm up in 60s" });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function handleStop(sendResponse) {
  try {
    const resp = await nativeMsg("stop");
    sendResponse({ success: resp?.success ?? true, message: resp?.message });
  } catch (e) { sendResponse({ success: false, error: e.message }); }
}

async function ensureServer() {
  // Check if already running and warm
  const h = await fetchHealth(3000);
  if (h?.model_warm) return true;

  // Try native messaging
  try {
    const resp = await nativeMsg("start");
    if (resp?.success === false) return false;
  } catch (e) { return false; }

  // Poll for warm
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const h = await fetchHealth(2000);
    if (h?.model_warm) return true;
    if (h?.model_loaded && i > 30) return true; // accept loaded after 30s
  }
  return false;
}

async function handleTTS(req, sendResponse) {
  try {
    // Quick health check — wait for warm
    const h = await fetchHealth(3000);
    if (!h?.model_warm) {
      // Try to start server
      try { await nativeMsg("start"); } catch (e) { sendResponse({ success: false, error: "Server not running" }); return; }
      // Wait for warm
      for (let i = 0; i < 45; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const h2 = await fetchHealth(2000);
        if (h2?.model_warm) break;
        if (i === 44) { sendResponse({ success: false, error: "Server not ready" }); return; }
      }
    }

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
    const buf = await r.arrayBuffer();
    const ct = r.headers.get("content-type") || "audio/wav";
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