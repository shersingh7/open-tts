// @ts-check
// Open TTS v4 — playback hosts: which one a run uses (plan 1.7), creating the offscreen document or the singleton
// Reader tab (plan 1.6: not discardable while it owns a run), and tracking the accepted host ports.

import { READER_TEXT_THRESHOLD, SLOW_MODEL_READER_THRESHOLD, SLOW_MODELS, SLOW_START_TIMEOUT_MS }
  from "../shared/constants.js";

export const OFFSCREEN_PATH = "host/offscreen.html";
export const READER_PATH = "host/reader.html";
export const HOST_READY_TIMEOUT_MS = 15000;

/** @typedef {"offscreen"|"reader"} HostKind */

/**
 * @param {{textLength: number, model: string, source?: string|null}} run
 * @returns {HostKind}
 */
export function chooseHostKind({ textLength, model, source }) {
  if (source === "reader") return "reader";
  if (textLength > READER_TEXT_THRESHOLD) return "reader";
  if (SLOW_MODELS.includes(model) && textLength > SLOW_MODEL_READER_THRESHOLD) return "reader";
  return "offscreen";
}

/**
 * Offscreen documents can be closed by Chrome after ~30 s without audio, so slow models get a first-audio deadline.
 * @param {HostKind} hostKind
 * @param {string} model
 * @returns {number|null}
 */
export function firstAudioDeadlineMs(hostKind, model) {
  return hostKind === "offscreen" && SLOW_MODELS.includes(model) ? SLOW_START_TIMEOUT_MS : null;
}

/**
 * Accepted host ports by kind, with waiters for "the host of this kind said HOST_HELLO".
 */
export function createHostRegistry() {
  /** @type {Record<HostKind, chrome.runtime.Port|null>} */
  const ports = { offscreen: null, reader: null };
  /** @type {Array<{kind: HostKind, resolve: (port: chrome.runtime.Port) => void}>} */
  let waiters = [];

  return {
    /** @param {HostKind} kind */
    get(kind) {
      return ports[kind];
    },
    /**
     * @param {HostKind} kind
     * @param {chrome.runtime.Port} port
     */
    set(kind, port) {
      ports[kind] = port;
      const ready = waiters.filter((waiter) => waiter.kind === kind);
      waiters = waiters.filter((waiter) => waiter.kind !== kind);
      for (const waiter of ready) waiter.resolve(port);
    },
    /**
     * Forget `port` if it is the accepted one for its kind. Returns the kind it was registered as, or null.
     * @param {chrome.runtime.Port} port
     * @returns {HostKind|null}
     */
    remove(port) {
      for (const kind of /** @type {HostKind[]} */ (["offscreen", "reader"])) {
        if (ports[kind] === port) {
          ports[kind] = null;
          return kind;
        }
      }
      return null;
    },
    /** @returns {number|null} tab id of the accepted Reader */
    readerTabId() {
      return ports.reader?.sender?.tab?.id ?? null;
    },
    /**
     * Resolve with the accepted port of `kind`, waiting up to `timeoutMs` for its HOST_HELLO.
     * @param {HostKind} kind
     * @param {number} [timeoutMs]
     * @returns {Promise<chrome.runtime.Port>}
     */
    waitFor(kind, timeoutMs = HOST_READY_TIMEOUT_MS) {
      const existing = ports[kind];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        /** @type {{kind: HostKind, resolve: (port: chrome.runtime.Port) => void}} */
        const waiter = {
          kind,
          resolve: (port) => {
            clearTimeout(timer);
            resolve(port);
          },
        };
        const timer = setTimeout(() => {
          waiters = waiters.filter((entry) => entry !== waiter);
          const label = kind === "reader" ? "Reader" : "Playback page";
          reject(Object.assign(new Error(`${label} did not start`), { code: "host_unavailable" }));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

/** @typedef {ReturnType<typeof createHostRegistry>} HostRegistry */

/**
 * @param {object} deps
 * @param {typeof chrome} deps.chrome
 * @param {HostRegistry} deps.registry
 * @param {number} [deps.readyTimeoutMs]
 */
export function createHostManager({ chrome: chromeApi, registry, readyTimeoutMs = HOST_READY_TIMEOUT_MS }) {
  /** @type {Promise<void>|null} */
  let offscreenCreation = null;
  /** @type {Promise<number>|null} */
  let readerCreation = null;
  /** @type {number|null} */
  let lastReaderTabId = null;

  async function hasOffscreen() {
    const contexts = await chromeApi.runtime.getContexts({
      contextTypes: [/** @type {chrome.runtime.ContextType} */ ("OFFSCREEN_DOCUMENT")],
      documentUrls: [chromeApi.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }

  /** Create the offscreen document unless it exists (single-flight). */
  function ensureOffscreen() {
    if (!offscreenCreation) {
      offscreenCreation = (async () => {
        if (await hasOffscreen()) return;
        try {
          await chromeApi.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: [/** @type {chrome.offscreen.Reason} */ ("AUDIO_PLAYBACK")],
            justification: "Local TTS audio playback and synthesis",
          });
        } catch (error) {
          if (!(await hasOffscreen())) throw error;
        }
      })().finally(() => {
        offscreenCreation = null;
      });
    }
    return offscreenCreation;
  }

  /** @param {number} tabId */
  async function pinTab(tabId) {
    await chromeApi.tabs.update(tabId, { autoDiscardable: false });
  }

  /**
   * Reuse the existing Reader tab (there is at most one) or open one; either way it is not discardable.
   * @returns {Promise<number>} the Reader tab id
   */
  function ensureReader() {
    if (!readerCreation) {
      readerCreation = (async () => {
        const url = chromeApi.runtime.getURL(READER_PATH);
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: [/** @type {chrome.runtime.ContextType} */ ("TAB")],
          documentUrls: [url],
        });
        const accepted = registry.readerTabId();
        const existing = contexts.find((context) => context.tabId === accepted) || contexts[0];
        let tabId = existing && existing.tabId >= 0 ? existing.tabId : null;
        if (tabId === null) {
          const tab = await chromeApi.tabs.create({ url, active: true });
          tabId = /** @type {number} */ (tab.id);
        }
        lastReaderTabId = tabId;
        await pinTab(tabId);
        return tabId;
      })().finally(() => {
        readerCreation = null;
      });
    }
    return readerCreation;
  }

  /**
   * Make sure the host page for `kind` exists and has said HOST_HELLO; resolves with its accepted port.
   * @param {HostKind} kind
   * @returns {Promise<chrome.runtime.Port>}
   */
  async function ensureHost(kind) {
    if (kind === "reader") await ensureReader();
    else await ensureOffscreen();
    return registry.waitFor(kind, readyTimeoutMs);
  }

  /** Let Chrome discard the Reader again once it no longer owns a run. Never rejects. */
  async function releaseReader() {
    const tabId = registry.readerTabId() ?? lastReaderTabId;
    if (tabId === null) return;
    await chromeApi.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  }

  /**
   * Pin the Reader while it owns a run (used when a run is adopted after a service-worker restart).
   * Never rejects.
   */
  async function pinReader() {
    const tabId = registry.readerTabId();
    if (tabId === null) return;
    lastReaderTabId = tabId;
    await pinTab(tabId).catch(() => {});
  }

  return { ensureOffscreen, ensureReader, ensureHost, releaseReader, pinReader };
}

/** @typedef {ReturnType<typeof createHostManager>} HostManager */
