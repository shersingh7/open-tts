import { describe, expect, it } from "vitest";
import * as playback from "../shared/playback.js";

const {
  createPlaybackClock, createPlaybackGate, hardSplit, nonWhitespaceKey, normalizeText, packGenerationUnits,
  sentenceUnits, splitText,
} = playback;

describe("shared/playback.js exports", () => {
  it("does not export dead helpers", () => {
    expect(playback).not.toHaveProperty("consumePlaybackStream");
    expect(playback).not.toHaveProperty("speakStatus");
  });
});

describe("playback gate", () => {
  it("does not resume a suspended context while paused", () => {
    const gate = createPlaybackGate();
    expect(gate.shouldResumeContext("suspended")).toBe(true);
    gate.pause();
    expect(gate.isPaused()).toBe(true);
    expect(gate.shouldResumeContext("suspended")).toBe(false);
    expect(gate.canStart("suspended")).toBe(true);
    gate.resume();
    expect(gate.shouldResumeContext("suspended")).toBe(true);
  });

  it("notifies listeners and supports unsubscribe", () => {
    const gate = createPlaybackGate();
    let calls = 0;
    const off = gate.onChange(() => { calls += 1; });
    gate.pause();
    gate.reset();
    off();
    gate.resume();
    expect(calls).toBe(2);
    expect(gate.canStart("closed")).toBe(false);
    expect(gate.canStart("suspended")).toBe(false);
  });
});

describe("playback clock", () => {
  it("applies lead only before the first buffer; later buffers abut", () => {
    const clock = createPlaybackClock(0.05);
    const first = clock.schedule(0.4, 1.0);
    const second = clock.schedule(0.3, 9.0);
    const third = clock.schedule(0.2, 9.1);
    expect(first).toBeCloseTo(1.05, 5);
    expect(second).toBeCloseTo(9.05, 5);
    expect(third).toBeCloseTo(second + 0.3, 5);
    expect(second).toBeGreaterThan(9.0);
  });

  it("reports horizon and resets", () => {
    const clock = createPlaybackClock(0);
    clock.schedule(2, 1);
    expect(clock.peekNext()).toBe(3);
    expect(clock.horizon(2)).toBe(1);
    clock.reset();
    expect(clock.peekNext()).toBe(0);
  });
});

describe("splitText first-slice sizing", () => {
  it("keeps short text as a single chunk", () => {
    expect(splitText("Hello world.", 8000, 400)).toEqual(["Hello world."]);
  });

  it("emits a smaller first slice than the rest target", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = splitText(text, 8000, 80);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].length).toBeLessThanOrEqual(80);
    expect(parts[0]).toContain("Sentence number 0");
    expect(parts.join(" ")).toContain("Sentence number 39");
  });

  it("enforces MAX_CHARS and MAX_BATCH_TEXTS", () => {
    expect(() => splitText("a".repeat(200001))).toThrow(expect.objectContaining({ code: "validation_error" }));
    expect(() => splitText("Word. ".repeat(60), 6, 6)).toThrow(expect.objectContaining({ code: "batch_too_large" }));
  });
});

describe("structure preserving partitioning", () => {
  it.each(["Hello.\n\nNext paragraph.", "Dr. Smith paid 3.50. “Really?” she asked.", "Title\n\n- First\n- Second",
    "Unicode café 🌍 पाठ."])("preserves content: %s", (text) => {
    expect(splitText(text, 40, 40).join("")).toBe(normalizeText(text));
  });

  it("retains paragraphs and abbreviations", () => {
    expect(normalizeText("One.\r\n\r\nTwo.")).toBe("One.\n\nTwo.");
    expect(sentenceUnits("Dr. Smith paid 3.50. Next.")[0]).toBe("Dr. Smith paid 3.50. ");
  });

  it("repacks remainder at the larger cap and handles long tokens", () => {
    const chunks = splitText("This is a sentence. ".repeat(40), 400, 40);
    expect(chunks[1].length).toBeGreaterThan(300);
    const word = "x".repeat(400);
    expect(splitText(word, 100, 100).join("")).toBe(word);
  });

  it("does not split surrogate pairs or remove meaningful Unicode joiners", () => {
    for (const chunk of splitText("🌍".repeat(20), 5, 5)) expect(chunk.length % 2).toBe(0);
    expect(normalizeText("क्‍ष")).toBe("क्‍ष");
  });

  it("hardSplit and packGenerationUnits cover the input exactly", () => {
    const text = "Alpha beta gamma. ".repeat(30);
    expect(hardSplit(text, 50).join("")).toBe(text);
    expect(packGenerationUnits(text, 40, 120).join("")).toBe(text);
    expect(() => hardSplit("abc", 0)).toThrow(/positive/);
  });

  it("nonWhitespaceKey drops all whitespace", () => {
    expect(nonWhitespaceKey(" a b\n\tc ")).toBe("abc");
    expect(nonWhitespaceKey(null)).toBe("");
  });
});
