/**
 * Fake `chrome` for Open TTS v4 unit tests (vitest). No real Chrome, no timers: everything asynchronous is
 * delivered with `queueMicrotask`, so `await flush()` (exported below) settles it. Works with fake timers.
 *
 * Usage:
 * ```js
 * import { createFakeChrome, createPortPair, flush } from "./helpers/fake-chrome.js";
 *
 * const chrome = createFakeChrome({ storage: { sync: { speed: 2 } } });
 * globalThis.chrome = chrome;                       // or inject it into the module under test
 * const { fake } = chrome;                           // test-only controls (not a Chrome API)
 *
 * // Ports: runtime.connect() returns the client end; the SW end is dispatched to runtime.onConnect.
 * chrome.runtime.onConnect.addListener((port) => {
 *   port.onMessage.addListener((msg) => port.postMessage({ echo: msg }));
 * });
 * const popup = chrome.runtime.connect({ name: "ui:popup" });          // sender = options.sender (extension page)
 * const content = fake.connect("ui:content", { tab: { id: 5 }, frameId: 0, url: "https://example.com/" });
 * popup.postMessage({ type: "STOP", runId: "r1" });
 * await flush();
 * expect(popup.received).toEqual([{ echo: { type: "STOP", runId: "r1" } }]);
 * fake.serverPorts[0].disconnect();                 // fires popup.onDisconnect (never the caller's own)
 *
 * // Scripting: every API is a spy with `.calls` (argument arrays) and a replaceable `.impl`.
 * // `.impl` receives the arguments without the trailing callback and may return a value, return a promise or throw;
 * // the wrapper handles callback vs promise form and sets chrome.runtime.lastError during callbacks on failure.
 * chrome.runtime.sendNativeMessage.impl = (host, message) => ({ success: true, install_token: "t" });
 * chrome.tabs.sendMessage.impl = (tabId, message, options) => ({ text: "Selected" });
 * fake.failNext("storage.local.set", "QUOTA_BYTES quota exceeded");   // next call fails (lastError / reject)
 *
 * // Events: addListener/removeListener/hasListener/hasListeners plus test-only `dispatch(...args)`.
 * chrome.commands.onCommand.dispatch("toggle-pause", { id: 5 });
 * const reply = await fake.sendRuntimeMessage({ type: "CONTENT_GET_HOST" }, { id: chrome.runtime.id });
 *
 * // Direct router tests without a chrome object:
 * const { client, server } = createPortPair("ui:content", { tab: { id: 5 }, frameId: 0 });
 * ```
 *
 * Semantics worth knowing:
 * - Port messages and storage values are JSON-cloned (like Chrome), so mutation after posting is not observed.
 * - Messages posted before a disconnect are still delivered to the peer, then the peer's onDisconnect fires.
 *   A port that called `disconnect()` itself receives nothing more and never sees its own onDisconnect.
 *   `postMessage` on a disconnected port throws "Attempting to use a disconnected port object".
 * - Callback-form APIs call back in a microtask; `chrome.runtime.lastError` is set only during that callback.
 * - `fake.log` records every API call in order as `{ api, args }`, e.g. `storage.local.set`,
 *   `port[ui:popup].postMessage`. Each spy's `.calls` holds just its own argument arrays.
 * - Defaults: sendNativeMessage and tabs.sendMessage reject ("Specified native messaging host not found." /
 *   "Could not establish connection. Receiving end does not exist.") until you script `.impl`.
 *   runtime.sendMessage also rejects: v4 code must not use it (assert `.calls` is empty).
 */

import { readFileSync } from "node:fs";

export const FAKE_EXTENSION_ID = "fakeopenttsextensionid";
const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
const DISCONNECTED_PORT = "Attempting to use a disconnected port object";

/** Settle queued microtasks (port delivery, callbacks, onChanged). */
export async function flush(rounds = 50) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
  } catch {
    return { manifest_version: 3, name: "Open TTS", version: "0.0.0" };
  }
}

/**
 * A Chrome event: addListener/removeListener/hasListener/hasListeners, plus test-only `dispatch(...args)` which
 * calls listeners synchronously and returns their return values, and `listeners` (live array).
 */
export function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) {
      if (!listeners.includes(fn)) listeners.push(fn);
    },
    removeListener(fn) {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    hasListeners: () => listeners.length > 0,
    dispatch: (...args) => [...listeners].map((fn) => fn(...args)),
  };
}

