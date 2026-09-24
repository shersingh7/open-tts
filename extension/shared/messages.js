// @ts-check
// Open TTS v4 — port names and message types. Single source of truth.
// content/content.js (classic script) mirrors these; tests/content-messages.test.js enforces equality.

export const PORTS = Object.freeze({
  UI_POPUP: "ui:popup",
  UI_CONTENT: "ui:content",
  UI_READER: "ui:reader",
  HOST_OFFSCREEN: "host:offscreen",
  HOST_READER: "host:reader",
});

export const MSG = Object.freeze({
  // UI -> SW
  SPEAK: "SPEAK",
  PAUSE: "PAUSE",
  RESUME: "RESUME",
  STOP: "STOP",
  START_SERVER: "START_SERVER",
  STOP_SERVER: "STOP_SERVER",
  LOAD_MODEL: "LOAD_MODEL",
  GET_MODELS: "GET_MODELS",
  // SW -> UI
  SESSION: "SESSION",
  SERVER_STATE: "SERVER_STATE",
  MODEL_STATE: "MODEL_STATE",
  HISTORY_ERROR: "HISTORY_ERROR",
  REPLY: "REPLY",
  // SW -> host
  HOST_ACCEPT: "HOST_ACCEPT",
  HOST_REJECT: "HOST_REJECT",
  HOST_SPEAK: "HOST_SPEAK",
  HOST_PAUSE: "HOST_PAUSE",
  HOST_RESUME: "HOST_RESUME",
  HOST_STOP: "HOST_STOP",
  // host -> SW
  HOST_HELLO: "HOST_HELLO",
  STATUS: "STATUS",
  PROGRESS: "PROGRESS",
  DONE: "DONE",
  ERROR: "ERROR",
  HEARTBEAT: "HEARTBEAT",
  // one-shot tabs.sendMessage to content
  CONTENT_GET_SELECTION: "CONTENT_GET_SELECTION",
  CONTENT_GET_HOST: "CONTENT_GET_HOST",
});

export const OUTCOMES = Object.freeze({
  COMPLETED: "completed",
  STOPPED: "stopped",
  SUPERSEDED: "superseded",
  FAILED: "failed",
  OWNER_LOST: "owner_lost",
});

export const SESSION_STATES = Object.freeze(["idle", "preparing", "buffering", "playing", "paused"]);

export const SERVER_STATES = Object.freeze(["unknown", "offline", "starting", "ready", "warming", "failed"]);

/** @returns {{runId:null, revision:number, state:"idle", label:string, source:null, sourceTabId:null,
 *  sourceFrameId:null, hostKind:null, progress:null}} */
export function idleSession(revision = 0) {
  return {
    runId: null,
    revision,
    state: "idle",
    label: "Ready",
    source: null,
    sourceTabId: null,
    sourceFrameId: null,
    hostKind: null,
    progress: null,
  };
}
