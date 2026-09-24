import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, FAKE_EXTENSION_ID, flush } from "./helpers/fake-chrome.js";
import { createSessionStore, SESSION_KEY } from "../sw/session-store.js";
import { createHostManager, createHostRegistry, READER_PATH } from "../sw/host-manager.js";
import { createRouter, OWNER_LOST_MESSAGE, READER_ALREADY_OPEN } from "../sw/router.js";
import { MSG } from "../shared/messages.js";

const settle = () => flush(400);
const LONG_TEXT = "Long text. ".repeat(500); // 5500 chars → Reader

function hostSender(chrome, kind, tabId) {
  const path = kind === "reader" ? READER_PATH : "host/offscreen.html";
  const sender = { id: FAKE_EXTENSION_ID, url: chrome.runtime.getURL(path) };
  if (tabId !== undefined) sender.tab = { id: tabId };
  return sender;
}

/** Simulated host page: connects, says HOST_HELLO, records everything it receives. */
function connectHost(chrome, kind, { tabId, activeRun = null } = {}) {
  const port = chrome.fake.connect(`host:${kind}`, hostSender(chrome, kind, tabId));
  port.postMessage({ type: MSG.HOST_HELLO, kind, activeRun });
  return port;
}

function ofType(port, type) {
  return port.received.filter((message) => message.type === type);
}

function lastSession(port) {
  return ofType(port, MSG.SESSION).at(-1);
}

function setup(options = {}) {
  const chrome = createFakeChrome({ storage: { session: options.session || {} } });
  const autoHosts = options.autoHosts !== false;
  const hostPorts = { offscreen: [], reader: [] };
  if (autoHosts) {
    const createDocument = chrome.offscreen.createDocument.impl;
    chrome.offscreen.createDocument.impl = (params) => {
      createDocument(params);
      queueMicrotask(() => hostPorts.offscreen.push(connectHost(chrome, "offscreen")));
    };
    const createTab = chrome.tabs.create.impl;
    chrome.tabs.create.impl = (props) => {
      const tab = createTab(props);
      if (props.url === chrome.runtime.getURL(READER_PATH)) {
        queueMicrotask(() => hostPorts.reader.push(connectHost(chrome, "reader", { tabId: tab.id })));
      }
      return tab;
    };
  }
  const store = createSessionStore({ storage: chrome.storage.session });
  const registry = createHostRegistry();
  const hosts = createHostManager({ chrome, registry, readyTimeoutMs: 1000 });
  let serverState = { state: "ready", message: "Connected — kokoro", model: "kokoro" };
  const server = {
    ensureServer: vi.fn(async () => ({ status: "ok" })),
    checkCapabilities: vi.fn(async () => ({ protocol_versions: [1, 2] })),
    checkHealth: vi.fn(async () => null),
    stopServer: vi.fn(async () => ({ success: true })),
    loadModel: vi.fn(async (modelId) => ({ modelId, state: "loaded", message: "ok" })),
    getModels: vi.fn(async () => ({ models: [{ id: "kokoro" }] })),
    serverState: () => serverState,
    modelState: vi.fn(() => null),
    setState(next) {
      serverState = next;
    },
  };
  const auth = { getToken: vi.fn(async () => "tok") };
  const settings = {
    resolve: vi.fn(async (provided) => ({
      model: provided?.model || "kokoro", voice: "af_bella", speed: 1.5, language: "Auto", instruct: "",
    })),
  };
  const history = { persistCompletion: vi.fn(async () => true) };
  let counter = 0;
  const router = createRouter({
    store, registry, hosts, server, auth, settings, history,
    extensionUrl: (path) => chrome.runtime.getURL(path),
    makeRunId: () => `gen-${++counter}`,
  });
  chrome.runtime.onConnect.addListener(router.handleConnect);
  const popup = () => chrome.runtime.connect({ name: "ui:popup" });
  const content = (tabId = 5, frameId = 0) => chrome.fake.connect("ui:content",
    { tab: { id: tabId }, frameId, url: "https://example.com/" });
  return { chrome, store, registry, hosts, server, auth, settings, history, router, hostPorts, popup, content };
}

/** Start a run from a fresh popup port and wait until its host got HOST_SPEAK. */
async function startRun(env, { text = "Hello there", runId = "r1", settings } = {}) {
  const ui = env.popup();
  ui.postMessage({ type: MSG.SPEAK, runId, text, settings, requestId: `req-${runId}` });
  await settle();
  return ui;
}

