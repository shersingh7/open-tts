// host/engine.js — ports every v3 offscreen.test.js / progressive.test.js pipeline test to the injectable engine,
// plus v4 behaviour: host→SW message shapes, slow_start deadline, heartbeat cadence, one terminal per run.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine, SLOW_START_MESSAGE, wavInfo } from "../host/engine.js";
import { HEARTBEAT_MS } from "../shared/constants.js";
import { MSG } from "../shared/messages.js";
import { FrameDecoder, StreamCursor } from "../shared/stream-decoder.js";
import { createPlaybackRun, readWithIdleTimeout } from "../shared/playback-session.js";
import {
  audioFrame, deferred, ending, engineHarness, flush, frame, makeContextClass, response, v2Frames, v2Response, wav,
} from "./host-harness.js";

const types = (events) => events.map((event) => event.type);

describe("engine pipeline (ported from v3 offscreen.test.js)", () => {
  it("accepts keepalive while awaiting real audio, but never treats it as completion", async () => {
    const h = engineHarness({ fetch: () => response([frame({ keepalive: true }), audioFrame(), ...ending()]) });
    h.speak();
    await flush(150);
    expect(h.terminals()).toHaveLength(0);
    expect(h.contexts[0].sources).toHaveLength(1);
    h.contexts[0].sources[0].end();
    await flush();
    expect(types(h.terminals())).toEqual([MSG.DONE]);
    const cursor = new StreamCursor(1);
    cursor.accept({ keepalive: true }, new Uint8Array());
    expect(() => cursor.finishEof()).toThrow();
    expect(() => cursor.accept({ keepalive: true }, new Uint8Array([1]))).toThrow();
  });

  it("preserves paragraphs and completes only after sources end", async () => {
    const h = engineHarness();
    h.speak();
    await flush();
    expect(JSON.parse(h.requests[0].body).texts.join("")).toBe("Hello.\n\nNext paragraph.");
    expect(h.terminals()).toHaveLength(0);
    h.contexts[0].sources[0].end();
    await flush();
    expect(types(h.terminals())).toEqual([MSG.DONE]);
    expect(h.terminals()[0]).toMatchObject({ runId: "A", outcome: "completed" });
    expect(h.contexts[0].state).toBe("closed");
  });

  it("late decode cannot schedule or finish a replacement run", async () => {
    const gate = deferred();
    let first = true;
    const h = engineHarness({
      decode: () => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return undefined;
      },
    });
    h.speak("A");
    await flush();
    h.speak("B");
    await flush();
    gate.resolve();
    await flush();
    expect(h.contexts[0].sources).toHaveLength(0);
    expect(h.contexts[1].sources).toHaveLength(1);
    expect(h.terminals().filter((event) => event.runId === "B")).toHaveLength(0);
    h.contexts[1].sources[0].end();
    await flush();
    expect(h.terminals().map((event) => event.runId)).toEqual(["A", "B"]);
    expect(h.terminals().map((event) => event.outcome)).toEqual(["superseded", "completed"]);
  });

  it("stop during headers prevents a late response from creating audio", async () => {
    const gate = deferred();
    const h = engineHarness({ fetch: () => gate.promise });
    h.speak();
    await flush();
    h.engine.stop("A", "stopped");
    gate.resolve(response([audioFrame(), ...ending()]));
    await flush();
    expect(h.contexts).toHaveLength(0);
    expect(h.terminals()).toHaveLength(1);
    expect(h.terminals()[0]).toMatchObject({ type: MSG.DONE, outcome: "stopped" });
  });

  it("pause survives decode and EOF; resume drains once", async () => {
    const gate = deferred();
    const h = engineHarness({ decode: () => gate.promise });
    h.speak();
    await flush();
    await h.engine.pause("A");
    gate.resolve();
    await flush();
    expect(h.contexts[0].state).toBe("suspended");
    expect(h.terminals()).toHaveLength(0);
    await h.engine.resume("A");
    h.contexts[0].sources[0].end();
    await flush();
    expect(types(h.terminals())).toEqual([MSG.DONE]);
  });

  it.each([
    [[frame({ error: "Broken passage", code: "generation_failed" })]],
    [[]],
    [[frame({ index: 0, final: true })]],
    [[frame({ done: true })]],
    [[...ending(), audioFrame()]],
    [[frame({ index: 0, final: true }), frame({ index: 0, final: true }), frame({ done: true })]],
  ])("never retries or succeeds on partial/malformed stream %#", async (tail) => {
    const h = engineHarness({ fetch: () => response([audioFrame(), ...tail]) });
    h.speak();
    await flush(150);
    expect(h.requests).toHaveLength(1);
    expect(types(h.terminals())).toEqual([MSG.ERROR]);
    expect(h.terminals()[0].outcome).toBe("failed");
    expect(h.contexts[0].sources[0].stopped).toBe(true);
  });

  it("forwards a server error frame's message and code", async () => {
    const h = engineHarness({
      fetch: () => response([audioFrame(), frame({ error: "Broken passage", code: "generation_failed" })]),
    });
    h.speak();
    await flush(150);
    expect(h.terminals()[0]).toMatchObject({ message: "Broken passage", code: "generation_failed" });
  });

  it("rejects oversized WAV before decode", async () => {
    let decoded = false;
    const h = engineHarness({
      fetch: () => response([audioFrame(21), ...ending()]),
      decode: () => {
        decoded = true;
      },
    });
    h.speak();
    await flush();
    expect(decoded).toBe(false);
    expect(h.terminals()[0].type).toBe(MSG.ERROR);
  });

  it("rebases after starvation, then abuts the next burst", async () => {
    const gate = deferred();
    const h = engineHarness({ fetch: () => response([audioFrame(), gate.promise, audioFrame(), ...ending()]) });
    h.speak();
    await flush();
    const ctx = h.contexts[0];
    ctx.sources[0].end();
    ctx.currentTime = 10;
    gate.resolve(audioFrame());
    await flush(150);
    expect(ctx.sources[1].startAt).toBeGreaterThanOrEqual(10);
    expect(ctx.sources[2].startAt).toBeCloseTo(ctx.sources[1].endAt, 8);
    h.engine.stop("A", "stopped");
  });

  it("bounds a 2000-frame production soak, including pause and cleanup", async () => {
    const count = 2000;
    const sample = audioFrame(1);
    const h = engineHarness({ fetch: () => response([...Array(count).fill(sample), ...ending()]) });
    h.speak();
    await flush(1200);
    const ctx = h.contexts[0];
    await h.engine.pause("A");
    await flush(40000);
    expect(ctx.sources.length).toBeLessThan(count);
    const pausedCount = ctx.sources.length;
    await flush(200);
    expect(ctx.sources.length).toBe(pausedCount);
    await h.engine.resume("A");
    let ended = 0;
    for (let i = 0; i < 10000 && h.terminals().length === 0; i++) {
      while (ended < ctx.sources.length) ctx.sources[ended++].end();
      await flush(30);
    }
    expect(ended).toBe(count);
    expect(types(h.terminals())).toEqual([MSG.DONE]);
    for (let i = 1; i < ctx.sources.length; i++) {
      expect(ctx.sources[i].startAt).toBeGreaterThanOrEqual(ctx.sources[i - 1].endAt - 1e-8);
    }
    expect(ctx.sources.every((source) => source.buffer === null && source.disconnected)).toBe(true);
    const { metrics } = h.terminals()[0];
    expect(metrics.peakBufferedSeconds).toBeLessThanOrEqual(20.25);
    expect(metrics.peakDecodedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("duplicate delivery is idempotent for the current run", async () => {
    const h = engineHarness();
    h.speak();
    await flush();
    h.speak();
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.contexts).toHaveLength(1);
    h.engine.stop("A", "stopped");
  });

  it.each(["pause", "resume"])("failed %s terminates and releases the run instead of leaving it stuck",
    async (control) => {
      const failure = () => Promise.reject(new Error("Audio device unavailable"));
      const h = engineHarness(control === "pause" ? { suspend: failure } : { resume: failure });
      h.speak();
      await flush();
      const result = await h.engine[control]("A");
      await flush();
      expect(result.ok).toBe(false);
      expect(types(h.terminals())).toEqual([MSG.ERROR]);
      expect(h.terminals()[0].message).toBe("Audio device unavailable");
      expect(h.contexts[0].state).toBe("closed");
      expect(h.engine.activeRun()).toBeNull();
    });

  it("late resume cannot revive a stopped context", async () => {
    const gate = deferred();
    const h = engineHarness({ resume: () => gate.promise });
    h.speak();
    await flush();
    await h.engine.pause("A");
    const resuming = h.engine.resume("A");
    await flush();
    h.engine.stop("A", "stopped");
    gate.resolve();
    await resuming;
    await flush();
    expect(h.terminals()).toHaveLength(1);
    expect(h.contexts[0].state).toBe("closed");
  });
});

describe("shared run queue (ported from v3 offscreen.test.js)", () => {
  it("run queue enforces exact byte and duration budgets and abort releases waits", async () => {
    const run = createPlaybackRun({ highWaterSeconds: 2, lowWaterSeconds: 1, maxDecodedBytes: 192000, startupLead: 0.25 });
    const Context = makeContextClass();
    const ctx = new Context();
    run.setContext(ctx);
    const buf = { duration: 1, length: 24000, numberOfChannels: 1 };
    await run.scheduleBuffer(ctx, buf);
    await run.scheduleBuffer(ctx, buf);
    let resolved = false;
    const waiting = run.scheduleBuffer(ctx, buf).then(() => {
      resolved = true;
    });
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
  });

  it("reader idle timeout cancels promptly", async () => {
    const read = () => new Promise(() => {});
    await expect(readWithIdleTimeout({ read }, new AbortController().signal, 5))
      .rejects.toMatchObject({ code: "stream_timeout" });
  });

  it("rolling horizon admits a packet before the current long node ends", async () => {
    const run = createPlaybackRun({ highWaterSeconds: 4, lowWaterSeconds: 2 });
    const Context = makeContextClass();
    const ctx = new Context();
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

  it("coalesced frames are yielded lazily, not collected into an audio list", () => {
    const single = audioFrame();
    const all = new Uint8Array(single.length * 10);
    for (let i = 0; i < 10; i++) all.set(single, i * single.length);
    const decoder = new FrameDecoder();
    const iterator = decoder.frames(all);
    expect(iterator.next().value.audio.length).toBeGreaterThan(0);
    expect(decoder.kind).toBe("headerLength");
    expect([...iterator]).toHaveLength(9);
    decoder.finish();
  });
});

describe("engine v2 protocol (ported from v3 progressive.test.js)", () => {
  it.each(["reader", "offscreen"])("%s uses the v2 pipeline and waits for audible-source drain", async (hostKind) => {
    const h = engineHarness({ hostKind, fetch: async () => v2Response(v2Frames("Hi 😀")) });
    h.speakV2("A", "Hi 😀");
    await flush();
    expect(JSON.parse(h.requests[0].body).protocol_version).toBe(2);
    expect(h.ofType(MSG.DONE)).toHaveLength(0);
    h.contexts[0].sources[0].end();
    await flush();
    const done = h.ofType(MSG.DONE);
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("completed");
    expect(h.ofType(MSG.PROGRESS).find((event) => event.end).end).toBe(4);
  });

  it("Reader retry begins at the first not-fully-played passage", async () => {
    const gate = deferred();
    const local = [];
    const unit = { protocol_version: 2, index: 0, unit_id: 0, start: 0, end: 6 };
    const h = engineHarness({
      hostKind: "reader",
      onTerminal: (info) => local.push(info),
      fetch: async () => v2Response([
        frame({
          ...unit, sequence: 0, samples: 2400, sample_rate: 24000, speed: 1, apply_playback_rate: false,
          playback_rate: 1,
        }, wav(0.1)),
        frame({ ...unit, sequence: 1, unit_final: true }),
        gate.promise,
      ]),
    });
    h.speakV2("A", "First. Second.");
    await flush();
    h.contexts[0].sources[0].end();
    await flush();
    h.engine.stop("A", "stopped");
    expect(local).toEqual([expect.objectContaining({ runId: "A", outcome: "stopped", retryText: " Second." })]);
    // DONE carries only the contract fields; the interruption text stays in the Reader page.
    expect(h.events.every((event) => event.retryText === undefined)).toBe(true);
    gate.resolve(frame({ error: "cancelled" }));
    await flush();
  });

  it("Reader ERROR carries retryText; offscreen ERROR does not", async () => {
    const make = (hostKind) => engineHarness({
      hostKind,
      fetch: () => response([audioFrame(), frame({ error: "Broken passage" })]),
    });
    const reader = make("reader");
    reader.speak("A", "Only text.");
    await flush(150);
    expect(reader.terminals()[0]).toMatchObject({ type: MSG.ERROR, retryText: "Only text." });
    const offscreen = make("offscreen");
    offscreen.speak("A", "Only text.");
    await flush(150);
    expect(offscreen.terminals()[0].type).toBe(MSG.ERROR);
    expect(offscreen.terminals()[0].retryText).toBeUndefined();
  });

  it("v2 refuses missing trailing source coverage", async () => {
    const h = engineHarness({ fetch: async () => v2Response(v2Frames("Hi")) });
    h.speakV2("A", "Hi plus omitted text");
    await flush();
    expect(h.ofType(MSG.ERROR)[0].message).toMatch(/coverage/);
    expect(h.events.some((event) => event.outcome === "completed")).toBe(false);
  });

  it("v2 refuses duplicate sequences", async () => {
    const parts = v2Frames();
    const h = engineHarness({ fetch: async () => v2Response([parts[0], parts[0], ...parts.slice(1)]) });
    h.speakV2();
    await flush();
    expect(h.ofType(MSG.ERROR)[0].message).toMatch(/sequence/);
  });

  it("v2 refuses a backend without the v2 protocol header", async () => {
    const h = engineHarness({ fetch: async () => response(v2Frames()) });
    h.speakV2();
    await flush();
    expect(h.ofType(MSG.ERROR)[0].message).toMatch(/protocol mismatch/);
  });

  it("legacy oversized packets fail explicitly before decode", async () => {
    let decoded = false;
    const h = engineHarness({
      decode: async () => {
        decoded = true;
      },
      fetch: async () => response([audioFrame(20)]),
    });
    h.speak();
    await flush();
    expect(decoded).toBe(false);
    expect(h.ofType(MSG.ERROR)[0].message).toMatch(/duration budget/);
  });
});

describe("engine request and messages (v4)", () => {
  it("posts the batch request with the token and resolved settings", async () => {
    const h = engineHarness({ fetch: async () => v2Response(v2Frames("Hello")) });
    h.speak("A", "Hello", {
      protocolVersion: 2,
      authToken: "secret-token",
      settings: { model: "kokoro", voice: "af_sarah", speed: 9, language: "English", instruct: "calm" },
    });
    await flush();
    const request = h.requests[0];
    expect(request.url).toBe("http://127.0.0.1:8000/v1/synthesize-stream-batch");
    expect(request.method).toBe("POST");
    expect(request.headers["X-Open-TTS-Token"]).toBe("secret-token");
    expect(JSON.parse(request.body)).toEqual({
      texts: ["Hello"], protocol_version: 2, voice: "af_sarah", speed: 3, language: "English", model: "kokoro",
      instruct: "calm",
    });
    h.engine.stop("A", "stopped");
  });

  it("maps HTTP errors through parseApiErrorBody", async () => {
    const h = engineHarness({
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ detail: { message: "Model busy", code: "busy" } }),
      }),
    });
    h.speak();
    await flush();
    expect(h.terminals()).toEqual([expect.objectContaining({
      type: MSG.ERROR, runId: "A", outcome: "failed", message: "Model busy", code: "busy",
    })]);
  });

  it("emits contract STATUS / PROGRESS / DONE shapes with v3 metric names", async () => {
    let clock = 1000;
    const h = engineHarness({ engine: { now: () => clock++ } });
    h.speak();
    await flush();
    const states = h.ofType(MSG.STATUS).map((event) => [event.state, event.label]);
    expect(states.slice(0, 3)).toEqual([
      ["preparing", "Preparing..."], ["buffering", "Generating..."], ["playing", "Reading..."],
    ]);
    for (const event of h.events) expect(event.runId).toBe("A");
    h.contexts[0].sources[0].end();
    await flush();
    expect(h.ofType(MSG.PROGRESS)[0]).toMatchObject({ runId: "A", played: 1, scheduled: 1 });
    const done = h.ofType(MSG.DONE)[0];
    expect(Object.keys(done).sort()).toEqual(["metrics", "outcome", "runId", "type"]);
    expect(done.metrics).toMatchObject({ acceptedAt: 1000, underflows: 0, terminalOutcome: "completed" });
    for (const name of ["firstPacketAt", "firstScheduledAt", "generationFinishedAt", "terminalAt"]) {
      expect(typeof done.metrics[name]).toBe("number");
    }
  });

  it("records firstAudioClockStartedAt once the context clock reaches the first start", async () => {
    const h = engineHarness({ fetch: () => response([audioFrame(), audioFrame(), ...ending()]) });
    h.speak();
    await flush();
    const ctx = h.contexts[0];
    ctx.sources[0].end();
    await new Promise((resolve) => setTimeout(resolve, 80));
    ctx.sources[1].end();
    await flush();
    expect(typeof h.ofType(MSG.DONE)[0].metrics.firstAudioClockStartedAt).toBe("number");
  });

  it("reports Buffering... on underflow and Paused / Reading... on controls", async () => {
    const gate = deferred();
    const h = engineHarness({ fetch: () => response([audioFrame(), gate.promise, ...ending()]) });
    h.speak();
    await flush();
    h.contexts[0].sources[0].end();
    await flush();
    expect(h.ofType(MSG.STATUS).at(-1)).toMatchObject({ state: "buffering", label: "Buffering..." });
    expect(await h.engine.pause("A")).toEqual({ ok: true, paused: true });
    expect(h.ofType(MSG.STATUS).at(-1)).toMatchObject({ state: "paused", label: "Paused" });
    expect(h.engine.activeRun()).toEqual({ runId: "A", state: "paused", paused: true });
    await h.engine.resume("A");
    expect(h.ofType(MSG.STATUS).at(-1)).toMatchObject({ state: "buffering", label: "Buffering..." });
    h.engine.stop("A", "stopped");
    gate.resolve(audioFrame());
  });

  it("latest control wins when context promises resolve out of order", async () => {
    const suspendGate = deferred();
    let suspends = 0;
    const h = engineHarness({
      suspend: () => {
        suspends++;
        return suspends === 1 ? suspendGate.promise : Promise.resolve();
      },
    });
    h.speak();
    await flush();
    const pausing = h.engine.pause("A");
    const resuming = h.engine.resume("A");
    await resuming;
    suspendGate.resolve();
    await pausing;
    expect(h.contexts[0].state).toBe("running");
    expect(h.engine.activeRun().paused).toBe(false);
    h.engine.stop("A", "stopped");
  });

  it("ignores controls and stops for another runId", async () => {
    const h = engineHarness();
    h.speak("A");
    await flush();
    expect(await h.engine.pause("B")).toMatchObject({ ok: false, ignored: true });
    expect(h.engine.stop("B", "stopped")).toBe(false);
    expect(h.engine.activeRun()).toMatchObject({ runId: "A", paused: false });
    expect(h.terminals()).toHaveLength(0);
    h.engine.stop("A", "stopped");
  });

  it("activeRun is null when idle and reports the run otherwise", async () => {
    const h = engineHarness();
    expect(h.engine.activeRun()).toBeNull();
    h.speak("A");
    await flush();
    expect(h.engine.activeRun()).toEqual({ runId: "A", state: "playing", paused: false });
  });

  it("rejects empty text with a terminal error", async () => {
    const h = engineHarness();
    h.speak("A", "   ");
    await flush();
    expect(h.terminals()).toEqual([expect.objectContaining({ type: MSG.ERROR, message: "Nothing to read" })]);
    expect(h.requests).toHaveLength(0);
  });

  it("wavInfo validates the container and duration budget", () => {
    expect(wavInfo(wav(0.5), 24000).duration).toBeCloseTo(0.5, 8);
    expect(() => wavInfo(wav(0.5), 22050)).toThrow(/inconsistent/);
    expect(() => wavInfo(wav(5), 24000)).toThrow(/duration budget/);
    expect(() => wavInfo(new Uint8Array(10), 24000)).toThrow(/Invalid WAV/);
  });
});

