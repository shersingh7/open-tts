// host/reader.js + offscreen.js wiring, keep-alive, and static page checks (CSP, a11y) for host/*.html|css.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createKeepAlive, KEEP_ALIVE_LOCK } from "../host/keep-alive.js";
import { startOffscreenHost } from "../host/offscreen.js";
import { startReader } from "../host/reader.js";
import { MSG, PORTS, idleSession } from "../shared/messages.js";
import { createFakeChrome, flush } from "./helpers/fake-chrome.js";
import { makeContextClass, v2Frames, v2Response } from "./host-harness.js";

const IDS = ["reader", "status", "model", "detail", "passage", "progress", "pause", "stop", "retry", "error",
  "metrics", "text"];

function fakeDocument() {
  const elements = {};
  for (const id of IDS) {
    const listeners = {};
    elements[id] = {
      id, textContent: "", value: "", disabled: false, hidden: false, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, fn) { listeners[type] = fn; },
      click() { if (!this.disabled && !this.hidden) listeners.click?.(); },
    };
  }
  return { elements, getElementById: (id) => elements[id] || null };
}

function fakeKeepAlive() {
  const calls = [];
  return {
    calls,
    hold() { calls.push("hold"); },
    release() { calls.push("release"); },
    get held() { return calls.at(-1) === "hold"; },
  };
}

function setupReader({ fetchImpl } = {}) {
  const chrome = createFakeChrome();
  const serverPorts = {};
  chrome.runtime.onConnect.addListener((port) => {
    (serverPorts[port.name] ||= []).push(port);
  });
  const doc = fakeDocument();
  const contexts = [];
  const Context = makeContextClass({}, contexts);
  const keepAlive = fakeKeepAlive();
  const reader = startReader({
    doc,
    connect: (info) => chrome.runtime.connect(info),
    keepAlive,
    engineOptions: {
      fetchImpl: fetchImpl || (async () => v2Response(v2Frames("Hello."))),
      audioContextFactory: () => new Context(),
    },
  });
  const host = () => serverPorts[PORTS.HOST_READER]?.at(-1);
  const ui = () => serverPorts[PORTS.UI_READER]?.at(-1);
  return { chrome, doc, el: doc.elements, reader, host, ui, contexts, keepAlive, serverPorts };
}

const speak = (runId = "r1", text = "Hello.") => ({
  type: MSG.HOST_SPEAK,
  run: { runId, source: "reader", sourceTabId: null, sourceFrameId: null },
  text,
  settings: { model: "kokoro", voice: "af_bella", speed: 1.5, language: "Auto", instruct: "" },
  authToken: "",
  protocolVersion: 2,
  firstAudioDeadlineMs: null,
});

const snapshot = (patch = {}, controllable = true) => ({
  type: MSG.SESSION,
  session: { ...idleSession(1), ...patch },
  controllable,
});

