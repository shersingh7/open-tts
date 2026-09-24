import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent, createFakeChrome, createPortPair, FAKE_EXTENSION_ID, flush } from "./helpers/fake-chrome.js";

afterEach(() => vi.useRealTimers());

describe("createPortPair", () => {
  it("delivers messages asynchronously, in order, JSON-cloned", async () => {
    const { client, server } = createPortPair("ui:popup");
    const seen = [];
    server.onMessage.addListener((message, port) => seen.push([message, port === server]));
    const payload = { type: "SPEAK", n: 1 };
    client.postMessage(payload);
    client.postMessage({ type: "STOP", n: 2 });
    payload.n = 99;
    expect(seen).toEqual([]);
    await flush();
    expect(seen).toEqual([[{ type: "SPEAK", n: 1 }, true], [{ type: "STOP", n: 2 }, true]]);
    expect(server.received).toEqual([{ type: "SPEAK", n: 1 }, { type: "STOP", n: 2 }]);
    expect(client.received).toEqual([]);
  });

  it("gives the server end the configured sender and the client end none", () => {
    const sender = { tab: { id: 5 }, frameId: 2, url: "https://example.com/" };
    const { client, server } = createPortPair("ui:content", sender);
    expect(server.sender).toEqual(sender);
    expect(client.sender).toBeUndefined();
    expect(client.name).toBe("ui:content");
    expect(server.name).toBe("ui:content");
    expect(createPortPair("x").server.sender).toEqual({ id: FAKE_EXTENSION_ID });
  });

  it("disconnect fires onDisconnect on the other side only", async () => {
    const { client, server } = createPortPair("host:reader");
    const clientEvents = [];
    const serverEvents = [];
    client.onDisconnect.addListener((port) => clientEvents.push(port));
    server.onDisconnect.addListener((port) => serverEvents.push(port));
    server.disconnect();
    await flush();
    expect(clientEvents).toEqual([client]);
    expect(serverEvents).toEqual([]);
    expect(client.connected).toBe(false);
    expect(server.connected).toBe(false);
    server.disconnect();
    client.disconnect();
    await flush();
    expect(clientEvents).toHaveLength(1);
    expect(serverEvents).toHaveLength(0);
  });

  it("delivers messages posted before a disconnect, then the peer's onDisconnect", async () => {
    const { client, server } = createPortPair("host:offscreen");
    const order = [];
    server.onMessage.addListener((message) => order.push(message.type));
    server.onDisconnect.addListener(() => order.push("disconnect"));
    client.postMessage({ type: "DONE" });
    client.disconnect();
    await flush();
    expect(order).toEqual(["DONE", "disconnect"]);
  });

  it("drops messages to a port that disconnected itself and throws on posting after disconnect", async () => {
    const { client, server } = createPortPair("ui:popup");
    const got = [];
    client.onMessage.addListener((message) => got.push(message));
    server.postMessage({ type: "SESSION" });
    client.disconnect();
    await flush();
    expect(got).toEqual([]);
    expect(() => server.postMessage({ type: "SESSION" })).toThrow("Attempting to use a disconnected port object");
    expect(() => client.postMessage({ type: "STOP" })).toThrow("Attempting to use a disconnected port object");
  });

  it("records postMessage and disconnect calls", () => {
    const { client } = createPortPair("ui:popup");
    client.postMessage({ type: "PAUSE" });
    client.disconnect();
    expect(client.postMessage.calls).toEqual([[{ type: "PAUSE" }]]);
    expect(client.disconnect.calls).toEqual([[]]);
  });
});

describe("createEvent", () => {
  it("adds, removes, reports and dispatches listeners", () => {
    const event = createEvent();
    const a = vi.fn(() => "a");
    const b = vi.fn(() => "b");
    event.addListener(a);
    event.addListener(a);
    event.addListener(b);
    expect(event.hasListener(a)).toBe(true);
    expect(event.dispatch(1, 2)).toEqual(["a", "b"]);
    expect(a).toHaveBeenCalledTimes(1);
    event.removeListener(a);
    expect(event.dispatch()).toEqual(["b"]);
    event.removeListener(b);
    expect(event.hasListeners()).toBe(false);
  });
});

