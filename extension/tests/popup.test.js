import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("popup Signal Chassis", () => {
  it("uses Volume Booster Pro chassis / LCD / signal tokens, not purple SaaS", () => {
    const css = readFileSync(join(root, "..", "popup.css"), "utf8");
    expect(css).toMatch(/#e4ddd0/i);
    expect(css).toMatch(/#121410/i);
    expect(css).toMatch(/#ff5c14/i);
    expect(css).not.toMatch(/#6c5ce7/);
  });

  it("still exposes Open TTS server, model, voice, speed, and playback controls", () => {
    const html = readFileSync(join(root, "..", "popup.html"), "utf8");
    for (const id of [
      "startBtn",
      "stopBtn",
      "model",
      "voice",
      "speed",
      "speakBtn",
      "pauseBtn",
      "stopPlaybackBtn",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
