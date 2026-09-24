// host/host-port.js — HELLO on every (re)connect, ACCEPT/REJECT, backoff reconnect, dispatch and forwarding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectHost, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from "../host/host-port.js";
import { MSG, PORTS } from "../shared/messages.js";
import { createFakeChrome, flush } from "./helpers/fake-chrome.js";
import { engineHarness, v2Frames, v2Response } from "./helpers/host-harness.js";

function fakeEngine(active = null) {
  const calls = [];
  return {
    calls,
    active,
    speak: (cmd) => calls.push(["speak", cmd.run.runId]),
    pause: (runId) => calls.push(["pause", runId]),
    resume: (runId) => calls.push(["resume", runId]),
    stop: (runId, outcome) => calls.push(["stop", runId, outcome]),
    activeRun() {
      return this.active;
    },
  };
}

function setup({ kind = "offscreen", engine = fakeEngine(), connect } = {}) {
  const chrome = createFakeChrome();
  const serverPorts = [];
  chrome.runtime.onConnect.addListener((port) => serverPorts.push(port));
  const onReject = vi.fn();
  const onAccept = vi.fn();
  const host = connectHost({
    kind,
    engine,
    onReject,
    onAccept,
    connect: connect || ((info) => chrome.runtime.connect(info)),
  });
  const server = () => serverPorts.at(-1);
  return { chrome, host, engine, onReject, onAccept, serverPorts, server };
}

const speakCommand = (runId = "r1") => ({
  type: MSG.HOST_SPEAK,
  run: { runId, source: "popup", sourceTabId: null, sourceFrameId: null },
  text: "Hello.",
  settings: { speed: 1 },
  authToken: "",
  protocolVersion: 2,
  firstAudioDeadlineMs: null,
});

describe("connectHost", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects host:<kind> and sends HOST_HELLO first", async () => {
    for (const [kind, name] of [["offscreen", PORTS.HOST_OFFSCREEN], ["reader", PORTS.HOST_READER]]) {
      const t = setup({ kind });
      await flush();
      expect(t.chrome.runtime.connect.calls).toEqual([[{ name }]]);
      expect(t.server().received).toEqual([{ type: MSG.HOST_HELLO, kind, activeRun: null }]);
    }
  });

  it("dispatches HOST_* commands to the engine", async () => {
    const t = setup();
    await flush();
    t.server().postMessage(speakCommand("r1"));
    t.server().postMessage({ type: MSG.HOST_PAUSE, runId: "r1" });
    t.server().postMessage({ type: MSG.HOST_RESUME, runId: "r1" });
    t.server().postMessage({ type: MSG.HOST_STOP, runId: "r1", outcome: "superseded" });
    t.server().postMessage({ type: "SOMETHING_ELSE" });
    await flush();
    expect(t.engine.calls).toEqual([
      ["speak", "r1"], ["pause", "r1"], ["resume", "r1"], ["stop", "r1", "superseded"],
    ]);
  });

  it("HOST_ACCEPT calls onAccept", async () => {
    const t = setup();
    await flush();
    t.server().postMessage({ type: MSG.HOST_ACCEPT });
    await flush();
    expect(t.onAccept).toHaveBeenCalledTimes(1);
    expect(t.host.accepted).toBe(true);
  });

  it("forwards engine events to the SW", async () => {
    const t = setup();
    await flush();
    t.host.forward({ type: MSG.STATUS, runId: "r1", state: "buffering", label: "Generating..." });
    await flush();
    expect(t.server().received.at(-1)).toEqual({
      type: MSG.STATUS, runId: "r1", state: "buffering", label: "Generating...",
    });
  });

  it("reconnects after disconnect with backoff 100 ms doubling to 2 s, re-sending HELLO with activeRun", async () => {
    const engine = fakeEngine({ runId: "r1", state: "paused", paused: true });
    const t = setup({ engine });
    await flush();
    const delays = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = t.serverPorts.length;
      t.server().disconnect();
      await flush();
      let waited = 0;
      while (t.serverPorts.length === before) {
        vi.advanceTimersByTime(50);
        waited += 50;
        await flush();
        if (waited > 5000) throw new Error("no reconnect");
      }
      delays.push(waited);
    }
    expect(RECONNECT_MIN_MS).toBe(100);
    expect(RECONNECT_MAX_MS).toBe(2000);
    expect(delays).toEqual([100, 200, 400, 800, 1600, 2000, 2000]);
    for (const port of t.serverPorts) {
      expect(port.received[0]).toEqual({
        type: MSG.HOST_HELLO, kind: "offscreen", activeRun: { runId: "r1", state: "paused", paused: true },
      });
    }
  });

  it("resets the backoff once the SW talks on the new port", async () => {
    const t = setup();
    await flush();
    t.server().disconnect();
    await flush();
    vi.advanceTimersByTime(100);
    await flush();
    t.server().disconnect();
    await flush();
    vi.advanceTimersByTime(200);
    await flush();
    t.server().postMessage({ type: MSG.HOST_ACCEPT });
    await flush();
    t.server().disconnect();
    await flush();
    vi.advanceTimersByTime(100);
    await flush();
    expect(t.serverPorts).toHaveLength(4);
  });

  it("retries when connect throws (extension context gone) and stops after close()", async () => {
    let failures = 2;
    const chrome = createFakeChrome();
    const serverPorts = [];
    chrome.runtime.onConnect.addListener((port) => serverPorts.push(port));
    const connect = (info) => {
      if (failures-- > 0) throw new Error("Extension context invalidated.");
      return chrome.runtime.connect(info);
    };
    const host = connectHost({ kind: "offscreen", engine: fakeEngine(), connect });
    vi.advanceTimersByTime(100);
    await flush();
    expect(serverPorts).toHaveLength(0);
    vi.advanceTimersByTime(200);
    await flush();
    expect(serverPorts).toHaveLength(1);
    host.close();
    await flush();
    vi.advanceTimersByTime(10000);
    await flush();
    expect(serverPorts).toHaveLength(1);
    expect(serverPorts[0].connected).toBe(false);
  });

  it("queues events while disconnected (without heartbeats) and flushes them after the next HELLO", async () => {
    const t = setup();
    await flush();
    t.server().disconnect();
    await flush();
    t.host.forward({ type: MSG.HEARTBEAT, runId: "r1" });
    t.host.forward({ type: MSG.DONE, runId: "r1", outcome: "completed", metrics: {} });
    vi.advanceTimersByTime(100);
    await flush();
    expect(t.server().received.map((message) => message.type)).toEqual([MSG.HOST_HELLO, MSG.DONE]);
  });

  it("HOST_REJECT shows the reason, stays inert and never reconnects", async () => {
    const t = setup({ kind: "reader" });
    await flush();
    t.server().postMessage({ type: MSG.HOST_REJECT, reason: "Reader already open in another tab" });
    await flush();
    expect(t.onReject).toHaveBeenCalledWith("Reader already open in another tab");
    expect(t.host.rejected).toBe(true);
    vi.advanceTimersByTime(10000);
    await flush();
    expect(t.serverPorts).toHaveLength(1);
    t.host.forward({ type: MSG.STATUS, runId: "x" });
    await flush();
    expect(t.serverPorts[0].received).toHaveLength(1);
  });
});