describe("runtime", () => {
  it("connect returns the client and dispatches the server end to onConnect with the default sender", async () => {
    const chrome = createFakeChrome({ sender: { id: "ext", url: "chrome-extension://ext/ui/popup.html" } });
    const connected = [];
    chrome.runtime.onConnect.addListener((port) => {
      connected.push(port);
      port.onMessage.addListener((message) => port.postMessage({ echo: message }));
    });
    const client = chrome.runtime.connect({ name: "ui:popup" });
    client.postMessage({ type: "GET_MODELS" });
    expect(connected).toEqual([]);
    await flush();
    expect(connected).toHaveLength(1);
    expect(connected[0].name).toBe("ui:popup");
    expect(connected[0].sender).toEqual({ id: "ext", url: "chrome-extension://ext/ui/popup.html" });
    expect(client.received).toEqual([{ echo: { type: "GET_MODELS" } }]);
    expect(chrome.runtime.connect.calls).toEqual([[{ name: "ui:popup" }]]);
    expect(chrome.fake.clientPorts).toEqual([client]);
    expect(chrome.fake.serverPorts).toEqual(connected);
  });

  it("fake.connect simulates other contexts with their own sender; default sender is configurable", async () => {
    const chrome = createFakeChrome();
    const senders = [];
    chrome.runtime.onConnect.addListener((port) => senders.push([port.name, port.sender]));
    chrome.fake.connect("ui:content", { tab: { id: 7 }, frameId: 3 });
    chrome.fake.sender = { url: "chrome-extension://x/host/reader.html", tab: { id: 9 } };
    chrome.runtime.connect({ name: "host:reader" });
    await flush();
    expect(senders).toEqual([
      ["ui:content", { tab: { id: 7 }, frameId: 3 }],
      ["host:reader", { url: "chrome-extension://x/host/reader.html", tab: { id: 9 } }],
    ]);
  });

  it("server-side disconnect reaches the connecting context", async () => {
    const chrome = createFakeChrome();
    const client = chrome.runtime.connect({ name: "host:offscreen" });
    const lost = vi.fn();
    client.onDisconnect.addListener(lost);
    await flush();
    chrome.fake.serverPorts[0].disconnect();
    await flush();
    expect(lost).toHaveBeenCalledWith(client);
  });

  it("getURL, getManifest and id", () => {
    const chrome = createFakeChrome({ manifest: { version: "9.9.9" } });
    expect(chrome.runtime.id).toBe(FAKE_EXTENSION_ID);
    expect(chrome.runtime.getURL("/host/reader.html")).toBe(`chrome-extension://${FAKE_EXTENSION_ID}/host/reader.html`);
    expect(chrome.runtime.getManifest().version).toBe("9.9.9");
    expect(createFakeChrome().runtime.getManifest().manifest_version).toBe(3);
  });

  it("sendNativeMessage rejects by default and is scriptable via impl (promise and callback forms)", async () => {
    const chrome = createFakeChrome();
    await expect(chrome.runtime.sendNativeMessage("com.open_tts.native_host", { command: "status" }))
      .rejects.toThrow("Specified native messaging host not found.");
    chrome.runtime.sendNativeMessage.impl = (host, message) => ({ success: true, host, echo: message.command });
    await expect(chrome.runtime.sendNativeMessage("h", { command: "start" }))
      .resolves.toEqual({ success: true, host: "h", echo: "start" });
    const response = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage("h", { command: "stop" }, (value) => {
        resolve([value, chrome.runtime.lastError]);
      });
    });
    expect(response).toEqual([{ success: true, host: "h", echo: "stop" }, undefined]);
    expect(chrome.runtime.sendNativeMessage.calls).toEqual([
      ["com.open_tts.native_host", { command: "status" }], ["h", { command: "start" }], ["h", { command: "stop" }],
    ]);
  });

  it("sets lastError only during the failing callback", async () => {
    const chrome = createFakeChrome();
    const seen = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage("h", {}, (value) => resolve([value, chrome.runtime.lastError?.message]));
    });
    expect(seen).toEqual([undefined, "Specified native messaging host not found."]);
    expect(chrome.runtime.lastError).toBeUndefined();
  });

  it("runtime.sendMessage exists only to prove it is unused", async () => {
    const chrome = createFakeChrome();
    await expect(chrome.runtime.sendMessage({})).rejects.toThrow(/Receiving end does not exist/);
    expect(chrome.runtime.sendMessage.calls).toHaveLength(1);
  });

  it("onInstalled and onStartup dispatch to listeners", () => {
    const chrome = createFakeChrome();
    const installed = vi.fn();
    chrome.runtime.onInstalled.addListener(installed);
    chrome.runtime.onInstalled.dispatch({ reason: "install" });
    expect(installed).toHaveBeenCalledWith({ reason: "install" });
    expect(chrome.runtime.onStartup.hasListeners()).toBe(false);
  });

  it("getContexts reflects offscreen documents and extension tabs, with filters", async () => {
    const chrome = createFakeChrome();
    const readerUrl = chrome.runtime.getURL("host/reader.html");
    await chrome.offscreen.createDocument({ url: "host/offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "x" });
    const tab = await chrome.tabs.create({ url: readerUrl, active: true });
    await chrome.tabs.create({ url: "https://example.com/" });
    expect((await chrome.runtime.getContexts({})).map((context) => context.contextType))
      .toEqual(["OFFSCREEN_DOCUMENT", "TAB"]);
    expect(await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [readerUrl] }))
      .toEqual([expect.objectContaining({ tabId: tab.id, documentUrl: readerUrl })]);
    await chrome.tabs.remove(tab.id);
    await chrome.offscreen.closeDocument();
    expect(await chrome.runtime.getContexts({})).toEqual([]);
  });

  it("fake.sendRuntimeMessage delivers one-shot messages with sync and async responses", async () => {
    const chrome = createFakeChrome();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "CONTENT_GET_HOST") sendResponse({ host: "example.com" });
      if (message.type === "CONTENT_GET_SELECTION") {
        queueMicrotask(() => sendResponse({ text: "later" }));
        return true;
      }
      return false;
    });
    expect(await chrome.fake.sendRuntimeMessage({ type: "CONTENT_GET_HOST" })).toEqual({ host: "example.com" });
    expect(await chrome.fake.sendRuntimeMessage({ type: "CONTENT_GET_SELECTION" })).toEqual({ text: "later" });
    expect(await chrome.fake.sendRuntimeMessage({ type: "OTHER" })).toBeUndefined();
  });
});

