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

  it("surfaces errors after audio instead of silently skipping", async () => {
    const { consumePlaybackStream } = playbackApi();
    const scheduled=[];
    await expect(consumePlaybackStream((async function* () {
      yield {audio:new Uint8Array([1])};
      yield {error:"later chunk failed",code:"generation_failed"};
    })(), {schedule: async frame=>scheduled.push(frame)})).rejects.toMatchObject({code:"generation_failed",afterAudio:true});
    expect(scheduled).toHaveLength(1);
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

describe("offscreen sends resolveSpeed", () => {
  it("builds stream requests with resolveSpeed not a 1.5 fallback or", () => {
    const src = readFileSync(join(root, "..", "offscreen.js"), "utf8");
    expect(src).toMatch(/resolveSpeed\(settings\.speed\)/);
    expect(src).not.toMatch(/Number\(settings\.speed\) \|\| 1\.5/);
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

describe("playback clock", () => {
  it("applies lead only before the first buffer; later buffers abut", () => {
    const { createPlaybackClock } = playbackApi();
    const clock = createPlaybackClock(0.05);
    const first = clock.schedule(0.4, 1.0);
    const second = clock.schedule(0.3, 9.0);
    const third = clock.schedule(0.2, 9.1);
    expect(first).toBeCloseTo(1.05, 5);
    expect(second).toBeCloseTo(9.05, 5);
    expect(third).toBeCloseTo(second + 0.3, 5);
    expect(second).toBeGreaterThan(9.0);
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

describe("structure preserving partitioning", () => {
  it.each(["Hello.\n\nNext paragraph.","Dr. Smith paid 3.50. “Really?” she asked.","Title\n\n- First\n- Second", "Unicode café 🌍 पाठ."])("preserves content: %s", text => {
    const p=playbackApi(), normalized=p.norm(text);
    expect(p.splitText(text,40,40).join("")).toBe(normalized);
  });
  it("retains paragraphs and abbreviations",()=>{
    const p=playbackApi();expect(p.norm("One.\r\n\r\nTwo.")).toBe("One.\n\nTwo.");
    expect(p.sentenceUnits("Dr. Smith paid 3.50. Next.")[0]).toBe("Dr. Smith paid 3.50. ");
  });
  it("repacks remainder at the larger cap and handles long tokens",()=>{
    const p=playbackApi();const text="This is a sentence. ".repeat(40);
    const chunks=p.splitText(text,400,40);expect(chunks[1].length).toBeGreaterThan(300);
    const word="x".repeat(400);expect(p.splitText(word,100,100).join("")).toBe(word);
  });
});

it('does not split surrogate pairs or remove meaningful Unicode joiners',()=>{
  const p=playbackApi(),text='🌍'.repeat(20);
  for(const chunk of p.splitText(text,5,5)) expect(chunk.length%2).toBe(0);
  expect(p.norm('क्‍ष')).toBe('क्‍ष');
});
