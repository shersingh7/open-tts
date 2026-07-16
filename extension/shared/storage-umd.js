(function (root) {
  const _timers = new Map();
  const OpenTTSStorage = {
    syncGet: (keys) => new Promise((r) => chrome.storage.sync.get(keys, r)),
    syncSet: (obj) => new Promise((r) => chrome.storage.sync.set(obj, r)),
    localGet: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
    localSet: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
    debouncedSyncSet(key, value, delay = 300) {
      const t = _timers.get(key);
      if (t) clearTimeout(t);
      _timers.set(key, setTimeout(() => {
        _timers.delete(key);
        OpenTTSStorage.syncSet({ [key]: value });
      }, delay));
    },
    debouncedLocalSet(key, value, delay = 300) {
      const timerKey = `local:${key}`;
      const t = _timers.get(timerKey);
      if (t) clearTimeout(t);
      _timers.set(timerKey, setTimeout(() => {
        _timers.delete(timerKey);
        OpenTTSStorage.localSet({ [key]: value });
      }, delay));
    },
    async getAuthHeaders() {
      const { installToken } = await OpenTTSStorage.localGet(["installToken"]);
      const headers = { "Content-Type": "application/json" };
      if (installToken) headers["X-Open-TTS-Token"] = installToken;
      return headers;
    },
    async storeInstallToken(token) {
      if (token) await OpenTTSStorage.localSet({ installToken: token });
    },
  };
  root.OpenTTSStorage = OpenTTSStorage;
})(typeof globalThis !== "undefined" ? globalThis : self);