describe("Reader page", () => {
  it("connects host:reader (HELLO) and ui:reader, rendering the waiting state", async () => {
    const t = setupReader();
    await flush();
    expect(t.host().received[0]).toEqual({ type: MSG.HOST_HELLO, kind: "reader", activeRun: null });
    expect(t.ui()).toBeDefined();
    expect(t.el.status.textContent).toBe("Ready");
    expect(t.el.model.textContent).toBe("Waiting for a reading from the extension.");
    expect(t.el.pause.disabled).toBe(true);
  });

  it("hosts a run, renders SESSION snapshots and sends Pause/Resume/Stop on ui:reader", async () => {
    const t = setupReader();
    await flush();
    t.host().postMessage({ type: MSG.HOST_ACCEPT });
    t.host().postMessage(speak("r1"));
    await flush(100);
    expect(t.contexts).toHaveLength(1);
    expect(t.keepAlive.calls).toEqual(["hold"]);
    expect(t.el.text.value).toBe("Hello.");
    expect(t.el.model.textContent).toBe("kokoro · af_bella · 1.5×");
    expect(t.host().received.some((message) => message.type === MSG.STATUS)).toBe(true);

    t.ui().postMessage(snapshot({ runId: "r1", state: "playing", label: "Reading...", hostKind: "reader" }));
    await flush();
    expect(t.el.status.textContent).toBe("Reading...");
    expect(t.el.passage.textContent).toBe("Passage 1 of 1");
    expect(t.el.pause.disabled).toBe(false);
    t.el.pause.click();
    await flush();
    expect(t.ui().received.at(-1)).toMatchObject({ type: MSG.PAUSE, runId: "r1" });
    expect(typeof t.ui().received.at(-1).requestId).toBe("string");

    t.ui().postMessage(snapshot({ runId: "r1", state: "paused", label: "Paused", hostKind: "reader" }));
    await flush();
    expect(t.el.pause.textContent).toBe("Resume");
    t.el.pause.click();
    t.el.stop.click();
    await flush();
    expect(t.ui().received.slice(-2).map((message) => message.type)).toEqual([MSG.RESUME, MSG.STOP]);
  });

  it("does not send controls when the snapshot is not controllable", async () => {
    const t = setupReader();
    await flush();
    t.ui().postMessage(snapshot({ runId: "r1", state: "playing", label: "Reading..." }, false));
    await flush();
    const before = t.ui().received.length;
    t.el.pause.disabled = false;
    t.el.pause.click();
    await flush();
    expect(t.ui().received).toHaveLength(before);
  });

  it("offers Retry from the interrupted passage after a stop and sends SPEAK with a new runId", async () => {
    const t = setupReader({ fetchImpl: () => new Promise(() => {}) });
    await flush();
    const text = "First passage.\n\nSecond passage.";
    t.host().postMessage(speak("r1", text));
    await flush();
    t.host().postMessage({ type: MSG.HOST_STOP, runId: "r1", outcome: "stopped" });
    await flush();
    expect(t.host().received.at(-1)).toMatchObject({ type: MSG.DONE, runId: "r1", outcome: "stopped" });
    expect(t.keepAlive.calls).toEqual(["hold", "release"]);
    t.ui().postMessage(snapshot({ runId: "r1", outcome: "stopped", label: "Stopped" }));
    await flush();
    expect(t.el.status.textContent).toBe("Stopped");
    expect(t.el.retry.hidden).toBe(false);
    t.el.retry.click();
    await flush();
    const command = t.ui().received.at(-1);
    expect(command).toMatchObject({
      type: MSG.SPEAK,
      text,
      settings: { model: "kokoro", voice: "af_bella", speed: 1.5, language: "Auto", instruct: "" },
    });
    expect(command.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(command.runId).not.toBe("r1");
    expect(t.el.retry.hidden).toBe(true);
  });

  it("offers Retry after an ERROR with the ERROR's retryText", async () => {
    const t = setupReader({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ detail: "Model crashed" }) }),
    });
    await flush();
    t.host().postMessage(speak("r1", "Some text."));
    await flush(100);
    const error = t.host().received.find((message) => message.type === MSG.ERROR);
    expect(error).toMatchObject({ runId: "r1", outcome: "failed", message: "Model crashed", retryText: "Some text." });
    t.ui().postMessage(snapshot({ runId: "r1", outcome: "failed", error: { message: "Model crashed" } }));
    await flush();
    expect(t.el.error.textContent).toBe("Model crashed");
    expect(t.el.retry.hidden).toBe(false);
    t.el.retry.click();
    await flush();
    expect(t.ui().received.at(-1)).toMatchObject({ type: MSG.SPEAK, text: "Some text." });
  });

  it("shows HISTORY_ERROR and failed replies", async () => {
    const t = setupReader();
    await flush();
    t.ui().postMessage(snapshot({ runId: "r1", state: "playing", label: "Reading..." }));
    t.ui().postMessage({ type: MSG.REPLY, requestId: "x", ok: false, error: "Not allowed" });
    await flush();
    expect(t.el.error.textContent).toBe("Not allowed");
    t.ui().postMessage(snapshot({ runId: "r1", outcome: "completed" }));
    t.ui().postMessage({ type: MSG.HISTORY_ERROR, runId: "r1", message: "quota" });
    await flush();
    expect(t.el.error.textContent).toBe("Audio completed, but history could not be saved: quota");
  });

  it("HOST_REJECT: shows the reason, closes ui:reader, and a racing HOST_SPEAK starts no engine", async () => {
    const t = setupReader();
    await flush();
    t.host().postMessage({ type: MSG.HOST_REJECT, reason: "Reader already open in another tab" });
    t.host().postMessage(speak("r1"));
    await flush(100);
    expect(t.el.status.textContent).toBe("Reader already open in another tab");
    expect(t.contexts).toHaveLength(0);
    expect(t.reader.engine.activeRun()).toBeNull();
    expect(t.ui().connected).toBe(false);
    expect(t.el.pause.disabled).toBe(true);
    expect(t.el.stop.disabled).toBe(true);
    expect(t.el.retry.hidden).toBe(true);
    expect(t.chrome.runtime.sendMessage.calls).toHaveLength(0);
  });

  it("reconnects ui:reader after the SW goes away", async () => {
    const t = setupReader();
    await flush();
    t.ui().disconnect();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await flush();
    expect(t.serverPorts[PORTS.UI_READER]).toHaveLength(2);
  });
});

