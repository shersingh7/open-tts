// @ts-check
// Open TTS v4 — authoritative session record for the service worker, persisted in chrome.storage.session.
// Mutations are synchronous in memory (so the router never races itself) and persisted in order; only the latest
// state is written when several mutations happen while a write is in flight.

import { idleSession } from "../shared/messages.js";

export const SESSION_KEY = "v4Session";
export const TEXT_PREVIEW_CHARS = 200;

/** @typedef {"idle"|"preparing"|"buffering"|"playing"|"paused"} SessionState */
/** @typedef {"popup"|"content"|"reader"|"menu"|"command"} RunSource */
/** @typedef {"completed"|"stopped"|"superseded"|"failed"|"owner_lost"} Outcome */

/**
 * @typedef {object} Session
 * @property {string|null} runId
 * @property {number} revision
 * @property {SessionState} state
 * @property {string} label
 * @property {RunSource|null} source
 * @property {number|null} sourceTabId
 * @property {number|null} sourceFrameId
 * @property {"offscreen"|"reader"|null} hostKind
 * @property {{played: number, scheduled: number, index?: number, end?: number, unitId?: number}|null} progress
 * @property {Outcome} [outcome]
 * @property {{message: string, code?: string}} [error]
 * @property {object} [metrics]
 * @property {string} [textPreview]
 */

/**
 * @typedef {object} RunStart
 * @property {string} runId
 * @property {RunSource} source
 * @property {number|null} [sourceTabId]
 * @property {number|null} [sourceFrameId]
 * @property {"offscreen"|"reader"} hostKind
 * @property {string} [text]
 * @property {string} [label]
 */

/**
 * Private per-run details persisted next to the session (never published to UIs).
 * @typedef {{runId: string, historyText: string, chars: number, voice: string, model: string, speed: number,
 *   startedAt: number}} RunInfo
 */

/** @param {Session} session */
export function isActive(session) {
  return Boolean(session.runId) && session.state !== "idle";
}

/**
 * @param {object} [options]
 * @param {{get: Function, set: Function}} [options.storage] a chrome.storage area (default chrome.storage.session)
 * @param {(error: Error) => void} [options.onError]
 */
export function createSessionStore(options = {}) {
  const storage = options.storage || chrome.storage.session;
  const onError = options.onError || (() => {});
  /** @type {Session} */
  let session = idleSession(0);
  /** @type {RunInfo|null} */
  let runInfo = null;
  /** @type {Promise<Session>|null} */
  let loading = null;
  let loaded = false;
  /** @type {Promise<void>} */
  let writing = Promise.resolve();
  let dirty = false;
  let writeScheduled = false;

  function persist() {
    dirty = true;
    if (writeScheduled) return;
    writeScheduled = true;
    writing = writing.then(async () => {
      writeScheduled = false;
      if (!dirty) return;
      dirty = false;
      try {
        await storage.set({ [SESSION_KEY]: { session, runInfo } });
      } catch (error) {
        onError(/** @type {Error} */ (error));
      }
    });
  }

  /** @param {Omit<Session, "revision"> & {revision?: number}} next */
  function commit(next) {
    session = { ...next, revision: session.revision + 1 };
    persist();
    return session;
  }

  return {
    /**
     * Restore the persisted session (once; later calls return the same promise).
     * @returns {Promise<Session>}
     */
    load() {
      if (!loading) {
        loading = (async () => {
          try {
            const stored = (await storage.get(SESSION_KEY))?.[SESSION_KEY];
            if (stored?.session && typeof stored.session.revision === "number") {
              // A mutation that happened before load finished wins, but revision must never go backwards.
              if (session.revision === 0 && !session.runId) {
                session = stored.session;
                runInfo = stored.runInfo || null;
              } else if (stored.session.revision >= session.revision) {
                session = { ...session, revision: stored.session.revision + 1 };
                persist();
              }
            }
          } catch (error) {
            onError(/** @type {Error} */ (error));
          }
          loaded = true;
          return session;
        })();
      }
      return loading;
    },
    get loaded() {
      return loaded;
    },
    /** @returns {Session} */
    current() {
      return session;
    },
    /** @returns {RunInfo|null} */
    runInfo() {
      return runInfo && runInfo.runId === session.runId ? runInfo : null;
    },
    /**
     * Start a new run in state "preparing". The caller must have ended any previous run first.
     * @param {RunStart} run
     * @param {RunInfo|null} [info]
     * @returns {Session}
     */
    begin(run, info = null) {
      runInfo = info;
      return commit({
        runId: run.runId,
        state: "preparing",
        label: run.label || "Generating...",
        source: run.source,
        sourceTabId: run.sourceTabId ?? null,
        sourceFrameId: run.sourceFrameId ?? null,
        hostKind: run.hostKind,
        progress: null,
        textPreview: String(run.text || "").slice(0, TEXT_PREVIEW_CHARS),
      });
    },
    /**
     * Patch the current active run. Returns null (and changes nothing) for any other run.
     * @param {string} runId
     * @param {Partial<Session>} patch
     * @returns {Session|null}
     */
    update(runId, patch) {
      if (!runId || runId !== session.runId || !isActive(session)) return null;
      const next = { ...session, ...patch, runId: session.runId };
      return commit(next);
    },
    /**
     * End the current run. True only the first time for the current run (terminal de-duplication).
     * @param {string} runId
     * @param {Outcome} outcome
     * @param {{error?: {message: string, code?: string}, metrics?: object, label?: string}} [extra]
     * @returns {boolean}
     */
    end(runId, outcome, extra = {}) {
      if (!runId || runId !== session.runId || !isActive(session)) return false;
      /** @type {Session} */
      const ended = {
        ...idleSession(session.revision),
        runId: session.runId,
        source: session.source,
        sourceTabId: session.sourceTabId,
        sourceFrameId: session.sourceFrameId,
        hostKind: session.hostKind,
        progress: session.progress,
        textPreview: session.textPreview,
        label: extra.label || labelFor(outcome, extra.error),
        outcome,
      };
      if (extra.error) ended.error = extra.error;
      const metrics = extra.metrics || session.metrics;
      if (metrics) ended.metrics = metrics;
      commit(ended);
      return true;
    },
    /** Resolves once every mutation so far is written. */
    async whenPersisted() {
      let pending;
      do {
        pending = writing;
        await pending;
      } while (pending !== writing);
    },
  };
}

/**
 * @param {Outcome} outcome
 * @param {{message: string}} [error]
 */
function labelFor(outcome, error) {
  if (outcome === "completed") return "Done";
  if (outcome === "stopped") return "Stopped";
  if (outcome === "superseded") return "Replaced by a new reading";
  return error?.message || "Playback failed";
}

/** @typedef {ReturnType<typeof createSessionStore>} SessionStore */
