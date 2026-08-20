// Open TTS v3.4 — Background Service Worker (routing + lifecycle only)
importScripts(
  "shared/constants-umd.js",
  "shared/protocol-umd.js",
  "shared/storage-umd.js",
);

const { SERVER_URL, NATIVE_HOST, LOAD_MODEL_TIMEOUT_MS } = OpenTTSConstants;
const { unwrap, ok, fail, playbackContext, parseApiErrorBody, sendWithRetry, describeFetchError } = OpenTTSProtocol;
const { getAuthHeaders, storeInstallToken } = OpenTTSStorage;

let activeSession = null;

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.().catch(() => null);
  if (exists) return true;
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Local TTS audio playback and synthesis",
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
  return sendWithRetry(() => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...payload, _fromBackground: true }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  }));
}

function nativeMsg(command) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native host timeout")), 30000);
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { command }, (resp) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function fetchHealth(timeoutMs = 3000) {
  try {
    const headers = await getAuthHeaders();
    delete headers["Content-Type"];
    const r = await fetch(`${SERVER_URL}/health`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!headers["X-Open-TTS-Token"]) {
      try {
        const status = await nativeMsg("status");
        if (status?.install_token) await storeInstallToken(status.install_token);
      } catch (_) {
        // Health remains useful when the host is not installed; authenticated
        // API calls will return a clear error rather than leaking the token.
      }
    }
    return data;
  } catch {
    return null;
  }
}