function makeSpy(api, impl, log) {
  const fn = (...args) => {
    fn.calls.push(args);
    log?.push({ api, args });
    return fn.impl(...args);
  };
  fn.calls = [];
  fn.impl = impl;
  fn.api = api;
  return fn;
}

function createPort(name, sender, log) {
  const port = {
    name,
    sender,
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    /** Messages delivered to this end, in order (test convenience). */
    received: [],
    connected: true,
    peer: null,
    closedLocally: false,
  };
  port.postMessage = makeSpy(`port[${name}].postMessage`, (message) => {
    if (!port.connected) throw new Error(DISCONNECTED_PORT);
    const receiver = port.peer;
    const payload = clone(message);
    queueMicrotask(() => {
      if (receiver.closedLocally) return;
      receiver.received.push(payload);
      receiver.onMessage.dispatch(payload, receiver);
    });
  }, log);
  port.disconnect = makeSpy(`port[${name}].disconnect`, () => {
    port.closedLocally = true;
    if (!port.connected) return;
    const receiver = port.peer;
    port.connected = false;
    receiver.connected = false;
    queueMicrotask(() => {
      if (!receiver.closedLocally) receiver.onDisconnect.dispatch(receiver);
    });
  }, log);
  return port;
}

/**
 * Linked port pair. `client` is what `chrome.runtime.connect` returns (no sender, like Chrome); `server` is what
 * the service worker's `runtime.onConnect` receives, with `sender` describing the connecting context.
 * @param {string} name
 * @param {object} [sender] e.g. `{ tab: { id: 5 }, frameId: 0, url: "https://example.com/" }`
 * @param {Array} [log] optional shared call log
 */
export function createPortPair(name, sender = { id: FAKE_EXTENSION_ID }, log = undefined) {
  const client = createPort(name, undefined, log);
  const server = createPort(name, sender, log);
  client.peer = server;
  server.peer = client;
  return { client, server };
}

/**
 * @param {object} [options]
 * @param {object} [options.sender] default sender for `runtime.connect` (an extension page)
 * @param {{sync?: object, local?: object, session?: object}} [options.storage] initial storage contents
 * @param {object} [options.manifest] returned by `runtime.getManifest()` (default: extension/manifest.json)
 * @param {string} [options.id] extension id
 */
