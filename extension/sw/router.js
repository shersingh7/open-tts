// @ts-check
// Open TTS v4 — the port router: registry of UI and host ports, the six ownership rules, the SPEAK flow, command
// routing and SESSION fan-out (plan 2.3). The session store is the single source of truth; UIs render snapshots.

import { HISTORY_TEXT_CAP, MAX_CHARS } from "../shared/constants.js";
import { MSG, OUTCOMES, PORTS } from "../shared/messages.js";
import { makeRunId as defaultMakeRunId } from "../shared/protocol.js";
import { chooseHostKind, firstAudioDeadlineMs, OFFSCREEN_PATH, READER_PATH } from "./host-manager.js";
import { isActive } from "./session-store.js";

export const OWNER_GRACE_MS = 2000;
export const RESTART_GRACE_MS = 5000;
export const OWNER_LOST_MESSAGE = "Playback page closed or was discarded. Start a new reading.";
export const READER_ALREADY_OPEN = "Reader already open in another tab";

/** @typedef {import("./session-store.js").Session} Session */
/** @typedef {import("./session-store.js").RunSource} RunSource */
/** @typedef {import("./host-manager.js").HostKind} HostKind */
/** @typedef {chrome.runtime.Port} Port */

/**
 * @typedef {object} SpeakRequest
 * @property {unknown} text
 * @property {unknown} [settings]
 * @property {unknown} [runId]
 * @property {RunSource} source
 * @property {number|null} [sourceTabId]
 * @property {number|null} [sourceFrameId]
 */

const UI_SOURCES = /** @type {Record<string, RunSource>} */ ({
  [PORTS.UI_POPUP]: "popup",
  [PORTS.UI_CONTENT]: "content",
  [PORTS.UI_READER]: "reader",
});

const HOST_KINDS = /** @type {Record<string, HostKind>} */ ({
  [PORTS.HOST_OFFSCREEN]: "offscreen",
  [PORTS.HOST_READER]: "reader",
});

const HOST_STATES = ["preparing", "buffering", "playing", "paused"];

/**
 * Error with a machine-readable code (sent as REPLY.code).
 * @param {string} message
 * @param {string} code
 */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Post without throwing when the peer is already gone.
 * @param {Port} port
 * @param {object} message
 * @returns {boolean}
 */
function safePost(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object} deps
 * @param {import("./session-store.js").SessionStore} deps.store
 * @param {import("./host-manager.js").HostRegistry} deps.registry
 * @param {Pick<import("./host-manager.js").HostManager, "ensureHost"|"releaseReader"|"pinReader">} deps.hosts
 * @param {Pick<import("./server-manager.js").ServerManager, "ensureServer"|"checkCapabilities"|"checkHealth"|
 *   "stopServer"|"loadModel"|"getModels"|"serverState"|"modelState">} deps.server
 * @param {{getToken: () => Promise<string>}} deps.auth
 * @param {{resolve: (provided: any) => Promise<import("./settings.js").SpeakSettings>}} deps.settings
 * @param {{persistCompletion: (run: any) => Promise<boolean>}} deps.history
 * @param {(path: string) => string} deps.extensionUrl chrome.runtime.getURL
 * @param {() => string} [deps.makeRunId]
 * @param {() => number} [deps.now]
 * @param {number} [deps.ownerGraceMs]
 * @param {number} [deps.restartGraceMs]
 */