describe("sw/router — connect snapshots", () => {
  it("posts SESSION, SERVER_STATE and (if known) MODEL_STATE on connect", async () => {
    const env = setup();
    env.server.modelState.mockReturnValue({ modelId: "kokoro", state: "loaded", message: "ok" });
    const ui = env.popup();
    await settle();
    expect(ui.received.map((m) => m.type)).toEqual([MSG.SESSION, MSG.SERVER_STATE, MSG.MODEL_STATE]);
    expect(ui.received[0]).toMatchObject({ session: { state: "idle", runId: null }, controllable: false });
    expect(ui.received[1]).toEqual({ type: MSG.SERVER_STATE, state: "ready", message: "Connected — kokoro",
      model: "kokoro" });
    expect(env.server.checkHealth).toHaveBeenCalledTimes(1);
  });

  it("a popup reconnecting mid-start receives the current SERVER_STATE and does not re-check health", async () => {
    const env = setup();
    env.server.setState({ state: "starting", message: "Starting server..." });
    const ui = env.popup();
    await settle();
    expect(ofType(ui, MSG.SERVER_STATE)).toEqual([{ type: MSG.SERVER_STATE, state: "starting",
      message: "Starting server..." }]);
    expect(env.server.checkHealth).not.toHaveBeenCalled();
  });

  it("publish fans out to every UI port", async () => {
    const env = setup();
    const a = env.popup();
    const b = env.content();
    await settle();
    env.router.publish({ type: MSG.HISTORY_ERROR, runId: "x", message: "nope" });
    await settle();
    expect(ofType(a, MSG.HISTORY_ERROR)).toHaveLength(1);
    expect(ofType(b, MSG.HISTORY_ERROR)).toHaveLength(1);
  });

  it("rejects ports from untrusted senders", async () => {
    const env = setup();
    const fakePopup = env.chrome.fake.connect("ui:popup", { tab: { id: 3 }, url: "https://evil.example/" });
    const fakeHost = env.chrome.fake.connect("host:reader", { tab: { id: 3 }, url: "https://evil.example/" });
    const wrongPage = env.chrome.fake.connect("host:offscreen",
      { id: FAKE_EXTENSION_ID, url: env.chrome.runtime.getURL("ui/popup.html") });
    const tabless = env.chrome.fake.connect("ui:content", { url: "https://example.com/" });
    const unknown = env.chrome.fake.connect("whatever", { id: FAKE_EXTENSION_ID });
    const disconnected = [];
    for (const port of [fakePopup, fakeHost, wrongPage, tabless, unknown]) {
      port.onDisconnect.addListener(() => disconnected.push(port.name));
    }
    await settle();
    expect(disconnected).toHaveLength(5);
  });
});

