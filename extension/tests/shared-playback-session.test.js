import { describe, expect, it } from "vitest";
import { bufferDecodedBytes, createPlaybackRun, readWithIdleTimeout } from "../shared/playback-session.js";
import { flush } from "./pipeline-harness.js";

class FakeContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
    this.sources = [];
  }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  createBufferSource() {
    const context = this;
    return {
      buffer: null,
      playbackRate: { value: 1 },
      connect() {},
      disconnect() { this.disconnected = true; },
      start(at) { this.startAt = at; this.endAt = at + this.buffer.duration; context.sources.push(this); },
      stop() { this.stopped = true; },
      end() { context.currentTime = Math.max(context.currentTime, this.endAt); this.onended?.(); },
    };
  }
}

describe("createPlaybackRun (ESM)", () => {
  it("enforces exact byte and duration budgets and abort releases waits", async () => {
    const run = createPlaybackRun({ highWaterSeconds: 2, lowWaterSeconds: 1, maxDecodedBytes: 192000, startupLead: 0.25 });
    const ctx = new FakeContext();
    run.setContext(ctx);
    const buf = { duration: 1, length: 24000, numberOfChannels: 1 };
    await run.scheduleBuffer(ctx, buf);
    await run.scheduleBuffer(ctx, buf);
    let resolved = false;
    const waiting = run.scheduleBuffer(ctx, buf).then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    ctx.sources[0].end();
    await waiting;
    expect(run.peakBytes).toBeLessThanOrEqual(192000);
    expect(run.peakHorizon).toBeLessThanOrEqual(2.25);
    const blocked = run.scheduleBuffer(ctx, buf);
    const rejected = expect(blocked).rejects.toMatchObject({ name: "AbortError" });
    run.teardown();
    await rejected;
    expect(ctx.state).toBe("closed");
  });

  it("rolling horizon admits a packet before the current long node ends", async () => {
    const run = createPlaybackRun({ highWaterSeconds: 4, lowWaterSeconds: 2 });
    const ctx = new FakeContext();
    run.setContext(ctx);
    await run.scheduleBuffer(ctx, { duration: 4, length: 96000, numberOfChannels: 1 });
    const pending = run.scheduleBuffer(ctx, { duration: 2, length: 48000, numberOfChannels: 1 });
    ctx.currentTime = 2.25;
    await pending;
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1].startAt).toBe(ctx.sources[0].endAt);
    expect(run.endedCount).toBe(0);
    run.teardown();
  });

  it("uses the shared constants as default limits", async () => {
    const run = createPlaybackRun();
    const ctx = new FakeContext();
    await expect(run.scheduleBuffer(ctx, { duration: 21, length: 1, numberOfChannels: 1 }))
      .rejects.toThrow(/exceeds playback budget/);
    run.teardown();
  });

  it("rejects invalid limits, non-unit playback rates and double terminals", async () => {
    expect(() => createPlaybackRun({ highWaterSeconds: 1, lowWaterSeconds: 2 })).toThrow(/Invalid playback limits/);
    const run = createPlaybackRun();
    const ctx = new FakeContext();
    await expect(run.scheduleBuffer(ctx, { duration: 1, length: 1, numberOfChannels: 1 }, 2))
      .rejects.toThrow(/exactly once/);
    expect(run.markTerminal()).toBe(true);
    expect(run.markTerminal()).toBe(false);
    expect(() => run.assertActive()).toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("tracks drain and clears the auth token on teardown", async () => {
    const run = createPlaybackRun({ authToken: "secret" });
    const ctx = new FakeContext();
    run.setContext(ctx);
    let ended = 0;
    await run.scheduleBuffer(ctx, { duration: 1, length: 24000, numberOfChannels: 1 }, 1, { onEnded: () => { ended += 1; } });
    run.markGenerationComplete();
    expect(run.playbackDrained()).toBe(false);
    ctx.sources[0].end();
    expect(ended).toBe(1);
    expect(run.playbackDrained()).toBe(true);
    run.teardown();
    expect(run.authToken).toBe("");
    expect(run.context).toBe(null);
  });

  it("decode reserves bytes and rejects concurrent or oversized decodes", async () => {
    const run = createPlaybackRun();
    let release;
    const first = run.decode(() => new Promise((resolve) => { release = resolve; }), 100);
    await flush();
    expect(run.decodedBytes).toBe(100);
    await expect(run.decode(async () => ({}), 1)).rejects.toThrow(/Concurrent/);
    release({ length: 100, numberOfChannels: 1 });
    await expect(first).rejects.toThrow(/exceeded reservation/);
    expect(run.decodedBytes).toBe(0);
  });
});

describe("readWithIdleTimeout (ESM)", () => {
  it("reader idle timeout cancels promptly", async () => {
    await expect(readWithIdleTimeout({ read: () => new Promise(() => {}) }, new AbortController().signal, 5))
      .rejects.toMatchObject({ code: "stream_timeout" });
  });

  it("resolves reads and rejects on abort", async () => {
    await expect(readWithIdleTimeout({ read: async () => ({ done: true }) }, undefined, 50)).resolves.toEqual({ done: true });
    const controller = new AbortController();
    const pending = readWithIdleTimeout({ read: () => new Promise(() => {}) }, controller.signal, 1000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("bufferDecodedBytes", () => {
  it("counts float32 samples per channel", () => {
    expect(bufferDecodedBytes({ length: 10, numberOfChannels: 2 })).toBe(80);
  });
});