describe("one terminal per run under stop / replace races", () => {
  it("stop(runId, outcome) emits DONE with that outcome exactly once", async () => {
    for (const outcome of ["stopped", "superseded"]) {
      const h = engineHarness();
      h.speak("A");
      await flush();
      expect(h.engine.stop("A", outcome)).toBe(true);
      expect(h.engine.stop("A", outcome)).toBe(false);
      await flush();
      expect(h.terminals()).toEqual([expect.objectContaining({ type: MSG.DONE, runId: "A", outcome })]);
    }
  });

  it("stop then speak of a replacement keeps each run to one terminal", async () => {
    const h = engineHarness();
    h.speak("A");
    await flush();
    h.engine.stop("A", "superseded");
    h.speak("B");
    h.engine.stop("A", "stopped");
    await flush();
    h.contexts[1].sources[0].end();
    await flush();
    expect(h.terminals().map((event) => [event.runId, event.outcome])).toEqual([
      ["A", "superseded"], ["B", "completed"],
    ]);
  });

  it("an error racing a stop yields only the stop", async () => {
    const gate = deferred();
    const h = engineHarness({ fetch: () => response([audioFrame(), gate.promise]) });
    h.speak("A");
    await flush();
    h.engine.stop("A", "stopped");
    gate.resolve(frame({ error: "late failure" }));
    await flush();
    expect(types(h.terminals())).toEqual([MSG.DONE]);
  });

  it("source end after stop does not emit PROGRESS or a second terminal", async () => {
    const h = engineHarness();
    h.speak("A");
    await flush();
    const source = h.contexts[0].sources[0];
    h.engine.stop("A", "stopped");
    const count = h.events.length;
    source.end();
    await flush();
    expect(h.events).toHaveLength(count);
  });
});