export function createRouter(deps) {
  const { store, registry, hosts, server, auth, settings, history, extensionUrl } = deps;
  const makeRunId = deps.makeRunId || defaultMakeRunId;
  const now = deps.now || (() => Date.now());
  const ownerGraceMs = deps.ownerGraceMs ?? OWNER_GRACE_MS;
  const restartGraceMs = deps.restartGraceMs ?? RESTART_GRACE_MS;

  /** @type {Set<Port>} */
  const uiPorts = new Set();
  /** Ports whose HOST_HELLO was rejected (rule 4): everything they send is ignored. */
  const rejectedHosts = new WeakSet();
  /** Ports that disconnected (so a late registration does not resurrect them). */
  const portClosed = new WeakSet();
  /** Runs whose HOST_SPEAK has not been sent yet by this service-worker instance. */
  const launching = new Set();
  /** @type {{runId: string, timer: ReturnType<typeof setTimeout>}|null} */
  let ownerGrace = null;

  const ready = store.load().then(() => {
    const session = store.current();
    if (isActive(session) && session.runId) startOwnerGrace(session.runId, restartGraceMs);
  });

  // ---------- publishing ----------

  /**
   * Rules 2/3: extension UIs may control the active run; a content port only the run bound to its tab and frame.
   * @param {Port} port
   * @param {Session} session
   */
  function canControl(port, session) {
    if (port.name === PORTS.UI_POPUP || port.name === PORTS.UI_READER) return true;
    if (port.name !== PORTS.UI_CONTENT) return false;
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId ?? 0;
    return session.sourceTabId === tabId && session.sourceFrameId === frameId;
  }

  /** @param {Port} port */
  function postSession(port) {
    const session = store.current();
    safePost(port, { type: MSG.SESSION, session, controllable: isActive(session) && canControl(port, session) });
  }

  function broadcastSession() {
    for (const port of uiPorts) postSession(port);
  }

  /**
   * Fan a snapshot (SERVER_STATE, MODEL_STATE, HISTORY_ERROR) out to every UI port.
   * @param {object} message
   */
  function publish(message) {
    for (const port of uiPorts) safePost(port, message);
  }

  /**
   * @param {Port} port
   * @param {unknown} requestId
   * @param {{ok: true, data?: unknown}|{ok: false, error: string, code?: string}} result
   */
  function reply(port, requestId, result) {
    if (typeof requestId !== "string" || !requestId) return;
    safePost(port, { type: MSG.REPLY, requestId, ...result });
  }

  // ---------- run lifecycle ----------

  function clearOwnerGrace() {
    if (ownerGrace) clearTimeout(ownerGrace.timer);
    ownerGrace = null;
  }

  /**
   * Rule 5: wait for the owning host to come back with the run before declaring it lost.
   * @param {string} runId
   * @param {number} delayMs
   */
  function startOwnerGrace(runId, delayMs) {
    clearOwnerGrace();
    const timer = setTimeout(() => {
      ownerGrace = null;
      ownerLost(runId);
    }, delayMs);
    ownerGrace = { runId, timer };
  }

  /**
   * End the current run (if `runId` is still current) and publish; releases the Reader pin.
   * @param {string} runId
   * @param {import("./session-store.js").Outcome} outcome
   * @param {{error?: {message: string, code?: string}, metrics?: object}} [extra]
   * @returns {boolean}
   */
  function endRun(runId, outcome, extra) {
    const hostKind = store.current().hostKind;
    if (!store.end(runId, outcome, extra)) return false;
    if (ownerGrace?.runId === runId) clearOwnerGrace();
    launching.delete(runId);
    broadcastSession();
    if (hostKind === "reader") void hosts.releaseReader();
    return true;
  }

  /** @param {string} runId */
  function ownerLost(runId) {
    endRun(runId, OUTCOMES.OWNER_LOST, { error: { message: OWNER_LOST_MESSAGE, code: "owner_lost" } });
  }

  /**
   * Tell the host of the current run to stop it (if that host is connected).
   * @param {Session} session
   * @param {"stopped"|"superseded"} outcome
   */
  function stopHost(session, outcome) {
    if (!session.hostKind || !session.runId) return;
    const port = registry.get(session.hostKind);
    if (port) safePost(port, { type: MSG.HOST_STOP, runId: session.runId, outcome });
  }

  /** @param {string} runId */
  function stillCurrent(runId) {
    const session = store.current();
    return session.runId === runId && isActive(session);
  }

  /**
   * Validate, resolve settings, supersede the active run (rule 1: HOST_STOP first) and begin the new run. The host
   * launch continues in the background; failures before the host accepts end the run as failed.
   * @param {SpeakRequest} request
   * @returns {Promise<{runId: string, hostKind: HostKind}>}
   */
  async function speak(request) {
    await ready;
    const text = typeof request.text === "string" ? request.text : "";
    if (!text.trim()) throw codedError("Nothing to read", "empty_text");
    if (text.length > MAX_CHARS) throw codedError(`Text exceeds ${MAX_CHARS} characters`, "text_too_long");
    const resolved = await settings.resolve(request.settings);
    const runId = typeof request.runId === "string" && request.runId ? request.runId : makeRunId();
    if (store.current().runId === runId) throw codedError("This reading was already started", "duplicate_run");
    const hostKind = chooseHostKind({ textLength: text.length, model: resolved.model, source: request.source });

    const previous = store.current();
    if (isActive(previous) && previous.runId) {
      stopHost(previous, OUTCOMES.SUPERSEDED);
      endRun(previous.runId, OUTCOMES.SUPERSEDED);
    }
    store.begin({
      runId,
      source: request.source,
      sourceTabId: request.sourceTabId ?? null,
      sourceFrameId: request.sourceFrameId ?? null,
      hostKind,
      text,
    }, {
      runId,
      historyText: text.slice(0, HISTORY_TEXT_CAP),
      chars: text.length,
      voice: resolved.voice,
      model: resolved.model,
      speed: resolved.speed,
      startedAt: now(),
    });
    launching.add(runId);
    broadcastSession();
    void launch(runId, text, resolved, hostKind);
    return { runId, hostKind };
  }

  /**
   * @param {string} runId
   * @param {string} text
   * @param {import("./settings.js").SpeakSettings} resolved
   * @param {HostKind} hostKind
   */
  async function launch(runId, text, resolved, hostKind) {
    try {
      await server.ensureServer();
      if (!stillCurrent(runId)) return;
      await server.checkCapabilities();
      if (!stillCurrent(runId)) return;
      const authToken = await auth.getToken();
      if (!stillCurrent(runId)) return;
      const port = await hosts.ensureHost(hostKind);
      if (!stillCurrent(runId)) return;
      const session = store.current();
      const sent = safePost(port, {
        type: MSG.HOST_SPEAK,
        run: { runId, source: session.source, sourceTabId: session.sourceTabId, sourceFrameId: session.sourceFrameId },
        text,
        settings: resolved,
        authToken,
        protocolVersion: 2,
        firstAudioDeadlineMs: firstAudioDeadlineMs(hostKind, resolved.model),
      });
      if (!sent) throw codedError("Playback page closed before it could start", "host_unavailable");
      launching.delete(runId);
      if (registry.get(hostKind) !== port) startOwnerGrace(runId, ownerGraceMs);
    } catch (error) {
      launching.delete(runId);
      if (!stillCurrent(runId)) return;
      const code = /** @type {any} */ (error)?.code;
      endRun(runId, OUTCOMES.FAILED, { error: { message: messageOf(error), ...(code ? { code } : {}) } });
    }
  }

  /**
   * PAUSE / RESUME / STOP. `port` null means the user pressed a keyboard command (always allowed).
   * @param {Port|null} port
   * @param {"PAUSE"|"RESUME"|"STOP"} type
   * @param {unknown} runId
   */
  async function control(port, type, runId) {
    await ready;
    const session = store.current();
    if (!isActive(session) || !session.runId) throw codedError("No active reading", "no_active_run");
    if (runId !== session.runId) throw codedError("That reading is no longer active", "stale_run");
    if (port && !canControl(port, session)) {
      throw codedError("This page does not control the active reading", "not_owner");
    }
    if (type === MSG.STOP) {
      stopHost(session, OUTCOMES.STOPPED);
      endRun(session.runId, OUTCOMES.STOPPED);
      return { runId: session.runId };
    }
    const hostPort = session.hostKind ? registry.get(session.hostKind) : null;
    if (launching.has(session.runId) || !hostPort) throw codedError("Still preparing playback", "not_ready");
    const hostType = type === MSG.PAUSE ? MSG.HOST_PAUSE : MSG.HOST_RESUME;
    safePost(hostPort, { type: hostType, runId: session.runId });
    return { runId: session.runId };
  }

  /** Keyboard `toggle-pause`: pause a playing run, resume a paused one. */
  async function togglePause() {
    await ready;
    const session = store.current();
    if (!isActive(session)) return null;
    return control(null, session.state === "paused" ? MSG.RESUME : MSG.PAUSE, session.runId);
  }

  // ---------- UI ports ----------

  /**
   * @param {Port} port
   * @param {any} message
   */
  async function handleUiCommand(port, message) {
    const source = UI_SOURCES[port.name];
    switch (message.type) {
      case MSG.SPEAK: {
        const isContent = port.name === PORTS.UI_CONTENT;
        const isReaderTab = port.name === PORTS.UI_READER;
        return speak({
          text: message.text,
          settings: message.settings,
          runId: message.runId,
          source,
          sourceTabId: isContent || isReaderTab ? port.sender?.tab?.id ?? null : null,
          sourceFrameId: isContent || isReaderTab ? port.sender?.frameId ?? 0 : null,
        });
      }
      case MSG.PAUSE:
      case MSG.RESUME:
      case MSG.STOP:
        return control(port, message.type, message.runId);
      case MSG.START_SERVER:
        await server.ensureServer({ waitForWarm: true });
        return server.serverState();
      case MSG.STOP_SERVER:
        return server.stopServer();
      case MSG.LOAD_MODEL:
        if (typeof message.modelId !== "string" || !message.modelId) {
          throw codedError("Missing modelId", "bad_request");
        }
        return server.loadModel(message.modelId);
      case MSG.GET_MODELS:
        return server.getModels();
      default:
        throw codedError(`Unknown message type: ${message.type}`, "unknown_type");
    }
  }

  /** @param {Port} port */
  function attachUi(port) {
    port.onMessage.addListener((/** @type {any} */ message) => {
      if (!message || typeof message !== "object") return;
      handleUiCommand(port, message).then(
        (data) => reply(port, message.requestId, { ok: true, data: data ?? null }),
        (error) => {
          const code = /** @type {any} */ (error)?.code;
          reply(port, message.requestId, { ok: false, error: messageOf(error), ...(code ? { code } : {}) });
        },
      );
    });
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
    });
    const register = () => {
      if (portClosed.has(port)) return;
      uiPorts.add(port);
      postSession(port);
      safePost(port, { type: MSG.SERVER_STATE, ...server.serverState() });
      const model = server.modelState();
      if (model) safePost(port, { type: MSG.MODEL_STATE, ...model });
      const serverState = server.serverState().state;
      if (port.name !== PORTS.UI_CONTENT && serverState !== "starting") void server.checkHealth();
    };
    void ready.then(register);
  }

  // ---------- host ports ----------

  /**
   * HOST_HELLO: accept (rule 4 for Readers), then reconcile the host's run against the store.
   * @param {Port} port
   * @param {HostKind} kind
   * @param {any} message
   */
  function handleHello(port, kind, message) {
    const accepted = registry.get(kind);
    if (accepted !== port) {
      if (kind === "reader" && accepted) {
        rejectedHosts.add(port);
        safePost(port, { type: MSG.HOST_REJECT, reason: READER_ALREADY_OPEN });
        return;
      }
      registry.set(kind, port);
      safePost(port, { type: MSG.HOST_ACCEPT });
    }
    const session = store.current();
    const hostRun = message.activeRun && typeof message.activeRun.runId === "string" ? message.activeRun : null;
    const ours = isActive(session) && session.hostKind === kind && session.runId;
    if (hostRun) {
      if (ours && hostRun.runId === session.runId) {
        if (ownerGrace?.runId === session.runId) clearOwnerGrace();
        launching.delete(session.runId);
        const state = hostRun.paused ? "paused" : hostRun.state;
        if (HOST_STATES.includes(state) && state !== session.state) {
          store.update(session.runId, { state, label: state === "paused" ? "Paused" : session.label });
          broadcastSession();
        }
        if (kind === "reader") void hosts.pinReader();
        return;
      }
      // The store says this run ended (or was replaced): it must not come back.
      const outcome = isActive(session) ? OUTCOMES.SUPERSEDED : OUTCOMES.STOPPED;
      safePost(port, { type: MSG.HOST_STOP, runId: hostRun.runId, outcome });
      return;
    }
    // The host no longer has our run. It may still flush a queued DONE/ERROR for it right after this HELLO
    // (terminal produced while disconnected), so wait out the grace instead of declaring loss immediately.
    if (ours && session.runId && !launching.has(session.runId) && ownerGrace?.runId !== session.runId) {
      startOwnerGrace(session.runId, ownerGraceMs);
    }
  }

  /**
   * @param {Port} port
   * @param {HostKind} kind
   * @param {any} message
   */
  function handleHostMessage(port, kind, message) {
    if (rejectedHosts.has(port)) return;
    if (message.type === MSG.HOST_HELLO) {
      handleHello(port, kind, message);
      return;
    }
    if (registry.get(kind) !== port) return;
    const session = store.current();
    const current = isActive(session) && session.runId === message.runId && session.hostKind === kind;
    switch (message.type) {
      case MSG.HEARTBEAT:
        if (!current && typeof message.runId === "string") {
          // An orphan still playing (e.g. after a lost terminal): silence it.
          safePost(port, { type: MSG.HOST_STOP, runId: message.runId, outcome: OUTCOMES.STOPPED });
        }
        return;
      case MSG.STATUS: {
        if (!current || !HOST_STATES.includes(message.state)) return;
        /** @type {Partial<Session>} */
        const patch = { state: message.state };
        if (typeof message.label === "string") patch.label = message.label;
        if (message.metrics && typeof message.metrics === "object") patch.metrics = message.metrics;
        store.update(message.runId, patch);
        broadcastSession();
        return;
      }
      case MSG.PROGRESS: {
        if (!current) return;
        /** @type {NonNullable<Session["progress"]>} */
        const progress = {
          played: isNumber(message.played) ? message.played : 0,
          scheduled: isNumber(message.scheduled) ? message.scheduled : 0,
        };
        for (const key of /** @type {const} */ (["index", "end", "unitId", "bufferedSeconds"])) {
          if (isNumber(message[key])) progress[key] = message[key];
        }
        store.update(message.runId, { progress });
        broadcastSession();
        return;
      }
      case MSG.DONE:
        handleDone(message);
        return;
      case MSG.ERROR: {
        if (!current) return;
        const error = { message: typeof message.message === "string" ? message.message : "Playback failed" };
        if (typeof message.code === "string") Object.assign(error, { code: message.code });
        const extra = { error, ...(message.metrics ? { metrics: message.metrics } : {}) };
        endRun(message.runId, OUTCOMES.FAILED, extra);
        return;
      }
      default:
    }
  }

  /** @param {any} message */
  function handleDone(message) {
    const allowed = [OUTCOMES.COMPLETED, OUTCOMES.STOPPED, OUTCOMES.SUPERSEDED];
    if (!allowed.includes(message.outcome)) return;
    const info = store.runInfo();
    const extra = message.metrics && typeof message.metrics === "object" ? { metrics: message.metrics } : {};
    if (!endRun(message.runId, message.outcome, extra)) return;
    if (message.outcome === OUTCOMES.COMPLETED && info && info.runId === message.runId) {
      void history.persistCompletion({
        id: info.runId,
        text: info.historyText,
        chars: info.chars,
        voice: info.voice,
        model: info.model,
        speed: info.speed,
        timestamp: now(),
      });
    }
  }

  /**
   * @param {Port} port
   * @param {HostKind} kind
   */
  function attachHost(port, kind) {
    port.onMessage.addListener((/** @type {any} */ message) => {
      if (!message || typeof message !== "object") return;
      void ready.then(() => handleHostMessage(port, kind, message));
    });
    port.onDisconnect.addListener(() => {
      void ready.then(() => {
        const removed = registry.remove(port);
        if (!removed) return;
        const session = store.current();
        if (!isActive(session) || session.hostKind !== removed || !session.runId) return;
        if (launching.has(session.runId)) return;
        startOwnerGrace(session.runId, ownerGraceMs);
      });
    });
  }

  // ---------- connect ----------

  /**
   * @param {chrome.runtime.MessageSender|undefined} sender
   * @param {string} [path] exact extension page path, or any extension page when omitted
   */
  function fromExtensionPage(sender, path) {
    const url = typeof sender?.url === "string" ? sender.url.split(/[?#]/)[0] : "";
    if (path) return url === extensionUrl(path);
    return url.startsWith(extensionUrl(""));
  }

  /**
   * Entry point for chrome.runtime.onConnect. Listeners are attached synchronously; handling waits for the store.
   * @param {Port} port
   */
  function handleConnect(port) {
    const name = port.name;
    const sender = port.sender;
    port.onDisconnect.addListener(() => {
      portClosed.add(port);
    });
    if (name === PORTS.UI_CONTENT) {
      if (typeof sender?.tab?.id !== "number") {
        port.disconnect();
        return;
      }
      attachUi(port);
      return;
    }
    if (name === PORTS.UI_POPUP || name === PORTS.UI_READER) {
      if (!fromExtensionPage(sender)) {
        port.disconnect();
        return;
      }
      attachUi(port);
      return;
    }
    const kind = HOST_KINDS[name];
    if (kind && fromExtensionPage(sender, kind === "reader" ? READER_PATH : OFFSCREEN_PATH)) {
      attachHost(port, kind);
      return;
    }
    port.disconnect();
  }

  return {
    ready,
    handleConnect,
    speak,
    control,
    togglePause,
    publish,
    /** @returns {Session} */
    session: () => store.current(),
  };
}

/** @typedef {ReturnType<typeof createRouter>} Router */