describe("offscreen host", () => {
  it("wires the engine to host:offscreen", async () => {
    const chrome = createFakeChrome();
    const ports = [];
    chrome.runtime.onConnect.addListener((port) => ports.push(port));
    const Context = makeContextClass();
    const { engine } = startOffscreenHost({
      connect: (info) => chrome.runtime.connect(info),
      engineOptions: {
        fetchImpl: async () => v2Response(v2Frames("Hello.")),
        audioContextFactory: () => new Context(),
      },
    });
    await flush();
    expect(ports[0].name).toBe(PORTS.HOST_OFFSCREEN);
    expect(ports[0].received[0]).toEqual({ type: MSG.HOST_HELLO, kind: "offscreen", activeRun: null });
    ports[0].postMessage({ ...speak("r1"), run: { runId: "r1", source: "popup", sourceTabId: 1, sourceFrameId: 0 } });
    await flush(100);
    expect(engine.activeRun()).toMatchObject({ runId: "r1" });
    ports[0].postMessage({ type: MSG.HOST_STOP, runId: "r1", outcome: "superseded" });
    await flush();
    expect(ports[0].received.at(-1)).toMatchObject({ type: MSG.DONE, runId: "r1", outcome: "superseded" });
    expect(chrome.runtime.sendMessage.calls).toHaveLength(0);
  });
});

describe("keep-alive", () => {
  it("holds one Web Lock until released", async () => {
    const requests = [];
    const locks = {
      request(name, callback) {
        const done = callback();
        requests.push({ name, done });
        return done;
      },
    };
    const keepAlive = createKeepAlive(locks);
    keepAlive.hold();
    keepAlive.hold();
    expect(requests).toHaveLength(1);
    expect(requests[0].name).toBe(KEEP_ALIVE_LOCK);
    expect(keepAlive.held).toBe(true);
    let released = false;
    requests[0].done.then(() => {
      released = true;
    });
    keepAlive.release();
    await flush();
    expect(released).toBe(true);
    expect(keepAlive.held).toBe(false);
  });

  it("is a no-op without navigator.locks", () => {
    const keepAlive = createKeepAlive(undefined);
    keepAlive.hold();
    keepAlive.release();
    expect(keepAlive.held).toBe(false);
  });
});

describe("host pages (static)", () => {
  const read = (name) => readFileSync(new URL(`../host/${name}`, import.meta.url), "utf8");

  it.each(["reader.html", "offscreen.html"])("%s has no inline scripts, styles or handlers (CSP)", (name) => {
    const html = read(name);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBe(1);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/type="module"/);
      expect(attributes).toMatch(/src="[a-z-]+\.js"/);
      expect(body.trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(html).not.toMatch(/-umd\.js/);
  });

  it("reader.html has every element the view writes to and ports the v3 text", () => {
    const html = read("reader.html");
    for (const id of IDS) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("Open TTS Reader");
    expect(html).toContain("Retry from interrupted passage");
    expect(html).toContain("Keep this tab open while listening.");
    expect(html).toContain("Local timing diagnostics");
  });

  it("reader.css honours reduced motion and keyboard focus", () => {
    const css = read("reader.css");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/\[hidden\]/);
  });
});
