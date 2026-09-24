import vm from "node:vm";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flush } from "./helpers/fake-chrome.js";

const CONTENT_SRC = readFileSync(new URL("../content/content.js", import.meta.url), "utf8");

function makeFakeElement(tag) {
  const listeners = {};
  const el = {
    tagName: tag,
    id: "",
    hidden: false,
    dataset: {},
    style: {},
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    offsetWidth: 100,
    offsetHeight: 40,
    children: [],
    _shadow: null,
    setAttribute(name, value) {
      this.dataset[`attr:${name}`] = value;
    },
    getAttribute(name) {
      return this.dataset[`attr:${name}`] ?? null;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event = { preventDefault() {}, stopPropagation() {} }) {
      [...(listeners[type] || [])].forEach((fn) => fn(event));
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...items) {
      items.forEach((item) => this.appendChild(item));
    },
    attachShadow() {
      const shadow = {
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        append(...items) {
          items.forEach((item) => this.appendChild(item));
        },
      };
      el._shadow = shadow;
      return shadow;
    },
    querySelectorAll: () => [],
  };
  return el;
}

/**
 * Builds a fresh vm sandbox, loads content.js into it, and returns helpers for driving/inspecting it.
 * Mirrors the style of the v3 `extension/tests/content.test.js` harness.
 */
function contentHarness({ hiddenSites = [], topFrame = true } = {}) {
  let selectionText = "";
  let selectionRect = { top: 100, left: 100, width: 50, height: 20 };

  const documentElementChildren = [];
  const documentElement = {
    clientWidth: 1000,
    clientHeight: 800,
    appendChild(child) {
      documentElementChildren.push(child);
      return child;
    },
  };
  const docListeners = {};
  const document = {
    documentElement,
    querySelectorAll: () => [],
    createElement: (tag) => makeFakeElement(tag),
    addEventListener(type, fn) {
      (docListeners[type] ||= []).push(fn);
    },
    dispatch(type, event) {
      [...(docListeners[type] || [])].forEach((fn) => fn(event));
    },
  };

  const windowObj = {
    scrollX: 0,
    scrollY: 0,
    getSelection: () => ({
      toString: () => selectionText,
      rangeCount: selectionText ? 1 : 0,
      getRangeAt: () => ({ getBoundingClientRect: () => selectionRect }),
    }),
  };
  windowObj.top = topFrame ? windowObj : {};

  let connectCalls = 0;
  const sentToSw = [];
  let portListeners = { message: [], disconnect: [] };
  let onMessageListener;
  const storageChangeListeners = [];

  const chrome = {
    runtime: {
      lastError: undefined,
      connect: () => {
        connectCalls += 1;
        portListeners = { message: [], disconnect: [] };
        return {
          postMessage: (msg) => sentToSw.push(msg),
          onMessage: { addListener: (fn) => portListeners.message.push(fn) },
          onDisconnect: { addListener: (fn) => portListeners.disconnect.push(fn) },
        };
      },
      onMessage: { addListener: (fn) => { onMessageListener = fn; } },
    },
    storage: {
      sync: {
        get(_keys, cb) {
          cb({ hiddenSites });
        },
      },
      onChanged: { addListener: (fn) => storageChangeListeners.push(fn) },
    },
  };

  const context = vm.createContext({
    console,
    setTimeout: () => 1,
    clearTimeout() {},
    Math,
    Date,
    document,
    window: windowObj,
    location: { hostname: "example.com" },
    chrome,
  });
  vm.runInContext(CONTENT_SRC, context);

  function widgetHost() {
    return documentElementChildren.find((c) => c.tagName === "open-tts-widget");
  }
  function inShadow(id) {
    const h = widgetHost();
    return h?._shadow?.children.find((c) => c.id === id);
  }
  function lastSent(type) {
    return [...sentToSw].reverse().find((m) => m.type === type);
  }

  return {
    sentToSw,
    connectCalls: () => connectCalls,
    widgetHost,
    primaryBtn: () => inShadow("primary"),
    readBtn: () => inShadow("read"),
    stopBtn: () => inShadow("stop"),
    labelSpan: () => inShadow("label"),
    setSelection(text, rect) {
      selectionText = text;
      if (rect) selectionRect = rect;
    },
    mouseup() {
      document.dispatch("mouseup");
    },
    mousedownOutside() {
      document.dispatch("mousedown", { target: {} });
    },
    async click(el) {
      el.dispatch("click");
      await flush();
    },
    deliverSession(session, controllable = true) {
      portListeners.message.forEach((fn) => fn({ type: "SESSION", session, controllable }));
    },
    async deliverReply(type, payload) {
      const sent = lastSent(type);
      expect(sent, `a ${type} message should have been sent`).toBeTruthy();
      portListeners.message.forEach((fn) => fn({ type: "REPLY", requestId: sent.requestId, ...payload }));
      await flush();
      return sent;
    },
    lastSent,
    sendOneShot(msg) {
      let response;
      let responded = false;
      onMessageListener(msg, {}, (resp) => {
        response = resp;
        responded = true;
      });
      return { response, responded };
    },
  };
}

