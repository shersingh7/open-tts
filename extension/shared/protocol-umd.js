(function (root) {
  const OpenTTSProtocol = {
    makeClientId() {
      return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    },
    makeRunId() {
      return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    },
    unwrap(resp) {
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
    },
    parseApiErrorBody(body, status) {
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
    },
    ok(data = {}) {
      return { success: true, data };
    },
    fail(error, code) {
      return { success: false, error, code };
    },
    playbackContext(sender, overrides = {}) {
      return {
        clientId: overrides.clientId || OpenTTSProtocol.makeClientId(),
        runId: overrides.runId || OpenTTSProtocol.makeRunId(),
        sourceTabId: overrides.sourceTabId ?? sender?.tab?.id ?? null,
        sourceFrameId: overrides.sourceFrameId ?? sender?.frameId ?? 0,
        source: overrides.source || (sender?.tab ? "content" : "popup"),
      };
    },
    isStaleEvent(session, msg) {
      if (!session || !msg?.runId) return false;
      return msg.runId !== session.runId;
    },
  };
  root.OpenTTSProtocol = OpenTTSProtocol;
})(typeof globalThis !== "undefined" ? globalThis : self);