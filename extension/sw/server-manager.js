// @ts-check
// Open TTS v4 — the one place that talks to the local server: health, start/stop via the native host, model loads
// and authenticated API calls. Publishes SERVER_STATE / MODEL_STATE snapshots (findings #4, #19; plan 2.5).

import { SERVER_URL } from "../shared/constants.js";
import { MSG } from "../shared/messages.js";
import { describeFetchError, interpretHealth, parseApiErrorBody } from "../shared/protocol.js";
import { sendNativeCommand } from "./native.js";

export const HEALTH_POLL_MS = 1000;
export const START_MAX_MS = 60000;
export const LOAD_REQUEST_TIMEOUT_MS = 10000;
export const LOAD_POLL_MAX_MS = 300000;
export const API_TIMEOUT_MS = 30000;

/**
 * @typedef {{state: "unknown"|"offline"|"starting"|"ready"|"warming"|"failed", message: string,
 *   model?: string|null}} ServerState
 * @typedef {{modelId: string, state: "idle"|"loading"|"loaded"|"failed", message: string}} ModelState
 * @typedef {{method?: string, body?: string, headers?: Record<string, string>, timeoutMs?: number}} ApiOptions
 */

/**
 * Error thrown by apiFetch / ensureServer, with an optional machine code and HTTP status.
 * @param {string} message
 * @param {string} [code]
 * @param {number} [status]
 */
