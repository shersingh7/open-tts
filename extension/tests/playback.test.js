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

describe("dead playback helpers", () => {
  it("no longer exports consumePlaybackStream or speakStatus", () => {
    const api = playbackApi();
    expect(api).not.toHaveProperty("consumePlaybackStream");
    expect(api).not.toHaveProperty("speakStatus");
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