describe("connectHost with the real engine", () => {
  it("reject keeps the engine idle: a later HOST_SPEAK starts nothing", async () => {
    const h = engineHarness({ hostKind: "reader" });
    const chrome = createFakeChrome();
    const serverPorts = [];
    chrome.runtime.onConnect.addListener((port) => serverPorts.push(port));
    const onReject = vi.fn();
    connectHost({ kind: "reader", engine: h.engine, onReject, connect: (info) => chrome.runtime.connect(info) });
    await flush();
    serverPorts[0].postMessage({ type: MSG.HOST_REJECT, reason: "Reader already open in another tab" });
    serverPorts[0].postMessage(speakCommand("late"));
    await flush();
    expect(onReject).toHaveBeenCalled();
    expect(h.engine.activeRun()).toBeNull();
    expect(h.requests).toHaveLength(0);
    expect(h.contexts).toHaveLength(0);
  });

  it("HELLO after a reconnect reports the engine's active run; engine events reach the SW", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const chrome = createFakeChrome();
      const serverPorts = [];
      chrome.runtime.onConnect.addListener((port) => serverPorts.push(port));
      /** @type {any} */
      let host = null;
      const h = engineHarness({
        fetch: () => v2Response(v2Frames("Hello.")),
        engine: { emit: (message) => host.forward(message) },
      });
      host = connectHost({ kind: "offscreen", engine: h.engine, connect: (info) => chrome.runtime.connect(info) });
      await flush();
      serverPorts[0].postMessage({ type: MSG.HOST_ACCEPT });
      serverPorts[0].postMessage(speakCommand("r1"));
      await flush(100);
      expect(serverPorts[0].received.map((message) => message.type)).toContain(MSG.STATUS);
      serverPorts[0].disconnect();
      await flush();
      vi.advanceTimersByTime(100);
      await flush();
      expect(serverPorts[1].received[0]).toEqual({
        type: MSG.HOST_HELLO, kind: "offscreen", activeRun: { runId: "r1", state: "playing", paused: false },
      });
      h.engine.stop("r1", "stopped");
      await flush();
      expect(serverPorts[1].received.at(-1)).toMatchObject({ type: MSG.DONE, runId: "r1", outcome: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });
});
