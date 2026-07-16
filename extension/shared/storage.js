/** Debounced chrome.storage helpers. */

const _timers = new Map();

export const syncGet = (keys) => new Promise((r) => chrome.storage.sync.get(keys, r));
export const syncSet = (obj) => new Promise((r) => chrome.storage.sync.set(obj, r));
export const localGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
export const localSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

export function debouncedSyncSet(key, value, delay = 300) {
  const t = _timers.get(key);
  if (t) clearTimeout(t);
  _timers.set(
    key,
    setTimeout(() => {
      _timers.delete(key);
      syncSet({ [key]: value });
    }, delay),
  );
}

export function debouncedLocalSet(key, value, delay = 300) {
  const timerKey = `local:${key}`;
  const t = _timers.get(timerKey);
  if (t) clearTimeout(t);
  _timers.set(
    timerKey,
    setTimeout(() => {
      _timers.delete(timerKey);
      localSet({ [key]: value });
    }, delay),
  );
}

export async function getAuthHeaders() {
  const { installToken } = await localGet(["installToken"]);
  const headers = { "Content-Type": "application/json" };
  if (installToken) headers["X-Open-TTS-Token"] = installToken;
  return headers;
}

export async function storeInstallToken(token) {
  if (token) await localSet({ installToken: token });
}