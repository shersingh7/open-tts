import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const sharedDir = join(root, "..", "shared");

function loadUmd(file) {
  const code = readFileSync(join(sharedDir, file), "utf8");
  const fn = new Function("globalThis", `${code}; return globalThis.OpenTTSProtocol || globalThis.OpenTTSStorage || globalThis.OpenTTSConstants;`);
  const g = {};
  return fn(g);
}

describe("protocol envelope", () => {
  let protocol;
  beforeAll(() => {
    const g = {};
    const code = readFileSync(join(sharedDir, "protocol-umd.js"), "utf8");
    new Function("globalThis", code)(g);
    protocol = g.OpenTTSProtocol;
  });

  it("unwraps success responses with data", () => {
    const r = protocol.unwrap({ success: true, data: { model_warm: true, model: "kokoro" } });
    expect(r.ok).toBe(true);
    expect(r.data.model_warm).toBe(true);
  });

  it("does not treat success boolean as nested path", () => {
    const r = protocol.unwrap({ success: true, data: { audioData: "data:audio/wav;base64,abc" } });
    expect(r.ok).toBe(true);
    expect(r.data.audioData).toContain("base64");
  });

  it("handles failures", () => {
    const r = protocol.unwrap({ success: false, error: "Server not reachable" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reachable/);
  });
});

describe("stale playback events", () => {
  let protocol;
  beforeAll(() => {
    const g = {};
    new Function("globalThis", readFileSync(join(sharedDir, "protocol-umd.js"), "utf8"))(g);
    protocol = g.OpenTTSProtocol;
  });

  it("suppresses mismatched runId", () => {
    const session = { runId: "r_1" };
    expect(protocol.isStaleEvent(session, { runId: "r_2", type: "TTS_DONE" })).toBe(true);
    expect(protocol.isStaleEvent(session, { runId: "r_1", type: "TTS_DONE" })).toBe(false);
  });
});

describe("API error envelope parsing", () => {
  let protocol;
  beforeAll(() => {
    const g = {};
    new Function("globalThis", readFileSync(join(sharedDir, "protocol-umd.js"), "utf8"))(g);
    protocol = g.OpenTTSProtocol;
  });

  it("parses FastAPI detail objects", () => {
    const r = protocol.parseApiErrorBody(
      { detail: { code: "validation_error", message: "text must not be empty" } },
      400,
    );
    expect(r.message).toBe("text must not be empty");
    expect(r.code).toBe("validation_error");
  });

  it("parses flat middleware error bodies", () => {
    const r = protocol.parseApiErrorBody(
      { code: "unauthorized", message: "Invalid or missing X-Open-TTS-Token" },
      401,
    );
    expect(r.message).toMatch(/Invalid or missing/);
    expect(r.code).toBe("unauthorized");
  });

  it("falls back when body is empty", () => {
    const r = protocol.parseApiErrorBody(null, 500);
    expect(r.message).toBe("Server error 500");
  });

  it("maps abort/timeout signal errors to a readable timeout", () => {
    expect(protocol.describeFetchError({ name: "AbortError", message: "signal is aborted without reason" })).toBe("Request timed out");
    expect(protocol.describeFetchError({ name: "TimeoutError", message: "signal timed out" })).toBe("Request timed out");
    expect(protocol.describeFetchError({ name: "TypeError", message: "Failed to fetch" })).toBe("Failed to fetch");
  });
});

describe("offscreen delivery retry", () => {
  let protocol;
  beforeAll(() => {
    const g = {};
    new Function("globalThis", readFileSync(join(sharedDir, "protocol-umd.js"), "utf8"))(g);
    protocol = g.OpenTTSProtocol;
  });

  it("retries receiving-end-does-not-exist then succeeds", async () => {
    let calls = 0;
    const result = await protocol.sendWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { success: true, started: true };
      },
      { delays: [0, 0, 0, 0] },
    );
    expect(calls).toBe(3);
    expect(result.started).toBe(true);
  });

  it("does not retry a non-delivery error", async () => {
    let calls = 0;
    await expect(
      protocol.sendWithRetry(async () => {
        calls += 1;
        throw new Error("Offscreen unavailable");
      }, { delays: [0, 0, 0] }),
    ).rejects.toThrow(/Offscreen unavailable/);
    expect(calls).toBe(1);
  });
});