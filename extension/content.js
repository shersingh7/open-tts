let widget = null;
let currentAudio = null;
let selectedText = "";
let speakRunId = 0;
let isSpeaking = false;
let isPaused = false;

// Web Audio API for gapless streaming playback
let audioContext = null;
let nextPlayTime = 0;
let activeSourceCount = 0;
let isStreamActive = false;
let activeAudioQueue = null;
let currentPlaybackRate = 1.0;
let activeSources = new Set(); // Track AudioBufferSourceNodes for clean stop

const MAX_SELECTION_CHARS = 200000;
const CHUNK_TARGET_CHARS = 2000;

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

function removeLegacyWidget() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach(n => n.remove());
}
removeLegacyWidget();
new MutationObserver(() => removeLegacyWidget())
  .observe(document.documentElement || document.body, { childList: true, subtree: true });

function createWidget() {
  const container = document.createElement("div");
  container.id = "qwen-tts-widget";

  const button = document.createElement("button");
  button.id = "qwen-tts-button";
  button.type = "button";
  button.title = "Read selection aloud";

  const glyph = document.createElement("span");
  glyph.className = "qwen-glyph";
  glyph.innerHTML = `
    <span class="qwen-glyph-body"></span>
    <span class="qwen-glyph-cone"></span>
    <span class="qwen-glyph-wave wave1"></span>
    <span class="qwen-glyph-wave wave2"></span>
  `;
  button.appendChild(glyph);

  const label = document.createElement("span");
  label.id = "qwen-tts-label";
  label.textContent = "Speak";

  container.appendChild(button);
  container.appendChild(label);
  button.addEventListener("click", onSpeakClick);
  document.body.appendChild(container);
  widget = container;
  return container;
}

function setLabel(text) {
  const label = widget?.querySelector("#qwen-tts-label");
  if (label) label.textContent = text;
}

function showWidgetAtSelection(text) {
  selectedText = text;
  if (!widget) createWidget();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const top = Math.max(window.scrollY + 8, window.scrollY + rect.top - 44);
  const left = Math.max(window.scrollX + 8, Math.min(
    window.scrollX + rect.left + rect.width / 2 - 48,
    window.scrollX + document.documentElement.clientWidth - 100
  ));
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.classList.add("visible");
}

function hideWidget() { widget?.classList.remove("visible"); }

function setBusy(busy, labelText) {
  if (!widget) return;
  widget.classList.toggle("busy", busy);
  setLabel(labelText || (busy ? "Generating…" : "Speak"));
}

function flashError(message) {
  if (!widget) return;
  setLabel(message);
  widget.classList.add("error");
  setTimeout(() => { widget?.classList.remove("error"); setLabel("Speak"); }, 3000);
}

// ---------------------------------------------------------------------------
// Audio cleanup — reuse AudioContext, just stop sources
// ---------------------------------------------------------------------------

function stopStreamPlayback() {
  // Stop all active AudioBufferSourceNodes without closing the AudioContext
  for (const source of activeSources) {
    try { source.stop(); } catch(e) {}
    try { source.disconnect(); } catch(e) {}
  }
  activeSources.clear();
  activeSourceCount = 0;
  nextPlayTime = 0;
  isStreamActive = false;
}

function closeAudioContext() {
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function stopAllAudio() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio._objectUrl) URL.revokeObjectURL(currentAudio._objectUrl);
    currentAudio.src = "";
    currentAudio = null;
  }
  stopStreamPlayback();
  closeAudioContext(); // Full stop — close context
}

// ---------------------------------------------------------------------------
// Text splitting — paragraph-aware, 2000-char target
// ---------------------------------------------------------------------------

function normalizeText(text) {
  return (text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTextForTTS(text, maxChars = CHUNK_TARGET_CHARS) {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const out = [];
  const flush = (chunk) => { if (chunk.trim()) out.push(chunk.trim()); };

  const paragraphs = cleaned.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length > maxChars && current) flush(current), current = "";

    if (para.length > maxChars) {
      if (current) flush(current), current = "";
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sChunk = "";
      for (const s of sentences) {
        if (!s) continue;
        if (s.length > maxChars) {
          if (sChunk) flush(sChunk), sChunk = "";
          const words = s.split(" ");
          let wChunk = "";
          for (const w of words) {
            const next = wChunk ? `${wChunk} ${w}` : w;
            if (next.length > maxChars && wChunk) flush(wChunk), wChunk = w;
            else wChunk = next;
          }
          if (wChunk) flush(wChunk);
          continue;
        }
        const next = sChunk ? `${sChunk} ${s}` : s;
        if (next.length > maxChars) flush(sChunk), sChunk = s;
        else sChunk = next;
      }
      if (sChunk) flush(sChunk);
    } else {
      current = candidate;
      if (current.length > maxChars) flush(current), current = "";
    }
  }
  if (current) flush(current);
  return out;
}