describe("storage", () => {
  it("supports callback and promise forms with Chrome key semantics", async () => {
    const chrome = createFakeChrome({ storage: { sync: { speed: 2, voice: "ryan" } } });
    expect(await chrome.storage.sync.get(null)).toEqual({ speed: 2, voice: "ryan" });
    expect(await chrome.storage.sync.get("speed")).toEqual({ speed: 2 });
    expect(await chrome.storage.sync.get(["voice", "missing"])).toEqual({ voice: "ryan" });
    expect(await chrome.storage.sync.get({ speed: 1, model: "kokoro" })).toEqual({ speed: 2, model: "kokoro" });
    await new Promise((resolve) => chrome.storage.local.set({ ttsHistory: [1] }, resolve));
    const viaCallback = await new Promise((resolve) => chrome.storage.local.get(["ttsHistory"], resolve));
    expect(viaCallback).toEqual({ ttsHistory: [1] });
    await chrome.storage.local.remove("ttsHistory");
    expect(chrome.fake.storageData.local).toEqual({});
    await chrome.storage.sync.clear();
    expect(chrome.fake.storageData.sync).toEqual({});
  });

  it("clones values in and out", async () => {
    const chrome = createFakeChrome();
    const value = { list: [1] };
    await chrome.storage.session.set({ v4Session: value });
    value.list.push(2);
    const read = await chrome.storage.session.get("v4Session");
    read.v4Session.list.push(3);
    expect(chrome.fake.storageData.session.v4Session).toEqual({ list: [1] });
  });

  it("fires storage.onChanged and area onChanged on set and remove", async () => {
    const chrome = createFakeChrome({ storage: { sync: { hiddenSites: ["a.com"] } } });
    const global = [];
    const area = [];
    chrome.storage.onChanged.addListener((changes, areaName) => global.push([changes, areaName]));
    chrome.storage.sync.onChanged.addListener((changes) => area.push(changes));
    await chrome.storage.sync.set({ hiddenSites: ["a.com", "b.com"], speed: 2 });
    await chrome.storage.sync.remove(["speed", "never-set"]);
    await flush();
    expect(global).toEqual([
      [{ hiddenSites: { oldValue: ["a.com"], newValue: ["a.com", "b.com"] }, speed: { newValue: 2 } }, "sync"],
      [{ speed: { oldValue: 2 } }, "sync"],
    ]);
    expect(area).toEqual(global.map(([changes]) => changes));
  });

  it("failNext rejects the promise form and sets lastError for the callback form, without writing", async () => {
    const chrome = createFakeChrome();
    chrome.fake.failNext("storage.local.set", "QUOTA_BYTES quota exceeded");
    await expect(chrome.storage.local.set({ a: 1 })).rejects.toThrow("QUOTA_BYTES quota exceeded");
    chrome.fake.failNext("storage.local.set", "second");
    const error = await new Promise((resolve) => {
      chrome.storage.local.set({ b: 2 }, () => resolve(chrome.runtime.lastError?.message));
    });
    expect(error).toBe("second");
    expect(chrome.runtime.lastError).toBeUndefined();
    expect(chrome.fake.storageData.local).toEqual({});
    await chrome.storage.local.set({ c: 3 });
    expect(chrome.fake.storageData.local).toEqual({ c: 3 });
  });

  it("storage.session.setAccessLevel is a spy that records the level", async () => {
    const chrome = createFakeChrome();
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(chrome.storage.session.setAccessLevel.calls).toEqual([[{ accessLevel: "TRUSTED_CONTEXTS" }]]);
    expect(chrome.storage.session.accessLevel).toBe("TRUSTED_CONTEXTS");
    expect(chrome.storage.local.setAccessLevel).toBeUndefined();
  });

  it("works with vitest fake timers", async () => {
    vi.useFakeTimers();
    const chrome = createFakeChrome();
    await chrome.storage.local.set({ a: 1 });
    const { client, server } = createPortPair("ui:popup");
    client.postMessage({ type: "STOP" });
    await flush();
    expect(server.received).toEqual([{ type: "STOP" }]);
    expect(await chrome.storage.local.get("a")).toEqual({ a: 1 });
  });
});

