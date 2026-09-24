import { describe, expect, it } from "vitest";
import { describeFetchError, interpretHealth, makeRunId, parseApiErrorBody } from "../shared/protocol.js";

describe("makeRunId", () => {
  it("returns a fresh crypto UUID", () => {
    const a = makeRunId();
    const b = makeRunId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("API error envelope parsing", () => {
  it("parses FastAPI detail objects", () => {
    const r = parseApiErrorBody({ detail: { code: "validation_error", message: "text must not be empty" } }, 400);
    expect(r.message).toBe("text must not be empty");
    expect(r.code).toBe("validation_error");
  });

  it("parses flat middleware error bodies", () => {
    const r = parseApiErrorBody({ code: "unauthorized", message: "Invalid or missing X-Open-TTS-Token" }, 401);
    expect(r.message).toMatch(/Invalid or missing/);
    expect(r.code).toBe("unauthorized");
  });

  it("parses string detail and error fields", () => {
    expect(parseApiErrorBody({ detail: "Nope", code: "x" }, 400)).toEqual({ message: "Nope", code: "x" });
    expect(parseApiErrorBody({ error: "Broken" }, 500)).toEqual({ message: "Broken", code: undefined });
    expect(parseApiErrorBody({ detail: { error: "Inner" } }, 500)).toEqual({ message: "Inner", code: undefined });
    expect(parseApiErrorBody({ other: 1, code: "y" }, 502)).toEqual({ message: "Server error 502", code: "y" });
  });

  it("falls back when body is empty", () => {
    expect(parseApiErrorBody(null, 500).message).toBe("Server error 500");
  });
});

describe("describeFetchError", () => {
  it("maps abort/timeout signal errors to a readable timeout", () => {
    expect(describeFetchError({ name: "AbortError", message: "signal is aborted without reason" })).toBe("Request timed out");
    expect(describeFetchError({ name: "TimeoutError", message: "signal timed out" })).toBe("Request timed out");
    expect(describeFetchError({ name: "TypeError", message: "Failed to fetch" })).toBe("Failed to fetch");
    expect(describeFetchError(null)).toBe("Request failed");
  });
});

describe("interpretHealth", () => {
  it("treats generating + gpu_busy + model_loaded as ready / connected (not warming)", () => {
    const res = interpretHealth({
      status: "ok", state: "generating", gpu_busy: true, model_loaded: true, model_warm: true, model: "kokoro",
    });
    expect(res.status).toBe("ready");
    expect(res.message).toBe("Connected — kokoro");
  });

  it("treats ready + model_warm as ready", () => {
    const res = interpretHealth({
      status: "ok", state: "ready", gpu_busy: false, model_loaded: true, model_warm: true, model: "kokoro",
    });
    expect(res.status).toBe("ready");
    expect(res.message).toBe("Connected — kokoro");
  });

  it("treats unloaded / !model_loaded + status ok as idle (pick a model)", () => {
    const res = interpretHealth({
      status: "ok", state: "unloaded", model_loaded: false, model_warm: false, gpu_busy: false,
    });
    expect(res.status).toBe("idle");
    expect(res.message).toBe("Connected — pick a model");
  });

  it("treats warming/loading/loaded as warming even before model_loaded is true", () => {
    for (const state of ["warming", "loading", "loaded"]) {
      const res = interpretHealth({
        status: "ok", state, model_loaded: state !== "loading", model_warm: false, gpu_busy: false, model: "kokoro",
      });
      expect(res.status).toBe("warming");
      expect(res.message).toBe("Warming up model...");
    }
  });

  it("treats failed + warm_error or load_error as failed immediately", () => {
    const resWarm = interpretHealth({ status: "ok", state: "failed", warm_error: "Warmup OOM" });
    expect(resWarm.status).toBe("failed");
    expect(resWarm.error).toBe("Warmup OOM");
    const resLoad = interpretHealth({ status: "ok", state: "failed", load_error: "Corrupt weights" });
    expect(resLoad.status).toBe("failed");
    expect(resLoad.error).toBe("Corrupt weights");
  });

  it("treats missing or not ok as offline", () => {
    expect(interpretHealth(null).status).toBe("offline");
    expect(interpretHealth(undefined).status).toBe("offline");
    expect(interpretHealth({ status: "error" }).status).toBe("offline");
  });
});
