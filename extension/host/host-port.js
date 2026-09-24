// @ts-check
// Open TTS v4 — playback host ↔ service worker port. Sends HOST_HELLO on every (re)connect, reconnects with
// backoff while the page lives, dispatches HOST_* commands to the engine and forwards engine events to the SW.

import { MSG, PORTS } from "../shared/messages.js";

export const RECONNECT_MIN_MS = 100;
export const RECONNECT_MAX_MS = 2000;
/** Events kept while disconnected; the oldest non-terminal event is dropped beyond this. */
export const MAX_PENDING_EVENTS = 100;

const PORT_NAMES = Object.freeze({ offscreen: PORTS.HOST_OFFSCREEN, reader: PORTS.HOST_READER });
const TERMINAL_TYPES = [MSG.DONE, MSG.ERROR];
const DEFAULT_REJECT_REASON = "Reader already open in another tab";

/**
 * @typedef {object} HostEngine the subset of host/engine.js used here
 * @property {(cmd: any) => void} speak
 * @property {(runId: string) => unknown} pause
 * @property {(runId: string) => unknown} resume
 * @property {(runId: string, outcome?: any) => unknown} stop
 * @property {() => ({runId: string, state: string, paused: boolean} | null)} activeRun
 */

/**
 * @typedef {object} ConnectHostOptions
 * @property {"offscreen"|"reader"} kind
 * @property {HostEngine} engine
 * @property {(reason: string) => void} [onReject]
 * @property {() => void} [onAccept]
 * @property {(info: {name: string}) => chrome.runtime.Port} [connect]
 * @property {(fn: () => void, ms: number) => any} [setTimeout]
 * @property {(id: any) => void} [clearTimeout]
 */

/**
 * Connect this playback host to the service worker.
 * @param {ConnectHostOptions} options
 */
export function connectHost({
  kind,
  engine,
  onReject = () => {},
  onAccept = () => {},
  connect = (info) => chrome.runtime.connect(info),
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
}) {
  const name = PORT_NAMES[kind];
  if (!name) throw new TypeError(`Unknown host kind: ${kind}`);

  /** @type {chrome.runtime.Port | null} */
  let port = null;
  let delay = RECONNECT_MIN_MS;
  /** @type {any} */
  let reconnectTimer = null;
  let closed = false;
  let rejected = false;
  let accepted = false;
  /** @type {Record<string, any>[]} */
  const pending = [];

  function scheduleReconnect() {
    if (closed || rejected || reconnectTimer !== null) return;
    const wait = delay;
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      open();
    }, wait);
  }

  /**
   * @param {chrome.runtime.Port} target
   * @param {Record<string, any>} message
   * @returns {boolean} false if the port is already dead
   */
  function post(target, message) {
    try {
      target.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {Record<string, any>} message */
  function enqueue(message) {
    if (message.type === MSG.HEARTBEAT) return;
    pending.push(message);
    while (pending.length > MAX_PENDING_EVENTS) {
      const index = pending.findIndex((queued) => !TERMINAL_TYPES.includes(queued.type));
      pending.splice(index >= 0 ? index : 0, 1);
    }
  }

  /** @param {chrome.runtime.Port} target */
  function flushPending(target) {
    while (pending.length) {
      if (!post(target, pending[0])) return;
      pending.shift();
    }
  }

  /**
   * @param {chrome.runtime.Port} source
   * @param {any} message
   */
  function onPortMessage(source, message) {
    if (source !== port || rejected || !message || typeof message !== "object") return;
    delay = RECONNECT_MIN_MS;
    switch (message.type) {
      case MSG.HOST_ACCEPT:
        accepted = true;
        onAccept();
        break;
      case MSG.HOST_REJECT:
        reject(source, message.reason);
        break;
      case MSG.HOST_SPEAK:
        engine.speak(message);
        break;
      case MSG.HOST_PAUSE:
        engine.pause(message.runId);
        break;
      case MSG.HOST_RESUME:
        engine.resume(message.runId);
        break;
      case MSG.HOST_STOP:
        engine.stop(message.runId, message.outcome);
        break;
      default:
        break;
    }
  }

  /**
   * Become inert: no engine work, no reconnects. A run already playing here (a stale host) is stopped.
   * @param {chrome.runtime.Port} source
   * @param {unknown} reason
   */
  function reject(source, reason) {
    rejected = true;
    accepted = false;
    pending.length = 0;
    const active = engine.activeRun();
    if (active) engine.stop(active.runId, "stopped");
    port = null;
    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
    onReject(typeof reason === "string" && reason ? reason : DEFAULT_REJECT_REASON);
  }

  /** @param {chrome.runtime.Port} source */
  function onPortDisconnect(source) {
    // Reading lastError marks it checked (Chrome logs unchecked errors on disconnect).
    void globalThis.chrome?.runtime?.lastError;
    if (source !== port) return;
    port = null;
    accepted = false;
    scheduleReconnect();
  }

  function open() {
    if (closed || rejected) return;
    /** @type {chrome.runtime.Port} */
    let next;
    try {
      next = connect({ name });
    } catch {
      scheduleReconnect();
      return;
    }
    port = next;
    next.onMessage.addListener((message) => onPortMessage(next, message));
    next.onDisconnect.addListener(() => onPortDisconnect(next));
    if (!post(next, { type: MSG.HOST_HELLO, kind, activeRun: engine.activeRun() })) return;
    flushPending(next);
  }

  open();

  return {
    /**
     * Send an engine event to the SW (queued while disconnected; dropped once rejected or closed).
     * @param {Record<string, any>} message
     */
    forward(message) {
      if (closed || rejected) return;
      if (port && pending.length === 0 && post(port, message)) return;
      enqueue(message);
      if (port) flushPending(port);
    },
    /** Disconnect for good (no reconnects). */
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      const current = port;
      port = null;
      try {
        current?.disconnect();
      } catch {
        // Already disconnected.
      }
    },
    get accepted() { return accepted; },
    get rejected() { return rejected; },
    get connected() { return port !== null; },
  };
}

/** @typedef {ReturnType<typeof connectHost>} HostPort */