export function apiError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * @param {object} deps
 * @param {typeof chrome} deps.chrome
 * @param {import("./auth.js").Auth} deps.auth
 * @param {(message: object) => void} deps.publish fan-out to every UI port
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(command: "start"|"stop"|"status") => Promise<any>} [deps.native]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 */
export function createServerManager(deps) {
  const { auth, publish } = deps;
  const fetchImpl = deps.fetchImpl || ((input, init) => fetch(input, init));
  const native = deps.native || ((command) => sendNativeCommand(deps.chrome, command));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());

  /** @type {ServerState} */
  let serverState = { state: "unknown", message: "Checking server..." };
  /** @type {ModelState|null} */
  let modelState = null;
  /** @type {Promise<any>|null} */
  let starting = null;
  let loadGeneration = 0;

  /** @param {ServerState} next */
  function setServerState(next) {
    serverState = next;
    publish({ type: MSG.SERVER_STATE, ...serverState });
  }

  /** @param {ModelState} next */
  function setModelState(next) {
    modelState = next;
    publish({ type: MSG.MODEL_STATE, ...modelState });
  }

  /** @param {any} health */
  function publishHealth(health) {
    const view = interpretHealth(health);
    /** @type {ServerState["state"]} */
    const state = view.status === "idle" ? "ready" : view.status;
    setServerState({ state, message: view.message, model: view.model ?? null });
  }

  /**
   * fetch with an AbortController timeout (setTimeout based, so it works with fake timers in tests).
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} timeoutMs
   */
  async function timedFetch(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /health. Returns the payload only if it is really an Open TTS backend (v3 identity check), else null.
   * @param {number} [timeoutMs]
   * @returns {Promise<any|null>}
   */
  async function fetchHealth(timeoutMs = 3000) {
    try {
      const response = await timedFetch(`${SERVER_URL}/health`, {}, timeoutMs);
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || data.engine !== "open-tts" || typeof data.version !== "string") return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Refresh SERVER_STATE from /health without starting anything (no-op while a start is in flight). */
  async function checkHealth() {
    if (starting) return null;
    const health = await fetchHealth(3000);
    if (starting) return health;
    if (health) publishHealth(health);
    else setServerState({ state: "offline", message: "Server offline" });
    return health;
  }

  /** @param {string} message */
  function failStart(message) {
    setServerState({ state: "failed", message });
    return apiError(message, "server_unavailable");
  }

  async function startOnce() {
    const existing = await fetchHealth(2000);
    if (existing) {
      publishHealth(existing);
      return existing;
    }
    setServerState({ state: "starting", message: "Starting server..." });
    let response;
    try {
      response = await native("start");
    } catch (error) {
      throw failStart(`Could not start the server: ${error instanceof Error ? error.message : error}`);
    }
    if (response?.install_token) await auth.storeToken(response.install_token);
    if (response?.success === false) throw failStart(response.message || "Open TTS server failed to start");
    const deadline = now() + START_MAX_MS;
    while (now() < deadline) {
      await sleep(HEALTH_POLL_MS);
      const health = await fetchHealth(2000);
      if (health) {
        publishHealth(health);
        return health;
      }
    }
    throw failStart("Open TTS server did not become ready");
  }

  /** @param {any} health */
  async function waitForWarm(health) {
    const deadline = now() + START_MAX_MS;
    let latest = health;
    for (;;) {
      const view = interpretHealth(latest);
      if (view.status === "ready" || view.status === "idle") return latest;
      if (view.status === "failed") throw apiError(view.message, "model_failed");
      if (now() >= deadline) return latest;
      await sleep(HEALTH_POLL_MS);
      const next = await fetchHealth(2000);
      if (next) {
        latest = next;
        publishHealth(next);
      }
    }
  }

  /**
   * Make sure the server is up. Concurrent callers share one in-flight start (one native `start`).
   * With waitForWarm, additionally wait (≤60 s) for the model to finish warming; still warming → resolves anyway.
   * @param {{waitForWarm?: boolean}} [options]
   * @returns {Promise<any>} the latest /health payload
   */
  async function ensureServer({ waitForWarm: warm = false } = {}) {
    if (!starting) {
      starting = startOnce().finally(() => {
        starting = null;
      });
    }
    const health = await starting;
    return warm ? waitForWarm(health) : health;
  }

  async function stopServer() {
    const response = await native("stop");
    if (response?.success === false) throw apiError(response.message || "Stop failed", "stop_failed");
    setServerState({ state: "offline", message: response?.message || "Server stopped" });
    return response;
  }

  /**
   * Authenticated API call with one token refresh on 401. Non-2xx responses throw with the backend's message/code.
   * @param {string} path
   * @param {ApiOptions} [options]
   * @returns {Promise<Response>}
   */
  async function apiFetch(path, options = {}) {
    const { timeoutMs = API_TIMEOUT_MS, headers: extraHeaders = {}, ...init } = options;
    const execute = async () => {
      const headers = await auth.authHeaders({ json: init.body !== undefined });
      return timedFetch(`${SERVER_URL}${path}`, { ...init, headers: { ...headers, ...extraHeaders } }, timeoutMs);
    };
    let response;
    try {
      response = await execute();
      if (response.status === 401) {
        const token = await auth.refreshToken();
        if (token) response = await execute();
      }
    } catch (error) {
      const message = describeFetchError(error);
      throw apiError(message, message === "Request timed out" ? "timeout" : "network");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const { message, code } = parseApiErrorBody(body, response.status);
      throw apiError(message, code, response.status);
    }
    return response;
  }

  async function getModels() {
    return (await apiFetch("/v1/models")).json();
  }

  /** The backend must speak the v2 progressive stream protocol. */
  async function checkCapabilities() {
    const caps = await (await apiFetch("/v1/capabilities")).json();
    if (caps?.engine !== "open-tts" || !caps?.protocol_versions?.includes?.(2)) {
      throw apiError("Update the backend to support progressive streaming v2", "protocol_unsupported");
    }
    return caps;
  }

  /**
   * Load a model: POST with a 10 s timeout; if that times out the load continues server-side, so poll /health
   * every second (≤300 s) until `model === modelId && model_warm`. A newer loadModel supersedes this one.
   * @param {string} modelId
   * @returns {Promise<ModelState>}
   */
  async function loadModel(modelId) {
    const generation = ++loadGeneration;
    const current = () => generation === loadGeneration;
    /** @param {ModelState} next */
    const settle = (next) => {
      if (current()) setModelState(next);
      return next;
    };
    setModelState({ modelId, state: "loading", message: `Loading ${modelId}...` });
    try {
      await ensureServer();
      try {
        const path = `/v1/load-model?model_id=${encodeURIComponent(modelId)}`;
        await (await apiFetch(path, { method: "POST", timeoutMs: LOAD_REQUEST_TIMEOUT_MS })).json().catch(() => ({}));
        const loaded = settle({ modelId, state: "loaded", message: `Model ready — ${modelId}` });
        if (current()) await checkHealth();
        return loaded;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "timeout") throw error;
      }
      const deadline = now() + LOAD_POLL_MAX_MS;
      while (now() < deadline) {
        await sleep(HEALTH_POLL_MS);
        if (!current()) return { modelId, state: "idle", message: "Superseded by another model load" };
        const health = await fetchHealth(2000);
        if (!health || health.model !== modelId) continue;
        if (health.model_warm) {
          publishHealth(health);
          return settle({ modelId, state: "loaded", message: `Model ready — ${modelId}` });
        }
        if (health.state === "failed") {
          const view = interpretHealth(health);
          throw apiError(view.message, "model_failed");
        }
      }
      throw apiError("Model load timed out. Larger models can take a few minutes — try again.", "timeout");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle({ modelId, state: "failed", message });
      throw error;
    }
  }

  return {
    fetchHealth,
    checkHealth,
    ensureServer,
    stopServer,
    apiFetch,
    getModels,
    checkCapabilities,
    loadModel,
    /** @returns {ServerState} */
    serverState: () => serverState,
    /** @returns {ModelState|null} */
    modelState: () => modelState,
    isStarting: () => Boolean(starting),
  };
}

/** @typedef {ReturnType<typeof createServerManager>} ServerManager */
