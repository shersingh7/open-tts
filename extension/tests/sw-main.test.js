import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, FAKE_EXTENSION_ID, flush } from "./helpers/fake-chrome.js";
import { startServiceWorker } from "../sw/main.js";
import { MENU_ID } from "../sw/menus.js";
import { MSG } from "../shared/messages.js";

const settle = () => flush(600);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch() {
  return vi.fn(async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/health") {
      return json({ status: "ok", engine: "open-tts", version: "4.0.0", model: "kokoro", model_loaded: true,
        model_warm: true, state: "ready" });
    }
    if (pathname === "/v1/capabilities") return json({ engine: "open-tts", protocol_versions: [1, 2] });
    return json({ detail: "not found" }, 404);
  });
}

/** Fake chrome whose offscreen document connects a host port and says HOST_HELLO, like host/offscreen.js. */
function chromeWithHosts(storage) {
  const chrome = createFakeChrome({ storage });
  const hostPorts = [];
  const createDocument = chrome.offscreen.createDocument.impl;
  chrome.offscreen.createDocument.impl = (params) => {
    createDocument(params);
    queueMicrotask(() => {
      const port = chrome.fake.connect("host:offscreen",
        { id: FAKE_EXTENSION_ID, url: chrome.runtime.getURL("host/offscreen.html") });
      port.postMessage({ type: MSG.HOST_HELLO, kind: "offscreen", activeRun: null });
      hostPorts.push(port);
    });
  };
  chrome.runtime.sendNativeMessage.impl = (host, message) => (message.command === "status"
    ? { success: true, running: true, install_token: "native-token" }
    : { success: true });
  return { chrome, hostPorts };
}

describe("sw/main — top level", () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.resetModules();
  });

  it("registers every listener synchronously when the module evaluates, and hardens the token", async () => {
    const chrome = createFakeChrome({ storage: { local: { installToken: "v3-token", speed: 2 } } });
    chrome.storage.session.accessLevel = "TRUSTED_AND_UNTRUSTED_CONTEXTS";
    globalThis.chrome = chrome;
    vi.resetModules();
    await import("../sw/main.js");
    expect(chrome.runtime.onConnect.hasListeners()).toBe(true);
    expect(chrome.runtime.onInstalled.hasListeners()).toBe(true);
    expect(chrome.contextMenus.onClicked.hasListeners()).toBe(true);
    expect(chrome.commands.onCommand.hasListeners()).toBe(true);
    expect(chrome.tabs.onRemoved.hasListeners()).toBe(true);
    await settle();
    expect(chrome.storage.session.accessLevel).toBe("TRUSTED_CONTEXTS");
    expect(chrome.fake.storageData.local).toEqual({ speed: 2 });
  });
});

