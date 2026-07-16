/** Shared message protocol helpers. */

export function makeClientId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeRunId() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize background/offscreen response envelopes. */
export function unwrap(resp) {
  if (!resp) return { ok: false, error: "No response" };
  if (resp.error && resp.success !== true) {
    return { ok: false, error: resp.error, code: resp.code, raw: resp };
  }
  if (resp.success === true) {
    return { ok: true, data: resp.data ?? resp, raw: resp };
  }
  if (resp.success === false) {
    return { ok: false, error: resp.error || resp.message || "Request failed", code: resp.code, raw: resp };
  }
  if (resp.started || resp.stopped || resp.paused || resp.resumed) {
    return { ok: true, data: resp, raw: resp };
  }
  return { ok: true, data: resp, raw: resp };
}

/**
 * Parse FastAPI / middleware JSON error bodies.
 * HTTPException => { detail: { code, message } }
 * Auth/rate middleware => { code, message }
 */
export function parseApiErrorBody(body, status) {
  const fallback = `Server error ${status}`;
  if (!body || typeof body !== "object") {
    return { message: fallback, code: undefined };
  }
  const detail = body.detail;
  if (detail && typeof detail === "object") {
    return {
      message: detail.message || detail.error || fallback,
      code: detail.code,
    };
  }
  if (typeof detail === "string" && detail) {
    return { message: detail, code: body.code };
  }
  if (typeof body.message === "string" && body.message) {
    return { message: body.message, code: body.code };
  }
  if (typeof body.error === "string" && body.error) {
    return { message: body.error, code: body.code };
  }
  return { message: fallback, code: body.code };
}

export function ok(data = {}) {
  return { success: true, data };
}

export function fail(error, code) {
  return { success: false, error, code };
}

export function playbackContext(sender, overrides = {}) {
  return {
    clientId: overrides.clientId || makeClientId(),
    runId: overrides.runId || makeRunId(),
    sourceTabId: overrides.sourceTabId ?? sender?.tab?.id ?? null,
    sourceFrameId: overrides.sourceFrameId ?? sender?.frameId ?? 0,
    source: overrides.source || (sender?.tab ? "content" : "popup"),
  };
}

export function isStaleEvent(session, msg) {
  if (!session || !msg?.runId) return false;
  return msg.runId !== session.runId;
}