export function createFakeChrome(options = {}) {
  const id = options.id || FAKE_EXTENSION_ID;
  const origin = `chrome-extension://${id}`;
  const log = [];
  const failures = new Map();
  const runtime = { id, lastError: undefined };

  const fake = {
    log,
    /** All `{client, server}` pairs created through runtime.connect / fake.connect. */
    ports: [],
    get clientPorts() { return fake.ports.map((pair) => pair.client); },
    get serverPorts() { return fake.ports.map((pair) => pair.server); },
    /** Default sender for runtime.connect. */
    sender: options.sender || { id, origin, url: `${origin}/ui/popup.html` },
    /** Raw storage contents (mutating these directly fires no events). */
    storageData: {
      sync: clone(options.storage?.sync) || {},
      local: clone(options.storage?.local) || {},
      session: clone(options.storage?.session) || {},
    },
    /** Tabs by id (created via tabs.create or fake.addTab). */
    tabs: new Map(),
    /** Contexts reported by runtime.getContexts (offscreen/tab contexts are added automatically). */
    contexts: [],
    offscreenDocument: null,
    menus: new Map(),
    nextTabId: 100,
    /** Make the next call to `api` (e.g. "storage.local.set", "runtime.sendNativeMessage") fail with `message`. */
    failNext(api, message = "Fake failure") {
      if (!failures.has(api)) failures.set(api, []);
      failures.get(api).push(message);
    },
    /** Simulate another context connecting with a custom sender; returns the client end. */
    connect(name, sender) {
      return connectWith({ name }, sender);
    },
    /** Register a tab without going through tabs.create. */
    addTab(tab) {
      const full = { active: false, windowId: 1, index: fake.tabs.size, ...tab };
      fake.tabs.set(full.id, full);
      return full;
    },
    /**
     * Deliver a one-shot message to runtime.onMessage listeners (as chrome.tabs.sendMessage would to a content
     * script). Resolves with the first sendResponse value; listeners returning `true` may respond later.
     */
    sendRuntimeMessage(message, sender = { id }) {
      return dispatchOneShot(runtime.onMessage, clone(message), sender);
    },
  };

  const takeFailure = (api) => {
    const queue = failures.get(api);
    return queue?.length ? queue.shift() : null;
  };

  /**
   * Chrome API supporting both callback and promise forms. `impl(...argsWithoutCallback)` may return, return a
   * promise or throw. Failures set runtime.lastError during the callback, or reject the promise.
   */
  const dual = (api, impl) => {
    const wrapper = (...args) => {
      const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
      wrapper.calls.push(args);
      log.push({ api, args });
      const failure = takeFailure(api);
      const result = failure
        ? Promise.reject(new Error(failure))
        : Promise.resolve().then(() => wrapper.impl(...args));
      if (!callback) return result;
      result.then(
        (value) => callback(value),
        (error) => {
          runtime.lastError = { message: error?.message || String(error) };
          try {
            callback(undefined);
          } finally {
            runtime.lastError = undefined;
          }
        },
      );
      return undefined;
    };
    wrapper.calls = [];
    wrapper.impl = impl;
    wrapper.api = api;
    return wrapper;
  };

  // ---------- storage ----------
  const storageOnChanged = createEvent();
  const selectKeys = (data, keys) => {
    if (keys === null || keys === undefined) return clone(data);
    if (typeof keys === "string") return keys in data ? { [keys]: clone(data[keys]) } : {};
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, clone(data[key])]));
    }
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
      key, key in data ? clone(data[key]) : clone(fallback),
    ]));
  };
  const makeArea = (areaName) => {
    const data = () => fake.storageData[areaName];
    const areaChanged = createEvent();
    const emit = (changes) => {
      if (!Object.keys(changes).length) return;
      queueMicrotask(() => {
        storageOnChanged.dispatch(clone(changes), areaName);
        areaChanged.dispatch(clone(changes));
      });
    };
    const removeKeys = (keys) => {
      const changes = {};
      for (const key of keys) {
        if (!(key in data())) continue;
        changes[key] = { oldValue: clone(data()[key]) };
        delete data()[key];
      }
      emit(changes);
    };
    const area = {
      onChanged: areaChanged,
      get: dual(`storage.${areaName}.get`, (keys) => selectKeys(data(), keys)),
      set: dual(`storage.${areaName}.set`, (items) => {
        const changes = {};
        for (const [key, value] of Object.entries(clone(items) || {})) {
          changes[key] = key in data() ? { oldValue: clone(data()[key]), newValue: value } : { newValue: value };
          data()[key] = value;
        }
        emit(changes);
      }),
      remove: dual(`storage.${areaName}.remove`, (keys) => removeKeys(Array.isArray(keys) ? keys : [keys])),
      clear: dual(`storage.${areaName}.clear`, () => removeKeys(Object.keys(data()))),
    };
    if (areaName === "session") {
      area.accessLevel = "TRUSTED_CONTEXTS";
      area.setAccessLevel = dual("storage.session.setAccessLevel", ({ accessLevel }) => {
        area.accessLevel = accessLevel;
      });
    }
    return area;
  };

  // ---------- runtime ----------
  runtime.onConnect = createEvent();
  runtime.onMessage = createEvent();
  runtime.onInstalled = createEvent();
  runtime.onStartup = createEvent();
  runtime.getURL = makeSpy("runtime.getURL", (path = "") => `${origin}/${String(path).replace(/^\/+/, "")}`, log);
  const manifest = options.manifest || readManifest();
  runtime.getManifest = makeSpy("runtime.getManifest", () => clone(manifest), log);
  runtime.getContexts = dual("runtime.getContexts", (filter = {}) => fake.contexts.filter((context) => {
    if (filter.contextTypes && !filter.contextTypes.includes(context.contextType)) return false;
    if (filter.documentUrls && !filter.documentUrls.includes(context.documentUrl)) return false;
    if (filter.tabIds && !filter.tabIds.includes(context.tabId)) return false;
    if (filter.contextIds && !filter.contextIds.includes(context.contextId)) return false;
    return true;
  }).map(clone));
  runtime.sendNativeMessage = dual("runtime.sendNativeMessage", () => {
    throw new Error("Specified native messaging host not found.");
  });
  runtime.sendMessage = dual("runtime.sendMessage", () => {
    throw new Error(NO_RECEIVER);
  });

  function connectWith(connectInfo, sender) {
    const name = connectInfo?.name ?? "";
    const pair = createPortPair(name, clone(sender), log);
    fake.ports.push(pair);
    queueMicrotask(() => runtime.onConnect.dispatch(pair.server));
    return pair.client;
  }
  runtime.connect = makeSpy("runtime.connect", (...args) => {
    const connectInfo = typeof args[0] === "string" ? args[1] : args[0];
    return connectWith(connectInfo || {}, fake.sender);
  }, log);

  // ---------- tabs ----------
  const tabs = { onRemoved: createEvent(), onUpdated: createEvent() };
  const requireTab = (tabId) => {
    const tab = fake.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  };
  tabs.create = dual("tabs.create", (props = {}) => {
    const tab = fake.addTab({ id: fake.nextTabId++, active: props.active !== false, autoDiscardable: true, ...props });
    if (tab.url?.startsWith(origin)) {
      const context = { contextType: "TAB", documentUrl: tab.url, tabId: tab.id, frameId: 0 };
      fake.contexts.push({ ...context, contextId: `tab-${tab.id}` });
    }
    return clone(tab);
  });
  tabs.update = dual("tabs.update", (tabId, props = {}) => {
    const tab = requireTab(tabId);
    Object.assign(tab, props);
    tabs.onUpdated.dispatch(tabId, clone(props), clone(tab));
    return clone(tab);
  });
  tabs.get = dual("tabs.get", (tabId) => clone(requireTab(tabId)));
  tabs.query = dual("tabs.query", (queryInfo = {}) => [...fake.tabs.values()].filter((tab) => {
    return Object.entries(queryInfo).every(([key, value]) => {
      if (key === "currentWindow" || key === "lastFocusedWindow") return true;
      return tab[key] === value;
    });
  }).map(clone));
  tabs.remove = dual("tabs.remove", (tabIds) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      requireTab(tabId);
      fake.tabs.delete(tabId);
      fake.contexts = fake.contexts.filter((context) => context.tabId !== tabId);
      tabs.onRemoved.dispatch(tabId, { windowId: 1, isWindowClosing: false });
    }
  });
  tabs.sendMessage = dual("tabs.sendMessage", () => {
    throw new Error(NO_RECEIVER);
  });

  // ---------- offscreen ----------
  const offscreen = {
    createDocument: dual("offscreen.createDocument", (params) => {
      if (fake.offscreenDocument) throw new Error("Only a single offscreen document may be created.");
      fake.offscreenDocument = clone(params);
      const documentUrl = params.url.startsWith(origin) ? params.url : runtime.getURL(params.url);
      fake.contexts.push({ contextType: "OFFSCREEN_DOCUMENT", documentUrl, contextId: "offscreen" });
    }),
    hasDocument: dual("offscreen.hasDocument", () => Boolean(fake.offscreenDocument)),
    closeDocument: dual("offscreen.closeDocument", () => {
      if (!fake.offscreenDocument) throw new Error("No current offscreen document.");
      fake.offscreenDocument = null;
      fake.contexts = fake.contexts.filter((context) => context.contextType !== "OFFSCREEN_DOCUMENT");
    }),
  };

  // ---------- contextMenus, commands, action ----------
  const contextMenus = {
    onClicked: createEvent(),
    create: makeSpy("contextMenus.create", (props, callback) => {
      const menuId = props.id ?? `menu-${fake.menus.size + 1}`;
      const duplicate = fake.menus.has(menuId);
      if (!duplicate) fake.menus.set(menuId, clone(props));
      queueMicrotask(() => {
        if (duplicate) runtime.lastError = { message: `Cannot create item with duplicate id ${menuId}` };
        try {
          callback?.();
        } finally {
          runtime.lastError = undefined;
        }
      });
      return menuId;
    }, log),
    removeAll: dual("contextMenus.removeAll", () => {
      fake.menus.clear();
    }),
  };
  const commands = { onCommand: createEvent() };
  const action = {
    setBadgeText: dual("action.setBadgeText", () => undefined),
    setTitle: dual("action.setTitle", () => undefined),
    setBadgeBackgroundColor: dual("action.setBadgeBackgroundColor", () => undefined),
  };

  function dispatchOneShot(event, message, sender) {
    return new Promise((resolve) => {
      let answered = false;
      const sendResponse = (response) => {
        if (answered) return;
        answered = true;
        resolve(clone(response));
      };
      let keepOpen = false;
      for (const listener of [...event.listeners]) {
        if (listener(message, sender, sendResponse) === true) keepOpen = true;
      }
      if (!keepOpen && !answered) resolve(undefined);
    });
  }

  return {
    runtime,
    storage: {
      onChanged: storageOnChanged,
      sync: makeArea("sync"),
      local: makeArea("local"),
      session: makeArea("session"),
    },
    tabs,
    offscreen,
    contextMenus,
    commands,
    action,
    fake,
  };
}
