// @ts-check
// Open TTS v4 — per-run playback resources and backpressure (ESM). Behaviour mirrors playback-session-umd.js.

import {
  PLAYBACK_HIGH_WATER_SECONDS,
  PLAYBACK_LOW_WATER_SECONDS,
  PLAYBACK_MAX_DECODED_BYTES,
  PLAYBACK_STARTUP_LEAD,
  STREAM_IDLE_TIMEOUT_MS,
} from "./constants.js";
import { createPlaybackClock, createPlaybackGate } from "./playback.js";

/** @returns {Error & {name: "AbortError"}} */
function abortError() {
  return Object.assign(new Error("Playback cancelled"), { name: /** @type {const} */ ("AbortError") });
}

/**
 * Bytes held by a decoded AudioBuffer (float32 per sample per channel).
 * @param {{length: number, numberOfChannels: number}} buf
 * @returns {number}
 */
export function bufferDecodedBytes(buf) {
  return buf.length * buf.numberOfChannels * 4;
}

/**
 * @typedef {object} PlaybackRunOptions
 * @property {number} [highWaterSeconds]
 * @property {number} [lowWaterSeconds]
 * @property {number} [maxDecodedBytes]
 * @property {number} [startupLead]
 * @property {string} [authToken] cleared on teardown
 */

/**
 * @typedef {object} ScheduleHooks
 * @property {() => void} [onEnded] called when a source finishes while the run is still active
 */

/**
 * Create one playback run: the single owner of its AudioContext, sources and asynchronous continuations.
 * Contexts are never shared between runs, so a late resume/decode cannot touch a replacement run.
 * Extra option fields (runId, authToken, ...) are copied onto the returned run object.
 * @param {PlaybackRunOptions & Record<string, any>} [opts]
 */
