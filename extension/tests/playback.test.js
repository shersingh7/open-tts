import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(root, "..", "shared", "playback-umd.js"), "utf8");

function playbackApi() {
  const global = {};
  new Function("globalThis", code)(global);
  return global.OpenTTSPlayback;
}

describe("playback consume loop", () => {
  it("schedules the first audio frame before later frames are pulled", async () => {
    const { consumePlaybackStream } = playbackApi();
    let pulled = 0;
    let laterPulledAtFirstSchedule = null;
    async function* source() {
      pulled += 1;
      yield { audio: new Uint8Array([1, 2, 3]), sampleRate: 24000, index: 0 };
      pulled += 1;
      yield { audio: new Uint8Array([4, 5, 6]), sampleRate: 24000, index: 0 };
    }
    const scheduled = [];
    const result = await consumePlaybackStream(source(), {
      schedule: async (frame) => {
        scheduled.push([...frame.audio]);
        if (scheduled.length === 1) laterPulledAtFirstSchedule = pulled;
      },
    });
    expect(laterPulledAtFirstSchedule).toBe(1);
    expect(scheduled).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(result.decoded).toBe(2);
  });

  it("keeps already-scheduled audio when a later frame errors", async () => {
    const { consumePlaybackStream } = playbackApi();
    const scheduled = [];
    const result = await consumePlaybackStream((async function* () {
      yield { audio: new Uint8Array([1]), sampleRate: 24000 };
      yield { error: "later chunk failed", code: "generation_failed" };
    })(), {
      schedule: async (frame) => { scheduled.push([...frame.audio]); },
    });
    expect(scheduled).toEqual([[1]]);
    expect(result.decoded).toBe(1);
  });

  it("schedules the first frame even when later frames are delayed", async () => {
    const { consumePlaybackStream } = playbackApi();
    let laterAvailable = false;
    const scheduled = [];
    async function* source() {
      yield { audio: new Uint8Array([9]), sampleRate: 24000 };
      laterAvailable = true;
      yield { audio: new Uint8Array([8]), sampleRate: 24000 };
    }
    await consumePlaybackStream(source(), {
      schedule: async (frame) => {
        if (scheduled.length === 0) expect(laterAvailable).toBe(false);
        scheduled.push([...frame.audio]);
      },
    });
    expect(scheduled).toEqual([[9], [8]]);
  });
});

describe("offscreen uses the abutting clock", () => {
  it("schedules through createPlaybackClock rather than re-applying lead", () => {
    const src = readFileSync(join(root, "..", "offscreen.js"), "utf8");
    expect(src).toMatch(/createPlaybackClock/);
    expect(src).toMatch(/playClock\.schedule\(/);
    expect(src).not.toMatch(/Math\.max\(nextStartTime,\s*ctx\.currentTime\s*\+\s*AUDIO_LEAD\)/);
  });
});

describe("playback gate", () => {
  it("does not resume a suspended context while paused", () => {
    const { createPlaybackGate } = playbackApi();
    const gate = createPlaybackGate();
    expect(gate.shouldResumeContext("suspended")).toBe(true);
    gate.pause();
    expect(gate.isPaused()).toBe(true);
    expect(gate.shouldResumeContext("suspended")).toBe(false);
    expect(gate.canStart("suspended")).toBe(true);
    gate.resume();
    expect(gate.shouldResumeContext("suspended")).toBe(true);
  });
});

describe("offscreen honors the pause gate", () => {
  it("will not auto-resume AudioContext on the next scheduled buffer", () => {
    const src = readFileSync(join(root, "..", "offscreen.js"), "utf8");
    expect(src).toMatch(/createPlaybackGate/);
    expect(src).toMatch(/playGate\.shouldResumeContext/);
    expect(src).not.toMatch(/if \(ctx\.state === "suspended"\) await ctx\.resume\(\);/);
  });
});

describe("playback clock", () => {
  it("applies lead only before the first buffer; later buffers abut", () => {
    const { createPlaybackClock } = playbackApi();
    const clock = createPlaybackClock(0.05);
    const first = clock.schedule(0.4, 1.0);
    const second = clock.schedule(0.3, 9.0);
    const third = clock.schedule(0.2, 99.0);
    expect(first).toBeCloseTo(1.05, 5);
    expect(second).toBeCloseTo(first + 0.4, 5);
    expect(third).toBeCloseTo(second + 0.3, 5);
    expect(second).toBeLessThan(9.0);
  });
});

describe("speak status labels", () => {
  it("never shows chunk counters", () => {
    const { speakStatus } = playbackApi();
    for (const phase of ["prepare", "generate", "read", "retry"]) {
      expect(speakStatus(phase)).not.toMatch(/\d+\s*\/\s*\d+/);
    }
    expect(speakStatus("generate")).toBe("Generating...");
    expect(speakStatus("read")).toBe("Reading...");
  });
});

describe("splitText first-slice sizing", () => {
  it("keeps short text as a single chunk", () => {
    const { splitText } = playbackApi();
    expect(splitText("Hello world.", 8000, 400)).toEqual(["Hello world."]);
  });

  it("emits a smaller first slice than the rest target", () => {
    const { splitText } = playbackApi();
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = splitText(text, 8000, 80);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].length).toBeLessThanOrEqual(80);
    expect(parts[0]).toContain("Sentence number 0");
    expect(parts.join(" ")).toContain("Sentence number 0");
    expect(parts.join(" ")).toContain("Sentence number 39");
  });
});
