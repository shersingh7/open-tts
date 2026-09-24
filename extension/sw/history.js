// @ts-check
// Open TTS v4 — bounded, privacy-first history (finding #6, plan 1.4, decision D1). Off unless historyEnabled===true.

import { HISTORY_MAX_BYTES, HISTORY_TEXT_CAP, MAX_HISTORY } from "../shared/constants.js";
import { localGet, localSet } from "../shared/storage.js";

/**
 * @typedef {{id: string, text: string, chars: number, truncated: boolean, voice: string, model: string,
 *   speed: number, timestamp: number}} HistoryEntry
 */

/**
 * Drop the oldest entries while there are more than MAX_HISTORY or the list is over HISTORY_MAX_BYTES as JSON.
 * @param {HistoryEntry[]} list oldest first
 * @returns {HistoryEntry[]}
 */
export function trimHistory(list) {
  const trimmed = list.slice();
  while (trimmed.length > MAX_HISTORY || (trimmed.length && JSON.stringify(trimmed).length > HISTORY_MAX_BYTES)) {
    trimmed.shift();
  }
  return trimmed;
}

/**
 * @param {object} [deps]
 * @param {(keys: string[]) => Promise<Record<string, any>>} [deps.read]
 * @param {(items: Record<string, any>) => Promise<void>} [deps.write]
 * @param {(runId: string, message: string) => void} [deps.onError] publish HISTORY_ERROR
 */
export function createHistory(deps = {}) {
  const read = deps.read || localGet;
  const write = deps.write || localSet;
  const onError = deps.onError || (() => {});
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * Store a completed run. Writes are serialized; failures are reported through onError, never thrown.
   * `chars` may be given when `text` was already capped (e.g. restored after a service-worker restart).
   * @param {{id: string, text: string, chars?: number, voice: string, model: string, speed: number,
   *   timestamp: number}} run
   * @returns {Promise<boolean>} true when an entry was written
   */
  function persistCompletion(run) {
    const task = queue.then(async () => {
      try {
        const { historyEnabled, ttsHistory } = await read(["historyEnabled", "ttsHistory"]);
        if (historyEnabled !== true) return false;
        const text = String(run.text || "");
        const chars = typeof run.chars === "number" ? Math.max(run.chars, text.length) : text.length;
        /** @type {HistoryEntry} */
        const entry = {
          id: run.id,
          text: text.slice(0, HISTORY_TEXT_CAP),
          chars,
          truncated: chars > HISTORY_TEXT_CAP,
          voice: run.voice,
          model: run.model,
          speed: run.speed,
          timestamp: run.timestamp,
        };
        const previous = Array.isArray(ttsHistory) ? ttsHistory.filter((item) => item?.id !== run.id) : [];
        await write({ ttsHistory: trimHistory([...previous, entry]) });
        return true;
      } catch (error) {
        onError(run.id, `Audio completed, but history could not be saved: ${errorMessage(error)}`);
        return false;
      }
    });
    queue = task;
    return task;
  }

  return { persistCompletion };
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
