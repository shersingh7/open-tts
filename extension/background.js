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
// Array buffer → base64 (only used for non-streaming path)
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
// Active stream ports — let content.js receive ArrayBuffer directly
// Keyed by `${tabId}-${chunkIndex}` so multiple streams can coexist
// ---------------------------------------------------------------------------

const activeStreamPorts = new Map();

function registerStreamPort(tabId, chunkIndex, port) {
  activeStreamPorts.set(`${tabId}-${chunkIndex}`, port);
}

function unregisterStreamPort(tabId, chunkIndex) {
  activeStreamPorts.delete(`${tabId}-${chunkIndex}`);
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
    return true; // No sendResponse — we send chunks via port
  }
  if (request.type === "TTS_STREAM_BATCH_REQUEST") {
    handleTTSStreamBatchRequest(request, sender);
    return true; // No sendResponse — we send chunks via port
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

// Handle port-based streaming from content.js for zero-copy ArrayBuffer transfer
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "tts-stream") {
    const { tabId, chunkIndex } = port.sender || {};
    // Port is from content.js — we'll send ArrayBuffer chunks on it
    // The actual sending happens in handleTTSStreamRequest after fetch starts
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
// maximum idle interval.
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
// Streaming TTS request — sends raw ArrayBuffer directly to content.js
// via chrome.tabs.sendMessage (supports transferable ArrayBuffer)
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
      // Server returned a single audio blob — send as ArrayBuffer directly
      const contentType = response.headers.get("content-type") || "audio/ogg";
      const arrayBuffer = await response.arrayBuffer();

      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_CHUNK",
        chunkIndex: request.chunkIndex,
        audioArrayBuffer: arrayBuffer,
        audioMimeType: contentType,
      });

      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_DONE",
        chunkIndex: request.chunkIndex,
      });
      return;
    }

    // Read streaming response, parse concatenated WAVs, forward raw ArrayBuffer chunks
    const reader = response.body.getReader();
    // Use array of chunks for O(1) append instead of O(n) concat
    const bufferParts = [];
    let bufferLength = 0;
    const STREAM_IDLE_TIMEOUT_MS = 30000;

    // Helper: find next RIFF header in Uint8Array
    function findRiffOffset(buf, start = 0) {
      for (let i = start; i <= buf.length - 4; i++) {
        if (buf[i] === 0x52 && buf[i+1] === 0x49 && buf[i+2] === 0x46 && buf[i+3] === 0x46) {
          return i;
        }
      }
      return -1;
    }

    // Flatten bufferParts into a single Uint8Array — only called when needed
    function flattenBuffer() {
      const result = new Uint8Array(bufferLength);
      let offset = 0;
      for (const part of bufferParts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    }

    while (true) {
      let result;
      try {
        result = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS);
      } catch (readErr) {
        throw new Error(`Stream read failed: ${readErr.message}`);
      }

      const { done, value } = result;
      if (done) break;

      // O(1) append — just push to array
      bufferParts.push(new Uint8Array(value));
      bufferLength += value.length;

      // Only flatten when we need to parse WAVs — avoids O(n) copy on every read
      let buffer = flattenBuffer();
      bufferParts.length = 0;
      bufferParts.push(buffer);
      // bufferLength stays the same

      // Extract complete WAV files from concatenated stream
      let offset = 0;
      while (offset + 44 <= buffer.length) {
        // Scan for RIFF header from current offset
        if (buffer[offset] !== 0x52 || buffer[offset+1] !== 0x49 || buffer[offset+2] !== 0x46 || buffer[offset+3] !== 0x46) {
          const riffOffset = findRiffOffset(buffer, offset);
          if (riffOffset > offset) {
            console.warn(`[Open TTS] Skipping ${riffOffset - offset} corrupted bytes before RIFF header`);
            offset = riffOffset;
            continue;
          } else {
            // No RIFF found — keep last 3 bytes and wait for more data
            const keep = buffer.slice(Math.max(offset, buffer.length - 3));
            bufferParts.length = 0;
            bufferParts.push(keep);
            bufferLength = keep.length;
            break;
          }
        }

        const wavSize = (buffer[offset+4] | (buffer[offset+5] << 8) | (buffer[offset+6] << 16) | (buffer[offset+7] << 24)) + 8;
        if (offset + wavSize > buffer.length) break; // Incomplete WAV — wait for more data

        const wavData = buffer.slice(offset, offset + wavSize);
        offset += wavSize;

        // Send raw ArrayBuffer directly — no base64 conversion!
        // Chrome messaging supports structured cloning of ArrayBuffer
        chrome.tabs.sendMessage(tabId, {
          type: "TTS_STREAM_CHUNK",
          chunkIndex: request.chunkIndex,
          audioArrayBuffer: wavData.buffer.slice(wavData.byteOffset, wavData.byteOffset + wavData.byteLength),
        });
      }

      // Keep unprocessed bytes for next iteration
      if (offset > 0 && offset < buffer.length) {
        const remaining = buffer.slice(offset);
        bufferParts.length = 0;
        bufferParts.push(remaining);
        bufferLength = remaining.length;
      }
    }

    // Process remaining buffer
    if (bufferLength >= 44) {
      const buffer = flattenBuffer();
      const riffOffset = findRiffOffset(buffer);
      const startIdx = riffOffset >= 0 ? riffOffset : (buffer[0] === 0x52 ? 0 : -1);
      if (startIdx >= 0 && startIdx < buffer.length) {
        const wavData = buffer.slice(startIdx);
        chrome.tabs.sendMessage(tabId, {
          type: "TTS_STREAM_CHUNK",
          chunkIndex: request.chunkIndex,
          audioArrayBuffer: wavData.buffer.slice(wavData.byteOffset, wavData.byteOffset + wavData.byteLength),
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

// ---------------------------------------------------------------------------
// Streaming batch handler — parses binary frames, forwards as TTS_STREAM_CHUNK
// ---------------------------------------------------------------------------
async function handleTTSStreamBatchRequest(request, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  try {
    const serverOk = await ensureServerRunning();
    if (!serverOk) {
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_ERROR",
        chunkIndex: 0,
        error: "Server not running or failed to start. Try restarting the server manually.",
      });
      return;
    }

    const body = JSON.stringify({
      texts: request.texts,
      voice: request.voice,
      speed: request.speed,
      language: request.language || "Auto",
      model: request.model,
    });

    const response = await fetchWithRetry(`${SERVER_URL}/v1/synthesize-stream-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: 300000,
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(() => ({}));
      throw new Error(maybeJson?.detail || `Server error ${response.status}`);
    }

    markServerKnownRunning();

    const reader = response.body.getReader();
    const bufferParts = [];
    let bufferLength = 0;
    const STREAM_IDLE_TIMEOUT_MS = 30000;

    function flattenBuffer() {
      const result = new Uint8Array(bufferLength);
      let offset = 0;
      for (const part of bufferParts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    }

    while (true) {
      let result;
      try {
        result = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS);
      } catch (readErr) {
        throw new Error(`Stream read failed: ${readErr.message}`);
      }

      const { done, value } = result;
      if (done) break;

      bufferParts.push(new Uint8Array(value));
      bufferLength += value.length;

      let buffer = flattenBuffer();
      bufferParts.length = 0;
      bufferParts.push(buffer);

      // Parse binary frames: [4-byte header-len][JSON header][4-byte audio-len][audio]
      let offset = 0;
      while (offset + 8 <= buffer.length) {
        const headerLen = new DataView(buffer.buffer, buffer.byteOffset + offset).getUint32(0, true);
        if (offset + 4 + headerLen + 4 > buffer.length) break; // Incomplete header

        const headerBytes = buffer.slice(offset + 4, offset + 4 + headerLen);
        const headerStr = new TextDecoder().decode(headerBytes);
        let header;
        try {
          header = JSON.parse(headerStr);
        } catch (e) {
          throw new Error(`Failed to parse frame header: ${e.message}`);
        }

        if (header.done) {
          // Terminal frame
          offset += 4 + headerLen + 4;
          continue;
        }

        const audioLen = new DataView(buffer.buffer, buffer.byteOffset + offset + 4 + headerLen).getUint32(0, true);
        if (offset + 4 + headerLen + 4 + audioLen > buffer.length) break; // Incomplete audio

        const chunkIndex = header.index;

        if (header.error) {
          chrome.tabs.sendMessage(tabId, {
            type: "TTS_STREAM_ERROR",
            chunkIndex,
            error: header.error,
          });
        } else if (audioLen > 0) {
          const audioData = buffer.slice(offset + 4 + headerLen + 4, offset + 4 + headerLen + 4 + audioLen);
          chrome.tabs.sendMessage(tabId, {
            type: "TTS_STREAM_CHUNK",
            chunkIndex,
            audioArrayBuffer: audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength),
            audioMimeType: "audio/wav",
          });

          if (header.final) {
            chrome.tabs.sendMessage(tabId, {
              type: "TTS_STREAM_DONE",
              chunkIndex,
            });
          }
        }

        offset += 4 + headerLen + 4 + audioLen;
      }

      // Keep unprocessed bytes for next iteration
      if (offset > 0 && offset < buffer.length) {
        const remaining = buffer.slice(offset);
        bufferParts.length = 0;
        bufferParts.push(remaining);
        bufferLength = remaining.length;
      }
    }

    // Process remaining buffer for any trailing frames
    if (bufferLength >= 8) {
      const buffer = flattenBuffer();
      let offset = 0;
      while (offset + 8 <= buffer.length) {
        const headerLen = new DataView(buffer.buffer, buffer.byteOffset + offset).getUint32(0, true);
        if (offset + 4 + headerLen + 4 > buffer.length) break;

        const headerBytes = buffer.slice(offset + 4, offset + 4 + headerLen);
        let header;
        try {
          header = JSON.parse(new TextDecoder().decode(headerBytes));
        } catch (e) { break; }

        if (header.done) {
          offset += 4 + headerLen + 4;
          continue;
        }

        const audioLen = new DataView(buffer.buffer, buffer.byteOffset + offset + 4 + headerLen).getUint32(0, true);
        if (offset + 4 + headerLen + 4 + audioLen > buffer.length) break;

        const chunkIndex = header.index;
        const audioData = buffer.slice(offset + 4 + headerLen + 4, offset + 4 + headerLen + 4 + audioLen);
        if (audioLen > 0) {
          chrome.tabs.sendMessage(tabId, {
            type: "TTS_STREAM_CHUNK",
            chunkIndex,
            audioArrayBuffer: audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength),
          });
        }

        if (header.final) {
          chrome.tabs.sendMessage(tabId, {
            type: "TTS_STREAM_DONE",
            chunkIndex,
          });
        }

        offset += 4 + headerLen + 4 + audioLen;
      }
    }

    // Ensure all chunks get a DONE signal even if server didn't send final frames
    for (let i = 0; i < (request.texts?.length || 0); i++) {
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_DONE",
        chunkIndex: i,
      });
    }

  } catch (error) {
    console.error("[Open TTS Background] Batch stream error:", error);
    markServerUnknown();
    for (let i = 0; i < (request.texts?.length || 0); i++) {
      chrome.tabs.sendMessage(tabId, {
        type: "TTS_STREAM_ERROR",
        chunkIndex: i,
        error: error.message || "Unknown batch streaming error",
      });
    }
  }
}