export function createPlaybackRun(opts = {}) {
  const high = opts.highWaterSeconds ?? PLAYBACK_HIGH_WATER_SECONDS;
  const low = opts.lowWaterSeconds ?? PLAYBACK_LOW_WATER_SECONDS;
  const maxBytes = opts.maxDecodedBytes ?? PLAYBACK_MAX_DECODED_BYTES;
  const lead = opts.startupLead ?? PLAYBACK_STARTUP_LEAD;
  const controller = new AbortController();
  const clock = createPlaybackClock(lead);
  const gate = createPlaybackGate();
  /** @type {Set<any>} */
  const sources = new Set();
  /** @type {Set<() => void>} */
  const waiters = new Set();
  let queuedSeconds = 0;
  let decodedBytes = 0;
  let scheduledCount = 0;
  let endedCount = 0;
  let peakBytes = 0;
  let peakHorizon = 0;
  let generationComplete = false;
  let terminal = false;
  let decoding = false;
  /** @type {any} */
  let context = null;
  let pendingBytes = 0;
  const remaining = () => (controller.signal.aborted || !context
    ? 0
    : Math.max(0, clock.peekNext() - context.currentTime));
  const notify = () => {
    for (const check of [...waiters]) check();
  };
  if (!(high > low && low >= 0 && maxBytes > 0 && Number.isFinite(high))) throw new Error("Invalid playback limits");
  controller.signal.addEventListener("abort", notify, { once: true });
  const run = {
    ...opts,
    controller,
    clock,
    gate,
    sources,
    maxBytes,
    get signal() { return controller.signal; },
    get context() { return context; },
    /** @param {any} ctx */
    setContext(ctx) { context = ctx; },
    get scheduledAny() { return scheduledCount > 0; },
    get scheduledCount() { return scheduledCount; },
    get endedCount() { return endedCount; },
    get queuedSeconds() { return remaining(); },
    get decodedBytes() { return decodedBytes + pendingBytes; },
    get peakBytes() { return peakBytes; },
    get peakHorizon() { return peakHorizon; },
    get terminalEmitted() { return terminal; },
    assertActive() {
      if (controller.signal.aborted || terminal) throw abortError();
    },
    /**
     * Wait until `seconds` more audio and `bytes` more decoded data fit the high-water budgets.
     * @param {number} [seconds]
     * @param {number} [bytes]
     * @returns {Promise<void>}
     */
    async waitForBudget(seconds = 0, bytes = 0) {
      run.assertActive();
      if (seconds > high || bytes > maxBytes) throw new Error("Audio frame exceeds playback budget");
      const throttled = remaining() + seconds > high + lead || decodedBytes + bytes > maxBytes;
      if (!throttled) return;
      await new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        /** @param {Error} [error] */
        const finish = (error) => {
          clearTimeout(timer);
          waiters.delete(check);
          if (error) reject(error);
          else resolve(undefined);
        };
        const check = () => {
          clearTimeout(timer);
          if (controller.signal.aborted) {
            finish(abortError());
            return;
          }
          const secondsLeft = remaining();
          if (secondsLeft <= low && secondsLeft + seconds <= high + lead && decodedBytes + bytes <= maxBytes) {
            finish();
            return;
          }
          timer = setTimeout(check, 50);
        };
        waiters.add(check);
        check();
      });
      run.assertActive();
    },
    /**
     * Run one decode with `estimatedBytes` reserved against the byte budget.
     * @template {{length: number, numberOfChannels: number}} T
     * @param {() => Promise<T>} fn
     * @param {number} estimatedBytes
     * @returns {Promise<T>}
     */
    async decode(fn, estimatedBytes) {
      run.assertActive();
      if (decoding) throw new Error("Concurrent audio decode");
      await run.waitForBudget(0, estimatedBytes);
      pendingBytes = estimatedBytes;
      peakBytes = Math.max(peakBytes, decodedBytes + pendingBytes);
      decoding = true;
      try {
        const buf = await fn();
        run.assertActive();
        if (bufferDecodedBytes(buf) > estimatedBytes) throw new Error("Decoded audio exceeded reservation");
        return buf;
      } finally {
        decoding = false;
        pendingBytes = 0;
      }
    },
    /**
     * Schedule a decoded buffer gaplessly after the previous one (waits for budget first).
     * @param {any} ctx AudioContext-like
     * @param {any} buf AudioBuffer-like
     * @param {number} [rate] must be 1: the server applies speed exactly once
     * @param {ScheduleHooks} [hooks]
     * @returns {Promise<{startAt: number, endAt: number, rebuffered: boolean}>}
     */
    async scheduleBuffer(ctx, buf, rate = 1, hooks = {}) {
      run.assertActive();
      if (rate !== 1) throw new Error("Server must apply audio speed exactly once");
      const duration = buf.duration;
      const bytes = bufferDecodedBytes(buf);
      if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("Invalid audio duration");
      await run.waitForBudget(duration, bytes);
      if (gate.shouldResumeContext(ctx.state)) await ctx.resume();
      run.assertActive();
      // Pause may arrive while resume is pending.
      if (gate.isPaused() && ctx.state === "running") await ctx.suspend();
      run.assertActive();
      if (!gate.canStart(ctx.state)) throw new Error("Audio playback is blocked by Chrome");
      const wasUnderflow = scheduledCount > 0 && clock.peekNext() <= ctx.currentTime;
      const startAt = clock.schedule(duration, ctx.currentTime);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1;
      src.connect(ctx.destination);
      src.onended = () => {
        if (!sources.delete(src)) return;
        src.onended = null;
        try {
          src.disconnect();
        } catch {
          // Already disconnected.
        }
        src.buffer = null;
        endedCount++;
        queuedSeconds = Math.max(0, queuedSeconds - duration);
        decodedBytes = Math.max(0, decodedBytes - bytes);
        notify();
        if (!controller.signal.aborted && hooks.onEnded) hooks.onEnded();
      };
      sources.add(src);
      scheduledCount++;
      queuedSeconds += duration;
      decodedBytes += bytes;
      peakBytes = Math.max(peakBytes, decodedBytes);
      peakHorizon = Math.max(peakHorizon, clock.horizon(ctx.currentTime));
      try {
        src.start(startAt);
      } catch (e) {
        run.teardown();
        throw e;
      }
      return { startAt, endAt: startAt + duration, rebuffered: wasUnderflow };
    },
    markGenerationComplete() { generationComplete = true; },
    playbackDrained() { return generationComplete && scheduledCount > 0 && sources.size === 0 && !decoding; },
    /** @returns {boolean} true only the first time */
    markTerminal() {
      if (terminal) return false;
      terminal = true;
      return true;
    },
    /** Abort the run, stop and release every source, clear the auth token and close the context. */
    teardown() {
      controller.abort();
      for (const src of sources) {
        src.onended = null;
        try {
          src.stop();
          src.disconnect();
        } catch {
          // Source never started or already stopped.
        }
        src.buffer = null;
      }
      sources.clear();
      queuedSeconds = 0;
      decodedBytes = 0;
      run.authToken = "";
      if (context) {
        const old = context;
        context = null;
        Promise.resolve(old.close()).catch(() => {});
      }
      notify();
    },
  };
  return run;
}

/** @typedef {ReturnType<typeof createPlaybackRun>} PlaybackRun */

/**
 * `reader.read()` that rejects with code `stream_timeout` after `idleMs` without data, or AbortError on abort.
 * @template T
 * @param {{read: () => Promise<T>}} reader
 * @param {AbortSignal | null} [signal]
 * @param {number} [idleMs]
 * @returns {Promise<T>}
 */
export function readWithIdleTimeout(reader, signal, idleMs = STREAM_IDLE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {(fn: (value: any) => void, value: any) => void} */
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error("Stream idle timeout"), { code: "stream_timeout" }));
    }, idleMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => reader.read()).then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}
