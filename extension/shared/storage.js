// @ts-check
// Open TTS v4 — chrome.storage promise wrappers and debounced preference writes (ESM).
// Every wrapper rejects when chrome.runtime.lastError is set. No token helpers here (see sw/auth.js).

/** @typedef {"sync" | "local" | "session"} AreaName */
/** @typedef {string | string[] | Record<string, any> | null} StorageKeys */

const DEFAULT_DEBOUNCE_MS = 300;

/** @type {((error: Error) => void) | null} */
let errorHandler = null;

/** @type {Map<string, {area: AreaName, key: string, value: unknown, timer: ReturnType<typeof setTimeout>}>} */
const pending = new Map();

/**
 * @param {AreaName} area
 * @param {"get" | "set" | "remove"} method
 * @param {unknown} value
 * @returns {Promise<any>}
 */
function call(area, method, value) {
  return new Promise((resolve, reject) => {
    const storageArea = /** @type {any} */ (chrome.storage[area]);
    storageArea[method](value, (/** @type {unknown} */ result) => {
      const error = chrome.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

/** @param {Error} error */
function report(error) {
  if (errorHandler) errorHandler(error);
  else console.error("Open TTS could not save local preferences");
}

/**
 * Receive failures of debounced and flushed writes (they have no caller to reject to).
 * @param {((error: Error) => void) | null} fn
 */
export function setStorageErrorHandler(fn) {
  errorHandler = fn;
}

/** @param {StorageKeys} keys @returns {Promise<Record<string, any>>} */
export const syncGet = (keys) => call("sync", "get", keys);
/** @param {Record<string, any>} items @returns {Promise<void>} */
export const syncSet = (items) => call("sync", "set", items);
/** @param {StorageKeys} keys @returns {Promise<Record<string, any>>} */
export const localGet = (keys) => call("local", "get", keys);
/** @param {Record<string, any>} items @returns {Promise<void>} */
export const localSet = (items) => call("local", "set", items);
/** @param {string | string[]} keys @returns {Promise<void>} */
export const localRemove = (keys) => call("local", "remove", keys);
/** @param {StorageKeys} keys @returns {Promise<Record<string, any>>} */
export const sessionGet = (keys) => call("session", "get", keys);
/** @param {Record<string, any>} items @returns {Promise<void>} */
export const sessionSet = (items) => call("session", "set", items);
/** @param {string | string[]} keys @returns {Promise<void>} */
export const sessionRemove = (keys) => call("session", "remove", keys);

/**
 * @param {AreaName} area
 * @param {string} timerKey
 * @param {string} key
 * @param {unknown} value
 * @param {number} delay
 */
function debounce(area, timerKey, key, value, delay) {
  const previous = pending.get(timerKey);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    pending.delete(timerKey);
    call(area, "set", { [key]: value }).catch(report);
  }, delay);
  pending.set(timerKey, { area, key, value, timer });
}

/**
 * Write `key` to storage.sync after `delay` ms of quiet; later calls for the same key replace the value.
 * @param {string} key
 * @param {unknown} value
 * @param {number} [delay]
 */
export function debouncedSyncSet(key, value, delay = DEFAULT_DEBOUNCE_MS) {
  debounce("sync", key, key, value, delay);
}

/**
 * Write `key` to storage.local after `delay` ms of quiet; later calls for the same key replace the value.
 * @param {string} key
 * @param {unknown} value
 * @param {number} [delay]
 */
export function debouncedLocalSet(key, value, delay = DEFAULT_DEBOUNCE_MS) {
  debounce("local", `local:${key}`, key, value, delay);
}

/**
 * Immediately write every pending debounced value (one set per area) and clear their timers.
 * Call on `pagehide` / `visibilitychange → hidden`. Failures go to the error handler; never rejects.
 * @returns {Promise<void>}
 */
export async function flushPending() {
  /** @type {Partial<Record<AreaName, Record<string, unknown>>>} */
  const byArea = {};
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    byArea[entry.area] = { ...byArea[entry.area], [entry.key]: entry.value };
  }
  pending.clear();
  const writes = Object.entries(byArea).map(([area, items]) => {
    return call(/** @type {AreaName} */ (area), "set", items).catch(report);
  });
  await Promise.all(writes);
}

/**
 * Read the TTS instruction from storage.local, migrating a legacy storage.sync copy first. The synced value is
 * removed only after the local copy is verified.
 * @returns {Promise<string>}
 */
export async function localInstruction() {
  let local = await localGet(["instruct"]);
  const legacy = await syncGet(["instruct"]);
  if (local.instruct === undefined && legacy.instruct !== undefined) {
    local = await localGet(["instruct"]);
    if (local.instruct === undefined) await localSet({ instruct: legacy.instruct });
    local = await localGet(["instruct"]);
    if (local.instruct === undefined) throw new Error("Could not migrate instruction to local storage");
  }
  if (legacy.instruct !== undefined) await call("sync", "remove", "instruct");
  return local.instruct || "";
}