describe("content script behaviour", () => {
  it("does not connect the port before a user action (lazy port)", async () => {
    const h = contentHarness();
    h.setSelection("Hello world");
    h.mouseup();
    await flush();
    expect(h.widgetHost()).toBeTruthy();
    expect(h.connectCalls()).toBe(0);
  });

  it("connects the port only once the user clicks Speak", async () => {
    const h = contentHarness();
    h.setSelection("Hello world");
    h.mouseup();
    await h.click(h.primaryBtn());
    expect(h.connectCalls()).toBe(1);
    expect(h.lastSent("SPEAK").text).toBe("Hello world");
  });

  it("answers CONTENT_GET_SELECTION with the current selection", async () => {
    const h = contentHarness();
    h.setSelection("Selected text");
    h.mouseup();
    const { response, responded } = h.sendOneShot({ type: "CONTENT_GET_SELECTION" });
    expect(responded).toBe(true);
    expect(response).toEqual({ text: "Selected text" });
  });

  it("answers CONTENT_GET_HOST only in the top frame", async () => {
    const top = contentHarness({ topFrame: true });
    const topReply = top.sendOneShot({ type: "CONTENT_GET_HOST" });
    expect(topReply.responded).toBe(true);
    expect(topReply.response).toEqual({ host: "example.com" });

    const frame = contentHarness({ topFrame: false });
    const frameReply = frame.sendOneShot({ type: "CONTENT_GET_HOST" });
    expect(frameReply.responded).toBe(false);
  });

  it("shows Read selection once a new selection differs from the running text, and starts a new run", async () => {
    const h = contentHarness();
    h.setSelection("Hello world");
    h.mouseup();
    await h.click(h.primaryBtn());
    const firstRunId = h.lastSent("SPEAK").runId;
    await h.deliverReply("SPEAK", { ok: true, data: {} });
    h.deliverSession({ runId: firstRunId, state: "playing", label: "Reading...", textPreview: "Hello world" }, true);

    h.setSelection("Totally different text");
    h.mouseup();
    expect(h.readBtn().hidden).toBe(false);
    expect(h.stopBtn().hidden).toBe(false);

    await h.click(h.readBtn());
    const second = h.lastSent("SPEAK");
    expect(second.text).toBe("Totally different text");
    expect(second.runId).not.toBe(firstRunId);
  });

  it("collapses instead of hiding the widget on an outside click during an active run", async () => {
    const h = contentHarness();
    h.setSelection("Hello world");
    h.mouseup();
    await h.click(h.primaryBtn());
    const runId = h.lastSent("SPEAK").runId;
    await h.deliverReply("SPEAK", { ok: true, data: {} });
    h.deliverSession({ runId, state: "playing", label: "Reading...", textPreview: "Hello world" }, true);

    h.mousedownOutside();
    expect(h.widgetHost().dataset.state).toBe("collapsed");
    expect(h.widgetHost().dataset.state).not.toBe("hidden");
  });

  it("hides (not just collapses) the widget on an outside click when idle", async () => {
    const h = contentHarness();
    h.setSelection("Hello world");
    h.mouseup();
    expect(h.widgetHost().dataset.state).toBe("expanded");
    h.mousedownOutside();
    expect(h.widgetHost().dataset.state).toBe("hidden");
  });

  it("maps context-invalidated errors to a friendly reload message", async () => {
    const h = contentHarness();
    h.setSelection("Hello world");
    h.mouseup();
    await h.click(h.primaryBtn());
    await h.deliverReply("SPEAK", { ok: false, error: "Extension context invalidated." });
    expect(h.labelSpan().textContent).toBe("Open TTS was updated — reload this page");
  });

  it("never creates a widget on a hidden site", async () => {
    const h = contentHarness({ hiddenSites: ["example.com"] });
    h.setSelection("Hello world");
    h.mouseup();
    await flush();
    expect(h.widgetHost()).toBeUndefined();
  });

  it("does not throw when the page has no document.body", async () => {
    // The fake `document` in this harness never defines `body` at all; content.js must never touch it.
    expect(() => {
      const h = contentHarness();
      h.setSelection("Hello world");
      h.mouseup();
    }).not.toThrow();
  });
});