describe("sw/main — integration with fake chrome", () => {
  let chrome;
  let hostPorts;
  beforeEach(() => {
    ({ chrome, hostPorts } = chromeWithHosts({ sync: { model: "kokoro", speed: 2 }, local: { historyEnabled: true } }));
    globalThis.chrome = chrome;
  });
  afterEach(() => {
    delete globalThis.chrome;
  });

  it("popup SPEAK → offscreen host gets HOST_SPEAK with settings from storage and the session token", async () => {
    startServiceWorker(chrome, { fetchImpl: fakeFetch() });
    const popup = chrome.runtime.connect({ name: "ui:popup" });
    popup.postMessage({ type: MSG.SPEAK, runId: "p1", text: "Hello from the popup", requestId: "a" });
    await settle();
    expect(chrome.offscreen.createDocument.calls[0][0]).toMatchObject({ url: "host/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"] });
    const speak = hostPorts[0].received.find((m) => m.type === MSG.HOST_SPEAK);
    expect(speak).toMatchObject({
      run: { runId: "p1", source: "popup" },
      settings: { model: "kokoro", voice: "af_bella", speed: 2, language: "Auto", instruct: "" },
      authToken: "native-token",
      protocolVersion: 2,
    });
    expect(chrome.fake.storageData.local.installToken).toBeUndefined();
    expect(chrome.runtime.sendMessage.calls).toHaveLength(0);

    hostPorts[0].postMessage({ type: MSG.DONE, runId: "p1", outcome: "completed", metrics: {} });
    await settle();
    const [entry] = chrome.fake.storageData.local.ttsHistory;
    expect(entry).toMatchObject({ id: "p1", text: "Hello from the popup", chars: 20, truncated: false, speed: 2 });
    const sessions = popup.received.filter((m) => m.type === MSG.SESSION);
    expect(sessions.at(-1).session).toMatchObject({ state: "idle", outcome: "completed" });
  });

  it("history write failure is published as HISTORY_ERROR", async () => {
    startServiceWorker(chrome, { fetchImpl: fakeFetch() });
    const popup = chrome.runtime.connect({ name: "ui:popup" });
    popup.postMessage({ type: MSG.SPEAK, runId: "p2", text: "Hi", requestId: "a" });
    await settle();
    chrome.fake.failNext("storage.local.set", "QUOTA_BYTES quota exceeded");
    hostPorts[0].postMessage({ type: MSG.DONE, runId: "p2", outcome: "completed", metrics: {} });
    await settle();
    const errors = popup.received.filter((m) => m.type === MSG.HISTORY_ERROR);
    expect(errors).toEqual([{ type: MSG.HISTORY_ERROR, runId: "p2",
      message: "Audio completed, but history could not be saved: QUOTA_BYTES quota exceeded" }]);
  });

  it("onInstalled creates the menu; a menu click starts a run the tab's widget can control", async () => {
    startServiceWorker(chrome, { fetchImpl: fakeFetch() });
    chrome.runtime.onInstalled.dispatch({ reason: "install" });
    await settle();
    expect(chrome.fake.menus.has(MENU_ID)).toBe(true);
    chrome.contextMenus.onClicked.dispatch({ menuItemId: MENU_ID, selectionText: "PDF words", frameId: 0 }, { id: 31 });
    await settle();
    const widget = chrome.fake.connect("ui:content", { tab: { id: 31 }, frameId: 0, url: "https://example.com/" });
    await settle();
    const snapshot = widget.received.find((m) => m.type === MSG.SESSION);
    expect(snapshot).toMatchObject({ session: { source: "menu", sourceTabId: 31 }, controllable: true });
    widget.postMessage({ type: MSG.STOP, runId: snapshot.session.runId, requestId: "s" });
    await settle();
    expect(widget.received.find((m) => m.type === MSG.REPLY)).toMatchObject({ ok: true });
  });

  it("keyboard read-selection with no content script shows the badge hint", async () => {
    startServiceWorker(chrome, { fetchImpl: fakeFetch() });
    chrome.commands.onCommand.dispatch("read-selection", { id: 9 });
    await settle();
    expect(chrome.action.setBadgeText.calls[0]).toEqual([{ tabId: 9, text: "?" }]);
    expect(chrome.offscreen.createDocument.calls).toHaveLength(0);
  });

  it("server offline and no native host → the run fails with a clear message", async () => {
    chrome.runtime.sendNativeMessage.impl = () => {
      throw new Error("Specified native messaging host not found.");
    };
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    startServiceWorker(chrome, { fetchImpl: offline });
    const popup = chrome.runtime.connect({ name: "ui:popup" });
    popup.postMessage({ type: MSG.SPEAK, runId: "p3", text: "Hi", requestId: "a" });
    await settle();
    const last = popup.received.filter((m) => m.type === MSG.SESSION).at(-1);
    expect(last.session).toMatchObject({ runId: "p3", state: "idle", outcome: "failed" });
    expect(last.session.error.message).toMatch(/Could not start the server/);
    expect(popup.received.filter((m) => m.type === MSG.SERVER_STATE).at(-1)).toMatchObject({ state: "failed" });
  });
});
