import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(root, "..", "shared", "stream-decoder-umd.js"), "utf8");

function decoderApi() {
  const global = {};
  new Function("globalThis", code)(global);
  return global.OpenTTSStream;
}

function frame(header, audio = new Uint8Array()) {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + encoded.length + 4 + audio.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, encoded.length, true);
  out.set(encoded, 4);
  view.setUint32(4 + encoded.length, audio.length, true);
  out.set(audio, 8 + encoded.length);
  return out;
}

describe("stream frame decoder", () => {
  it("decodes a frame fragmented one byte at a time", () => {
    const { FrameDecoder } = decoderApi();
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
    const { FrameDecoder } = decoderApi();
    const decoder = new FrameDecoder();
    const a = frame({ index: 0 }, new Uint8Array([7]));
    const b = frame({ done: true });
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a);
    combined.set(b, a.length);
    expect(decoder.push(combined).map((item) => item.header)).toEqual([{ index: 0 }, { done: true }]);
    decoder.finish();
  });

  it("rejects a truncated terminal stream", () => {
    const { FrameDecoder } = decoderApi();
    const decoder = new FrameDecoder();
    decoder.push(frame({ index: 0 }, new Uint8Array([1, 2])).slice(0, -1));
    expect(() => decoder.finish()).toThrow(/truncated/i);
  });

  it("rejects absurd frame headers before buffering payloads", () => {
    const { FrameDecoder, MAX_HEADER_BYTES } = decoderApi();
    const decoder = new FrameDecoder();
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, MAX_HEADER_BYTES + 1, true);
    expect(() => decoder.push(bytes)).toThrow(/header is too large/i);
  });
});
