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
let activeSources = new Set();
let pendingDecodes = 0; // Track active decodeAudioData calls for clean shutdown

const MAX_SELECTION_CHARS = 200000;
const CHUNK_TARGET_CHARS = 4000;
const STREAM_THRESHOLD_CHARS = 0; // Always stream — first audio ~250ms

// ---------------------------------------------------------------------------
// Text normalizer — precompiled regex for performance
// ---------------------------------------------------------------------------

const RE_ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const RE_WHITESPACE = /\s+/g;

function normalizeText(text) {
  return (text || "").replace(RE_ZERO_WIDTH, "").replace(RE_WHITESPACE, " ").trim();
}

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
  setLabel(labelText || (busy ? "Generating..." : "Speak"));
}

function flashError(message) {
  if (!widget) return;
  setLabel(message);
  widget.classList.add("error");
  setTimeout(() => { widget?.classList.remove("error"); setLabel("Speak"); }, 3000);
}

// ---------------------------------------------------------------------------
// Audio cleanup
// ---------------------------------------------------------------------------

function stopStreamPlayback() {
  for (const source of activeSources) {
    try { source.stop(); } catch(e) {}
    try { source.disconnect(); } catch(e) {}
  }
  activeSources.clear();
  activeSourceCount = 0;
  pendingDecodes = 0;
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
  closeAudioContext();
}

// ---------------------------------------------------------------------------
// Text splitting — paragraph-aware
// ---------------------------------------------------------------------------

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
// AudioBufferQueue — per-chunk lifecycle manager
// ---------------------------------------------------------------------------

class AudioBufferQueue {
  constructor() {
    this.buffers = new Map();     // idx -> { complete: bool }
    this.pending = new Map();     // idx -> { promise, resolve, reject }
    this.isStopped = false;
    this.completedCount = 0;
    this.totalChunks = 0;
  }

  addStreamChunk(idx) {
    if (this.isStopped) return;
    if (!this.buffers.has(idx)) this.buffers.set(idx, { complete: false });
  }

  markChunkComplete(idx) {
    if (this.isStopped) return;
    if (!this.buffers.has(idx)) this.buffers.set(idx, { complete: true });
    const b = this.buffers.get(idx);
    if (!b.complete) {
      b.complete = true;
      this.completedCount++;
    }
    const p = this.pending.get(idx);
    if (p) { this.pending.delete(idx); p.resolve(b); }
  }

  waitForChunk(idx) {
    if (this.isStopped) return Promise.reject(new Error("stopped"));
    const b = this.buffers.get(idx);
    if (b?.complete) return Promise.resolve(b);
    if (this.pending.has(idx)) return this.pending.get(idx).promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.pending.set(idx, { promise, resolve, reject });
    return promise;
  }

  cleanup(fromIdx) {
    for (const [idx] of this.buffers) {
      if (idx < fromIdx) this.buffers.delete(idx);
    }
  }

