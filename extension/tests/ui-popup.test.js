import { afterEach, describe, expect, it } from "vitest";
import { createFakeChrome, flush } from "./helpers/fake-chrome.js";
import { init } from "../ui/popup.js";
import { MSG } from "../shared/messages.js";

// shared/storage.js (owned by P0) reads the global `chrome`, not an injected one.
afterEach(() => {
  delete globalThis.chrome;
});

/** Minimal fake DOM element: enough surface for popup.js's element interactions. */
function makeElement(id) {
  const listeners = {};
  const el = {
    id,
    value: "",
    textContent: "",
    disabled: false,
    hidden: false,
    checked: false,
    title: "",
    type: "",
    dataset: {},
    children: [],
    parentElement: { hidden: false },
    classList: {
      _set: new Set(),
      add(...cls) {
        cls.forEach((c) => this._set.add(c));
      },
      remove(...cls) {
        cls.forEach((c) => this._set.delete(c));
      },
      toggle(cls, force) {
        const has = this._set.has(cls);
        const next = force === undefined ? !has : force;
        if (next) this._set.add(cls);
        else this._set.delete(cls);
        return next;
      },
      contains(cls) {
        return this._set.has(cls);
      },
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
    },
    setAttribute(name, val) {
      this.dataset[`attr:${name}`] = val;
    },
    getAttribute(name) {
      return this.dataset[`attr:${name}`] ?? null;
    },
    querySelectorAll: () => [],
  };
  return el;
}

/** Builds a fake `document` with every element popup.js's `init()` looks up by id. */
function makeFakeDoc() {
  const ids = [
    "model", "voice", "language", "instruct", "instructWrap", "fishStyleWrap", "fishStyle",
    "speed", "speedValue", "previewText", "charCount", "speakBtn", "pauseBtn", "stopPlaybackBtn",
    "copyBtn", "startBtn", "stopBtn", "statusDot", "statusText", "modelMeta", "progress",
    "historyToggle", "historyPanel", "historyList", "historyCount", "clearHistory", "historyEnabled",
    "errorBanner", "errorText", "copyDiagnostics", "version", "app", "firstAudioMetric",
    "hideSiteRow", "hideSiteToggle", "hideSiteHost",
  ];
  const nodes = new Map(ids.map((id) => [id, makeElement(id)]));
  // Mirror popup.html's `hidden` starting attribute for these elements.
  for (const id of ["errorBanner", "fishStyleWrap", "instructWrap", "hideSiteRow"]) {
    nodes.get(id).hidden = true;
  }
  const listeners = {};
  return {
    nodes,
    visibilityState: "visible",
    getElementById: (id) => nodes.get(id),
    createElement: (tag) => makeElement(`created-${tag}`),
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
  };
}

function makeFakeWin() {
  const listeners = {};
  return {
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
  };
}

/** Wires a fake SW that always answers GET_MODELS with one model and no-ops other commands unless scripted. */
function setupSw(chrome, { models = [], onCommand } = {}) {
  chrome.runtime.onConnect.addListener((port) => {
    port.postMessage({
      type: MSG.SESSION,
      session: { runId: null, state: "idle", label: "Ready", metrics: null },
      controllable: true,
    });
    port.postMessage({ type: MSG.SERVER_STATE, state: "ready", message: "Connected — ready" });
    port.onMessage.addListener((msg) => {
      if (msg.type === MSG.GET_MODELS) {
        port.postMessage({ type: MSG.REPLY, requestId: msg.requestId, ok: true, data: { models } });
        return;
      }
      onCommand?.(msg, port);
    });
  });
}

const KOKORO = {
  id: "kokoro", name: "Kokoro", description: "Fast local model", loaded: false, active: false,
  supports_native_speed: true, supports_streaming: true,
  voices: [{ id: "af_bella", name: "Bella" }],
};

async function bootPopup({ chrome, models = [KOKORO], onCommand, storage } = {}) {
  // Only wire the default fake SW when the caller didn't already supply a fully-wired one
  // (passing `chrome` means the test wants full control over what gets posted on connect).
  const fakeChrome = chrome || createFakeChrome({ storage });
  globalThis.chrome = fakeChrome;
  if (!chrome) {
    setupSw(fakeChrome, { models, onCommand });
    fakeChrome.tabs.sendMessage.impl = () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
  }
  const doc = makeFakeDoc();
  const win = makeFakeWin();
  await init({ doc, win, chromeApi: fakeChrome });
  await flush();
  return { chrome: fakeChrome, doc, win };
}