describe("tabs", () => {
  it("create, update, get, query and remove with onRemoved", async () => {
    const chrome = createFakeChrome();
    const removed = vi.fn();
    chrome.tabs.onRemoved.addListener(removed);
    const tab = await chrome.tabs.create({ url: "https://example.com/", active: true });
    expect(tab).toEqual(expect.objectContaining({ id: 100, url: "https://example.com/", active: true }));
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    expect((await chrome.tabs.get(tab.id)).autoDiscardable).toBe(false);
    chrome.fake.addTab({ id: 5, url: "https://other.test/", active: false });
    expect((await chrome.tabs.query({ active: true, currentWindow: true })).map((t) => t.id)).toEqual([100]);
    await chrome.tabs.remove(tab.id);
    expect(removed).toHaveBeenCalledWith(100, { windowId: 1, isWindowClosing: false });
    await expect(chrome.tabs.get(100)).rejects.toThrow("No tab with id: 100.");
    await expect(chrome.tabs.update(100, {})).rejects.toThrow("No tab with id: 100.");
  });

  it("tabs.sendMessage rejects by default and is scriptable via impl", async () => {
    const chrome = createFakeChrome();
    await expect(chrome.tabs.sendMessage(5, { type: "CONTENT_GET_SELECTION" }))
      .rejects.toThrow("Could not establish connection. Receiving end does not exist.");
    chrome.tabs.sendMessage.impl = async (tabId, message, options) => ({ tabId, type: message.type, options });
    expect(await chrome.tabs.sendMessage(5, { type: "CONTENT_GET_HOST" }, { frameId: 0 }))
      .toEqual({ tabId: 5, type: "CONTENT_GET_HOST", options: { frameId: 0 } });
    expect(chrome.tabs.sendMessage.calls).toHaveLength(2);
  });
});

