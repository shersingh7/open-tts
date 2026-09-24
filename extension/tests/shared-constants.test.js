import { describe, expect, it } from "vitest";
import * as C from "../shared/constants.js";

describe("shared/constants.js (ESM)", () => {
  it("gives Qwen/Fish several minutes instead of a 30s abort", () => {
    expect(C.LOAD_MODEL_TIMEOUT_MS).toBeGreaterThanOrEqual(180000);
  });

  it("keeps a slider value of 2.5 instead of falling back to 1.5", () => {
    expect(C.resolveSpeed(2.5)).toBe(2.5);
    expect(C.resolveSpeed("2.5")).toBe(2.5);
    expect(C.resolveSpeed(undefined)).toBe(1.5);
  });

  it("clamps speed and honours an explicit fallback", () => {
    expect(C.resolveSpeed(9)).toBe(3);
    expect(C.resolveSpeed(0.1)).toBe(0.5);
    expect(C.resolveSpeed("nope", 1)).toBe(1);
  });

  it("does not send Kokoro Bella to Qwen after a model switch", () => {
    expect(C.resolveVoice("qwen3-tts", { voice: "af_bella" })).toBe("ryan");
  });

  it("prefers the per-model saved voice", () => {
    expect(C.resolveVoice("qwen3-tts", { voice: "af_bella", voicePrefs: { "qwen3-tts": "vivian" } })).toBe("vivian");
  });

  it("keeps Ryan when it is valid for Qwen", () => {
    expect(C.resolveVoice("qwen3-tts", { voice: "ryan" })).toBe("ryan");
  });

  it("uses the Fish style and model defaults", () => {
    expect(C.resolveVoice("fish-s2-pro", {})).toBe("whisper");
    expect(C.resolveVoice("fish-s2-pro", { fishStyle: "calm" })).toBe("calm");
    expect(C.resolveVoice(undefined, undefined)).toBe("af_bella");
  });

  it("drops dead chunking constants", () => {
    for (const name of ["CHUNK_TARGET", "FIRST_CHUNK_TARGET", "FALLBACK_WINDOW"]) expect(C).not.toHaveProperty(name);
  });

  it("exports the v4 constants from the contract", () => {
    expect(C.READER_TEXT_THRESHOLD).toBe(4000);
    expect(C.SLOW_MODELS).toEqual(["qwen3-tts", "fish-s2-pro"]);
    expect(C.SLOW_MODEL_READER_THRESHOLD).toBe(600);
    expect(C.SLOW_START_TIMEOUT_MS).toBe(25000);
    expect(C.HISTORY_TEXT_CAP).toBe(2000);
    expect(C.HISTORY_MAX_BYTES).toBe(256000);
    expect(C.HEARTBEAT_MS).toBe(20000);
    expect(C.HIDDEN_SITES_KEY).toBe("hiddenSites");
  });

  it("matches every live value of the v3 UMD constants", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../shared/constants-umd.js", import.meta.url), "utf8");
    const global = {};
    new Function("globalThis", code)(global);
    for (const [key, value] of Object.entries(global.OpenTTSConstants)) {
      if (typeof value === "function") continue;
      expect(C[key], key).toEqual(value);
    }
  });
});
