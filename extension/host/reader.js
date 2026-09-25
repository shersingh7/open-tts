// @ts-check
// Open TTS v4 — Reader page. Two roles: playback host (host:reader, same engine as offscreen) and a UI
// (ui:reader) that renders the SW's SESSION snapshots and sends Pause/Resume/Stop/Retry commands.

import { MSG, PORTS } from "../shared/messages.js";
import { makeRunId } from "../shared/protocol.js";
import { createEngine, partitionText } from "./engine.js";
import { connectHost, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from "./host-port.js";
import { createKeepAlive } from "./keep-alive.js";
import { applyView, renderReader } from "./reader-view.js";

const DISCONNECTED_TEXT = "Reconnecting to Open TTS… try again in a moment.";

/**
 * @typedef {object} ReaderOptions
 * @property {{getElementById: (id: string) => any}} [doc]
 * @property {(info: {name: string}) => chrome.runtime.Port} [connect]
 * @property {Record<string, any>} [engineOptions] extra createEngine options (tests: fetchImpl, audioContextFactory)
 * @property {ReturnType<typeof createKeepAlive>} [keepAlive]
 * @property {(fn: () => void, ms: number) => any} [setTimeout]
 * @property {(id: any) => void} [clearTimeout]
 */

/**
 * @param {string} text
 * @returns {string[]}
 */
function safePartitions(text) {
  try {
    return partitionText(text);
  } catch {
    return [];
  }
}

/**
 * Start the Reader page.
 * @param {ReaderOptions} [options]
 */
export function startReader(options = {}) {
  const doc = options.doc || document;
  const connect = options.connect || ((info) => chrome.runtime.connect(info));
  const setTimer = options.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimeout || ((id) => globalThis.clearTimeout(id));
  const keepAlive = options.keepAlive || createKeepAlive();

  /** @type {import("./reader-view.js").ReaderState} */
  const state = {
    session: null,
    controllable: false,
    local: null,
    rejected: null,
    historyError: null,
    commandError: null,
  };
  const render = () => applyView(doc, renderReader(state));

  // ---------- playback host ----------
  /** @type {import("./host-port.js").HostPort | null} */
  let hostPort = null;
  const engine = createEngine({
    hostKind: "reader",
    emit: (message) => hostPort?.forward(message),
    onTerminal: (info) => {
      if (state.local?.runId === info.runId) {
        state.local.retryText = info.retryText;
        state.local.outcome = info.outcome;
      }
      if (!engine.activeRun()) keepAlive.release();
      render();
    },
    ...options.engineOptions,
  });
  /** Engine facade that records what this page is about to read before playback starts. */
  const readerEngine = {
    ...engine,
    /** @param {any} cmd HOST_SPEAK */
    speak(cmd) {
      const runId = cmd?.run?.runId;
      if (!runId || engine.activeRun()?.runId === runId) return;
      const text = String(cmd.text || "");
      state.local = {
        runId,
        text,
        parts: safePartitions(text),
        settings: { ...(cmd.settings || {}) },
        retryText: "",
        outcome: null,
      };
      state.commandError = null;
      keepAlive.hold();
      render();
      engine.speak(cmd);
    },
  };

  // ---------- UI port ----------
  /** @type {chrome.runtime.Port | null} */
  let uiPort = null;
  let uiDelay = RECONNECT_MIN_MS;
  /** @type {any} */
  let uiTimer = null;
  let uiClosed = false;

  /** @param {any} message */
  function onUiMessage(message) {
    if (!message || typeof message !== "object") return;
    uiDelay = RECONNECT_MIN_MS;
    if (message.type === MSG.SESSION) {
      const previousRunId = state.session?.runId;
      state.session = message.session || null;
      state.controllable = Boolean(message.controllable);
      if (state.session?.runId !== previousRunId) state.commandError = null;
    } else if (message.type === MSG.HISTORY_ERROR) {
      state.historyError = { runId: message.runId, message: message.message };
    } else if (message.type === MSG.REPLY && message.ok === false) {
      state.commandError = message.error || "Command failed";
    } else {
      return;
    }
    render();
  }

  function openUiPort() {
    uiTimer = null;
    if (uiClosed) return;
    /** @type {chrome.runtime.Port} */
    let port;
    try {
      port = connect({ name: PORTS.UI_READER });
    } catch {
      scheduleUiReconnect();
      return;
    }
    uiPort = port;
    port.onMessage.addListener((message) => {
      if (port === uiPort) onUiMessage(message);
    });
    port.onDisconnect.addListener(() => {
      void globalThis.chrome?.runtime?.lastError;
      if (port !== uiPort) return;
      uiPort = null;
      scheduleUiReconnect();
    });
  }

  function scheduleUiReconnect() {
    if (uiClosed || uiTimer !== null) return;
    const wait = uiDelay;
    uiDelay = Math.min(uiDelay * 2, RECONNECT_MAX_MS);
    uiTimer = setTimer(openUiPort, wait);
  }

  function closeUiPort() {
    uiClosed = true;
    if (uiTimer !== null) clearTimer(uiTimer);
    uiTimer = null;
    const port = uiPort;
    uiPort = null;
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  /** @param {Record<string, any>} command */
  function sendCommand(command) {
    if (state.rejected) return false;
    try {
      if (!uiPort) throw new Error("disconnected");
      uiPort.postMessage({ requestId: makeRunId(), ...command });
      return true;
    } catch {
      state.commandError = DISCONNECTED_TEXT;
      render();
      return false;
    }
  }

  // ---------- controls ----------
  function onPauseClick() {
    const session = state.session;
    if (!session?.runId || !state.controllable) return;
    sendCommand({ type: session.state === "paused" ? MSG.RESUME : MSG.PAUSE, runId: session.runId });
  }

  function onStopClick() {
    const session = state.session;
    if (!session?.runId || !state.controllable) return;
    sendCommand({ type: MSG.STOP, runId: session.runId });
  }

  function onRetryClick() {
    const local = state.local;
    if (!local?.retryText) return;
    const command = { type: MSG.SPEAK, runId: makeRunId(), text: local.retryText, settings: local.settings };
    if (sendCommand(command)) {
      local.retryText = "";
      render();
    }
  }

  doc.getElementById("pause")?.addEventListener("click", onPauseClick);
  doc.getElementById("stop")?.addEventListener("click", onStopClick);
  doc.getElementById("retry")?.addEventListener("click", onRetryClick);

  // Keyboard: Space pauses/resumes, Escape stops (ignored while a button has focus so Space still clicks it).
  /** @type {any} */ (doc).addEventListener?.("keydown", (/** @type {KeyboardEvent} */ event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = String(/** @type {any} */ (doc).activeElement?.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "SUMMARY" || tag === "INPUT") return;
    if (event.key === " " || event.code === "Space") {
      if (!state.session?.runId || state.session.state === "idle") return;
      event.preventDefault();
      onPauseClick();
    } else if (event.key === "Escape") {
      onStopClick();
    }
  });

  render();
  hostPort = connectHost({
    kind: "reader",
    engine: readerEngine,
    connect,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    onReject: (reason) => {
      state.rejected = reason;
      state.local = null;
      keepAlive.release();
      closeUiPort();
      render();
    },
  });
  if (!state.rejected) openUiPort();

  return {
    engine,
    state,
    get hostPort() { return hostPort; },
  };
}

if (typeof document !== "undefined" && globalThis.chrome?.runtime?.id) startReader();
