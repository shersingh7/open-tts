import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, flush } from "./helpers/fake-chrome.js";
import { createAuth } from "../sw/auth.js";
import { createServerManager } from "../sw/server-manager.js";
import { MSG } from "../shared/messages.js";

const HEALTHY = { status: "ok", engine: "open-tts", version: "4.0.0", model: "kokoro", model_loaded: true,
  model_warm: true, state: "ready" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A scriptable fake backend: `routes[path]` returns a Response, a body object, or a promise. */
function fakeBackend() {
  const backend = {
    up: true,
    health: { ...HEALTHY },
    calls: [],
    routes: {},
    fetch: vi.fn(async (url, init = {}) => {
      const path = new URL(url).pathname + new URL(url).search;
      backend.calls.push({ path, init });
      if (!backend.up) throw new TypeError("Failed to fetch");
      const route = backend.routes[new URL(url).pathname];
      if (route) {
        const result = await route(path, init);
        return result instanceof Response ? result : json(result);
      }
      if (path === "/health") return json(backend.health);
      return json({ detail: "not found" }, 404);
    }),
  };
  return backend;
}

function hangUntilAbort(init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
}

function setup({ storage, backendUp = true } = {}) {
  const chrome = createFakeChrome({ storage: { session: { installToken: "tok" }, ...storage } });
  const backend = fakeBackend();
  backend.up = backendUp;
  const published = [];
  const auth = createAuth({ chrome });
  const manager = createServerManager({ chrome, auth, publish: (m) => published.push(m), fetchImpl: backend.fetch });
  return { chrome, backend, published, manager, auth };
}

describe("sw/server-manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetchHealth keeps the v3 identity check", async () => {
    const { backend, manager } = setup();
    expect(await manager.fetchHealth()).toMatchObject({ engine: "open-tts" });
    backend.health = { status: "ok", engine: "other", version: "1" };
    expect(await manager.fetchHealth()).toBeNull();
    backend.health = { status: "ok", engine: "open-tts", version: 4 };
    expect(await manager.fetchHealth()).toBeNull();
    backend.up = false;
    expect(await manager.fetchHealth()).toBeNull();
  });

  it("fetchHealth never sends the token", async () => {
    const { backend, manager } = setup();
    await manager.fetchHealth();
    expect(JSON.stringify(backend.calls[0].init)).not.toContain("tok");
  });

  it("ensureServer returns immediately when healthy and publishes ready", async () => {
    const { chrome, published, manager } = setup();
    await manager.ensureServer();
    expect(chrome.runtime.sendNativeMessage.calls).toHaveLength(0);
    expect(published.at(-1)).toEqual({ type: MSG.SERVER_STATE, state: "ready", message: "Connected — kokoro",
      model: "kokoro" });
  });

  it("two concurrent ensureServer calls produce one native start", async () => {
    const { chrome, backend, published, manager } = setup({ backendUp: false });
    chrome.runtime.sendNativeMessage.impl = () => {
      setTimeout(() => {
        backend.up = true;
      }, 2500);
      return { success: true, install_token: "started-token" };
    };
    const first = manager.ensureServer();
    const second = manager.ensureServer();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(first).resolves.toMatchObject({ engine: "open-tts" });
    await expect(second).resolves.toMatchObject({ engine: "open-tts" });
    expect(chrome.runtime.sendNativeMessage.calls.filter(([, m]) => m.command === "start")).toHaveLength(1);
    expect(chrome.fake.storageData.session.installToken).toBe("started-token");
    expect(published.map((m) => m.state)).toEqual(["starting", "ready"]);
  });

  it("a popup reconnecting mid-start reads the current SERVER_STATE", async () => {
    const { chrome, manager } = setup({ backendUp: false });
    chrome.runtime.sendNativeMessage.impl = () => ({ success: true });
    const pending = manager.ensureServer().catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(manager.serverState()).toEqual({ state: "starting", message: "Starting server..." });
    expect(manager.isStarting()).toBe(true);
    // checkHealth must not clobber "starting" while a start is in flight.
    await manager.checkHealth();
    expect(manager.serverState().state).toBe("starting");
    await vi.advanceTimersByTimeAsync(61000);
    await pending;
    expect(manager.serverState()).toEqual({ state: "failed", message: "Open TTS server did not become ready" });
  });

  it("native start failure publishes failed and rejects", async () => {
    const { chrome, manager } = setup({ backendUp: false });
    chrome.runtime.sendNativeMessage.impl = () => ({ success: false, message: "Port busy" });
    await expect(manager.ensureServer()).rejects.toThrow("Port busy");
    expect(manager.serverState()).toEqual({ state: "failed", message: "Port busy" });
  });

  it("missing native host rejects with a clear message", async () => {
    const { manager } = setup({ backendUp: false });
    await expect(manager.ensureServer()).rejects.toThrow(/Could not start the server: .*native messaging host/);
  });

  it("ensureServer({waitForWarm}) waits for the model to warm", async () => {
    const { backend, manager, published } = setup();
    backend.health = { ...HEALTHY, model_warm: false, state: "warming" };
    const pending = manager.ensureServer({ waitForWarm: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(manager.serverState().state).toBe("warming");
    backend.health = { ...HEALTHY };
    await vi.advanceTimersByTimeAsync(1100);
    await expect(pending).resolves.toMatchObject({ model_warm: true });
    expect(published.at(-1).state).toBe("ready");
  });

  it("checkHealth publishes offline when unreachable", async () => {
    const { manager } = setup({ backendUp: false });
    await manager.checkHealth();
    expect(manager.serverState()).toEqual({ state: "offline", message: "Server offline" });
  });

  it("stopServer calls native stop and publishes offline", async () => {
    const { chrome, manager } = setup();
    chrome.runtime.sendNativeMessage.impl = () => ({ success: true, message: "Server stopped (PID 1)" });
    await manager.stopServer();
    expect(chrome.runtime.sendNativeMessage.calls[0][1]).toEqual({ command: "stop" });
    expect(manager.serverState()).toEqual({ state: "offline", message: "Server stopped (PID 1)" });
  });

  it("apiFetch sends the token and refreshes once on 401", async () => {
    const { chrome, backend, manager } = setup();
    chrome.runtime.sendNativeMessage.impl = () => ({ success: true, install_token: "rotated" });
    backend.routes["/v1/models"] = (path, init) => (init.headers["X-Open-TTS-Token"] === "rotated"
      ? { models: [] }
      : json({ detail: { code: "unauthorized", message: "Invalid token" } }, 401));
    await expect(manager.getModels()).resolves.toEqual({ models: [] });
    const tokens = backend.calls.filter((c) => c.path === "/v1/models").map((c) => c.init.headers["X-Open-TTS-Token"]);
    expect(tokens).toEqual(["tok", "rotated"]);
  });

  it("apiFetch surfaces backend errors after a failed refresh", async () => {
    const { backend, manager } = setup();
    backend.routes["/v1/models"] = () => json({ detail: { code: "unauthorized", message: "Invalid token" } }, 401);
    await expect(manager.getModels()).rejects.toMatchObject({ message: "Invalid token", code: "unauthorized",
      status: 401 });
    expect(backend.calls.filter((c) => c.path === "/v1/models")).toHaveLength(1);
  });

  it("apiFetch maps network failures", async () => {
    const { backend, manager } = setup();
    backend.up = false;
    await expect(manager.apiFetch("/v1/models")).rejects.toMatchObject({ message: "Failed to fetch", code: "network" });
  });

  it("checkCapabilities requires protocol v2", async () => {
    const { backend, manager } = setup();
    backend.routes["/v1/capabilities"] = () => ({ engine: "open-tts", protocol_versions: [1] });
    await expect(manager.checkCapabilities()).rejects.toThrow("Update the backend to support progressive streaming v2");
    backend.routes["/v1/capabilities"] = () => ({ engine: "open-tts", protocol_versions: [1, 2] });
    await expect(manager.checkCapabilities()).resolves.toBeTruthy();
  });

  it("loadModel success publishes loading → loaded", async () => {
    const { backend, manager, published } = setup();
    backend.routes["/v1/load-model"] = () => ({ success: true, model: "qwen3-tts" });
    await expect(manager.loadModel("qwen3-tts")).resolves.toMatchObject({ state: "loaded" });
    const modelStates = published.filter((m) => m.type === MSG.MODEL_STATE).map((m) => m.state);
    expect(modelStates).toEqual(["loading", "loaded"]);
    expect(backend.calls.find((c) => c.path.startsWith("/v1/load-model")).path).toBe("/v1/load-model?model_id=qwen3-tts");
  });

  it("loadModel timeout → polls /health until the model is warm", async () => {
    const { backend, manager, published } = setup();
    backend.routes["/v1/load-model"] = (path, init) => hangUntilAbort(init);
    const pending = manager.loadModel("fish-s2-pro");
    await vi.advanceTimersByTimeAsync(10500);
    expect(manager.modelState()).toMatchObject({ modelId: "fish-s2-pro", state: "loading" });
    backend.health = { ...HEALTHY, model: "fish-s2-pro", model_warm: false, state: "loading" };
    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.modelState().state).toBe("loading");
    backend.health = { ...HEALTHY, model: "fish-s2-pro" };
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toMatchObject({ modelId: "fish-s2-pro", state: "loaded" });
    expect(published.filter((m) => m.type === MSG.MODEL_STATE).at(-1).state).toBe("loaded");
  });

  it("loadModel poll gives up after 300 s", async () => {
    const { backend, manager } = setup();
    backend.routes["/v1/load-model"] = (path, init) => hangUntilAbort(init);
    const pending = manager.loadModel("fish-s2-pro");
    const assertion = expect(pending).rejects.toThrow(/Model load timed out/);
    await vi.advanceTimersByTimeAsync(320000);
    await assertion;
    expect(manager.modelState().state).toBe("failed");
  });

  it("loadModel poll reports a failed model", async () => {
    const { backend, manager } = setup();
    backend.routes["/v1/load-model"] = (path, init) => hangUntilAbort(init);
    const pending = manager.loadModel("qwen3-tts");
    const assertion = expect(pending).rejects.toThrow("Out of memory");
    await vi.advanceTimersByTimeAsync(10500);
    backend.health = { ...HEALTHY, model: "qwen3-tts", model_warm: false, state: "failed", load_error: "Out of memory" };
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(manager.modelState()).toEqual({ modelId: "qwen3-tts", state: "failed", message: "Out of memory" });
  });

  it("loadModel backend error publishes failed", async () => {
    const { backend, manager } = setup();
    backend.routes["/v1/load-model"] = () => json({ detail: { code: "model_not_found", message: "Unknown model: x" } },
      404);
    await expect(manager.loadModel("x")).rejects.toThrow("Unknown model: x");
    expect(manager.modelState()).toEqual({ modelId: "x", state: "failed", message: "Unknown model: x" });
  });

  it("a newer loadModel supersedes an older polling one", async () => {
    const { backend, manager } = setup();
    backend.routes["/v1/load-model"] = (path, init) => (path.includes("fish") ? hangUntilAbort(init)
      : { success: true });
    const older = manager.loadModel("fish-s2-pro");
    await vi.advanceTimersByTimeAsync(10500);
    await manager.loadModel("kokoro");
    await vi.advanceTimersByTimeAsync(1500);
    await expect(older).resolves.toMatchObject({ state: "idle" });
    expect(manager.modelState()).toMatchObject({ modelId: "kokoro", state: "loaded" });
    await flush();
  });
});