describe("popup init", () => {
  it("never sends LOAD_MODEL on open, only GET_MODELS", async () => {
    const { chrome } = await bootPopup();
    const received = chrome.fake.serverPorts[0].received;
    expect(received.some((m) => m.type === MSG.LOAD_MODEL)).toBe(false);
    expect(received.some((m) => m.type === MSG.GET_MODELS)).toBe(true);
  });

  it("shows '<model> — loads on first Speak' when the model isn't loaded", async () => {
    const { doc } = await bootPopup({ models: [KOKORO] });
    expect(doc.nodes.get("modelMeta").textContent).toBe("Kokoro — loads on first Speak");
  });

  it("sends LOAD_MODEL only on an explicit model change", async () => {
    const { chrome, doc } = await bootPopup();
    const before = chrome.fake.serverPorts[0].received.filter((m) => m.type === MSG.LOAD_MODEL);
    expect(before).toHaveLength(0);

    doc.nodes.get("model").value = "kokoro";
    doc.nodes.get("model").dispatch("change");
    await flush();

    const after = chrome.fake.serverPorts[0].received.filter((m) => m.type === MSG.LOAD_MODEL);
    expect(after).toHaveLength(1);
    expect(after[0].modelId).toBe("kokoro");
  });

  it("history toggle defaults off when historyEnabled is unset", async () => {
    const { doc } = await bootPopup();
    expect(doc.nodes.get("historyEnabled").checked).toBe(false);
  });

  it("history toggle is on only when historyEnabled is explicitly true", async () => {
    const { doc } = await bootPopup({ storage: { local: { historyEnabled: true } } });
    expect(doc.nodes.get("historyEnabled").checked).toBe(true);
  });

  it("labels a truncated history entry '(first 2,000 chars)'", async () => {
    const history = [{ id: "1", text: "a".repeat(2000), chars: 5000, truncated: true, timestamp: Date.now() }];
    const { doc } = await bootPopup({ storage: { local: { ttsHistory: history } } });
    const item = doc.nodes.get("historyList").children[0];
    const truncatedNode = item.children.find((c) => c.className === "history-truncated");
    expect(truncatedNode.textContent).toBe("(first 2,000 chars)");
  });

  it("replay plays the stored (possibly truncated) slice, not the original text", async () => {
    const history = [{ id: "1", text: "stored slice", chars: 9999, truncated: true, timestamp: Date.now() }];
    const { chrome, doc } = await bootPopup({ storage: { local: { ttsHistory: history } } });
    const item = doc.nodes.get("historyList").children[0];
    const replayBtn = item.children.find((c) => c.title === "Replay");
    replayBtn.dispatch("click");
    await flush();
    expect(doc.nodes.get("previewText").value).toBe("stored slice");
    const speakSent = chrome.fake.serverPorts[0].received.find((m) => m.type === MSG.SPEAK);
    expect(speakSent.text).toBe("stored slice");
  });

  it("disables pause/stop controls when the session is not controllable", async () => {
    const chrome = createFakeChrome();
    chrome.runtime.onConnect.addListener((port) => {
      port.postMessage({
        type: MSG.SESSION,
        session: { runId: "r1", state: "playing", label: "Reading..." },
        controllable: false,
      });
      port.postMessage({ type: MSG.SERVER_STATE, state: "ready", message: "Connected" });
      port.onMessage.addListener((msg) => {
        if (msg.type === MSG.GET_MODELS) {
          port.postMessage({ type: MSG.REPLY, requestId: msg.requestId, ok: true, data: { models: [KOKORO] } });
        }
      });
    });
    const { doc } = await bootPopup({ chrome });
    expect(doc.nodes.get("pauseBtn").disabled).toBe(true);
    expect(doc.nodes.get("stopPlaybackBtn").disabled).toBe(true);
  });

  it("enables pause/stop controls when the session is controllable and active", async () => {
    const chrome = createFakeChrome();
    chrome.runtime.onConnect.addListener((port) => {
      port.postMessage({
        type: MSG.SESSION,
        session: { runId: "r1", state: "playing", label: "Reading..." },
        controllable: true,
      });
      port.postMessage({ type: MSG.SERVER_STATE, state: "ready", message: "Connected" });
      port.onMessage.addListener((msg) => {
        if (msg.type === MSG.GET_MODELS) {
          port.postMessage({ type: MSG.REPLY, requestId: msg.requestId, ok: true, data: { models: [KOKORO] } });
        }
      });
    });
    const { doc } = await bootPopup({ chrome });
    expect(doc.nodes.get("pauseBtn").disabled).toBe(false);
    expect(doc.nodes.get("stopPlaybackBtn").disabled).toBe(false);
  });

  it("formats 'First audio: X.Xs' from session metrics", async () => {
    const chrome = createFakeChrome();
    chrome.runtime.onConnect.addListener((port) => {
      port.postMessage({
        type: MSG.SESSION,
        session: {
          runId: "r1", state: "playing", label: "Reading...",
          metrics: { acceptedAt: 1000, firstAudioClockStartedAt: 3400 },
        },
        controllable: true,
      });
      port.postMessage({ type: MSG.SERVER_STATE, state: "ready", message: "Connected" });
      port.onMessage.addListener((msg) => {
        if (msg.type === MSG.GET_MODELS) {
          port.postMessage({ type: MSG.REPLY, requestId: msg.requestId, ok: true, data: { models: [KOKORO] } });
        }
      });
    });
    const { doc } = await bootPopup({ chrome });
    expect(doc.nodes.get("firstAudioMetric").textContent).toBe("First audio: 2.4s");
  });

  it("leaves the metric blank when metrics are absent", async () => {
    const { doc } = await bootPopup();
    expect(doc.nodes.get("firstAudioMetric").textContent).toBe("");
  });

  it("re-renders from the new snapshot after the service worker reconnects", async () => {
    let callCount = 0;
    const chrome = createFakeChrome();
    chrome.runtime.onConnect.addListener((port) => {
      callCount += 1;
      port.postMessage({
        type: MSG.SESSION,
        session: { runId: null, state: "idle", label: `Ready #${callCount}` },
        controllable: true,
      });
      port.postMessage({ type: MSG.SERVER_STATE, state: "ready", message: `Connected #${callCount}` });
      port.onMessage.addListener((msg) => {
        if (msg.type === MSG.GET_MODELS) {
          port.postMessage({ type: MSG.REPLY, requestId: msg.requestId, ok: true, data: { models: [KOKORO] } });
        }
      });
    });
    const { doc } = await bootPopup({ chrome });
    expect(doc.nodes.get("progress").textContent).toBe("Ready #1");
    expect(doc.nodes.get("statusText").textContent).toBe("Connected #1");

    chrome.fake.serverPorts[0].disconnect();
    await flush();

    expect(doc.nodes.get("progress").textContent).toBe("Ready #2");
    expect(doc.nodes.get("statusText").textContent).toBe("Connected #2");
  });
});