describe("offscreen, contextMenus, commands, action", () => {
  it("offscreen documents are single and closable", async () => {
    const chrome = createFakeChrome();
    expect(await chrome.offscreen.hasDocument()).toBe(false);
    await chrome.offscreen.createDocument({ url: "host/offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "x" });
    expect(await chrome.offscreen.hasDocument()).toBe(true);
    await expect(chrome.offscreen.createDocument({ url: "host/offscreen.html" }))
      .rejects.toThrow("Only a single offscreen document may be created.");
    await chrome.offscreen.closeDocument();
    await expect(chrome.offscreen.closeDocument()).rejects.toThrow("No current offscreen document.");
    expect(chrome.offscreen.createDocument.calls).toHaveLength(2);
  });

  it("contextMenus.create records menus, reports duplicates via lastError; removeAll clears", async () => {
    const chrome = createFakeChrome();
    const props = { id: "open-tts-read", title: "Read with Open TTS", contexts: ["selection"] };
    expect(chrome.contextMenus.create(props)).toBe("open-tts-read");
    const duplicateError = await new Promise((resolve) => {
      chrome.contextMenus.create(props, () => resolve(chrome.runtime.lastError?.message));
    });
    expect(duplicateError).toBe("Cannot create item with duplicate id open-tts-read");
    expect(chrome.fake.menus.get("open-tts-read")).toEqual(props);
    await chrome.contextMenus.removeAll();
    expect(chrome.fake.menus.size).toBe(0);
    const clicked = vi.fn();
    chrome.contextMenus.onClicked.addListener(clicked);
    chrome.contextMenus.onClicked.dispatch({ menuItemId: "open-tts-read", selectionText: "Hi", frameId: 2 }, { id: 5 });
    expect(clicked).toHaveBeenCalledWith({ menuItemId: "open-tts-read", selectionText: "Hi", frameId: 2 }, { id: 5 });
  });

  it("commands.onCommand dispatches and action setters are recorded spies", async () => {
    const chrome = createFakeChrome();
    const onCommand = vi.fn();
    chrome.commands.onCommand.addListener(onCommand);
    chrome.commands.onCommand.dispatch("read-selection", { id: 5 });
    expect(onCommand).toHaveBeenCalledWith("read-selection", { id: 5 });
    await chrome.action.setBadgeText({ tabId: 5, text: "?" });
    await chrome.action.setTitle({ tabId: 5, title: "Use right-click → Read with Open TTS" });
    expect(chrome.action.setBadgeText.calls).toEqual([[{ tabId: 5, text: "?" }]]);
    expect(chrome.action.setTitle.calls[0][0].title).toMatch(/right-click/);
  });
});

describe("call log", () => {
  it("records every API call in order", async () => {
    const chrome = createFakeChrome();
    await chrome.storage.local.set({ a: 1 });
    const client = chrome.runtime.connect({ name: "ui:popup" });
    client.postMessage({ type: "STOP" });
    await chrome.action.setBadgeText({ text: "" });
    expect(chrome.fake.log.map((entry) => entry.api)).toEqual([
      "storage.local.set", "runtime.connect", "port[ui:popup].postMessage", "action.setBadgeText",
    ]);
  });
});
