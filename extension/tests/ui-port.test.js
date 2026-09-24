import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, flush } from "./helpers/fake-chrome.js";
import { connectUi } from "../ui/ui-port.js";
import { MSG } from "../shared/messages.js";

/** Wires a minimal fake SW: posts SESSION + SERVER_STATE on connect, forwards commands to `onCommand`. */
function setupSw(chrome, { onCommand } = {}) {
  chrome.runtime.onConnect.addListener((port) => {
    port.postMessage({ type: MSG.SESSION, session: { runId: null, revision: 1 } });
    port.postMessage({ type: MSG.SERVER_STATE, state: "offline", message: "Server offline" });
    port.onMessage.addListener((msg) => onCommand?.(msg, port));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("connectUi", () => {
  it("delivers every non-REPLY message to onSnapshot, in order", async () => {
    const chrome = createFakeChrome();
    setupSw(chrome);
    const snapshots = [];
    connectUi({ name: "ui:popup", onSnapshot: (m) => snapshots.push(m), connect: chrome.runtime.connect });
    await flush();
    expect(snapshots.map((s) => s.type)).toEqual([MSG.SESSION, MSG.SERVER_STATE]);
  });

  it("send() posts the command with no requestId attached", async () => {
    const chrome = createFakeChrome();
    const received = [];
    setupSw(chrome, { onCommand: (m) => received.push(m) });
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    ui.send({ type: MSG.PAUSE, runId: "r1" });
    await flush();
    expect(received).toEqual([{ type: MSG.PAUSE, runId: "r1" }]);
  });

  it("request() resolves with data from a matching ok:true REPLY", async () => {
    const chrome = createFakeChrome();
    setupSw(chrome, {
      onCommand: (m, port) => {
        if (m.type === MSG.GET_MODELS) {
          expect(typeof m.requestId).toBe("string");
          port.postMessage({ type: MSG.REPLY, requestId: m.requestId, ok: true, data: { models: [] } });
        }
      },
    });
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    await expect(ui.request({ type: MSG.GET_MODELS })).resolves.toEqual({ models: [] });
  });

  it("request() rejects with the message/code from an ok:false REPLY", async () => {
    const chrome = createFakeChrome();
    setupSw(chrome, {
      onCommand: (m, port) => {
        port.postMessage({ type: MSG.REPLY, requestId: m.requestId, ok: false, error: "Nope", code: "bad" });
      },
    });
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    await expect(ui.request({ type: MSG.SPEAK, runId: "r1", text: "hi" })).rejects.toMatchObject({
      message: "Nope",
      code: "bad",
    });
  });

  it("request() times out after 15s by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chrome = createFakeChrome();
    setupSw(chrome); // never replies to commands
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    const promise = ui.request({ type: MSG.STOP, runId: "r1" });
    const assertion = expect(promise).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });

  it("request() allows 330s for LOAD_MODEL before timing out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chrome = createFakeChrome();
    setupSw(chrome); // never replies
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    const promise = ui.request({ type: MSG.LOAD_MODEL, modelId: "kokoro" });
    let settled = false;
    promise.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(329000);
    expect(settled).toBe(false);
    const assertion = expect(promise).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("reconnects after a disconnect and re-renders from the new snapshot", async () => {
    const chrome = createFakeChrome();
    setupSw(chrome);
    const snapshots = [];
    connectUi({ name: "ui:popup", onSnapshot: (m) => snapshots.push(m), connect: chrome.runtime.connect });
    await flush();
    expect(chrome.fake.serverPorts).toHaveLength(1);

    chrome.fake.serverPorts[0].disconnect();
    await flush();

    expect(chrome.fake.serverPorts).toHaveLength(2);
    expect(snapshots.map((s) => s.type)).toEqual([MSG.SESSION, MSG.SERVER_STATE, MSG.SESSION, MSG.SERVER_STATE]);
  });

  it("rejects in-flight requests when the port disconnects", async () => {
    const chrome = createFakeChrome();
    setupSw(chrome); // never replies
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    const promise = ui.request({ type: MSG.GET_MODELS });
    chrome.fake.serverPorts[0].disconnect();
    await expect(promise).rejects.toThrow("Disconnected");
  });

  it("close() disconnects and stops reconnecting", async () => {
    const chrome = createFakeChrome();
    setupSw(chrome);
    const ui = connectUi({ name: "ui:popup", onSnapshot: () => {}, connect: chrome.runtime.connect });
    await flush();
    ui.close();
    await flush();
    expect(chrome.fake.serverPorts).toHaveLength(1);
    expect(chrome.fake.serverPorts[0].connected).toBe(false);
  });
});
