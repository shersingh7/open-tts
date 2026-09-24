// Open TTS v4 — Content script. Classic script (no imports, no build step): the widget is a closed shadow
// root on <open-tts-widget>, attached to document.documentElement, with its CSS inlined as a <style>.
// The `ui:content` port is opened lazily on the first user action and reconnects the next time it's needed
// (not immediately) if the service worker restarts. See docs/plans/v4-contract.md "Content script".

(function () {
  "use strict";

  // Mirror of the shared/shared/messages.js values this file actually uses.
  // tests/content-messages.test.js asserts every value here equals shared/messages.js.
  const MSG = {
    SPEAK: "SPEAK",
    PAUSE: "PAUSE",
    RESUME: "RESUME",
    STOP: "STOP",
    SESSION: "SESSION",
    REPLY: "REPLY",
    CONTENT_GET_SELECTION: "CONTENT_GET_SELECTION",
    CONTENT_GET_HOST: "CONTENT_GET_HOST",
  };
  const PORT_NAME = "ui:content";
  const HIDDEN_SITES_KEY = "hiddenSites";
  const MAX_CHARS = 200000;
  const REQUEST_TIMEOUT_MS = 15000;
  const HIDE_CHECK_DELAY_MS = 80;
  const CONTEXT_LOST_PATTERN = /context invalidated|Receiving end does not exist|Extension context/i;

  if (!document.documentElement) return;

  function removeLegacy() {
    document.querySelectorAll("#qwen-tts-icon-container").forEach((n) => n.remove());
  }
  removeLegacy();

  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch {
      return false; // cross-origin frame: treat as not-top, never answers CONTENT_GET_HOST
    }
  })();

  const WIDGET_CSS = `
    :host {
      position: absolute;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px 6px 8px;
      border-radius: 12px;
      background: #121410;
      border: 1px solid #2a2c26;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 92, 20, 0.12);
      color: #e8e2d4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
      font-size: 13px;
      font-weight: 600;
      opacity: 0;
      transform: translateY(4px) scale(0.96);
      pointer-events: none;
      transition: opacity 150ms ease, transform 150ms ease;
    }
    :host([data-state="expanded"]) {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    :host([data-state="collapsed"]) {
      opacity: 1;
      transform: none;
      pointer-events: auto;
      position: fixed;
      top: auto;
      left: auto;
      bottom: 16px;
      right: 16px;
      padding: 6px 10px;
    }
    button {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
    }
    #primary {
      background: rgba(255, 92, 20, 0.14);
      width: 40px;
      height: 40px;
      min-width: 40px;
      min-height: 40px;
      border-radius: 50%;
      display: grid;
      place-items: center;
    }
    #primary:hover { background: rgba(255, 92, 20, 0.28); }
    #primary svg { width: 14px; height: 14px; color: #ff5c14; }
    #label { font-size: 12px; font-weight: 600; white-space: nowrap; letter-spacing: 0.01em; }
    #read {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(160, 240, 255, 0.14);
      color: #a0f0ff;
      font-size: 11px;
    }
    #stop {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: rgba(255, 71, 87, 0.14);
      color: #ff8a8a;
      font-size: 13px;
    }
    #stop:hover, #stop:focus-visible { background: rgba(255, 71, 87, 0.28); outline: 2px solid #ff8a8a; outline-offset: 2px; }
    :host([data-error="true"]) { border-color: rgba(255, 71, 87, 0.4); background: #1a1014; }
    :host([data-error="true"]) #label { color: #ff8a8a; }
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `;

  // ---------- state ----------

  let hiddenSites = [];
  let hiddenSite = false;
  let host = null;
  let els = null;
  /** @type {"hidden"|"expanded"|"collapsed"} */
  let displayMode = "hidden";
  let savedSelectionText = "";
  let lastRect = null;
  let errorTimer = null;

  let port = null;
  let requestSeq = 0;
  const pending = new Map();
  let latestSession = { runId: null, state: "idle", label: "Ready", textPreview: "" };
  let controllable = false;

  function isActiveHere() {
    return latestSession.state !== "idle" && controllable;
  }

  // ---------- port (lazy connect, reconnect only on next use) ----------

  function rejectAllPending(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function handlePortMessage(message) {
    if (!message) return;
    if (message.type === MSG.REPLY) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.data);
      } else {
        const error = new Error(message.error || "Request failed");
        if (message.code) error.code = message.code;
        entry.reject(error);
      }
      return;
    }
    if (message.type === MSG.SESSION) {
      latestSession = message.session;
      controllable = message.controllable;
      if (!isActiveHere() && displayMode === "collapsed") displayMode = "hidden";
      renderWidget();
    }
  }

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      rejectAllPending("Disconnected");
    });
    return port;
  }

  function request(cmd) {
    const p = ensurePort();
    const requestId = `c_${Date.now()}_${++requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Request timed out"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      try {
        p.postMessage({ ...cmd, requestId });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(err);
      }
    });
  }

  // ---------- errors ----------

  function friendlyError(err) {
    const message = (err && err.message) || String(err || "");
    if (CONTEXT_LOST_PATTERN.test(message)) return "Open TTS was updated — reload this page";
    return message || "Something went wrong";
  }

  function flashError(message) {
    clearTimeout(errorTimer);
    if (!els) return;
    els.label.textContent = message;
    host.dataset.error = "true";
    errorTimer = setTimeout(() => {
      host.dataset.error = "false";
      renderWidget();
    }, 3000);
  }

  // ---------- widget ----------

  function ensureWidget() {
    if (host) return;
    host = document.createElement("open-tts-widget");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    shadow.appendChild(style);

    const primary = document.createElement("button");
    primary.id = "primary";
    primary.type = "button";
    primary.setAttribute("aria-label", "Speak selected text");
    primary.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    primary.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    primary.addEventListener("click", onPrimaryClick);

    const label = document.createElement("span");
    label.id = "label";
    label.textContent = "Speak";

    const readBtn = document.createElement("button");
    readBtn.id = "read";
    readBtn.type = "button";
    readBtn.title = "Read selection";
    readBtn.setAttribute("aria-label", "Read the new selection");
    readBtn.textContent = "NEW";
    readBtn.hidden = true;
    readBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    readBtn.addEventListener("click", onReadSelectionClick);

    const stopBtn = document.createElement("button");
    stopBtn.id = "stop";
    stopBtn.type = "button";
    stopBtn.title = "Stop reading";
    stopBtn.setAttribute("aria-label", "Stop reading");
    stopBtn.textContent = "■";
    stopBtn.hidden = true;
    stopBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    stopBtn.addEventListener("click", onStopClick);

    shadow.append(primary, label, readBtn, stopBtn);
    host.setAttribute("role", "toolbar");
    host.setAttribute("aria-label", "Open TTS speak widget");
    host.dataset.state = "hidden";
    host.dataset.error = "false";
    document.documentElement.appendChild(host);
    els = { primary, label, readBtn, stopBtn };
  }

  function clampPosition(rect) {
    const margin = 8;
    const widgetW = host.offsetWidth || 148;
    const widgetH = host.offsetHeight || 52;
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

  function renderWidget() {
    if (hiddenSite) {
      if (host) host.dataset.state = "hidden";
      return;
    }
    if (!host) return;
    const active = isActiveHere();
    els.label.textContent = active ? (latestSession.state === "paused" ? "Resume" : "Pause") : "Speak";
    els.stopBtn.hidden = !active;
    const prefix = savedSelectionText.slice(0, 200);
    els.readBtn.hidden = !(active && prefix && prefix !== latestSession.textPreview);

    if (displayMode === "expanded" && lastRect) {
      const { top, left } = clampPosition(lastRect);
      host.style.top = `${top}px`;
      host.style.left = `${left}px`;
    }
    host.dataset.state = displayMode;
  }

  function showExpanded() {
    ensureWidget();
    displayMode = "expanded";
    renderWidget();
  }

  function collapseOrHide() {
    if (!host) return;
    displayMode = isActiveHere() ? "collapsed" : "hidden";
    renderWidget();
  }

  function teardownDisplay() {
    displayMode = "hidden";
    if (host) renderWidget();
  }

  // ---------- actions ----------

  async function onPrimaryClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (isActiveHere()) {
      const runId = latestSession.runId;
      const pause = latestSession.state !== "paused";
      try {
        await request({ type: pause ? MSG.PAUSE : MSG.RESUME, runId });
      } catch (err) {
        flashError(friendlyError(err));
      }
      return;
    }
    const text = savedSelectionText || (window.getSelection() ? window.getSelection().toString().trim() : "");
    if (!text) return;
    await startRun(text);
  }

  async function onReadSelectionClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!savedSelectionText) return;
    await startRun(savedSelectionText);
  }

  async function startRun(text) {
    if (text.length > MAX_CHARS) {
      flashError(`Selection exceeds ${MAX_CHARS} characters`);
      return;
    }
    const runId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await request({ type: MSG.SPEAK, runId, text });
    } catch (err) {
      flashError(friendlyError(err));
    }
  }

  async function onStopClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const runId = latestSession.runId;
    if (!runId) return;
    try {
      await request({ type: MSG.STOP, runId });
    } catch (err) {
      flashError(friendlyError(err));
    }
  }

  // ---------- hidden sites ----------

  function applyHiddenState() {
    hiddenSite = hiddenSites.includes(location.hostname);
    if (hiddenSite) teardownDisplay();
  }

  chrome.storage.sync.get([HIDDEN_SITES_KEY], (result) => {
    if (chrome.runtime.lastError) return;
    hiddenSites = (result && result[HIDDEN_SITES_KEY]) || [];
    applyHiddenState();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[HIDDEN_SITES_KEY]) return;
    hiddenSites = changes[HIDDEN_SITES_KEY].newValue || [];
    applyHiddenState();
  });

  // ---------- selection tracking ----------

  document.addEventListener("mouseup", () => {
    if (hiddenSite) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (text) {
      savedSelectionText = text;
      if (sel.rangeCount > 0) lastRect = sel.getRangeAt(0).getBoundingClientRect();
      showExpanded();
      return;
    }
    setTimeout(() => {
      const stillEmpty = !window.getSelection() || !window.getSelection().toString().trim();
      if (stillEmpty && !isActiveHere()) {
        savedSelectionText = "";
        teardownDisplay();
      }
    }, HIDE_CHECK_DELAY_MS);
  });

  document.addEventListener("mousedown", (event) => {
    if (host && event.target === host) return;
    collapseOrHide();
  });

  // ---------- one-shot messages from the SW/popup ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === MSG.CONTENT_GET_SELECTION) {
      const text = savedSelectionText || (window.getSelection() ? window.getSelection().toString().trim() : "");
      // The SW broadcasts this to every frame in the tab with no frameId and takes whichever frame answers
      // first. An empty-selection frame must stay silent, or it can win the race against the frame that
      // actually holds the selection.
      if (!text) return false;
      sendResponse({ text });
      return false;
    }
    if (message && message.type === MSG.CONTENT_GET_HOST && isTopFrame) {
      sendResponse({ host: location.hostname });
      return false;
    }
    return false;
  });
})();
