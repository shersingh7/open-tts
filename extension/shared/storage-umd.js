(function (root) {
  const _timers = new Map();
  function call(area, method, value) {
    return new Promise((resolve,reject)=>chrome.storage[area][method](value, result=>{
      const error=chrome.runtime?.lastError;
      error ? reject(new Error(error.message)) : resolve(result);
    }));
  }
  const report = error => {
    if (OpenTTSStorage.onError) OpenTTSStorage.onError(error);
    else console.error("Open TTS could not save local preferences");
  };
  const OpenTTSStorage = {
    syncGet: keys => call("sync","get",keys),
    syncSet: obj => call("sync","set",obj),
    localGet: keys => call("local","get",keys),
    localSet: obj => call("local","set",obj),
    async localInstruction() {
      let local = await OpenTTSStorage.localGet(["instruct"]);
      const legacy = await OpenTTSStorage.syncGet(["instruct"]);
      if (local.instruct === undefined && legacy.instruct !== undefined) {
        local = await OpenTTSStorage.localGet(["instruct"]);
        if (local.instruct === undefined) await OpenTTSStorage.localSet({instruct:legacy.instruct});
        local = await OpenTTSStorage.localGet(["instruct"]);
        if (local.instruct === undefined) throw new Error("Could not migrate instruction to local storage");
      }
      if (legacy.instruct !== undefined) await call("sync","remove","instruct");
      return local.instruct || "";
    },
    debouncedSyncSet(key, value, delay = 300) {
      const t = _timers.get(key);
      if (t) clearTimeout(t);
      _timers.set(key, setTimeout(() => {
        _timers.delete(key);
        OpenTTSStorage.syncSet({ [key]: value }).catch(report);
      }, delay));
    },
    debouncedLocalSet(key, value, delay = 300) {
      const timerKey = `local:${key}`;
      const t = _timers.get(timerKey);
      if (t) clearTimeout(t);
      _timers.set(timerKey, setTimeout(() => {
        _timers.delete(timerKey);
        OpenTTSStorage.localSet({ [key]: value }).catch(report);
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