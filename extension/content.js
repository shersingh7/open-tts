let widget = null;
let currentRunId = 0;
let isSpeaking   = false;
let isPaused     = false;

const MAX_SELECTION_CHARS = 200000;

// ─── Helpers ─────────────────────────────────────────────────────

function removeLegacyWidget() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach(n => n.remove());
}
removeLegacyWidget();
new MutationObserver(() => removeLegacyWidget())
  .observe(document.documentElement || document.body, { childList: true, subtree: true });

// ─── Widget creation ─────────────────────────────────────────

function createWidget() {
  const container = document.createElement("div");
  container.id = "qwen-tts-widget";

  const btn = document.createElement("button");
  btn.id = "qwen-tts-button";
  btn.type = "button";
  btn.title = "Read selection aloud";

  const glyph = document.createElement("span");
  glyph.className = "qwen-glyph";
  glyph.innerHTML = `
    <span class="qwen-glyph-body"></span>
    <span class="qwen-glyph-cone"></span>
    <span class="qwen-glyph-wave wave1"></span>
    <span class="qwen-glyph-wave wave2"></span>
  `;
  btn.appendChild(glyph);

  const label = document.createElement("span");
  label.id = "qwen-tts-label";
  label.textContent = "Speak";
  container.appendChild(btn);
  container.appendChild(label);
  btn.addEventListener("click", onSpeakClick);
  document.body.appendChild(container);
  widget = container;
  return container;
}

function setLabel(text) {
  const label = widget?.querySelector("#qwen-tts-label");
  if (label) label.textContent = text;
}

function showWidgetAtSelection(text) {
  if (!widget) createWidget();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const top  = Math.max(window.scrollY + 8, window.scrollY + rect.top - 44);
  const left = Math.max(window.scrollX + 8, Math.min(
    window.scrollX + rect.left + rect.width / 2 - 48,
    window.scrollX + document.documentElement.clientWidth - 100
  ));
  widget.style.top  = `${top}px`;
  widget.style.left = `${left}px`;
  widget.classList.add("visible");
}

function hideWidget()  { widget?.classList.remove("visible"); }
function setBusy(b, t) { widget?.classList.toggle("busy", b); setLabel(t || (b ? "Generating..." : "Speak")); }

function flashError(msg) {
  setLabel(msg);
  widget?.classList.add("error");
  setTimeout(() => { widget?.classList.remove("error"); setLabel("Speak"); }, 3000);
}

// ─── Offscreen document lifecycle ──────────────────────────

let _offscreenUrl = null;

async function ensureOffscreen() {
  const path = chrome.runtime.getURL("offscreen.html");
  if (_offscreenUrl === path) return;            // already open
  try {
    await chrome.offscreen.createDocument({
      url: path,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Local text-to-speech audio playback",
    });
    _offscreenUrl = path;
  } catch (e) {
    // may already exist across content-script tab switches
    if (e.message?.includes("offscreen")) {
      _offscreenUrl = path;
    } else {
      throw e;
    }
  }
}

function msgToOffscreen(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

// ─── Speak / Pause / Resume / Stop ─────────────────────────

async function onSpeakClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const text = window.getSelection()?.toString().trim() || "";
  if (!text) return;

  // Toggle off if already playing or pausing
  if (isSpeaking) {
    if (isPaused) {
      await msgToOffscreen("RESUME");
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading... tap to stop");
      return;
    }
    // Actually playing — pause
    await msgToOffscreen("PAUSE");
    isPaused = true;
    widget?.classList.add("paused");
    setBusy(true, "Paused — tap to resume");
    return;
  }

  // Full stop-reset
  currentRunId++;
  isSpeaking = true; isPaused = false;
  const runId = currentRunId;

  try {
    await ensureOffscreen();
    setBusy(true, "Generating...");

    const settings = await chrome.storage.sync.get(["voice", "speed", "language", "model"]);
    await msgToOffscreen("SPEAK", { text: text.slice(0, MAX_SELECTION_CHARS), settings });
  } catch (err) {
    if (runId !== currentRunId) return;
    console.error("[Open TTS] Speak error:", err);
    flashError(err.message || "Couldn't read. Tap again");
    isSpeaking = false; isPaused = false;
    setBusy(false, "Speak");
  }
}

// ─── STOP handler from popup ───────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "STOP_TTS") {
    currentRunId++;
    isSpeaking = false; isPaused = false;
    widget?.classList.remove("paused");
    msgToOffscreen("STOP").catch(() => {});
    setLabel("Speak");
    if (sendResponse) sendResponse({ stopped: true });
    return true;
  }
});

// Status updates from offscreen → background → content
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TTS_STATUS") {
    setBusy(true, msg.label);
    return;
  }
  if (msg.type === "TTS_ERROR") {
    isSpeaking = false; isPaused = false;
    flashError(msg.message || "Error");
    setBusy(false, "Speak");
    return;
  }
  if (msg.type === "TTS_DONE") {
    isSpeaking = false; isPaused = false;
    setBusy(false, "Speak");
    return;
  }
});

// ─── Selection events ──────────────────────────────────────

document.addEventListener("mouseup", () => {
  const text = window.getSelection()?.toString().trim();
  if (text) showWidgetAtSelection(text.slice(0, MAX_SELECTION_CHARS));
  else setTimeout(() => { if (!window.getSelection()?.toString().trim()) hideWidget(); }, 80);
});

document.addEventListener("mousedown", (e) => {
  if (widget && !widget.contains(e.target)) hideWidget();
});
