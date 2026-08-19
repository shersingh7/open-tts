import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(root, "..", "shared", "constants-umd.js"), "utf8");

function constantsApi() {
  const global = {};
  new Function("globalThis", code)(global);
  return global.OpenTTSConstants;
}

describe("model load timeout", () => {
  it("gives Qwen/Fish several minutes instead of a 30s abort", () => {
    const c = constantsApi();
    expect(c.LOAD_MODEL_TIMEOUT_MS).toBeGreaterThanOrEqual(180000);
    const background = readFileSync(join(root, "..", "background.js"), "utf8");
    expect(background).toMatch(/timeout:\s*LOAD_MODEL_TIMEOUT_MS/);
  });
});

describe("resolveVoice", () => {
  it("does not send Kokoro Bella to Qwen after a model switch", () => {
    const { resolveVoice } = constantsApi();
    expect(resolveVoice("qwen3-tts", { voice: "af_bella" })).toBe("ryan");
  });

  it("prefers the per-model saved voice", () => {
    const { resolveVoice } = constantsApi();
    expect(resolveVoice("qwen3-tts", {
      voice: "af_bella",
      voicePrefs: { "qwen3-tts": "vivian" },
    })).toBe("vivian");
  });

  it("keeps Ryan when it is valid for Qwen", () => {
    const { resolveVoice } = constantsApi();
    expect(resolveVoice("qwen3-tts", { voice: "ryan" })).toBe("ryan");
  });
});