describe("sw/router — SPEAK flow", () => {
  it("replies with the runId, begins preparing, ensures the host and sends HOST_SPEAK", async () => {
    const env = setup();
    const ui = await startRun(env);
    expect(ofType(ui, MSG.REPLY)).toEqual([{ type: MSG.REPLY, requestId: "req-r1", ok: true,
      data: { runId: "r1", hostKind: "offscreen" } }]);
    expect(ofType(ui, MSG.SESSION)[1]).toMatchObject({
      session: { runId: "r1", state: "preparing", source: "popup", hostKind: "offscreen", textPreview: "Hello there" },
      controllable: true,
    });
    const [host] = env.hostPorts.offscreen;
    expect(host.received.map((m) => m.type)).toEqual([MSG.HOST_ACCEPT, MSG.HOST_SPEAK]);
    expect(ofType(host, MSG.HOST_SPEAK)[0]).toEqual({
      type: MSG.HOST_SPEAK,
      run: { runId: "r1", source: "popup", sourceTabId: null, sourceFrameId: null },
      text: "Hello there",
      settings: { model: "kokoro", voice: "af_bella", speed: 1.5, language: "Auto", instruct: "" },
      authToken: "tok",
      protocolVersion: 2,
      firstAudioDeadlineMs: null,
    });
    expect(env.server.ensureServer).toHaveBeenCalled();
    expect(env.chrome.runtime.sendMessage.calls).toHaveLength(0);
  });

  it("generates a runId when none is given and derives source from the port, not the payload", async () => {
    const env = setup();
    const page = env.content(7, 2);
    page.postMessage({ type: MSG.SPEAK, text: "Hi", source: "popup", requestId: "q" });
    await settle();
    expect(ofType(page, MSG.REPLY)[0].data.runId).toBe("gen-1");
    expect(env.store.current()).toMatchObject({ source: "content", sourceTabId: 7, sourceFrameId: 2 });
  });

  it("slow models on offscreen carry the first-audio deadline", async () => {
    const env = setup();
    await startRun(env, { settings: { model: "qwen3-tts" } });
    expect(ofType(env.hostPorts.offscreen[0], MSG.HOST_SPEAK)[0].firstAudioDeadlineMs).toBe(25000);
  });

  it("long text goes to a pinned Reader tab that is released when the run ends", async () => {
    const env = setup();
    const ui = await startRun(env, { text: LONG_TEXT });
    const [reader] = env.hostPorts.reader;
    expect(ofType(reader, MSG.HOST_SPEAK)).toHaveLength(1);
    const tabId = env.chrome.tabs.create.calls.length && [...env.chrome.fake.tabs.keys()][0];
    expect(env.chrome.fake.tabs.get(tabId).autoDiscardable).toBe(false);
    reader.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed", metrics: {} });
    await settle();
    expect(env.chrome.fake.tabs.get(tabId).autoDiscardable).toBe(true);
    expect(lastSession(ui).session).toMatchObject({ state: "idle", outcome: "completed" });
  });

  it("rejects empty and oversized text without touching the current run", async () => {
    const env = setup();
    const ui = await startRun(env);
    ui.postMessage({ type: MSG.SPEAK, text: "   ", requestId: "e" });
    ui.postMessage({ type: MSG.SPEAK, text: "x".repeat(200001), requestId: "big" });
    await settle();
    const replies = ofType(ui, MSG.REPLY).slice(1);
    expect(replies).toEqual([
      { type: MSG.REPLY, requestId: "e", ok: false, error: "Nothing to read", code: "empty_text" },
      { type: MSG.REPLY, requestId: "big", ok: false, error: "Text exceeds 200000 characters", code: "text_too_long" },
    ]);
    expect(env.store.current()).toMatchObject({ runId: "r1", state: "preparing" });
  });

  it("a duplicate runId is rejected", async () => {
    const env = setup();
    const ui = await startRun(env);
    ui.postMessage({ type: MSG.SPEAK, runId: "r1", text: "again", requestId: "dup" });
    await settle();
    expect(ofType(ui, MSG.REPLY).at(-1)).toMatchObject({ ok: false, code: "duplicate_run" });
  });

  it("a failure before the host accepts ends the run as failed with a clear message", async () => {
    const env = setup();
    env.server.ensureServer.mockRejectedValueOnce(Object.assign(new Error("Could not start the server: boom"),
      { code: "server_unavailable" }));
    const ui = await startRun(env);
    expect(lastSession(ui).session).toMatchObject({
      runId: "r1", state: "idle", outcome: "failed",
      error: { message: "Could not start the server: boom", code: "server_unavailable" },
    });
    expect(env.hostPorts.offscreen).toHaveLength(0);
  });

  it("an old backend without protocol v2 fails the run", async () => {
    const env = setup();
    env.server.checkCapabilities.mockRejectedValueOnce(new Error("Update the backend to support progressive streaming v2"));
    const ui = await startRun(env);
    expect(lastSession(ui).session.error.message).toMatch(/progressive streaming v2/);
  });

  it("a host that never says HELLO fails the run with host_unavailable", async () => {
    vi.useFakeTimers();
    try {
      const env = setup({ autoHosts: false });
      const ui = await startRun(env);
      await vi.advanceTimersByTimeAsync(1100);
      await settle();
      expect(lastSession(ui).session).toMatchObject({ outcome: "failed", error: { code: "host_unavailable" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("STOP while the server is still starting prevents HOST_SPEAK", async () => {
    const env = setup();
    let release;
    env.server.ensureServer.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const ui = await startRun(env);
    ui.postMessage({ type: MSG.STOP, runId: "r1", requestId: "s" });
    await settle();
    expect(lastSession(ui).session).toMatchObject({ state: "idle", outcome: "stopped" });
    release({ status: "ok" });
    await settle();
    expect(env.hostPorts.offscreen).toHaveLength(0);
  });

  it("PAUSE before the host has the run replies not_ready", async () => {
    const env = setup();
    env.server.ensureServer.mockImplementationOnce(() => new Promise(() => {}));
    const ui = await startRun(env);
    ui.postMessage({ type: MSG.PAUSE, runId: "r1", requestId: "p" });
    await settle();
    expect(ofType(ui, MSG.REPLY).at(-1)).toMatchObject({ ok: false, code: "not_ready" });
  });
});

describe("sw/router — host events", () => {
  let env;
  let ui;
  let host;
  beforeEach(async () => {
    env = setup();
    ui = await startRun(env);
    host = env.hostPorts.offscreen[0];
  });

  it("STATUS and PROGRESS update the store and fan out SESSION to every UI port", async () => {
    const page = env.content();
    await settle();
    host.postMessage({ type: MSG.STATUS, runId: "r1", state: "playing", label: "Reading...", metrics: { a: 1 } });
    host.postMessage({ type: MSG.PROGRESS, runId: "r1", played: 2, scheduled: 5, index: 1, end: 3, junk: "x",
      bufferedSeconds: 4.5 });
    await settle();
    for (const port of [ui, page]) {
      expect(lastSession(port).session).toMatchObject({ state: "playing", label: "Reading...", metrics: { a: 1 },
        progress: { played: 2, scheduled: 5, index: 1, end: 3, bufferedSeconds: 4.5 } });
    }
    expect(lastSession(page).controllable).toBe(false);
    expect(lastSession(ui).controllable).toBe(true);
  });

  it("DONE completed persists history from the run info exactly once", async () => {
    host.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed", metrics: { total: 1 } });
    host.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed", metrics: {} });
    await settle();
    expect(env.history.persistCompletion).toHaveBeenCalledTimes(1);
    expect(env.history.persistCompletion.mock.calls[0][0]).toMatchObject({ id: "r1", text: "Hello there", chars: 11,
      voice: "af_bella", model: "kokoro", speed: 1.5 });
    expect(lastSession(ui).session).toMatchObject({ state: "idle", outcome: "completed", metrics: { total: 1 } });
  });

  it("ERROR ends the run as failed with the host message and code", async () => {
    host.postMessage({ type: MSG.ERROR, runId: "r1", outcome: "failed", message: "Model is slow to start — retry to open the Reader",
      code: "slow_start" });
    await settle();
    expect(lastSession(ui).session).toMatchObject({ outcome: "failed",
      error: { message: "Model is slow to start — retry to open the Reader", code: "slow_start" } });
    expect(env.history.persistCompletion).not.toHaveBeenCalled();
  });

  it("rule 6: terminal events for another runId are dropped", async () => {
    host.postMessage({ type: MSG.DONE, runId: "other", outcome: "completed" });
    host.postMessage({ type: MSG.ERROR, runId: "other", outcome: "failed", message: "x" });
    await settle();
    expect(env.store.current()).toMatchObject({ runId: "r1", state: "preparing" });
  });

  it("a host terminal after STOP does not produce a second terminal or history", async () => {
    const revisionsBefore = ofType(ui, MSG.SESSION).length;
    ui.postMessage({ type: MSG.STOP, runId: "r1", requestId: "s" });
    await settle();
    expect(ofType(host, MSG.HOST_STOP)).toEqual([{ type: MSG.HOST_STOP, runId: "r1", outcome: "stopped" }]);
    host.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed" });
    await settle();
    expect(ofType(ui, MSG.SESSION).length).toBe(revisionsBefore + 1);
    expect(lastSession(ui).session.outcome).toBe("stopped");
    expect(env.history.persistCompletion).not.toHaveBeenCalled();
  });

  it("PAUSE / RESUME are forwarded to the owning host", async () => {
    host.postMessage({ type: MSG.STATUS, runId: "r1", state: "playing", label: "Reading..." });
    ui.postMessage({ type: MSG.PAUSE, runId: "r1", requestId: "p" });
    await settle();
    ui.postMessage({ type: MSG.RESUME, runId: "r1", requestId: "r" });
    await settle();
    expect(host.received.filter((m) => m.type === MSG.HOST_PAUSE || m.type === MSG.HOST_RESUME)).toEqual([
      { type: MSG.HOST_PAUSE, runId: "r1" }, { type: MSG.HOST_RESUME, runId: "r1" },
    ]);
    expect(ofType(ui, MSG.REPLY).slice(-2).every((m) => m.ok)).toBe(true);
  });

  it("controls for a stale runId are rejected", async () => {
    ui.postMessage({ type: MSG.STOP, runId: "old", requestId: "s" });
    await settle();
    expect(ofType(ui, MSG.REPLY).at(-1)).toMatchObject({ ok: false, code: "stale_run" });
    expect(env.store.current().state).toBe("preparing");
  });

  it("a HEARTBEAT for a run that is not current silences the orphan", async () => {
    host.postMessage({ type: MSG.HEARTBEAT, runId: "r1" });
    host.postMessage({ type: MSG.HEARTBEAT, runId: "ghost" });
    await settle();
    expect(ofType(host, MSG.HOST_STOP)).toEqual([{ type: MSG.HOST_STOP, runId: "ghost", outcome: "stopped" }]);
  });

  it("messages without a type or from non-accepted ports are ignored", async () => {
    const stray = env.chrome.fake.connect("host:offscreen", hostSender(env.chrome, "offscreen"));
    stray.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed" });
    host.postMessage(null);
    await settle();
    expect(env.store.current().state).toBe("preparing");
  });
});

describe("sw/router — ownership rules", () => {
  it("rule 1: HOST_STOP(superseded) to the old host is sent before HOST_SPEAK to the new host", async () => {
    const env = setup();
    const ui = await startRun(env, { text: LONG_TEXT, runId: "old" });
    const reader = env.hostPorts.reader[0];
    ui.postMessage({ type: MSG.SPEAK, runId: "new", text: "Short", requestId: "n" });
    await settle();
    const log = env.chrome.fake.log.map((entry) => ({ api: entry.api, type: entry.args[0]?.type,
      runId: entry.args[0]?.runId ?? entry.args[0]?.run?.runId }));
    const stopIndex = log.findIndex((e) => e.api === "port[host:reader].postMessage" && e.type === MSG.HOST_STOP);
    const speakIndex = log.findIndex((e) => e.api === "port[host:offscreen].postMessage" && e.type === MSG.HOST_SPEAK);
    expect(stopIndex).toBeGreaterThan(-1);
    expect(speakIndex).toBeGreaterThan(stopIndex);
    expect(ofType(reader, MSG.HOST_STOP)).toEqual([{ type: MSG.HOST_STOP, runId: "old", outcome: "superseded" }]);
    const sessions = ofType(ui, MSG.SESSION).map((m) => m.session);
    expect(sessions.some((s) => s.runId === "old" && s.state === "idle" && s.outcome === "superseded")).toBe(true);
    expect(sessions.at(-1)).toMatchObject({ runId: "new", hostKind: "offscreen" });
  });

  it("rule 1: replacing a run on the same host still stops before speaking", async () => {
    const env = setup();
    const ui = await startRun(env, { runId: "a" });
    ui.postMessage({ type: MSG.SPEAK, runId: "b", text: "Next", requestId: "b" });
    await settle();
    const host = env.hostPorts.offscreen[0];
    const types = host.received.map((m) => `${m.type}:${m.runId ?? m.run?.runId ?? ""}`);
    expect(types).toEqual(["HOST_ACCEPT:", "HOST_SPEAK:a", "HOST_STOP:a", "HOST_SPEAK:b"]);
  });

  it("rule 2: popup and reader UI ports may control any run", async () => {
    const env = setup();
    const page = env.content(5);
    page.postMessage({ type: MSG.SPEAK, runId: "c", text: "From page", requestId: "c" });
    await settle();
    const reader = env.chrome.fake.connect("ui:reader",
      { id: FAKE_EXTENSION_ID, url: env.chrome.runtime.getURL(READER_PATH), tab: { id: 99 } });
    await settle();
    expect(lastSession(reader).controllable).toBe(true);
    reader.postMessage({ type: MSG.STOP, runId: "c", requestId: "s" });
    await settle();
    expect(ofType(reader, MSG.REPLY).at(-1)).toMatchObject({ ok: true });
  });

  it("rule 3: a content port of another tab or frame cannot control the run", async () => {
    const env = setup();
    const owner = env.content(5, 0);
    owner.postMessage({ type: MSG.SPEAK, runId: "c", text: "From page", requestId: "c" });
    await settle();
    const otherTab = env.content(6, 0);
    const otherFrame = env.content(5, 3);
    await settle();
    expect(lastSession(owner).controllable).toBe(true);
    expect(lastSession(otherTab).controllable).toBe(false);
    expect(lastSession(otherFrame).controllable).toBe(false);
    otherTab.postMessage({ type: MSG.STOP, runId: "c", requestId: "x" });
    otherFrame.postMessage({ type: MSG.PAUSE, runId: "c", requestId: "y" });
    await settle();
    expect(ofType(otherTab, MSG.REPLY)[0]).toMatchObject({ ok: false, code: "not_owner" });
    expect(ofType(otherFrame, MSG.REPLY)[0]).toMatchObject({ ok: false, code: "not_owner" });
    expect(env.store.current()).toMatchObject({ runId: "c", state: "preparing" });
    owner.postMessage({ type: MSG.STOP, runId: "c", requestId: "z" });
    await settle();
    expect(env.store.current().outcome).toBe("stopped");
  });

  it("rule 3: menu/command runs bind to the tab (frame 0 / menu frame)", async () => {
    const env = setup();
    await env.router.speak({ text: "Menu text", source: "menu", sourceTabId: 5, sourceFrameId: 0 });
    const page = env.content(5, 0);
    const other = env.content(8, 0);
    await settle();
    expect(lastSession(page).controllable).toBe(true);
    expect(lastSession(other).controllable).toBe(false);
    expect(env.store.current()).toMatchObject({ source: "menu", sourceTabId: 5, sourceFrameId: 0 });
  });

  it("rule 4: a second Reader host is rejected and stays inert", async () => {
    const env = setup();
    const first = connectHost(env.chrome, "reader", { tabId: 10 });
    const second = connectHost(env.chrome, "reader", { tabId: 11 });
    await settle();
    expect(first.received).toEqual([{ type: MSG.HOST_ACCEPT }]);
    expect(second.received).toEqual([{ type: MSG.HOST_REJECT, reason: READER_ALREADY_OPEN }]);
    env.chrome.fake.contexts.push({ contextType: "TAB", documentUrl: env.chrome.runtime.getURL(READER_PATH), tabId: 10 });
    env.chrome.fake.addTab({ id: 10 });
    const ui = await startRun(env, { text: LONG_TEXT });
    expect(ofType(first, MSG.HOST_SPEAK)).toHaveLength(1);
    expect(ofType(second, MSG.HOST_SPEAK)).toHaveLength(0);
    second.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed" });
    await settle();
    expect(lastSession(ui).session.state).toBe("preparing");
  });

  it("rule 4: after the accepted Reader closes, a new Reader is accepted", async () => {
    const env = setup();
    const first = connectHost(env.chrome, "reader", { tabId: 10 });
    await settle();
    first.disconnect();
    await settle();
    const second = connectHost(env.chrome, "reader", { tabId: 11 });
    await settle();
    expect(second.received).toEqual([{ type: MSG.HOST_ACCEPT }]);
  });
});

describe("sw/router — owner loss (rule 5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("owner disconnect → owner_lost exactly once after the 2 s grace", async () => {
    const env = setup();
    const ui = await startRun(env);
    const host = env.hostPorts.offscreen[0];
    host.disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(1900);
    expect(env.store.current().state).toBe("preparing");
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    const lost = ofType(ui, MSG.SESSION).filter((m) => m.session.outcome === "owner_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0].session.error).toEqual({ message: OWNER_LOST_MESSAGE, code: "owner_lost" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ofType(ui, MSG.SESSION).filter((m) => m.session.outcome === "owner_lost")).toHaveLength(1);
  });

  it("no owner_lost when the host reconnects with the run within the grace", async () => {
    const env = setup();
    const ui = await startRun(env);
    env.hostPorts.offscreen[0].postMessage({ type: MSG.STATUS, runId: "r1", state: "playing", label: "Reading..." });
    await settle();
    env.hostPorts.offscreen[0].disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    const back = connectHost(env.chrome, "offscreen", { activeRun: { runId: "r1", state: "paused", paused: true } });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(back.received).toEqual([{ type: MSG.HOST_ACCEPT }]);
    expect(ofType(ui, MSG.SESSION).some((m) => m.session.outcome === "owner_lost")).toBe(false);
    expect(env.store.current()).toMatchObject({ runId: "r1", state: "paused" });
    ui.postMessage({ type: MSG.RESUME, runId: "r1", requestId: "r" });
    await settle();
    expect(ofType(back, MSG.HOST_RESUME)).toEqual([{ type: MSG.HOST_RESUME, runId: "r1" }]);
  });

  it("a host that reconnects without the run and sends no terminal → owner_lost when the grace ends", async () => {
    const env = setup();
    const ui = await startRun(env);
    env.hostPorts.offscreen[0].disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    connectHost(env.chrome, "offscreen", { activeRun: null });
    await settle();
    expect(env.store.current().state).toBe("preparing");
    await vi.advanceTimersByTimeAsync(1600);
    await settle();
    expect(ofType(ui, MSG.SESSION).filter((m) => m.session.outcome === "owner_lost")).toHaveLength(1);
  });

  it("a queued DONE flushed right after HOST_HELLO{activeRun:null} completes the run (no owner_lost)", async () => {
    const env = setup();
    const ui = await startRun(env);
    env.hostPorts.offscreen[0].disconnect();
    await settle();
    const back = connectHost(env.chrome, "offscreen", { activeRun: null });
    back.postMessage({ type: MSG.DONE, runId: "r1", outcome: "completed", metrics: { total: 2 } });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(lastSession(ui).session).toMatchObject({ outcome: "completed", metrics: { total: 2 } });
    expect(ofType(ui, MSG.SESSION).some((m) => m.session.outcome === "owner_lost")).toBe(false);
    expect(env.history.persistCompletion).toHaveBeenCalledTimes(1);
  });

  it("a queued ERROR flushed after HOST_HELLO{activeRun:null} fails the run with the host's message", async () => {
    const env = setup();
    const ui = await startRun(env);
    env.hostPorts.offscreen[0].disconnect();
    await settle();
    const back = connectHost(env.chrome, "offscreen", { activeRun: null });
    back.postMessage({ type: MSG.ERROR, runId: "r1", outcome: "failed", message: "Stream cut", code: "stream" });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSession(ui).session).toMatchObject({ outcome: "failed", error: { message: "Stream cut", code: "stream" } });
  });

  it("closing the Reader tab loses the Reader run", async () => {
    const env = setup();
    const ui = await startRun(env, { text: LONG_TEXT });
    env.hostPorts.reader[0].disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(2100);
    await settle();
    expect(lastSession(ui).session).toMatchObject({ outcome: "owner_lost", hostKind: "reader" });
  });

  it("a non-owner host disconnecting does not affect the run", async () => {
    const env = setup();
    await startRun(env);
    const reader = connectHost(env.chrome, "reader", { tabId: 50 });
    await settle();
    reader.disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(env.store.current().state).toBe("preparing");
  });
});

describe("sw/router — service-worker restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function persisted(state, hostKind = "offscreen") {
    return {
      [SESSION_KEY]: {
        session: { runId: "r9", revision: 12, state, label: "Reading...", source: "popup", sourceTabId: null,
          sourceFrameId: null, hostKind, progress: { played: 3, scheduled: 4 }, textPreview: "persisted" },
        runInfo: { runId: "r9", historyText: "persisted text", chars: 14, voice: "af_bella", model: "kokoro",
          speed: 1, startedAt: 1 },
      },
    };
  }

  it("a new router restores the run; HOST_HELLO with the run adopts it and controls work", async () => {
    const env = setup({ session: persisted("playing") });
    const ui = env.popup();
    await settle();
    expect(lastSession(ui)).toMatchObject({ session: { runId: "r9", state: "playing", revision: 12 },
      controllable: true });
    const host = connectHost(env.chrome, "offscreen", { activeRun: { runId: "r9", state: "playing", paused: false } });
    await settle();
    await vi.advanceTimersByTimeAsync(6000);
    expect(env.store.current()).toMatchObject({ runId: "r9", state: "playing" });
    ui.postMessage({ type: MSG.PAUSE, runId: "r9", requestId: "p" });
    await settle();
    expect(ofType(host, MSG.HOST_PAUSE)).toEqual([{ type: MSG.HOST_PAUSE, runId: "r9" }]);
    host.postMessage({ type: MSG.DONE, runId: "r9", outcome: "completed" });
    await settle();
    expect(env.history.persistCompletion).toHaveBeenCalledWith(expect.objectContaining({ id: "r9",
      text: "persisted text", chars: 14 }));
  });

  it("adopting a Reader run re-pins its tab", async () => {
    const env = setup({ session: persisted("playing", "reader") });
    env.chrome.fake.addTab({ id: 77, autoDiscardable: true });
    connectHost(env.chrome, "reader", { tabId: 77, activeRun: { runId: "r9", state: "playing", paused: false } });
    await settle();
    expect(env.chrome.fake.tabs.get(77).autoDiscardable).toBe(false);
  });

  it("the store says the run ended → the reconnecting host gets HOST_STOP", async () => {
    const stored = persisted("idle");
    stored[SESSION_KEY].session.outcome = "stopped";
    const env = setup({ session: stored });
    const host = connectHost(env.chrome, "offscreen", { activeRun: { runId: "r9", state: "playing", paused: false } });
    await settle();
    expect(host.received).toEqual([{ type: MSG.HOST_ACCEPT }, { type: MSG.HOST_STOP, runId: "r9", outcome: "stopped" }]);
    expect(env.store.current().state).toBe("idle");
  });

  it("a host with a different run than the store is superseded", async () => {
    const env = setup({ session: persisted("playing") });
    const host = connectHost(env.chrome, "offscreen", { activeRun: { runId: "zombie", state: "playing" } });
    await settle();
    expect(ofType(host, MSG.HOST_STOP)).toEqual([{ type: MSG.HOST_STOP, runId: "zombie", outcome: "superseded" }]);
  });

  it("no host comes back → owner_lost after the restart grace", async () => {
    const env = setup({ session: persisted("paused") });
    const ui = env.popup();
    await settle();
    await vi.advanceTimersByTimeAsync(5100);
    await settle();
    expect(lastSession(ui).session).toMatchObject({ runId: "r9", state: "idle", outcome: "owner_lost" });
    expect(lastSession(ui).session.revision).toBeGreaterThan(12);
  });

  it("the host comes back without the run → owner_lost (unless it flushes a terminal)", async () => {
    const env = setup({ session: persisted("preparing") });
    connectHost(env.chrome, "offscreen", { activeRun: null });
    await settle();
    await vi.advanceTimersByTimeAsync(5100);
    await settle();
    expect(env.store.current().outcome).toBe("owner_lost");
  });
});

describe("sw/router — other commands", () => {
  it("togglePause pauses a playing run and resumes a paused one", async () => {
    const env = setup();
    await startRun(env);
    const host = env.hostPorts.offscreen[0];
    host.postMessage({ type: MSG.STATUS, runId: "r1", state: "playing", label: "Reading..." });
    await settle();
    await env.router.togglePause();
    host.postMessage({ type: MSG.STATUS, runId: "r1", state: "paused", label: "Paused" });
    await settle();
    await env.router.togglePause();
    await settle();
    expect(host.received.filter((m) => m.type === MSG.HOST_PAUSE || m.type === MSG.HOST_RESUME).map((m) => m.type))
      .toEqual([MSG.HOST_PAUSE, MSG.HOST_RESUME]);
  });

  it("togglePause with no run is a no-op", async () => {
    const env = setup();
    await expect(env.router.togglePause()).resolves.toBeNull();
  });

  it("server commands reply with data or errors", async () => {
    const env = setup();
    env.server.stopServer.mockRejectedValueOnce(Object.assign(new Error("Stop failed"), { code: "stop_failed" }));
    const ui = env.popup();
    ui.postMessage({ type: MSG.START_SERVER, requestId: "1" });
    ui.postMessage({ type: MSG.LOAD_MODEL, modelId: "qwen3-tts", requestId: "2" });
    ui.postMessage({ type: MSG.GET_MODELS, requestId: "3" });
    ui.postMessage({ type: MSG.STOP_SERVER, requestId: "4" });
    ui.postMessage({ type: MSG.LOAD_MODEL, requestId: "5" });
    ui.postMessage({ type: "NOPE", requestId: "6" });
    ui.postMessage({ type: MSG.GET_MODELS });
    await settle();
    const replies = Object.fromEntries(ofType(ui, MSG.REPLY).map((m) => [m.requestId, m]));
    expect(Object.keys(replies).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(env.server.ensureServer).toHaveBeenCalledWith({ waitForWarm: true });
    expect(replies[1]).toMatchObject({ ok: true, data: { state: "ready" } });
    expect(replies[2]).toMatchObject({ ok: true, data: { modelId: "qwen3-tts", state: "loaded" } });
    expect(replies[3]).toMatchObject({ ok: true, data: { models: [{ id: "kokoro" }] } });
    expect(replies[4]).toEqual({ type: MSG.REPLY, requestId: "4", ok: false, error: "Stop failed", code: "stop_failed" });
    expect(replies[5]).toMatchObject({ ok: false, code: "bad_request" });
    expect(replies[6]).toMatchObject({ ok: false, error: "Unknown message type: NOPE" });
  });

  it("a UI port that disconnects stops receiving fan-out", async () => {
    const env = setup();
    const ui = env.popup();
    await settle();
    const count = ui.received.length;
    ui.disconnect();
    await settle();
    await env.router.speak({ text: "x", source: "menu", sourceTabId: 1, sourceFrameId: 0 });
    await settle();
    expect(ui.received.length).toBe(count);
  });
});
