// Open TTS v3.3 — Content Script

let widget = null;
let clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let currentRunId = null;
let isSpeaking = false;
let isPaused = false;
let savedSelection = "";
let _lastRect = null;

const MAX_CHARS = OpenTTSConstants?.MAX_CHARS || 200000;

function removeLegacy() {
  document.querySelectorAll("#qwen-tts-icon-container").forEach((n) => n.remove());
}
removeLegacy();
new MutationObserver(removeLegacy).observe(document.documentElement || document.body, { childList: true, subtree: true });

function createWidget() {
  const container = document.createElement("div");
  container.id = "open-tts-widget";
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "Open TTS speak widget");

  const btn = document.createElement("button");
  btn.id = "open-tts-button";
  btn.type = "button";
  btn.title = "Read selection aloud";
  btn.setAttribute("aria-label", "Speak selected text");
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

  const label = document.createElement("span");
  label.id = "open-tts-label";
  label.textContent = "Speak";

  const stopBtn = document.createElement("button");
  stopBtn.id = "open-tts-stop";
  stopBtn.type = "button";
  stopBtn.title = "Stop reading";
  stopBtn.setAttribute("aria-label", "Stop reading selected text");
  stopBtn.textContent = "■";

  container.append(btn, label, stopBtn);
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  btn.addEventListener("click", onClick);
  stopBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  stopBtn.addEventListener("click", onStop);
  document.body.appendChild(container);
  widget = container;
  return container;
}

function setLabel(text) {
  const l = widget?.querySelector("#open-tts-label");
  if (l) l.textContent = text;
}

function clampPosition(rect) {
  const margin = 8;
  const widgetW = widget?.offsetWidth || 148;
  const widgetH = widget?.offsetHeight || 52;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const top = Math.min(
    Math.max(window.scrollY + margin, window.scrollY + rect.top - widgetH),
    window.scrollY + vh - widgetH - margin,
  );
  const left = Math.min(
    Math.max(window.scrollX + margin, window.scrollX + rect.left + rect.width / 2 - widgetW / 2),
    window.scrollX + vw - widgetW - margin,
  );
  return { top, left };
}

function showWidget() {
  if (!widget) createWidget();
  if (!_lastRect) return;
  const { top, left } = clampPosition(_lastRect);
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.classList.add("visible");
}

function hideWidget() {
  widget?.classList.remove("visible");
  savedSelection = "";
}

function setBusy(b, t) {
  widget?.classList.toggle("busy", b);
  setLabel(t || (b ? "Generating..." : "Speak"));
}

function flashError(msg) {
  setLabel(msg);
  widget?.classList.add("error");
  setTimeout(() => {
    widget?.classList.remove("error");
    setLabel("Speak");
  }, 3000);
}

function send(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function onStop(e) {
  e.preventDefault();
  e.stopPropagation();
  const runId = currentRunId;
  if (runId) {
    await send({ type: "STOP", clientId, runId }).catch(() => {});
  }
  currentRunId = null;
  isSpeaking = false;
  isPaused = false;
  widget?.classList.remove("paused");
  setBusy(false, "Speak");
}

async function onClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const text = savedSelection || window.getSelection()?.toString().trim() || "";
  if (!text) return;

  if (isSpeaking) {
    if (isPaused) {
      await send({ type: "RESUME", clientId, runId: currentRunId }).catch(() => {});
      isPaused = false;
      widget?.classList.remove("paused");
      setBusy(true, "Reading...");
      return;
    }
    await send({ type: "PAUSE", clientId, runId: currentRunId }).catch(() => {});
    isPaused = true;
    widget?.classList.add("paused");
    setBusy(true, "Paused");
    return;
  }

  currentRunId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  isSpeaking = true;
  isPaused = false;

  try {
    setBusy(true, "Generating...");
    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get(["voice", "speed", "language", "model", "voicePrefs", "instruct", "fishStyle"], (data) => {
        const model = data.model || "kokoro";
        resolve({
          voice: OpenTTSConstants.resolveVoice(model, data),
          speed: Number(data.speed) || 1.5,
          language: data.language || "Auto",
          model,
          instruct: data.instruct || "",
        });
      });
    });

    const response = await send({
      type: "SPEAK",
      text: text.slice(0, MAX_CHARS),
      settings,
      clientId,
      runId: currentRunId,
      source: "content",
    });
    if (response?.success === false) throw new Error(response.error || "Playback failed to start");
  } catch (err) {
    flashError(err.message || "Couldn't read");
    isSpeaking = false;
    isPaused = false;
    currentRunId = null;
    setBusy(false, "Speak");
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg._routedByBackground) return false;
  if (msg.clientId && msg.clientId !== clientId) {
    sendResponse({ ignored: true });
    return true;
  }
  if (currentRunId && msg.runId && msg.runId !== currentRunId) {
    sendResponse({ ignored: true });
    return true;
  }

  if (msg.type === "STOP_TTS") {
    currentRunId = null;
    isSpeaking = false;
    isPaused = false;
    widget?.classList.remove("paused");
    setLabel("Speak");
    sendResponse({ stopped: true });
    return true;
  }
  if (msg.type === "TTS_STATUS") {
    setBusy(true, msg.label);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "TTS_PROGRESS") {
    setBusy(true, "Reading...");
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "TTS_ERROR") {
    isSpeaking = false;
    isPaused = false;
    currentRunId = null;
    flashError(msg.message || "Error");
    setBusy(false, "Speak");
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "TTS_DONE") {
    isSpeaking = false;
    isPaused = false;
    currentRunId = null;
    setBusy(false, "Speak");
    sendResponse({ ok: true });
    return true;
  }
  sendResponse({ error: "unknown_message" });
  return true;
});

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