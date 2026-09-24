// @ts-check
// Open TTS v4 — UI-side port client. Connects a UI context (popup/content/reader) to the service worker
// over a long-lived `chrome.runtime.connect` port, delivers every non-REPLY message to `onSnapshot`, and
// resolves/rejects `request()` calls against `{type: MSG.REPLY, requestId, ok, data|error, code}` replies.
// Reconnects automatically if the port disconnects (e.g. the service worker restarted); the service worker
// re-posts SESSION/SERVER_STATE/MODEL_STATE immediately on connect, so `onSnapshot` re-renders from that.

import { MSG } from "../shared/messages.js";

const DEFAULT_TIMEOUT_MS = 15000;
const LOAD_MODEL_TIMEOUT_MS = 330000;

/**
 * @typedef {{type: string, requestId?: string, [key: string]: any}} Command
 */

/**
 * @param {object} options
 * @param {string} options.name port name, e.g. "ui:popup"
 * @param {(message: Record<string, any>) => void} options.onSnapshot called for every message that isn't a REPLY
 * @param {typeof chrome.runtime.connect} [options.connect]
 * @returns {{send: (cmd: Command) => void, request: (cmd: Command) => Promise<any>, close: () => void}}
 */
export function connectUi({ name, onSnapshot, connect = chrome.runtime.connect }) {
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  let closed = false;
  let requestSeq = 0;
  /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();

  function rejectAllPending(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function handleMessage(message) {
    if (message && message.type === MSG.REPLY) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.data);
      } else {
        const error = new Error(message.error || "Request failed");
        if (message.code) /** @type {any} */ (error).code = message.code;
        entry.reject(error);
      }
      return;
    }
    onSnapshot?.(message);
  }

  function open() {
    port = connect({ name });
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      rejectAllPending("Disconnected");
      if (!closed) open();
    });
  }
  open();

  /** @param {Command} cmd */
  function send(cmd) {
    port?.postMessage(cmd);
  }

  /** @param {Command} cmd @returns {Promise<any>} */
  function request(cmd) {
    const requestId = cmd.requestId || `req_${Date.now()}_${++requestSeq}`;
    const timeoutMs = cmd.type === MSG.LOAD_MODEL ? LOAD_MODEL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Request timed out"));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        port?.postMessage({ ...cmd, requestId });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(/** @type {Error} */ (err));
      }
    });
  }

  function close() {
    closed = true;
    rejectAllPending("Closed");
    port?.disconnect();
  }

  return { send, request, close };
}