async function apiFetch(path, options = {}) {
  const execute = async () => {
    const headers = await getAuthHeaders();
    return fetch(`${SERVER_URL}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(options.timeout || 30000),
    });
  };
  let r;
  try {
    r = await execute();
  } catch (err) {
    throw Object.assign(new Error(describeFetchError(err)), { cause: err });
  }
  if (r.status === 401) {
    try {
      const status = await nativeMsg("status");
      if (status?.install_token) {
        await storeInstallToken(status.install_token);
        r = await execute();
      }
    } catch (_) {}
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const { message, code } = parseApiErrorBody(err, r.status);
    throw Object.assign(new Error(message), { code, status: r.status });
  }
  return r;
}

async function ensureBackendAvailable() {
  const existing = await fetchHealth(2000);
  if (existing?.status === "ok") return existing;

  const started = await nativeMsg("start");
  if (started?.install_token) await storeInstallToken(started.install_token);
  if (started?.success === false) throw new Error(started.message || "Open TTS server failed to start");

  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const health = await fetchHealth(2000);
    if (health?.status === "ok") return health;
  }
  throw new Error("Open TTS server did not become ready");
}

function notifyClient(session, payload) {
  const routed = { ...payload, _routedByBackground: true };
  if (!session?.sourceTabId || session.source === "popup") {
    chrome.runtime.sendMessage(routed).catch(() => {});
    return;
  }
  chrome.tabs.sendMessage(session.sourceTabId, routed, { frameId: session.sourceFrameId || 0 }).catch(() => {});
}

function ownsActiveSession(req) {
  if (!activeSession || !req.runId) return false;
  if (req.runId !== activeSession.runId) return false;
  return !req.clientId || req.clientId === activeSession.clientId;
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req._fromOffscreen) {
    if (["TTS_STATUS", "TTS_ERROR", "TTS_DONE", "TTS_PROGRESS"].includes(req.type)) {
      if (OpenTTSProtocol.isStaleEvent(activeSession, req)) {
        sendResponse({ ignored: true });
        return true;
      }
      notifyClient(activeSession || req, req);
      if (req.type === "TTS_DONE" || req.type === "TTS_ERROR") activeSession = null;
      sendResponse({ success: true });
      return true;
    }
    return false;
  }
  if (req._fromBackground) return false;
  const type = req.type;

  if (type === "SPEAK") {
    const ctx = playbackContext(sender, req);
    const previous = activeSession;
    activeSession = { ...ctx, state: "speaking" };
    Promise.resolve()
      .then(async () => {
        if (previous?.runId && previous.runId !== ctx.runId) {
          await sendToOffscreen({ type: "STOP", ...previous }).catch(() => {});
          notifyClient(previous, { type: "TTS_DONE", ...previous });
        }
      })
      .then(() => ensureBackendAvailable())
      .then(async () => {
        const headers = await getAuthHeaders();
        const settings = {
          ...(req.settings || {}),
          authToken: headers["X-Open-TTS-Token"] || "",
        };
        return sendToOffscreen({ type: "SPEAK", text: req.text, settings, ...ctx });
      })
      .then((r) => sendResponse(r || { success: true, started: true }))
      .catch((e) => {
        if (activeSession?.runId === ctx.runId) activeSession = null;
        sendResponse(fail(e.message, e.code));
      });
    return true;
  }

  if (["STOP", "PAUSE", "RESUME"].includes(type)) {
    if (!ownsActiveSession(req)) {
      sendResponse(fail("Playback control does not own the active run", "stale_run"));
      return true;
    }
    sendToOffscreen({ type, ...activeSession, _fromBackground: true })
      .then((r) => sendResponse(r || { success: true }))
      .catch((e) => sendResponse(fail(e.message)));
    return true;
  }

  if (type === "STOP_TTS") {
    if (ownsActiveSession(req)) {
      sendToOffscreen({ type: "STOP", ...activeSession, _fromBackground: true }).catch(() => {});
    }
    sendResponse({ success: true, stopped: true });
    return true;
  }

  if (type === "ENSURE_OFFSCREEN") {
    ensureOffscreen().then((v) => sendResponse(ok({ ready: v }))).catch(() => sendResponse(fail("Offscreen failed")));
    return true;
  }

  if (type === "GET_HEALTH") {
    fetchHealth(5000).then((data) => {
      if (data) sendResponse(ok(data));
      else sendResponse(fail("Server not reachable"));
    });
    return true;
  }

  if (type === "GET_MODELS") {
    apiFetch("/v1/models").then((r) => r.json()).then((data) => sendResponse(ok(data)))
      .catch((e) => sendResponse(fail(e.message, e.code)));
    return true;
  }

  if (type === "LOAD_MODEL") {
    apiFetch(`/v1/load-model?model_id=${encodeURIComponent(req.modelId || "kokoro")}`, {
      method: "POST",
      timeout: LOAD_MODEL_TIMEOUT_MS || 300000,
    })
      .then((r) => r.json()).then((data) => sendResponse(ok(data)))
      .catch((e) => {
        const message = describeFetchError(e);
        if (message === "Request timed out") {
          sendResponse(fail("Model load timed out. Larger models can take a few minutes — try again.", "timeout"));
          return;
        }
        sendResponse(fail(message, e.code));
      });
    return true;
  }

  if (type === "GET_VOICES") {
    apiFetch("/v1/voices").then((r) => r.json()).then((data) => sendResponse(ok(data)))
      .catch((e) => sendResponse(fail(e.message, e.code)));
    return true;
  }

  if (type === "START_SERVER") {
    (async () => {
      try {
        const existing = await fetchHealth(2000);
        if (existing?.model_warm || existing?.status === "ok") {
          sendResponse(ok({ message: "Already running", model: existing.model, voices: existing.voices, lazy: !existing.model_loaded }));
          return;
        }
        const resp = await nativeMsg("start");
        if (resp?.install_token) await storeInstallToken(resp.install_token);
        if (resp?.success === false) {
          sendResponse(fail(resp.message || "Start failed"));
          return;
        }
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const h = await fetchHealth(3000);
          if (!h) continue;
          if (h.model_warm) {
            sendResponse(ok({ message: `Server ready — ${h.model}`, model: h.model, voices: h.voices }));
            return;
          }
          if (h.status === "ok" && !h.model_loaded) {
            sendResponse(ok({ message: "Server ready", model: null, voices: [], lazy: true }));
            return;
          }
          if (h.model_loaded && i > 30) {
            sendResponse(ok({ message: `Server ready (warming) — ${h.model}`, model: h.model, voices: h.voices }));
            return;
          }
        }
        sendResponse(fail("Server started but model didn't warm up in 60s"));
      } catch (e) {
        sendResponse(fail(e.message));
      }
    })();
    return true;
  }

  if (type === "STOP_SERVER") {
    nativeMsg("stop").then((resp) => sendResponse(ok({ message: resp?.message })))
      .catch((e) => sendResponse(fail(e.message)));
    return true;
  }

  if (type === "ENSURE_SERVER") {
    (async () => {
      const h = await fetchHealth(2000);
      if (h?.model_warm || h?.status === "ok") {
        sendResponse(ok({ ready: true }));
        return;
      }
      try {
        const resp = await nativeMsg("start");
        if (resp?.install_token) await storeInstallToken(resp.install_token);
        sendResponse(ok({ ready: resp?.success !== false }));
      } catch (e) {
        sendResponse(fail(e.message));
      }
    })();
    return true;
  }

  sendResponse(fail(`Unknown message type: ${type}`));
  return true;
});