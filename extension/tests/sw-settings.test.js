import { afterEach, describe, expect, it } from "vitest";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { createSettingsResolver } from "../sw/settings.js";

afterEach(() => {
  delete globalThis.chrome;
});

function withChrome(storage) {
  globalThis.chrome = createFakeChrome({ storage });
  return globalThis.chrome;
}

describe("sw/settings", () => {
  it("defaults when storage is empty", async () => {
    withChrome({});
    expect(await createSettingsResolver().resolve(undefined)).toEqual({
      model: "kokoro", voice: "af_bella", speed: 1.5, language: "Auto", instruct: "",
    });
  });

  it("reads model/voice/speed/language from sync and instruct from local (v3 content rules)", async () => {
    withChrome({
      sync: { model: "qwen3-tts", voice: "am_adam", speed: 9, language: "English", voicePrefs: { "qwen3-tts": "serena" } },
      local: { instruct: "calm" },
    });
    expect(await createSettingsResolver().resolve(null)).toEqual({
      model: "qwen3-tts", voice: "serena", speed: 3, language: "English", instruct: "calm",
    });
  });

  it("fish uses fishStyle as the voice", async () => {
    withChrome({ sync: { model: "fish-s2-pro", fishStyle: "narrator" } });
    expect((await createSettingsResolver().resolve(undefined)).voice).toBe("narrator");
  });

  it("migrates a legacy synced instruction to local storage", async () => {
    const chrome = withChrome({ sync: { instruct: "old" } });
    expect((await createSettingsResolver().resolve(undefined)).instruct).toBe("old");
    expect(chrome.fake.storageData.local.instruct).toBe("old");
    expect(chrome.fake.storageData.sync.instruct).toBeUndefined();
  });

  it("an instruction read failure falls back to empty", async () => {
    withChrome({});
    const resolver = createSettingsResolver({ readInstruction: () => Promise.reject(new Error("x")) });
    expect((await resolver.resolve(undefined)).instruct).toBe("");
  });

  it("normalises UI-provided settings", async () => {
    withChrome({ sync: { voicePrefs: { kokoro: "af_sky" } } });
    const resolver = createSettingsResolver();
    expect(await resolver.resolve({ model: "kokoro", voice: "am_echo", speed: 0.1, language: "", instruct: "x" }))
      .toEqual({ model: "kokoro", voice: "am_echo", speed: 0.5, language: "Auto", instruct: "x" });
    expect(await resolver.resolve({ model: "kokoro" })).toEqual({
      model: "kokoro", voice: "af_sky", speed: 1.5, language: "Auto", instruct: "",
    });
  });
});
