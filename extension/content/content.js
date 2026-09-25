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
      all: initial;
      position: absolute;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px 5px 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(20, 24, 40, 0.1);
      box-shadow: 0 8px 28px rgba(20, 24, 40, 0.18), 0 1px 3px rgba(20, 24, 40, 0.1);
      color: #151826;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      backdrop-filter: blur(12px);
      opacity: 0;
      transform: translateY(6px) scale(0.94);
      pointer-events: none;
      transition: opacity 140ms ease, transform 160ms cubic-bezier(0.2, 0.8, 0.3, 1.2);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        background: rgba(30, 33, 43, 0.96);
        border-color: rgba(255, 255, 255, 0.1);
        color: #eceef5;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      }
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
      bottom: 20px;
      right: 20px;
    }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      display: inline-grid;
      place-items: center;
      font: inherit;
      color: inherit;
    }
    [hidden] { display: none !important; }
    button:focus-visible { outline: 2px solid #2f6bff; outline-offset: 2px; }
    #primary {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      color: #fff;
      background: linear-gradient(135deg, #2f6bff, #5b4dff);
      box-shadow: 0 3px 10px rgba(47, 107, 255, 0.4);
      transition: transform 120ms ease;
    }
    #primary:hover { transform: scale(1.07); }
    #primary:active { transform: scale(0.95); }
    #primary svg { width: 14px; height: 14px; fill: currentColor; }
    #primary svg.play { margin-left: 2px; }
    #primary .spin {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.4);
      border-top-color: #fff;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #label { font-size: 12.5px; white-space: nowrap; letter-spacing: -0.005em; padding-right: 2px; }
    #read {
      height: 24px;
      padding: 0 9px;
      border-radius: 999px;
      font-size: 11.5px;
      color: #2f6bff;
      background: rgba(47, 107, 255, 0.12);
    }
    #read:hover { background: rgba(47, 107, 255, 0.2); }
    #stop {
      width: 26px;
      height: 26px;
      margin-right: -6px;
      border-radius: 50%;
      color: #868ca3;
    }
    #stop svg { width: 11px; height: 11px; fill: currentColor; }
    #stop:hover { color: #e0433a; background: rgba(224, 67, 58, 0.12); }
    :host([data-error="true"]) { border-color: rgba(224, 67, 58, 0.5); }
    :host([data-error="true"]) #label { color: #e0433a; white-space: normal; max-width: 260px; line-height: 1.3; }
    @media (prefers-reduced-motion: reduce) {
      :host, #primary { transition: none; }
      #primary .spin { animation: none; }
    }
  `;

  const ICON_PLAY = '<svg class="play" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M7 4.6v14.8a1 1 0 0 0 1.5.86l12-7.4a1 1 0 0 0 0-1.72l-12-7.4A1 1 0 0 0 7 4.6Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<rect x="6" y="4.5" width="4.5" height="15" rx="1.2"/><rect x="13.5" y="4.5" width="4.5" height="15" rx="1.2"/></svg>';
  const ICON_SPIN = '<span class="spin" aria-hidden="true"></span>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';

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
    primary.setAttribute("aria-label", "Read selected text aloud");
    primary.innerHTML = ICON_PLAY;
    primary.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    primary.addEventListener("click", onPrimaryClick);

    const label = document.createElement("span");
    label.id = "label";
    label.textContent = "Listen";

    const readBtn = document.createElement("button");
    readBtn.id = "read";
    readBtn.type = "button";
    readBtn.title = "Stop the current reading and read this selection instead";
    readBtn.setAttribute("aria-label", "Read the new selection instead");
    readBtn.textContent = "Read this";
    readBtn.hidden = true;
    readBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    readBtn.addEventListener("click", onReadSelectionClick);

    const stopBtn = document.createElement("button");
    stopBtn.id = "stop";
    stopBtn.type = "button";
    stopBtn.title = "Stop reading";
    stopBtn.setAttribute("aria-label", "Stop reading");
    stopBtn.innerHTML = ICON_STOP;
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
    const state = latestSession.state;
    const loading = active && (state === "preparing" || state === "buffering");
    let label = "Listen";
    let icon = ICON_PLAY;
    let aria = "Read selected text aloud";
    if (active && state === "paused") {
      label = "Resume";
      aria = "Resume reading";
    } else if (loading) {
      label = state === "preparing" ? "Starting…" : "Loading…";
      icon = ICON_SPIN;
      aria = "Pause reading";
    } else if (active) {
      label = "Pause";
      icon = ICON_PAUSE;
      aria = "Pause reading";
    }
    if (host.dataset.error !== "true") els.label.textContent = label;
    const iconKey = icon === ICON_PLAY ? "play" : icon === ICON_PAUSE ? "pause" : "spin";
    if (els.primary.dataset.icon !== iconKey) {
      els.primary.innerHTML = icon;
      els.primary.dataset.icon = iconKey;
    }
    els.primary.setAttribute("aria-label", aria);
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