describe("timers: slow_start deadline and heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails with slow_start when no audio is scheduled before firstAudioDeadlineMs", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const h = engineHarness({ fetch: () => pending.promise });
    h.speak("A", "Hello", { firstAudioDeadlineMs: 25000 });
    await flush();
    vi.advanceTimersByTime(24999);
    expect(h.terminals()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(h.terminals()).toEqual([expect.objectContaining({
      type: MSG.ERROR, runId: "A", outcome: "failed", code: "slow_start", message: SLOW_START_MESSAGE,
    })]);
    expect(SLOW_START_MESSAGE).toBe("Model is slow to start — retry to open the Reader");
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.engine.activeRun()).toBeNull();
  });

  it("does not fire the deadline once audio is scheduled", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const h = engineHarness({ fetch: () => response([audioFrame(), gate.promise]) });
    h.speak("A", "Hello", { firstAudioDeadlineMs: 1000 });
    await flush();
    expect(h.contexts[0].sources).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.terminals()).toHaveLength(0);
    h.engine.stop("A", "stopped");
  });

  it("null deadline never fails a slow start", async () => {
    vi.useFakeTimers();
    const h = engineHarness({ fetch: () => new Promise(() => {}) });
    h.speak("A", "Hello", { firstAudioDeadlineMs: null });
    await flush();
    vi.advanceTimersByTime(59000);
    await flush();
    expect(h.terminals()).toHaveLength(0);
    h.engine.stop("A", "stopped");
  });

  it("emits HEARTBEAT every HEARTBEAT_MS while a run exists, including paused, and stops after terminal", async () => {
    vi.useFakeTimers();
    const h = engineHarness({ fetch: () => new Promise(() => {}) });
    const beats = () => h.ofType(MSG.HEARTBEAT);
    h.speak("A");
    await flush();
    expect(beats()).toHaveLength(0);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(beats()).toEqual([{ type: MSG.HEARTBEAT, runId: "A" }]);
    await h.engine.pause("A");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(beats()).toHaveLength(2);
    h.engine.stop("A", "stopped");
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(beats()).toHaveLength(2);
  });

  it("uses the injected timer functions", async () => {
    const timers = [];
    const cleared = [];
    const h = engineHarness({
      fetch: () => new Promise(() => {}),
      engine: {
        setTimeout: (fn, ms) => {
          timers.push({ fn, ms });
          return timers.length;
        },
        clearTimeout: (id) => cleared.push(id),
      },
    });
    h.speak("A", "Hello", { firstAudioDeadlineMs: 5000 });
    await flush();
    expect(timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([5000, HEARTBEAT_MS]);
    timers.find((timer) => timer.ms === HEARTBEAT_MS).fn();
    expect(h.ofType(MSG.HEARTBEAT)).toHaveLength(1);
    expect(timers.filter((timer) => timer.ms === HEARTBEAT_MS)).toHaveLength(2);
    h.engine.stop("A", "stopped");
    expect(cleared.length).toBeGreaterThanOrEqual(2);
  });
});

it("createEngine requires emit and a valid hostKind", () => {
  expect(() => createEngine({ emit: null, hostKind: "offscreen" })).toThrow();
  expect(() => createEngine({ emit: () => {}, hostKind: "tab" })).toThrow();
});
