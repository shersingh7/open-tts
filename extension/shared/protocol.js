// @ts-check
// Open TTS v4 — protocol helpers (ESM). Envelope helpers from protocol-umd.js are gone: v4 uses ports.

/** @returns {string} a unique run id */
export function makeRunId() {
  return crypto.randomUUID();
}

/**
 * Extract a readable message and code from a backend error body (FastAPI `detail` or flat middleware shape).
 * @param {unknown} body
 * @param {number} status
 * @returns {{message: string, code: string | undefined}}
 */
export function parseApiErrorBody(body, status) {
  const fallback = `Server error ${status}`;
  if (!body || typeof body !== "object") {
    return { message: fallback, code: undefined };
  }
  const { detail, code, message, error } = /** @type {Record<string, any>} */ (body);
  if (detail && typeof detail === "object") {
    return {
      message: detail.message || detail.error || fallback,
      code: detail.code,
    };
  }
  if (typeof detail === "string" && detail) {
    return { message: detail, code };
  }
  if (typeof message === "string" && message) {
    return { message, code };
  }
  if (typeof error === "string" && error) {
    return { message: error, code };
  }
  return { message: fallback, code };
}

/**
 * Map fetch failures to a user-facing message; aborts and timeouts become "Request timed out".
 * @param {any} err
 * @returns {string}
 */
export function describeFetchError(err) {
  const name = err && err.name;
  const message = String(err && err.message ? err.message : err || "");
  if (
    name === "TimeoutError"
    || name === "AbortError"
    || /timed? ?out|signal timed out|signal is aborted|operation was aborted|The user aborted/i.test(message)
  ) {
    return "Request timed out";
  }
  return message || "Request failed";
}

/**
 * @typedef {{status: "offline"|"failed"|"ready"|"warming"|"idle", message: string, model?: string | null,
 *   error?: string}} HealthView
 */

/**
 * Interpret a `/health` payload for display.
 * @param {any} data
 * @returns {HealthView}
 */
export function interpretHealth(data) {
  if (!data || typeof data !== "object" || data.status !== "ok") {
    return { status: "offline", message: "Server offline" };
  }
  if (data.state === "failed") {
    const error = data.warm_error || data.load_error || "Model failed";
    return { status: "failed", error, message: error };
  }
  if (data.model_warm || data.gpu_busy || data.state === "generating" || data.state === "ready") {
    return {
      status: "ready",
      model: data.model || "ready",
      message: `Connected — ${data.model || "ready"}`,
    };
  }
  if (data.state === "loading" || data.state === "warming" || data.state === "loaded") {
    return { status: "warming", model: data.model || null, message: "Warming up model..." };
  }
  if (!data.model_loaded || data.state === "unloaded") {
    return { status: "idle", message: "Connected — pick a model" };
  }
  if (data.model_loaded) {
    return { status: "warming", model: data.model || null, message: "Warming up model..." };
  }
  return { status: "offline", message: "Server offline" };
}
