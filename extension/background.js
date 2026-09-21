// Open TTS v3.5.0 — Background Service Worker (routing + lifecycle only)
importScripts(
  "shared/constants-umd.js",
  "shared/protocol-umd.js",
  "shared/storage-umd.js",
);

const { SERVER_URL, NATIVE_HOST, LOAD_MODEL_TIMEOUT_MS } = OpenTTSConstants;
const { unwrap, ok, fail, playbackContext, parseApiErrorBody, sendWithRetry, describeFetchError } = OpenTTSProtocol;
const { getAuthHeaders, storeInstallToken } = OpenTTSStorage;

let activeSession = null;
let sessionRevision = 0;

let offscreenCreation = null;
let readerCreation = null;
async function hostExists(kind) {
  if (kind === "offscreen" && chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({documentUrls:[chrome.runtime.getURL(kind === "reader" ? "reader.html" : "offscreen.html")]});
  return contexts.length > 0;
}
async function ensureReader() {
  if (await hostExists("reader")) return true;
  if (!readerCreation) readerCreation = (async () => {
    await chrome.tabs.create({url:chrome.runtime.getURL("reader.html"), active:true});
    for (let n=0;n<50;n++) {
      try {
        const r = await chrome.runtime.sendMessage({type:"PING_HOST",_fromBackground:true,hostKind:"reader"});
        if (r?.ready) return true;
      } catch (_) {}
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error("Reader did not become ready");
  })().finally(()=>{readerCreation=null;});
  return readerCreation;
}
async function hostSnapshot(kind) {
  if (!await hostExists(kind)) return null;
  const snapshot = await chrome.runtime.sendMessage({type:"GET_PLAYBACK_STATE",_fromBackground:true,hostKind:kind});
  return snapshot ? {...snapshot,hostKind:kind} : null;
}
function ownerLost(target) {
  if (activeSession?.runId !== target.runId) return;
  sessionRevision++; activeSession=null;
  notifyClient(target,{type:"TTS_ERROR",...target,outcome:"owner_lost",message:"Playback page closed or was discarded. Start a new reading."});
}
let historyWrite = Promise.resolve();
function persistCompletion(entry) {
  if (!entry) return Promise.resolve();
  historyWrite = historyWrite.catch(()=>{}).then(async()=>{
    const {historyEnabled,ttsHistory=[]} = await OpenTTSStorage.localGet(["historyEnabled","ttsHistory"]);
    if (historyEnabled === false) return;
    const history = ttsHistory.filter(e=>e.id!==entry.id);
    history.push(entry);
    await OpenTTSStorage.localSet({ttsHistory:history.slice(-OpenTTSConstants.MAX_HISTORY)});
  });
  return historyWrite;
}
async function ensureOffscreen() {
  if (await hostExists("offscreen")) return true;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"), reasons: ["AUDIO_PLAYBACK"],
      justification: "Local TTS audio playback and synthesis",
    }).then(() => true).catch(async (error) => {
      if (await hostExists("offscreen")) return true;
      throw error;
    }).finally(() => { offscreenCreation = null; });
  }
  return offscreenCreation;
}

async function recoverSession() {
  if (activeSession) return activeSession;
  const revision = sessionRevision;
  const reader = await hostSnapshot("reader");
  const resp = reader?.active ? reader : await hostSnapshot("offscreen");
  if (sessionRevision !== revision) return activeSession;
  // Both a new SPEAK and a terminal event invalidate an outstanding snapshot.
  if (!activeSession && resp?.active && resp.runId && resp.clientId) {
    activeSession = { ...resp };
    sessionRevision++;
  }
  return activeSession;
}