  stop() {
    this.isStopped = true;
    for (const [, p] of this.pending) {
      try { p.reject(new Error("stopped")); } catch(_) {}
    }
    this.buffers.clear();
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Web Audio API gapless scheduling
// ---------------------------------------------------------------------------

function getAudioContext() {
  if (!audioContext || audioContext.state === "closed")
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return audioContext;
}

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

function waitForAllAudioToFinish(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = setInterval(() => {
      if (activeSourceCount <= 0 && pendingDecodes <= 0) {
        clearInterval(check);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(check);
        reject(new Error("Audio playback timed out"));
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// ArrayBuffer decode helper
// ---------------------------------------------------------------------------

function decodeArrayBufferToAudioBuffer(arrayBuffer) {
  const ctx = getAudioContext();
  const owned = arrayBuffer.slice(0); // owned copy
  pendingDecodes++;
  return ctx.decodeAudioData(owned).finally(() => { pendingDecodes--; });
}

// ---------------------------------------------------------------------------
// Message handlers from background
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STOP_TTS") {
    stopAllAudio();
    if (activeAudioQueue && !activeAudioQueue.isStopped) { activeAudioQueue.stop(); activeAudioQueue = null; }
    isSpeaking = false;
    isPaused = false;
    speakRunId++;
    isStreamActive = false;
    widget?.classList.remove("paused");
    setLabel("Speak");
    if (sendResponse) sendResponse({ stopped: true });
    return;
  }

  // ---- Streaming sub-chunk from background.js ----
  if (message.type === "TTS_STREAM_CHUNK") {
    const { chunkIndex, audioArrayBuffer, audioBase64, audioMimeType } = message;
    if (!activeAudioQueue || activeAudioQueue.isStopped) return;

    const buf = audioArrayBuffer || (audioBase64 ? (() => {
      const binaryStr = atob(audioBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      return bytes.buffer;
    })() : null);

    if (!buf) return;

    (async () => {
      try {
        const ctx = getAudioContext();
        if (ctx.state === "suspended") await ctx.resume();
        if (activeAudioQueue?.isStopped) return;

        const audioBuffer = await decodeArrayBufferToAudioBuffer(buf);
        if (activeAudioQueue?.isStopped) return;

        const dur = scheduleAudioBuffer(audioBuffer);
        if (dur > 0) console.log(`[Open TTS] Scheduled: ${dur.toFixed(1)}s (chunk ${chunkIndex}${audioMimeType ? `, ${audioMimeType}` : ''})`);
      } catch (e) {
        console.error("[Open TTS] Stream decode error:", e);
      }
    })();

    activeAudioQueue.addStreamChunk(chunkIndex);
  }

  if (message.type === "TTS_STREAM_DONE") {
    const { chunkIndex } = message;
    console.log(`[Open TTS] Stream done for chunk ${chunkIndex}`);
    activeAudioQueue?.markChunkComplete(chunkIndex);
  }

  if (message.type === "TTS_STREAM_ERROR") {
    const { chunkIndex, error } = message;
    console.error(`[Open TTS] Stream error chunk ${chunkIndex}:`, error);
    const p = activeAudioQueue?.pending.get(chunkIndex);
    if (p) { activeAudioQueue.pending.delete(chunkIndex); p.reject(new Error(error)); }
  }

  // ---- BATCH result from background.js ----
  if (message.type === "TTS_BATCH_RESULT") {
    const { batchId, result } = message;
    console.log(`[Open TTS] Batch result received: ${result.results.length} items`);
    if (window._batchCallbacks && window._batchCallbacks[batchId]) {
      window._batchCallbacks[batchId](null, result);
      delete window._batchCallbacks[batchId];
    }
  }

  if (message.type === "TTS_BATCH_ERROR") {
    const { batchId, error } = message;
    console.error(`[Open TTS] Batch error:`, error);
    if (window._batchCallbacks && window._batchCallbacks[batchId]) {
      window._batchCallbacks[batchId](new Error(error), null);
      delete window._batchCallbacks[batchId];
    }
  }
});

// ---------------------------------------------------------------------------
// Batch callback registry
// ---------------------------------------------------------------------------
window._batchCallbacks = window._batchCallbacks || {};

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
// BATCH pipeline — single HTTP call for all chunks. The BIG speedup.
// ---------------------------------------------------------------------------

function requestBatchAudio(texts, settings, batchId) {
  return new Promise((resolve, reject) => {
    window._batchCallbacks[batchId] = (err, result) => {
      if (err) reject(err);
      else resolve(result);
    };

    chrome.runtime.sendMessage({
      type: "TTS_BATCH_REQUEST",
      texts,
      voice: settings.voice || "ryan",
      speed: settings.speed || 1.0,
      language: settings.language || "Auto",
      model: settings.model || "qwen3-tts",
      batchId,
    });
  });
}

// ---------------------------------------------------------------------------
// Single-chunk streaming request
// ---------------------------------------------------------------------------

function requestStreamAudio(text, settings, chunkIndex) {
  chrome.runtime.sendMessage({
    type: "TTS_STREAM_REQUEST",
    text,
    voice: settings.voice || "ryan",
    speed: settings.speed || 1.0,
    language: settings.language || "Auto",
    model: settings.model || "qwen3-tts",
    chunkIndex,
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

  // Handle pause / resume / stop
  if (isSpeaking) {
    if (currentAudio && !currentAudio.paused && !isPaused) {
      currentAudio.pause();
      isPaused = true;
      widget?.classList.add("paused");
      setBusy(true, "Paused - tap to resume");
      return;
    }
    if (currentAudio && isPaused) {
      await currentAudio.play();
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading... tap to pause");
      return;
    }
    // Stop everything
    speakRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    stopAllAudio();
    if (activeAudioQueue && !activeAudioQueue.isStopped) { activeAudioQueue.stop(); activeAudioQueue = null; }
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

  // Eagerly resume AudioContext on user gesture
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  try {
    setBusy(true, "Preparing...");
    // Pre-warm server while we prepare
    const serverReady = chrome.runtime.sendMessage({ type: "ENSURE_SERVER" }).catch(() => null);
    const settings = await chrome.storage.sync.get(["voice", "speed", "language", "model"]);
    const playbackRate = Number(settings.speed) || 1.0;
    currentPlaybackRate = playbackRate;

    const chunks = splitTextForTTS(text, CHUNK_TARGET_CHARS);
    if (!chunks.length) throw new Error("Nothing to read");

    await serverReady;

    console.log(`[Open TTS] ${chunks.length} chunk(s), ${text.length} chars, speed: ${playbackRate}x`);

    // ---- ROUTING: Batch for multi-chunk, streaming for single-chunk ----
    if (chunks.length >= 2) {
      await _speakBatch(chunks, settings, runId);
    } else {
      await _speakStream(chunks, settings, runId);
    }

    if (runId === speakRunId) setBusy(false);
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
    if (activeAudioQueue) {
      if (!activeAudioQueue.isStopped) activeAudioQueue.stop();
      activeAudioQueue = null;
    }
  }
}

// ---------------------------------------------------------------------------
// BATCH path — one HTTP call, one gpu_lock acquisition for ALL chunks
// Saves N-1 round-trips and N-1 lock acquires
// ---------------------------------------------------------------------------

async function _speakBatch(chunks, settings, runId) {
  isStreamActive = true;
  const queue = new AudioBufferQueue();
  activeAudioQueue = queue;
  queue.totalChunks = chunks.length;

  setBusy(true, `Generating 1/${chunks.length}...`);

  const batchId = `batch-${runId}-${Date.now()}`;

  let batchResult;
  try {
    batchResult = await requestBatchAudio(chunks, settings, batchId);
  } catch (err) {
    throw new Error(`Batch generation failed: ${err.message}`);
  }

  if (runId !== speakRunId || queue.isStopped) return;

  const totalTime = batchResult.total_time || 0;
  const errorCount = batchResult.error_count || 0;
  console.log(`[Open TTS] Batch done in ${totalTime}s, ${errorCount} errors`);

  // Schedule all results for playback
  for (const item of batchResult.results || []) {
    if (runId !== speakRunId || queue.isStopped) return;

    if (item.error) {
      console.error(`[Open TTS] Batch chunk ${item.index} error: ${item.error}`);
      queue.markChunkComplete(item.index);
      continue;
    }

    if (!item.audio_base64) {
      queue.markChunkComplete(item.index);
      continue;
    }

    setBusy(true, `Reading ${item.index + 1}/${chunks.length}...`);

    try {
      const binaryStr = atob(item.audio_base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      if (runId !== speakRunId || queue.isStopped) return;

      const ctx = getAudioContext();
      if (ctx.state === "suspended") await ctx.resume();

      if (runId !== speakRunId || queue.isStopped) return;

      const audioBuffer = await decodeArrayBufferToAudioBuffer(bytes.buffer);
      if (runId !== speakRunId || queue.isStopped) return;

      const dur = scheduleAudioBuffer(audioBuffer);
      console.log(`[Open TTS] Scheduled batch chunk ${item.index}: ${dur.toFixed(1)}s`);
    } catch (e) {
      console.error(`[Open TTS] Batch chunk ${item.index} decode error:`, e);
    }

    queue.markChunkComplete(item.index);
  }

  // Wait for all audio to finish playing
  if (activeSourceCount > 0) {
    setBusy(true, "Finishing...");
    try {
      await waitForAllAudioToFinish(120000);
    } catch (e) {
      console.error("[Open TTS] Playback timeout:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// SINGLE-CHUNK streaming path — for short text
// ---------------------------------------------------------------------------

async function _speakStream(chunks, settings, runId) {
  isStreamActive = true;
  const queue = new AudioBufferQueue();
  activeAudioQueue = queue;
  queue.totalChunks = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    if (runId !== speakRunId || queue.isStopped) return;

    setBusy(true, `Generating ${i + 1}/${chunks.length}...`);

    requestStreamAudio(chunks[i], settings, i);

    try {
      await queue.waitForChunk(i);
    } catch (e) {
      if (queue.isStopped) return;
      throw e;
    }

    if (runId !== speakRunId || queue.isStopped) return;

    setBusy(true, chunks.length > 1 ? `Reading ${i + 1}/${chunks.length}...` : "Reading... tap to stop");

    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 10));
    }

    queue.cleanup(i);
  }

  if (activeSourceCount > 0) {
    setBusy(true, "Finishing...");
    try {
      await waitForAllAudioToFinish(60000);
    } catch (e) {
      console.error("[Open TTS] Stream playback timeout:", e);
    }
  }
}