// ---------------------------------------------------------------------------
// Base64 → Object URL (only for non-streaming path in DOM context)
// ---------------------------------------------------------------------------

function base64ToObjectUrl(base64, mimeType = "audio/wav") {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

// Base64 → ArrayBuffer (for direct AudioContext decode — streaming path)
function base64ToArrayBuffer(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// AudioBufferQueue — per-chunk lifecycle manager
// ---------------------------------------------------------------------------

class AudioBufferQueue {
  constructor() {
    this.buffers = new Map();
    this.pending = new Map();
    this.isStopped = false;
    this.completedCount = 0;
    this.totalChunks = 0;
    this.objectUrls = []; // Track all Object URLs for cleanup
  }

  isReady(idx) { const b = this.buffers.get(idx); return b?.complete; }

  addStreamChunk(idx, objectUrl) {
    if (this.isStopped) return;
    if (!this.buffers.has(idx))
      this.buffers.set(idx, { objectUrls: [], complete: false });
    if (objectUrl) {
      this.buffers.get(idx).objectUrls.push(objectUrl);
      this.objectUrls.push(objectUrl);
    }
  }

  markChunkComplete(idx) {
    if (this.isStopped) return;
    if (!this.buffers.has(idx))
      this.buffers.set(idx, { objectUrls: [], complete: true });
    const b = this.buffers.get(idx);
    if (!b.complete) {
      b.complete = true;
      this.completedCount++;
    }
    const p = this.pending.get(idx);
    if (p) { this.pending.delete(idx); p.resolve(b); }
  }

  setChunkData(idx, audioData, isObjectUrl) {
    if (this.isStopped) return;
    this.buffers.set(idx, { audioData, isObjectUrl, objectUrls: [], complete: true });
    this.completedCount++;
    if (isObjectUrl) this.objectUrls.push(audioData);
    const p = this.pending.get(idx);
    if (p) { this.pending.delete(idx); p.resolve(this.buffers.get(idx)); }
  }

  waitForChunk(idx) {
    const b = this.buffers.get(idx);
    if (b?.complete) return Promise.resolve(b);
    // If there's already a pending promise for this chunk, just return it
    if (this.pending.has(idx)) return this.pending.get(idx).promise;
    // Create a new pending entry
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.pending.set(idx, { promise, resolve, reject });
    return promise;
  }

  waitForAll() {
    if (this.completedCount >= this.totalChunks) return Promise.resolve();
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.isStopped || this.completedCount >= this.totalChunks) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
  }

  getChunk(idx) { return this.buffers.get(idx); }

  cleanup(fromIdx) {
    for (const [idx, b] of this.buffers) {
      if (idx < fromIdx) {
        this.buffers.delete(idx);
      }
    }
  }

  revokeAllUrls() {
    for (const url of this.objectUrls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    this.objectUrls = [];
  }

  stop() {
    this.isStopped = true;
    this.revokeAllUrls();
    for (const [idx, p] of this.pending) { if (p) p.reject(new Error("stopped")); }
    this.buffers.clear();
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Audio request helpers
// ---------------------------------------------------------------------------

async function requestChunkAudio(text, settings) {
  const response = await chrome.runtime.sendMessage({
    type: "TTS_REQUEST",
    text,
    voice: settings.voice || "ryan",
    speed: settings.speed || 1.0,  // FIX: was hardcoded 1.0
    language: settings.language || "Auto",
    model: settings.model || "qwen3-tts",
  });
  if (!response?.success) {
    if (response?.serverDown) throw new Error("Server not running. Start it from the extension popup.");
    throw new Error(response?.error || "Unknown TTS error");
  }
  // background.js returns base64 data URL — convert to Object URL in DOM
  const dataUrl = response.audioData;
  if (dataUrl && dataUrl.startsWith("data:")) {
    const mimeMatch = dataUrl.match(/^data:([^;]+);/);
    const mime = mimeMatch ? mimeMatch[1] : "audio/ogg";
    const base64 = dataUrl.split(",")[1];
    const objectUrl = base64ToObjectUrl(base64, mime);
    return { audioData: objectUrl, isObjectUrl: true };
  }
  return { audioData: dataUrl, isObjectUrl: false };
}

function requestStreamAudio(text, settings, chunkIndex) {
  chrome.runtime.sendMessage({
    type: "TTS_STREAM_REQUEST",
    text,
    voice: settings.voice || "ryan",
    speed: settings.speed || 1.0,  // FIX: was hardcoded 1.0
    language: settings.language || "Auto",
    model: settings.model || "qwen3-tts",
    chunkIndex,
  });
}

// ---------------------------------------------------------------------------
// Web Audio API gapless scheduling — reuse AudioContext
// ---------------------------------------------------------------------------

function getAudioContext() {
  if (!audioContext || audioContext.state === "closed")
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return audioContext;
}

// Schedule a pre-decoded AudioBuffer directly (no Object URL needed)
function scheduleAudioBuffer(audioBuffer) {
  const ctx = getAudioContext();

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = Math.max(0.5, Math.min(3.0, currentPlaybackRate));
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.02;
  source.start(nextPlayTime);
  nextPlayTime += audioBuffer.duration / currentPlaybackRate;

  activeSourceCount++;
  activeSources.add(source);
  source.onended = () => {
    activeSourceCount--;
    activeSources.delete(source);
  };

  return audioBuffer.duration;
}

// Schedule via Object URL fetch + decode (only used for non-streaming path)
async function scheduleAudioUrl(audioUrl) {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  try {
    const resp = await fetch(audioUrl);
    const arrBuf = await resp.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrBuf);
    return scheduleAudioBuffer(decoded);
  } catch (e) {
    console.error("[Open TTS] scheduleAudioUrl error:", e);
    return 0;
  }
}

function waitForAllAudioToFinish() {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (activeSourceCount <= 0) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Stream chunk messages from background.js — direct decode (no Object URL)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STOP_TTS") {
    stopAllAudio();
    if (activeAudioQueue) { activeAudioQueue.stop(); activeAudioQueue = null; }
    isSpeaking = false;
    isPaused = false;
    speakRunId++;
    isStreamActive = false;
    widget?.classList.remove("paused");
    setLabel("Speak");
    if (sendResponse) sendResponse({ stopped: true });
    return;
  }

  if (!activeAudioQueue || !isStreamActive) return;

  if (message.type === "TTS_STREAM_CHUNK") {
    const { chunkIndex, audioBase64, audioMimeType } = message;

    // Direct decode: base64 → ArrayBuffer → AudioContext.decodeAudioData → schedule
    // Works for both WAV (streaming) and opus/mp3 (non-streaming fallback)
    (async () => {
      try {
        const ctx = getAudioContext();
        if (ctx.state === "suspended") await ctx.resume();

        const arrBuf = base64ToArrayBuffer(audioBase64);
        const audioBuffer = await ctx.decodeAudioData(arrBuf);
        const dur = scheduleAudioBuffer(audioBuffer);
        if (dur > 0) console.log(`[Open TTS] Scheduled sub-chunk: ${dur.toFixed(1)}s (chunk ${chunkIndex}${audioMimeType ? `, ${audioMimeType}` : ''})`);
      } catch (e) {
        console.error("[Open TTS] Stream decode error:", e);
      }
    })();

    // Track in queue (no Object URL needed — we decoded directly)
    activeAudioQueue.addStreamChunk(chunkIndex, null);
  }

  if (message.type === "TTS_STREAM_DONE") {
    const { chunkIndex } = message;
    console.log(`[Open TTS] Stream complete for chunk ${chunkIndex}`);
    activeAudioQueue.markChunkComplete(chunkIndex);
  }

  if (message.type === "TTS_STREAM_ERROR") {
    const { chunkIndex, error } = message;
    console.error(`[Open TTS] Stream error chunk ${chunkIndex}:`, error);
    const p = activeAudioQueue.pending.get(chunkIndex);
    if (p) { activeAudioQueue.pending.delete(chunkIndex); p.reject(new Error(error)); }
  }
});

// ---------------------------------------------------------------------------
// Mouse events
// ---------------------------------------------------------------------------

document.addEventListener("mouseup", () => {
  const text = window.getSelection()?.toString().trim();
  if (text) showWidgetAtSelection(text.slice(0, MAX_SELECTION_CHARS));
  else setTimeout(() => { if (!window.getSelection()?.toString().trim()) hideWidget(); }, 80);
});

document.addEventListener("mousedown", (e) => {
  if (widget && !widget.contains(e.target)) hideWidget();
});

// ---------------------------------------------------------------------------
// Play HTMLAudioElement (non-streaming, single chunk)
// ---------------------------------------------------------------------------

function playAudioObjectUrl(audioData, runId, playbackRate) {
  return new Promise((resolve, reject) => {
    if (runId !== speakRunId) return resolve();

    // Only stop HTMLAudioElement, NOT stream playback / audioContext
    if (currentAudio) {
      currentAudio.pause();
      if (currentAudio._objectUrl) URL.revokeObjectURL(currentAudio._objectUrl);
      currentAudio.src = "";
      currentAudio = null;
    }

    currentAudio = new Audio(audioData);
    currentAudio._objectUrl = audioData.startsWith("blob:") ? audioData : null;
    currentAudio.playbackRate = Math.max(0.5, Math.min(3.0, playbackRate));
    currentAudio.preservesPitch = true;
    currentAudio.onended = resolve;
    currentAudio.onerror = () => reject(new Error("Audio playback failed"));
    currentAudio.play().catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Main speak handler
// ---------------------------------------------------------------------------

async function onSpeakClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const text = selectedText?.trim();
  if (!text) return;

  // Pause / resume (HTMLAudioElement only — streaming can't pause mid-buffer)
  if (isSpeaking) {
    if (currentAudio && !currentAudio.paused && !isPaused) {
      currentAudio.pause();
      isPaused = true;
      widget?.classList.add("paused");
      setBusy(true, "Paused · tap to resume");
      return;
    }
    if (currentAudio && isPaused) {
      await currentAudio.play();
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading… tap to pause");
      return;
    }
    // Stop everything
    speakRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    stopAllAudio();
    if (activeAudioQueue) { activeAudioQueue.stop(); activeAudioQueue = null; }
    setBusy(false, "Stopped");
    return;
  }

  const runId = ++speakRunId;
  isSpeaking = true;
  isPaused = false;
  isStreamActive = false;
  widget?.classList.remove("paused");
  nextPlayTime = 0;
  activeSourceCount = 0;
  activeSources.clear();

  // Eagerly resume AudioContext on user gesture (before any network requests)
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  const queue = new AudioBufferQueue();
  activeAudioQueue = queue;

  try {
    setBusy(true, "Preparing…");
    // Pre-warm server connection while we prepare chunks
    const serverReady = chrome.runtime.sendMessage({ type: "ENSURE_SERVER" }).catch(() => null);
    const settings = await chrome.storage.sync.get(["voice", "speed", "language", "model"]);
    const playbackRate = Number(settings.speed) || 1.0;
    currentPlaybackRate = playbackRate;

    const chunks = splitTextForTTS(text, CHUNK_TARGET_CHARS);
    if (!chunks.length) throw new Error("Nothing to read");

    // Ensure server is ready before we start requesting audio
    await serverReady;

    queue.totalChunks = chunks.length;
    console.log(`[Open TTS] ${chunks.length} chunk(s), ${text.length} chars, speed: ${playbackRate}x`);

    const useStream = chunks.length > 1 || text.length > 800;

    if (useStream) {
      // ---- STREAMING PATH ----
      // Sequential chunk generation: MLX GPU can't handle concurrent inference
      // Streaming within each chunk delivers sub-chunks progressively
      // so audio starts playing in ~0.5s regardless of total length.
      isStreamActive = true;

      for (let i = 0; i < chunks.length; i++) {
        if (runId !== speakRunId || queue.isStopped) return;

        setBusy(true, `Generating ${i + 1}/${chunks.length}…`);

        // Start streaming for this chunk
        requestStreamAudio(chunks[i], settings, i);

        // Wait for this chunk's stream to complete
        try {
          await queue.waitForChunk(i);
        } catch (e) {
          if (queue.isStopped) return;
          throw e;
        }

        if (runId !== speakRunId || queue.isStopped) return;

        setBusy(true, `Reading ${i + 1}/${chunks.length}… tap to stop`);

        // Brief pause to let audio pipeline fill before next chunk request
        // GPU lock on server ensures no concurrent inference
        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 20));
        }

        queue.cleanup(i);
      }

      // All chunks generated and scheduled — wait for remaining audio to finish
      if (activeSourceCount > 0) {
        setBusy(true, "Finishing…");
        await waitForAllAudioToFinish();
      }

      queue.revokeAllUrls();

    } else {
      // ---- NON-STREAMING PATH (short text, single chunk) ----
      setBusy(true, "Generating…");
      const result = await requestChunkAudio(chunks[0], settings);
      queue.setChunkData(0, result.audioData, result.isObjectUrl);

      if (runId !== speakRunId || queue.isStopped) return;

      setBusy(true, "Reading… tap to pause");
      await playAudioObjectUrl(result.audioData, runId, playbackRate);
    }

    if (runId === speakRunId && !queue.isStopped) setBusy(false);
  } catch (error) {
    console.error("[Open TTS] Error:", error);
    if (runId === speakRunId) flashError(error?.message || "Couldn't read. Tap again");
  } finally {
    if (runId === speakRunId) {
      isSpeaking = false;
      isPaused = false;
      isStreamActive = false;
      widget?.classList.remove("paused");
    }
    if (activeAudioQueue === queue) {
      queue.stop();
      activeAudioQueue = null;
    }
  }
}