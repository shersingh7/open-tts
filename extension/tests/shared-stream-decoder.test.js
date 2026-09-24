import { describe, expect, it } from "vitest";
import { FrameDecoder, MAX_AUDIO_BYTES, MAX_HEADER_BYTES, StreamCursor } from "../shared/stream-decoder.js";
import { audioFrame, frame } from "./pipeline-harness.js";

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("stream frame decoder (ESM)", () => {
  it("exports the v3 budgets", () => {
    expect(MAX_HEADER_BYTES).toBe(64 * 1024);
    expect(MAX_AUDIO_BYTES).toBe(8 * 1024 * 1024);
  });

  it("decodes a frame fragmented one byte at a time", () => {
    const decoder = new FrameDecoder();
    const encoded = frame({ index: 2, final: false }, new Uint8Array([1, 2, 3]));
    const output = [];
    for (const byte of encoded) output.push(...decoder.push(new Uint8Array([byte])));
    decoder.finish();
    expect(output).toHaveLength(1);
    expect(output[0].header.index).toBe(2);
    expect([...output[0].audio]).toEqual([1, 2, 3]);
  });

  it("decodes multiple frames from one chunk", () => {
    const decoder = new FrameDecoder();
    const combined = concat([frame({ index: 0 }, new Uint8Array([7])), frame({ done: true })]);
    expect(decoder.push(combined).map((item) => item.header)).toEqual([{ index: 0 }, { done: true }]);
    decoder.finish();
  });

  it("rejects a truncated terminal stream", () => {
    const decoder = new FrameDecoder();
    decoder.push(frame({ index: 0 }, new Uint8Array([1, 2])).slice(0, -1));
    expect(() => decoder.finish()).toThrow(/truncated/i);
  });

  it("rejects absurd frame headers before buffering payloads", () => {
    const decoder = new FrameDecoder();
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, MAX_HEADER_BYTES + 1, true);
    expect(() => decoder.push(bytes)).toThrow(/header is too large/i);
  });

  it("decodes a first audio frame then later frames and done in order", () => {
    const decoder = new FrameDecoder();
    const combined = concat([
      frame({ index: 0, sample_rate: 24000, final: false }, new Uint8Array([82, 73, 70, 70, 1, 2])),
      frame({ index: 0, sample_rate: 24000, final: false }, new Uint8Array([82, 73, 70, 70, 3, 4])),
      frame({ index: 0, final: true }),
      frame({ done: true }),
    ]);
    const out = decoder.push(combined);
    decoder.finish();
    expect(out.map((item) => item.header)).toEqual([
      { index: 0, sample_rate: 24000, final: false },
      { index: 0, sample_rate: 24000, final: false },
      { index: 0, final: true },
      { done: true },
    ]);
    expect([...out[0].audio]).toEqual([82, 73, 70, 70, 1, 2]);
    expect([...out[1].audio]).toEqual([82, 73, 70, 70, 3, 4]);
    expect(out[2].audio.length).toBe(0);
  });

  it("yields coalesced frames lazily, not collected into an audio list", () => {
    const one = audioFrame();
    const all = concat(Array.from({ length: 10 }, () => one));
    const decoder = new FrameDecoder();
    const iterator = decoder.frames(all);
    expect(iterator.next().value.audio.length).toBeGreaterThan(0);
    expect(decoder.kind).toBe("headerLength");
    expect([...iterator]).toHaveLength(9);
    decoder.finish();
  });
});

describe("stream cursor (ESM)", () => {
  const audio = new Uint8Array([1]);
  const v1Audio = { index: 0, sample_rate: 24000, speed: 1, apply_playback_rate: false, playback_rate: 1 };

  function v2Frames(end) {
    const unit = { protocol_version: 2, index: 0, unit_id: 0, start: 0, end };
    return [
      [{ ...unit, sequence: 0, samples: 24000, sample_rate: 24000, speed: 1, apply_playback_rate: false, playback_rate: 1 }, audio],
      [{ ...unit, sequence: 1, unit_final: true }, new Uint8Array()],
      [{ protocol_version: 2, sequence: 2, index: 0, final: true }, new Uint8Array()],
      [{ protocol_version: 2, sequence: 3, done: true, outcome: "completed" }, new Uint8Array()],
    ];
  }

  it("accepts a complete v1 stream", () => {
    const cursor = new StreamCursor(1);
    cursor.accept(v1Audio, audio);
    cursor.accept({ index: 0, final: true }, new Uint8Array());
    cursor.accept({ done: true }, new Uint8Array());
    cursor.finishEof();
    expect(cursor.rate).toBe(24000);
  });

  it("accepts a complete v2 stream with full source coverage", () => {
    const cursor = new StreamCursor(1, 2, [5]);
    for (const [header, bytes] of v2Frames(5)) cursor.accept(header, bytes);
    cursor.finishEof();
    expect(cursor.done).toBe(true);
  });

  it("v2 refuses missing trailing source coverage", () => {
    const cursor = new StreamCursor(1, 2, [20]);
    const frames = v2Frames(2);
    cursor.accept(...frames[0]);
    cursor.accept(...frames[1]);
    expect(() => cursor.accept(...frames[2])).toThrow(/coverage/);
  });

  it("v2 refuses duplicate sequences", () => {
    const cursor = new StreamCursor(1, 2, [5]);
    const frames = v2Frames(5);
    cursor.accept(...frames[0]);
    expect(() => cursor.accept(...frames[0])).toThrow(/sequence/);
  });

  it("surfaces backend error frames with their code", () => {
    const cursor = new StreamCursor(1);
    expect(() => cursor.accept({ error: "boom", code: "generation_failed" }, new Uint8Array()))
      .toThrow(expect.objectContaining({ message: "boom", code: "generation_failed" }));
  });

  it("rejects out-of-order indexes, rate changes and EOF without done", () => {
    expect(() => new StreamCursor(1).accept({ ...v1Audio, index: 1 }, audio)).toThrow(/Out-of-order/);
    const cursor = new StreamCursor(1);
    cursor.accept(v1Audio, audio);
    expect(() => cursor.accept({ ...v1Audio, sample_rate: 22050 }, audio)).toThrow(/Sample rate changed/);
    expect(() => cursor.finishEof()).toThrow(/without final\/done/);
  });

  it("accepts keepalives only when empty", () => {
    const cursor = new StreamCursor(1);
    cursor.accept({ keepalive: true }, new Uint8Array());
    expect(() => cursor.accept({ keepalive: true, extra: 1 }, new Uint8Array())).toThrow(/keepalive/);
  });
});