async function sendToOffscreen(payload) {
  const kind = payload.hostKind || "offscreen";
  if (payload.type === "SPEAK") {
    if (!await (kind === "reader" ? ensureReader() : ensureOffscreen())) throw new Error("Playback host unavailable");
  } else if (!await hostExists(kind)) return {success:true,ignored:true};
  if (payload.type === "SPEAK" && activeSession?.runId !== payload.runId) throw new Error("Superseded playback request");
  return sendWithRetry(() => new Promise((resolve, reject) => {
    if (payload.type === "SPEAK" && activeSession?.runId !== payload.runId) {
      reject(new Error("Superseded playback request")); return;
    }
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
    if (data.engine !== "open-tts" || typeof data.version !== "string") throw new Error("Port is not an Open TTS backend");
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

const deliveredTerminals = new Set();
function notifyClient(session, payload) {
  if (["TTS_DONE","TTS_ERROR"].includes(payload.type) && payload.runId) {
    if (deliveredTerminals.has(payload.runId)) return false;
    deliveredTerminals.add(payload.runId);
    if (deliveredTerminals.size > 200) deliveredTerminals.delete(deliveredTerminals.values().next().value);
  }
  const routed = { ...payload, _routedByBackground: true };
  chrome.runtime.sendMessage(routed).catch(() => {});
  if (session?.sourceTabId && session.source !== "popup") {
    chrome.tabs.sendMessage(session.sourceTabId, routed, { frameId: session.sourceFrameId || 0 }).catch(() => {});
  }
  return true;
}

function ownsActiveSession(req) {
  if (!activeSession || !req.runId) return false;
  if (req.runId !== activeSession.runId) return false;
  return !req.clientId || req.clientId === activeSession.clientId;
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req._routedByBackground) return false;
  if (req._fromOffscreen) {
    const expectedURL = chrome.runtime.getURL(req.hostKind === "reader" ? "reader.html" : "offscreen.html");
    if (sender.url !== expectedURL) { sendResponse(fail("Invalid playback sender")); return false; }
    if (["TTS_STATUS", "TTS_ERROR", "TTS_DONE", "TTS_PROGRESS"].includes(req.type)) {
      if (OpenTTSProtocol.isStaleEvent(activeSession, req)) {
        sendResponse({ ignored: true });
        return true;
      }
      if (activeSession) activeSession.state = "active";
      const delivered = notifyClient(activeSession || req, req);
      if (req.type === "TTS_DONE" || req.type === "TTS_ERROR") {
        sessionRevision++;
        activeSession = null;
      }
      if (delivered && req.type === "TTS_DONE" && req.outcome === "completed") {
        persistCompletion(req.historyEntry).then(()=>sendResponse({success:true})).catch(e=>{
          notifyClient(req,{type:"TTS_HISTORY_ERROR",runId:req.runId,clientId:req.clientId,message:e.message}); sendResponse(fail(e.message));
        });
      } else sendResponse({ success: true });
      return true;
    }
    return false;
  }
  if (req._fromBackground) return false;
  const type = req.type;

  if (type === "SPEAK") {
    const ctx = playbackContext(sender, req);
    ctx.hostKind = (String(req.text || "").length > 4000 || ["qwen3-tts","fish-s2-pro"].includes(req.settings?.model) || req.source === "reader") ? "reader" : "offscreen";
    const previous = activeSession;
    sessionRevision++;
    activeSession = { ...ctx, state: "speaking" };
    Promise.resolve()
      .then(async () => {
        // Inspect physical owners too: service-worker memory may have been lost.
        for (const kind of ["reader","offscreen"]) {
          const owner = await hostSnapshot(kind);
          if (activeSession?.runId !== ctx.runId) throw new Error("Superseded playback request");
          if (owner?.active && owner.runId !== ctx.runId) {
            const stopped = await sendToOffscreen({...owner,type:"STOP",outcome:"superseded"});
            if (stopped?.success === false || !stopped) throw new Error("Could not stop previous audio owner");
            notifyClient(owner,{...owner,type:"TTS_DONE",outcome:"superseded"});
          }
        }
        if (previous?.runId && previous.runId !== ctx.runId) notifyClient(previous, { ...previous, type: "TTS_DONE", outcome:"superseded" });
      })
      .then(() => {
        if (activeSession?.runId !== ctx.runId) throw new Error("Superseded playback request");
        return ensureBackendAvailable();
      })
      .then(async () => {
        if (activeSession?.runId !== ctx.runId) throw new Error("Superseded playback request");
        const caps = await (await apiFetch("/v1/capabilities")).json();
        if (caps.engine !== "open-tts" || !caps.protocol_versions?.includes(2)) throw new Error("Update the backend to support progressive streaming v2");
        const headers = await getAuthHeaders();
        if (activeSession?.runId !== ctx.runId) throw new Error("Superseded playback request");
        const settings = {
          ...(req.settings || {}),
          authToken: headers["X-Open-TTS-Token"] || "", protocolVersion:2,
        };
        const historyEntry = {id:ctx.runId,text:req.text,voice:settings.voice,model:settings.model,
          speed:settings.speed,timestamp:Date.now()};
        return sendToOffscreen({ type: "SPEAK", text: req.text, settings, historyEntry, ...ctx });
      })
      .then((r) => sendResponse(r || { success: true, started: true }))
      .catch((e) => {
        if (activeSession?.runId === ctx.runId) activeSession = null;
        sendResponse(fail(e.message, e.code));
      });
    return true;
  }

  if (["STOP", "STOP_TTS", "PAUSE", "RESUME"].includes(type)) {
    (async () => {
      await recoverSession();
      if (!ownsActiveSession(req)) return fail("Playback control does not own the active run", "stale_run");
      const target = { ...activeSession };
      const control = type === "STOP_TTS" ? "STOP" : type;
      if (control !== "STOP" && !await hostExists(target.hostKind || "offscreen")) { ownerLost(target); return fail("Playback host was lost", "owner_lost"); }
      if (control !== "STOP" && target.state === "speaking") return fail("Still preparing playback", "not_ready");
      if (control === "STOP") {
        sessionRevision++;
        activeSession = null; // invalidate pending startup immediately
      }
      const response = await sendToOffscreen({ ...target, type: control });
      if (control !== "STOP" && response?.ignored) { ownerLost(target); return fail("Playback session was lost", "owner_lost"); }
      if (control === "STOP") notifyClient(target,{...target,type:"TTS_DONE",outcome:"stopped"});
      return response;
    })().then(sendResponse).catch(e => sendResponse(fail(e.message)));
    return true;
  }

  if (type === "GET_PLAYBACK_STATE" || type === "GET_STATUS") {
    (async () => {
      const target = await recoverSession();
      if (!target) return ok({ active: false });
      const resp = await hostSnapshot(target.hostKind || "offscreen");
      if (activeSession?.runId !== target.runId) return ok({ active: !!activeSession, ...activeSession });
      if (!resp?.active) {
        // A run may still be preparing the backend, before offscreen SPEAK.
        if (target.state === "speaking") return ok({ active: true, ...target, paused: false });
        ownerLost(target); return ok({ active: false, outcome:"owner_lost" });
      }
      return ok(resp);
    })().then(sendResponse).catch(e => sendResponse(fail(e.message)));
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
        if (existing?.model_warm || existing?.gpu_busy || existing?.status === "ok") {
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
          if (h.model_warm || h.gpu_busy) {
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
    nativeMsg("stop").then((resp) => sendResponse(resp?.success === false ? fail(resp.message || "Stop failed") : ok({ message: resp?.message })))
      .catch((e) => sendResponse(fail(e.message)));
    return true;
  }

  if (type === "ENSURE_SERVER") {
    (async () => {
      const h = await fetchHealth(2000);
      if (h?.model_warm || h?.gpu_busy || h?.status === "ok") {
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