// Open TTS v3.0 — Content Script
// Floating "Speak" widget on selected text.

let widget = null;
let currentRunId = 0;
let isSpeaking = false;
let isPaused = false;
let savedSelection = "";
let _lastRect = null;

const MAX_CHARS = 200000;

// Remove legacy widgets
function removeLegacy() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach(n => n.remove());
}
removeLegacy();
new MutationObserver(removeLegacy)
  .observe(document.documentElement || document.body, { childList: true, subtree: true });

// ─── Widget ──────────────────────────────────────────

function createWidget() {
  const container = document.createElement("div");
  container.id = "open-tts-widget";

  const btn = document.createElement("button");
  btn.id = "open-tts-button";
  btn.type = "button";
  btn.title = "Read selection aloud";
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

  const label = document.createElement("span");
  label.id = "open-tts-label";
  label.textContent = "Speak";

  container.appendChild(btn);
  container.appendChild(label);

  btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  btn.addEventListener("click", onClick);

  document.body.appendChild(container);
  widget = container;
  return container;
}

function setLabel(text) {
  const l = widget?.querySelector("#open-tts-label");
  if (l) l.textContent = text;
}

function showWidget() {
  if (!widget) createWidget();
  if (!_lastRect) return;
  const rect = _lastRect;
  const top = Math.max(window.scrollY + 8, window.scrollY + rect.top - 44);
  const left = Math.max(window.scrollX + 8, Math.min(
    window.scrollX + rect.left + rect.width / 2 - 48,
    window.scrollX + document.documentElement.clientWidth - 100
  ));
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.classList.add("visible");
}

function hideWidget() { widget?.classList.remove("visible"); savedSelection = ""; }
function setBusy(b, t) { widget?.classList.toggle("busy", b); setLabel(t || (b ? "Generating..." : "Speak")); }

function flashError(msg) {
  setLabel(msg);
  widget?.classList.add("error");
  setTimeout(() => { widget?.classList.remove("error"); setLabel("Speak"); }, 3000);
}

// ─── Messaging ───────────────────────────────────────

function send(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(resp);
    });
  });
}

// ─── Click handler ────────────────────────────────────

async function onClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const text = savedSelection || window.getSelection()?.toString().trim() || "";
  if (!text) return;

  if (isSpeaking) {
    if (isPaused) {
      await send({ type: "RESUME" }).catch(() => {});
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading... tap to stop");
      return;
    }
    await send({ type: "PAUSE" }).catch(() => {});
    isPaused = true;
    widget?.classList.add("paused");
    setBusy(true, "Paused — tap to resume");
    return;
  }

  currentRunId++;
  isSpeaking = true;
  isPaused = false;

  try {
    setBusy(true, "Generating...");

    const settings = await new Promise(resolve => {
      chrome.storage.sync.get(["voice", "speed", "language", "model"], (data) => {
        resolve({
          voice: data.voice || "af_bella",
          speed: Number(data.speed) || 1.5,
          language: data.language || "Auto",
          model: data.model || "kokoro",
        });
      });
    });

    await send({ type: "SPEAK", text: text.slice(0, MAX_CHARS), settings });
  } catch (err) {
    flashError(err.message || "Couldn't read");
    isSpeaking = false;
    isPaused = false;
    setBusy(false, "Speak");
  }
}

// ─── Messages from background ───────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "STOP_TTS") {
    currentRunId++;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    setLabel("Speak");
    sendResponse({ stopped: true });
    return true;
  }
  if (msg.type === "TTS_STATUS") {
    setBusy(true, msg.label);
    return true;
  }
  if (msg.type === "TTS_ERROR") {
    isSpeaking = false;
    isPaused = false;
    flashError(msg.message || "Error");
    setBusy(false, "Speak");
    return true;
  }
  if (msg.type === "TTS_DONE") {
    isSpeaking = false;
    isPaused = false;
    setBusy(false, "Speak");
    return true;
  }
});

// ─── Selection events ────────────────────────────────

document.addEventListener("mouseup", () => {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (text) {
    savedSelection = text.slice(0, MAX_CHARS);
    if (sel.rangeCount > 0) _lastRect = sel.getRangeAt(0).getBoundingClientRect();
    showWidget();
  } else {
    setTimeout(() => {
      if (!window.getSelection()?.toString().trim()) hideWidget();
    }, 80);
  }
});

document.addEventListener("mousedown", (e) => {
  if (widget && widget.contains(e.target)) return;
  hideWidget();
});