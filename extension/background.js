const SERVER_URL = "http://127.0.0.1:8000";
const NATIVE_HOST_NAME = "com.open_tts.native_host";

// ---------------------------------------------------------------------------
// Server-known-running cache
// ---------------------------------------------------------------------------
let _serverKnownRunning = false;
let _serverKnownRunningAt = 0;
const SERVER_KNOWN_TTL_MS = 5 * 60 * 1000;

function isServerKnownRunning() {
  if (!_serverKnownRunning) return false;
  if (Date.now() - _serverKnownRunningAt > SERVER_KNOWN_TTL_MS) {
    _serverKnownRunning = false;
    return false;
  }
  return true;
}

function markServerKnownRunning() {
  _serverKnownRunning = true;
  _serverKnownRunningAt = Date.now();
}

function markServerUnknown() {
  _serverKnownRunning = false;
}

// ---------------------------------------------------------------------------
// Array buffer → base64 (for passing audio through extension messaging)
// Service workers have no URL.createObjectURL or FileReader, so we go base64.
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TTS_REQUEST") {
    handleTTSRequest(request, sendResponse);
    return true;
  }
  if (request.type === "TTS_STREAM_REQUEST") {
    handleTTSStreamRequest(request, sender);
    return true; // No sendResponse — we send chunks via chrome.tabs.sendMessage
  }
  if (request.type === "GET_VOICES") {
    handleGetVoices(request, sendResponse);
    return true;
  }
  if (request.type === "GET_MODELS") {
    handleGetModels(sendResponse);
    return true;
  }
  if (request.type === "LOAD_MODEL") {
    handleLoadModel(request, sendResponse);
    return true;
  }
  if (request.type === "GET_HEALTH") {
    handleHealth(sendResponse);
    return true;
  }
  if (request.type === "ENSURE_SERVER") {
    ensureServerRunning().then(ok => sendResponse({ success: ok })).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (request.type === "START_SERVER") {
    handleStartServer(sendResponse);
    return true;
  }
  if (request.type === "STOP_SERVER") {
    handleStopServer(sendResponse);
    return true;
  }
  if (request.type === "GET_SERVER_STATUS") {
    handleServerStatus(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------------
// Native messaging
// ---------------------------------------------------------------------------
function sendNativeMessage(command) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { command },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------
async function handleStartServer(sendResponse) {
  try {
    const response = await sendNativeMessage("start");
    markServerUnknown();
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    sendResponse({
      success: false,
      error: `Native messaging error: ${error.message}. Make sure the native host is installed (run install_native_host.sh)`,
    });
  }
}

async function handleStopServer(sendResponse) {
  try {
    const response = await sendNativeMessage("stop");
    markServerUnknown();
    sendResponse({ success: response?.success ?? true, message: response?.message });
  } catch (error) {
    sendResponse({
      success: false,
      error: `Native messaging error: ${error.message}. Make sure the native host is installed (run install_native_host.sh)`,
    });
  }
}

async function handleServerStatus(sendResponse) {
  try {
    const response = await sendNativeMessage("status");
    sendResponse({ success: true, running: response?.running ?? false, pid: response?.pid });
  } catch (error) {
    sendResponse({ success: false, running: false });
  }
}

async function autoStartServer() {
  try {
    // Check if native host is available before attempting start
    const statusResponse = await sendNativeMessage("status").catch(() => null);
    if (statusResponse === null) {
      console.error("[Open TTS Background] Native host not available");
      return { success: false, error: "Native host not available. Make sure the native host is installed (run install_native_host.sh)" };
    }

    console.log("[Open TTS Background] Auto-starting server...");
    const response = await sendNativeMessage("start");
    return { success: response?.success ?? true };
  } catch (error) {
    console.error("[Open TTS Background] Auto-start failed:", error);
    return { success: false, error: error.message };
  }
}

async function waitForServerReady(timeoutMs = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${SERVER_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.model_loaded) {
          markServerKnownRunning();
          return true;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function fetchJson(path, options = {}) {
  // Default 10s timeout so a hung server doesn't freeze the extension
  const timeoutMs = options.timeoutMs ?? 10000;
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const maybeJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    markServerUnknown();
    const detail = maybeJson?.detail || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  markServerKnownRunning();
  return maybeJson;
}

// ---------------------------------------------------------------------------
// Retry helper — 1 retry with 1s delay for transient failures (5xx, network)
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, options = {}, retries = 1, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
      if (response.ok) {
        markServerKnownRunning();
        return response;
      }
      // 4xx = client error, don't retry
      if (response.status >= 400 && response.status < 500) {
        markServerUnknown();
        const maybeJson = await response.json().catch(() => ({}));
        throw new Error(maybeJson?.detail || `Server error ${response.status}`);
      }
      // 5xx = server error, retry
      lastError = new Error(`Server error ${response.status}`);
      markServerUnknown();
    } catch (err) {
      markServerUnknown();
      lastError = err;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Health / Models / Voices / Load-model
// ---------------------------------------------------------------------------
async function handleHealth(sendResponse) {
  try {
    const data = await fetchJson("/health");
    sendResponse({ success: true, data });
  } catch (error) {
    markServerUnknown();
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetModels(sendResponse) {
  try {
    const data = await fetchJson("/v1/models");
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleLoadModel(request, sendResponse) {
  try {
    const modelId = request.modelId || "qwen3-tts";
    const data = await fetchJson(`/v1/load-model?model_id=${encodeURIComponent(modelId)}`, { method: "POST" });
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetVoices(request, sendResponse) {
  try {
    const data = await fetchJson("/v1/voices");
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Ensure server is running
// ---------------------------------------------------------------------------
async function ensureServerRunning() {
  if (isServerKnownRunning()) return true;

  // Use a longer timeout (3s) for the initial health check to avoid false negatives
  // under slow network or container startup conditions
  const healthCheck = await fetch(`${SERVER_URL}/health`, {
    method: "GET",
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

  if (healthCheck && healthCheck.ok) {
    markServerKnownRunning();
    return true;
  }

  markServerUnknown();
  const startResult = await autoStartServer();
  if (!startResult.success) return false;
  return await waitForServerReady(30000);
}

// ---------------------------------------------------------------------------
// Non-streaming TTS request
// Returns base64 data URL — content.js creates Object URL from it
// ---------------------------------------------------------------------------
async function handleTTSRequest(request, sendResponse) {
  try {
    const serverOk = await ensureServerRunning();
    if (!serverOk) {
      sendResponse({ success: false, error: "Server not running or failed to start.", serverDown: true });
      return;
    }

    const body = {
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
      format: "opus",
    };
    if (request.model) body.model = request.model;

    const response = await fetchWithRetry(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 300000,
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      throw new Error(maybeJson?.detail || `Server error ${response.status}`);
    }

    markServerKnownRunning();

    // Convert audio to base64 data URL (service workers can't use URL.createObjectURL)
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "audio/ogg";
    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUrl = `data:${contentType};base64,${base64}`;

    sendResponse({ success: true, audioData: dataUrl });
  } catch (error) {
    console.error("[Open TTS Background] Error:", error);
    markServerUnknown();
    sendResponse({ success: false, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Read with idle timeout — wraps a ReadableStream reader.read() with a
// maximum idle interval.  If the server stops sending data for more than
// `timeoutMs` milliseconds the promise rejects with a descriptive error.
// ---------------------------------------------------------------------------
function readWithTimeout(reader, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel();
      reject(new Error(`Stream read timeout — no data received for ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  return reader.read().then(
    (result) => {
      clearTimeout(timer);
      return result;
    },
    (err) => {
      clearTimeout(timer);
      throw err;
    }
  );
}

// ---------------------------------------------------------------------------
// Streaming TTS request
// Sends raw WAV bytes to content.js via chrome.tabs.sendMessage
// Content.js creates Object URLs (DOM context, not service worker)
// ---------------------------------------------------------------------------
async function handleTTSStreamRequest(request, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  try {
    const serverOk = await ensureServerRunning();
    if (!serverOk) {
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_ERROR",
        chunkIndex: request.chunkIndex,
        error: "Server not running or failed to start. Try restarting the server manually.",
      });
      return;
    }

    const body = {
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
      stream: true,
    };
    if (request.model) body.model = request.model;

    const response = await fetchWithRetry(`${SERVER_URL}/v1/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 300000,
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      const detail = maybeJson?.detail || `Server error ${response.status}`;
      throw new Error(detail);
    }

    markServerKnownRunning();

    // Check if server fell back to non-streaming (e.g. Fish S2 Pro)
    const fallbackHeader = response.headers.get("X-TTS-Fallback");
    if (fallbackHeader === "non-streaming") {
      // Server returned a single audio blob instead of streamed WAV chunks
      // Forward it as a single chunk to content.js
      const contentType = response.headers.get("content-type") || "audio/ogg";
      const arrayBuffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);

      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_CHUNK",
        chunkIndex: request.chunkIndex,
        audioBase64: base64,
        audioMimeType: contentType,
      });

      // Signal completion
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_DONE",
        chunkIndex: request.chunkIndex,
      });
      return;
    }

    // Read streaming response, parse concatenated WAVs, forward raw bytes
    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);
    const STREAM_IDLE_TIMEOUT_MS = 30000; // 30-second idle timeout

    // Helper: find next RIFF header in buffer, skipping corrupted bytes
    function findRiffOffset(buf) {
      for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i] === 0x52 && buf[i+1] === 0x49 && buf[i+2] === 0x46 && buf[i+3] === 0x46) {
          return i;
        }
      }
      return -1;
    }

    while (true) {
      let result;
      try {
        result = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS);
      } catch (readErr) {
        // Timeout or read failure — abort the stream and notify content.js
        throw new Error(`Stream read failed: ${readErr.message}`);
      }

      const { done, value } = result;
      if (done) break;

      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Extract complete WAV files from concatenated stream
      while (buffer.length >= 44) {
        // If buffer doesn't start with RIFF, scan for next RIFF header
        if (buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46) {
          const riffOffset = findRiffOffset(buffer);
          if (riffOffset > 0) {
            console.warn(`[Open TTS] Skipping ${riffOffset} corrupted bytes before RIFF header`);
            buffer = buffer.slice(riffOffset);
            continue;
          } else if (buffer.length > 4) {
            // No RIFF found — keep last 3 bytes (might be partial header) and wait for more data
            buffer = buffer.slice(-3);
            break;
          } else {
            break;
          }
        }

        const wavSize = (buffer[4] | (buffer[5] << 8) | (buffer[6] << 16) | (buffer[7] << 24)) + 8;
        if (buffer.length < wavSize) break; // Incomplete WAV — wait for more data

        const wavData = buffer.slice(0, wavSize);
        buffer = buffer.slice(wavSize);

        // Send raw WAV bytes to content.js — it creates Object URL in DOM context
        // Use base64 for reliable transfer through Chrome messaging
        const base64 = arrayBufferToBase64(wavData.buffer);
        chrome.tabs.sendMessage(tabId, {
          type: "TTS_STREAM_CHUNK",
          chunkIndex: request.chunkIndex,
          audioBase64: base64,
        });
      }
    }

    // Process remaining buffer
    if (buffer.length >= 44) {
      const riffOffset = findRiffOffset(buffer);
      const startIdx = riffOffset >= 0 ? riffOffset : (buffer[0] === 0x52 ? 0 : -1);
      if (startIdx >= 0) {
        const wavData = buffer.slice(startIdx);
        const base64 = arrayBufferToBase64(wavData.buffer);
        chrome.tabs.sendMessage(tabId, {
          type: "TTS_STREAM_CHUNK",
          chunkIndex: request.chunkIndex,
          audioBase64: base64,
        });
      }
    }

    // Signal completion
    chrome.tabs.sendMessage(tabId, {
      type: "TTS_STREAM_DONE",
      chunkIndex: request.chunkIndex,
    });
  } catch (error) {
    console.error("[Open TTS Background] Stream error:", error);
    markServerUnknown();
    chrome.tabs.sendMessage(tabId, {
      type: "TTS_STREAM_ERROR",
      chunkIndex: request.chunkIndex,
      error: error.message || "Unknown streaming error",
    });
  }
}