describe("popup settings survive close", () => {
  it("flushPending() on pagehide writes a debounced speed change immediately", async () => {
    const { chrome, doc, win } = await bootPopup();
    doc.nodes.get("speed").value = "2.5";
    doc.nodes.get("speed").dispatch("input");
    // No "change" event yet (drag still in progress) and no time has passed for the 300ms debounce.
    win.dispatch("pagehide");
    await flush();
    expect(chrome.fake.storageData.sync.speed).toBe(2.5);
  });

  it("flushPending() on visibilitychange -> hidden also writes pending values", async () => {
    const { chrome, doc } = await bootPopup();
    doc.nodes.get("speed").value = "0.75";
    doc.nodes.get("speed").dispatch("input");
    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    await flush();
    expect(chrome.fake.storageData.sync.speed).toBe(0.75);
  });
});

describe("popup hide-per-site toggle", () => {
  it("stays hidden when the content script doesn't answer", async () => {
    const { doc } = await bootPopup();
    expect(doc.nodes.get("hideSiteRow").hidden).toBe(true);
  });

  it("shows the toggle and host when the content script answers", async () => {
    const chrome = createFakeChrome();
    globalThis.chrome = chrome;
    setupSw(chrome, { models: [KOKORO] });
    chrome.fake.addTab({ id: 7, active: true, windowId: 1 });
    chrome.tabs.sendMessage.impl = () => ({ host: "example.com" });
    const doc = makeFakeDoc();
    const win = makeFakeWin();
    await init({ doc, win, chromeApi: chrome });
    await flush();
    expect(doc.nodes.get("hideSiteRow").hidden).toBe(false);
    expect(doc.nodes.get("hideSiteHost").textContent).toBe("example.com");
  });
});
