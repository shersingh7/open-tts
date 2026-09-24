import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal callback-style chrome.storage fake. `fail` = "local" fails every call on that area,
 * "local.set" fails only that method (the callback runs with chrome.runtime.lastError set).
 */
function installChrome({ fail = null } = {}) {
  const data = { sync: {}, local: {}, session: {} };
  const runtime = {};
  const calls = [];
  const area = (name) => {
    const failing = (method) => fail === name || fail === `${name}.${method}`;
    const finish = (method, callback, result) => {
      if (failing(method)) runtime.lastError = { message: `${name} quota` };
      callback(result);
      delete runtime.lastError;
    };
    return {
      get: vi.fn((keys, callback) => {
        calls.push([name, "get", keys]);
        const list = Array.isArray(keys) ? keys : [keys];
        finish("get", callback, Object.fromEntries(list.filter((key) => key in data[name]).map((key) => [key, data[name][key]])));
      }),
      set: vi.fn((value, callback) => {
        calls.push([name, "set", value]);
        if (!failing("set")) Object.assign(data[name], value);
        finish("set", callback);
      }),
      remove: vi.fn((keys, callback) => {
        calls.push([name, "remove", keys]);
        if (!failing("remove")) for (const key of Array.isArray(keys) ? keys : [keys]) delete data[name][key];
        finish("remove", callback);
      }),
    };
  };
  globalThis.chrome = { runtime, storage: { sync: area("sync"), local: area("local"), session: area("session") } };
  return { data, calls };
}

async function freshStorage() {
  vi.resetModules();
  return import("../shared/storage.js");
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.chrome;
});

describe("promise wrappers", () => {
  it("read and write every area", async () => {
    const fake = installChrome();
    const storage = await freshStorage();
    await storage.syncSet({ speed: 2 });
    await storage.localSet({ ttsHistory: [] });
    await storage.sessionSet({ v4Session: { runId: "a" } });
    expect(await storage.syncGet(["speed"])).toEqual({ speed: 2 });
    expect(await storage.localGet(["ttsHistory"])).toEqual({ ttsHistory: [] });
    expect(await storage.sessionGet(["v4Session"])).toEqual({ v4Session: { runId: "a" } });
    await storage.sessionRemove("v4Session");
    await storage.localRemove(["ttsHistory"]);
    expect(fake.data.session).toEqual({});
    expect(fake.data.local).toEqual({});
  });

  it.each(["sync", "local", "session"])("rejects on chrome.runtime.lastError (%s)", async (name) => {
    installChrome({ fail: name });
    const storage = await freshStorage();
    const getter = { sync: storage.syncGet, local: storage.localGet, session: storage.sessionGet }[name];
    const setter = { sync: storage.syncSet, local: storage.localSet, session: storage.sessionSet }[name];
    await expect(getter(["x"])).rejects.toThrow(`${name} quota`);
    await expect(setter({ x: 1 })).rejects.toThrow(`${name} quota`);
  });

  it("does not export token helpers", async () => {
    installChrome();
    const storage = await freshStorage();
    expect(storage).not.toHaveProperty("getAuthHeaders");
    expect(storage).not.toHaveProperty("storeInstallToken");
  });
});

describe("debounced setters", () => {
  it("debounces draft text into local storage only", async () => {
    vi.useFakeTimers();
    const fake = installChrome();
    const storage = await freshStorage();
    storage.debouncedLocalSet("previewText", "first", 50);
    storage.debouncedLocalSet("previewText", "private phrase", 50);
    await vi.advanceTimersByTimeAsync(51);
    expect(fake.calls).toEqual([["local", "set", { previewText: "private phrase" }]]);
  });

  it("keeps sync and local timers for the same key independent", async () => {
    vi.useFakeTimers();
    const fake = installChrome();
    const storage = await freshStorage();
    storage.debouncedSyncSet("speed", 2);
    storage.debouncedLocalSet("speed", 3);
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.data.sync).toEqual({ speed: 2 });
    expect(fake.data.local).toEqual({ speed: 3 });
  });

  it("routes write failures to the registered error handler", async () => {
    vi.useFakeTimers();
    installChrome({ fail: "sync" });
    const storage = await freshStorage();
    const errors = [];
    storage.setStorageErrorHandler((error) => errors.push(error.message));
    storage.debouncedSyncSet("speed", 2, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(["sync quota"]);
  });

  it("falls back to console.error without a handler", async () => {
    vi.useFakeTimers();
    installChrome({ fail: "local" });
    const storage = await freshStorage();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.debouncedLocalSet("x", 1, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(spy).toHaveBeenCalledWith("Open TTS could not save local preferences");
    spy.mockRestore();
  });
});

describe("flushPending", () => {
  it("writes all pending debounced values immediately and clears timers", async () => {
    vi.useFakeTimers();
    const fake = installChrome();
    const storage = await freshStorage();
    storage.debouncedSyncSet("speed", 1.5);
    storage.debouncedSyncSet("speed", 2.5);
    storage.debouncedSyncSet("voice", "ryan");
    storage.debouncedLocalSet("previewText", "draft");
    await storage.flushPending();
    expect(fake.data.sync).toEqual({ speed: 2.5, voice: "ryan" });
    expect(fake.data.local).toEqual({ previewText: "draft" });
    const writes = fake.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toHaveLength(writes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a no-op with nothing pending and reports failures instead of rejecting", async () => {
    installChrome({ fail: "local" });
    const storage = await freshStorage();
    await storage.flushPending();
    const errors = [];
    storage.setStorageErrorHandler((error) => errors.push(error.message));
    storage.debouncedLocalSet("previewText", "draft", 10000);
    await expect(storage.flushPending()).resolves.toBeUndefined();
    expect(errors).toEqual(["local quota"]);
  });
});

describe("localInstruction migration", () => {
  it("verifies the local copy before deleting the synced source", async () => {
    const fake = installChrome();
    fake.data.sync.instruct = "Private direction";
    const storage = await freshStorage();
    expect(await storage.localInstruction()).toBe("Private direction");
    expect(fake.data.local.instruct).toBe("Private direction");
    expect(fake.data.sync.instruct).toBeUndefined();
    expect(fake.calls.filter(([, method]) => method !== "get").map(([name, method]) => name + method))
      .toEqual(["localset", "syncremove"]);
  });

  it("failed local migration retains the synced value and reports failure", async () => {
    const fake = installChrome({ fail: "local.set" });
    fake.data.sync.instruct = "Private direction";
    const storage = await freshStorage();
    await expect(storage.localInstruction()).rejects.toThrow("local quota");
    expect(fake.data.sync.instruct).toBe("Private direction");
    expect(fake.calls.filter(([, method]) => method !== "get").map(([name, method]) => name + method))
      .toEqual(["localset"]);
  });
});
