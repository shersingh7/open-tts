// @ts-check
// Open TTS v4 — playback engine shared by the offscreen document and the Reader (one pipeline, two hosts).
// Port of the v3 offscreen.js pipeline: validated v2 framed stream → run-scoped AudioContext → gapless schedule.
// Events go to the injected `emit` as the contract's host→SW messages (STATUS, PROGRESS, DONE, ERROR, HEARTBEAT).

import { HEARTBEAT_MS, resolveSpeed, SERVER_URL } from "../shared/constants.js";
import { MSG, OUTCOMES } from "../shared/messages.js";
import { normalizeText, splitText } from "../shared/playback.js";
import { createPlaybackRun, readWithIdleTimeout } from "../shared/playback-session.js";
import { parseApiErrorBody } from "../shared/protocol.js";
import { FrameDecoder, StreamCursor } from "../shared/stream-decoder.js";

export const SLOW_START_MESSAGE = "Model is slow to start — retry to open the Reader";

/** Transport partitions are large; the backend alone selects generation units. */
const TRANSPORT_PARTITION_CHARS = 40000;
const READING_LIMIT_CHARS = 200000;
const READING_LIMIT_PARTITIONS = 50;
const MAX_FRAME_SECONDS = 4;
const START_MONITOR_MS = 30;

const LABELS = Object.freeze({
  preparing: "Preparing...",
  generating: "Generating...",
  buffering: "Buffering...",
  reading: "Reading...",
  paused: "Paused",
});

/** @type {Record<string, "preparing"|"buffering"|"playing"|"paused">} */
const STATE_FOR_LABEL = {
  [LABELS.preparing]: "preparing",
  [LABELS.generating]: "buffering",
  [LABELS.buffering]: "buffering",
  [LABELS.reading]: "playing",
  [LABELS.paused]: "paused",
};

/**
 * @typedef {object} HostSpeak HOST_SPEAK command (contract "SW → host")
 * @property {{runId: string, source?: string|null, sourceTabId?: number|null, sourceFrameId?: number|null}} run
 * @property {string} text
 * @property {{model?: string, voice?: string, speed?: number, language?: string, instruct?: string}} [settings]
 * @property {string} [authToken]
 * @property {number} [protocolVersion] 2 in v4; 1 is still accepted (legacy stream)
 * @property {number|null} [firstAudioDeadlineMs]
 */

/**
 * @typedef {object} TerminalInfo local-only terminal notice (never sent to the SW as-is)
 * @property {string} runId
 * @property {"completed"|"stopped"|"superseded"|"failed"} outcome
 * @property {string} [message]
 * @property {string} [code]
 * @property {string} retryText not-yet-fully-played text (Reader host only, empty when completed)
 */

/**
 * @typedef {object} EngineOptions
 * @property {(message: Record<string, any>) => void} emit receives host→SW messages
 * @property {"offscreen"|"reader"} hostKind
 * @property {(url: string, init: RequestInit) => Promise<any>} [fetchImpl]
 * @property {() => any} [audioContextFactory] returns a new AudioContext-like object
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimeout]
 * @property {(id: any) => void} [clearTimeout]
 * @property {number} [heartbeatMs]
 * @property {string} [serverUrl]
 * @property {((info: TerminalInfo) => void) | null} [onTerminal]
 */

/** @returns {Error & {name: "AbortError"}} */
function supersededError() {
  return Object.assign(new Error("Superseded"), { name: /** @type {const} */ ("AbortError") });
}

/**
 * Validate the actual PCM container before Chrome allocates or resamples it.
 * @param {Uint8Array} bytes
 * @param {number} advertisedRate sample rate from the frame header
 * @returns {{duration: number}}
 */
export function wavInfo(bytes, advertisedRate) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @param {number} offset */
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const validHeader = bytes.length >= 44 && tag(0) === "RIFF" && tag(8) === "WAVE"
    && view.getUint32(4, true) + 8 === bytes.length;
  if (!validHeader) throw new Error("Invalid WAV container");
  /** @type {{codec: number, channels: number, rate: number, align: number, bits: number} | null} */
  let format = null;
  /** @type {number | null} */
  let dataSize = null;
  for (let pos = 12; pos + 8 <= bytes.length;) {
    const size = view.getUint32(pos + 4, true);
    const end = pos + 8 + size;
    if (end > bytes.length) throw new Error("Truncated WAV chunk");
    if (tag(pos) === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format");
      format = {
        codec: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        rate: view.getUint32(pos + 12, true),
        align: view.getUint16(pos + 20, true),
        bits: view.getUint16(pos + 22, true),
      };
    }
    if (tag(pos) === "data") {
      if (dataSize !== null) throw new Error("Duplicate WAV data");
      dataSize = size;
    }
    pos = end + (size % 2);
  }
  const supported = format && dataSize !== null && format.codec === 1 && format.bits === 16
    && format.channels === 1 && format.align === 2 && dataSize % 2 === 0 && format.rate === advertisedRate;
  if (!supported) throw new Error("Unsupported or inconsistent WAV audio");
  const duration = dataSize / 2 / format.rate;
  if (!(duration > 0) || duration > MAX_FRAME_SECONDS) throw new Error("Audio frame exceeds duration budget");
  return { duration };
}

/** @returns {any} */
function defaultAudioContext() {
  return new AudioContext();
}

/**
 * Create a playback engine. Exactly one run at a time; exactly one terminal (DONE or ERROR) per run.
 * @param {EngineOptions} options
 */
export function createEngine({
  emit,
  hostKind,
  fetchImpl = (url, init) => fetch(url, init),
  audioContextFactory = defaultAudioContext,
  now = Date.now,
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
  heartbeatMs = HEARTBEAT_MS,
  serverUrl = SERVER_URL,
  onTerminal = null,
}) {
  if (typeof emit !== "function") throw new TypeError("createEngine requires an emit function");
  if (hostKind !== "offscreen" && hostKind !== "reader") throw new TypeError(`Unknown host kind: ${hostKind}`);

  /** @type {any} the active PlaybackRun plus engine fields, or null */
  let session = null;

  /** @param {any} run */
  function assertCurrent(run) {
    run.assertActive();
    if (session !== run) throw supersededError();
  }

  /**
   * @param {any} run
   * @param {string} type
   * @param {Record<string, any>} [fields]
   */
  function send(run, type, fields = {}) {
    if (session !== run) return;
    emit({ type, runId: run.runId, ...fields });
  }

  /**
   * @param {any} run
   * @param {string} label one of LABELS
   * @param {Record<string, any>} [fields]
   */
  function sendStatus(run, label, fields = {}) {
    send(run, MSG.STATUS, { state: STATE_FOR_LABEL[label], label, ...fields });
  }

  /** @param {any} run */
  function clearRunTimers(run) {
    for (const key of ["startMonitor", "heartbeat", "deadline"]) {
      if (run[key] !== undefined && run[key] !== null) clearTimer(run[key]);
      run[key] = null;
    }
  }

  /** @param {any} run */
  function remainingText(run) {
    if (!run.texts) return "";
    const position = run.playedPosition || { index: 0, end: 0 };
    const first = Array.from(run.texts[position.index] || "").slice(position.end).join("");
    return [first, ...run.texts.slice(position.index + 1)].join("\n\n");
  }

  /**
   * End `run` once: emit its terminal, release every resource.
   * @param {any} run
   * @param {(Error & {code?: string}) | null} error
   * @param {"completed"|"stopped"|"superseded"|"failed"} [outcome]
   */
  function finish(run, error, outcome = error ? OUTCOMES.FAILED : OUTCOMES.COMPLETED) {
    if (session !== run || !run.markTerminal()) return;
    clearRunTimers(run);
    run.metrics.terminalAt = now();
    run.metrics.terminalOutcome = outcome;
    const retryText = hostKind === "reader" && outcome !== OUTCOMES.COMPLETED ? remainingText(run) : "";
    const metrics = { ...run.metrics };
    if (error) {
      send(run, MSG.ERROR, {
        outcome: OUTCOMES.FAILED,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(retryText ? { retryText } : {}),
        metrics,
      });
    } else {
      send(run, MSG.DONE, { outcome, metrics });
    }
    session = null;
    run.teardown();
    onTerminal?.({
      runId: run.runId,
      outcome,
      retryText,
      ...(error ? { message: error.message, ...(error.code ? { code: error.code } : {}) } : {}),
    });
  }

  /**
   * @param {any} run
   * @param {{final: boolean, pending: number, id: number, index: number, end: number}} unit
   */
  function unitPlayed(run, unit) {
    if (!unit.final || unit.pending) return;
    run.playedPosition = { index: unit.index, end: unit.end };
    run.units.delete(unit.id);
    send(run, MSG.PROGRESS, {
      played: run.endedCount,
      scheduled: run.scheduledCount,
      unitId: unit.id,
      index: unit.index,
      end: unit.end,
      bufferedSeconds: run.queuedSeconds,
    });
  }

  /** @param {any} run */
  function maybeFinish(run) {
    if (session === run && run.playbackDrained()) finish(run, null);
  }

  /** @param {any} run */
  function getContext(run) {
    assertCurrent(run);
    if (!run.context) run.setContext(audioContextFactory());
    return run.context;
  }

  /** @param {any} run */
  function scheduleHeartbeat(run) {
    run.heartbeat = setTimer(() => {
      if (session !== run) return;
      send(run, MSG.HEARTBEAT);
      scheduleHeartbeat(run);
    }, heartbeatMs);
  }

  /**
   * @param {any} run
   * @param {number|null|undefined} deadlineMs
   */
  function scheduleFirstAudioDeadline(run, deadlineMs) {
    if (!(typeof deadlineMs === "number" && deadlineMs > 0)) return;
    run.deadline = setTimer(() => {
      run.deadline = null;
      if (session !== run || run.scheduledAny) return;
      finish(run, Object.assign(new Error(SLOW_START_MESSAGE), { code: "slow_start" }));
    }, deadlineMs);
  }

  /**
   * POST the batch and yield validated frames that carry audio or finalize a unit.
   * @param {any} run
   * @param {string[]} texts
   * @param {NonNullable<HostSpeak["settings"]>} settings
   * @param {number} protocolVersion
   */
  async function* streamBatch(run, texts, settings, protocolVersion) {
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": "application/json" };
    if (run.authToken) headers["X-Open-TTS-Token"] = run.authToken;
    const body = {
      texts,
      protocol_version: protocolVersion,
      voice: settings.voice || "af_bella",
      speed: resolveSpeed(settings.speed),
      language: settings.language || "Auto",
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.instruct ? { instruct: settings.instruct } : {}),
    };
    const request = () => fetchImpl(`${serverUrl}/v1/synthesize-stream-batch`, {
      method: "POST",
      headers,
      signal: run.signal,
      body: JSON.stringify(body),
    });
    const response = await readWithIdleTimeout({ read: request }, run.signal);
    assertCurrent(run);
    if (!response.ok) {
      const errorBody = await readWithIdleTimeout({ read: () => response.json() }, run.signal);
      assertCurrent(run);
      const error = parseApiErrorBody(errorBody, response.status);
      throw Object.assign(new Error(error.message), { code: error.code });
    }
    if (protocolVersion === 2 && response.headers?.get("X-TTS-Protocol-Version") !== "2") {
      throw new Error("Backend streaming protocol mismatch; update backend and extension together");
    }
    const reader = response.body.getReader();
    const decoder = new FrameDecoder();
    const cursor = new StreamCursor(texts.length, protocolVersion, texts.map((text) => Array.from(text).length));
    try {
      while (true) {
        assertCurrent(run);
        // Intentional backpressure is not a server idle timeout.
        await run.waitForBudget();
        assertCurrent(run);
        const { value, done } = await readWithIdleTimeout(reader, run.signal);
        assertCurrent(run);
        for (const frame of value ? decoder.frames(value) : []) {
          assertCurrent(run);
          cursor.accept(frame.header, frame.audio);
          run.metrics.peakEncodedBytes = decoder.peakBytes;
          if (frame.header.done) {
            run.metrics.serverQueuePeakBytes = frame.header.queue_peak_bytes;
            run.metrics.queueWaitSeconds = frame.header.queue_wait_seconds;
          }
          if (frame.audio.length || frame.header.unit_final) yield frame;
        }
        if (done) {
          decoder.finish();
          cursor.finishEof();
          return;
        }
      }
    } finally {
      // Do not await a noncooperative cancel promise before releasing the run.
      Promise.resolve(reader.cancel()).catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
  }

  /**
   * @param {any} run
   * @param {any} header unit_final frame header
   */
  function acceptUnitFinal(run, header) {
    const unit = run.units.get(header.unit_id);
    if (!unit) throw new Error("Missing playback unit");
    const metrics = run.metrics;
    metrics.generationSeconds = (metrics.generationSeconds || 0) + (header.generation_seconds || 0);
    metrics.processedAudioSeconds = (metrics.processedAudioSeconds || 0) + (header.processed_audio_seconds || 0);
    if (metrics.processedAudioSeconds) {
      metrics.normalizedRTF = metrics.generationSeconds / metrics.processedAudioSeconds;
    }
    unit.final = true;
    unitPlayed(run, unit);
  }

  /**
   * Record when the audio clock actually passes the first scheduled start.
   * @param {any} run
   * @param {any} ctx
   * @param {number} startAt
   */
  function observeFirstAudio(run, ctx, startAt) {
    if (session !== run) return;
    if (ctx.currentTime >= startAt && ctx.state === "running") {
      run.metrics.firstAudioClockStartedAt = now();
      run.startMonitor = null;
      return;
    }
    run.startMonitor = setTimer(() => observeFirstAudio(run, ctx, startAt), START_MONITOR_MS);
  }

  /**
   * @param {any} run
   * @param {any} ctx
   * @param {any} unit
   */
  function onSourceEnded(run, ctx, unit) {
    if (session !== run) return;
    if (unit) {
      unit.pending--;
      unitPlayed(run, unit);
    }
    send(run, MSG.PROGRESS, { played: run.endedCount, scheduled: run.scheduledCount });
    if (!run.gate.isPaused() && !run.playbackDrained() && run.sources.size === 0) {
      run.underflowStarted = ctx.currentTime;
      sendStatus(run, LABELS.buffering);
    }
    maybeFinish(run);
  }

  /**
   * Validate, decode and schedule one audio frame.
   * @param {any} run
   * @param {{header: any, audio: Uint8Array}} frame
   * @param {number} protocolVersion
   */
  async function playFrame(run, frame, protocolVersion) {
    const header = frame.header;
    const metrics = run.metrics;
    metrics.firstPacketAt ??= now();
    metrics.modelReadySeconds ??= header.model_ready_seconds;
    metrics.firstModelPCMSeconds ??= header.first_pcm_seconds;
    const { duration } = wavInfo(frame.audio, header.sample_rate);
    if (protocolVersion === 2 && Math.round(duration * header.sample_rate) !== header.samples) {
      throw new Error("PCM sample count mismatch");
    }
    let unit = null;
    if (protocolVersion === 2) {
      unit = run.units.get(header.unit_id);
      if (!unit) {
        unit = { id: header.unit_id, index: header.index, end: header.end, pending: 0, final: false };
        run.units.set(header.unit_id, unit);
      }
      unit.pending++;
    }
    const ctx = getContext(run);
    const estimate = (Math.ceil(duration * ctx.sampleRate) + 128) * 4;
    await run.waitForBudget(duration, estimate);
    assertCurrent(run);
    const bytes = frame.audio;
    const copy = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const buffer = await run.decode(() => ctx.decodeAudioData(copy()), estimate);
    assertCurrent(run);
    const scheduled = await run.scheduleBuffer(ctx, buffer, 1, { onEnded: () => onSourceEnded(run, ctx, unit) });
    assertCurrent(run);
    if (!metrics.firstScheduledAt) {
      metrics.firstScheduledAt = now();
      if (run.deadline !== null) {
        clearTimer(run.deadline);
        run.deadline = null;
      }
      observeFirstAudio(run, ctx, scheduled.startAt);
    }
    if (scheduled.rebuffered && run.underflowStarted !== undefined) {
      const gap = Math.max(0, scheduled.startAt - run.underflowStarted);
      metrics.underflowSeconds = (metrics.underflowSeconds || 0) + gap;
      delete run.underflowStarted;
    }
    if (scheduled.rebuffered) metrics.underflows += 1;
    metrics.peakDecodedBytes = run.peakBytes;
    metrics.peakBufferedSeconds = run.peakHorizon;
    const label = run.gate.isPaused() ? LABELS.paused : LABELS.reading;
    sendStatus(run, label, { bufferedSeconds: run.queuedSeconds, metrics: { ...metrics } });
  }

  /**
   * @param {any} run
   * @param {HostSpeak} cmd
   */
  async function runSpeak(run, cmd) {
    const settings = cmd.settings || {};
    const protocolVersion = cmd.protocolVersion || 1;
    try {
      sendStatus(run, LABELS.preparing);
      const texts = splitText(cmd.text, TRANSPORT_PARTITION_CHARS, TRANSPORT_PARTITION_CHARS).map(normalizeText);
      if (!texts.length) throw new Error("Nothing to read");
      if (texts.join("").length > READING_LIMIT_CHARS || texts.length > READING_LIMIT_PARTITIONS) {
        throw new Error("Text exceeds the 200,000-character reading limit");
      }
      run.texts = texts;
      sendStatus(run, LABELS.generating);
      for await (const frame of streamBatch(run, texts, settings, protocolVersion)) {
        assertCurrent(run);
        if (frame.header.unit_final) acceptUnitFinal(run, frame.header);
        else await playFrame(run, frame, protocolVersion);
      }
      assertCurrent(run);
      if (!run.scheduledAny) throw new Error("No playable audio generated");
      run.metrics.generationFinishedAt = now();
      run.markGenerationComplete();
      maybeFinish(run);
    } catch (error) {
      if (session !== run) return;
      // Never replay a whole passage or silently skip missing audio. An explicit user retry starts a new run.
      if (error?.name === "AbortError") finish(run, null, OUTCOMES.STOPPED);
      else finish(run, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Start a run for a HOST_SPEAK command. A different active run is superseded; a duplicate delivery of the
   * current runId is ignored.
   * @param {HostSpeak} cmd
   */
  function speak(cmd) {
    const runId = cmd?.run?.runId;
    if (!runId) return;
    if (session?.runId === runId) return;
    if (session) finish(session, null, OUTCOMES.SUPERSEDED);
    const run = /** @type {any} */ (createPlaybackRun({
      runId,
      source: cmd.run.source ?? null,
      sourceTabId: cmd.run.sourceTabId ?? null,
      sourceFrameId: cmd.run.sourceFrameId ?? null,
      authToken: cmd.authToken || "",
    }));
    run.units = new Map();
    run.metrics = { acceptedAt: now(), underflows: 0 };
    run.startMonitor = null;
    run.heartbeat = null;
    run.deadline = null;
    session = run;
    scheduleHeartbeat(run);
    scheduleFirstAudioDeadline(run, cmd.firstAudioDeadlineMs);
    runSpeak(run, cmd).catch(() => {});
  }

  /**
   * Pause or resume. Latest control wins even if context promises resolve out of order.
   * @param {string} runId
   * @param {boolean} pause
   * @returns {Promise<{ok: boolean, paused?: boolean, ignored?: boolean, error?: string}>}
   */
  async function control(runId, pause) {
    const run = session;
    if (!run || run.runId !== runId) return { ok: false, ignored: true };
    if (pause) run.gate.pause();
    else run.gate.resume();
    const ctx = run.context;
    try {
      if (ctx) await (pause ? ctx.suspend() : ctx.resume());
      assertCurrent(run);
      if (ctx && run.gate.isPaused() && ctx.state === "running") await ctx.suspend();
      if (ctx && !run.gate.isPaused() && ctx.state === "suspended") await ctx.resume();
      assertCurrent(run);
      /** @type {string} */
      let label = LABELS.buffering;
      if (run.gate.isPaused()) label = LABELS.paused;
      else if (run.sources.size) label = LABELS.reading;
      sendStatus(run, label);
      return { ok: true, paused: run.gate.isPaused() };
    } catch (error) {
      // A device/context failure must not leave the UI believing this run is paused or reading forever.
      // Late controls never tear down a successor.
      if (session === run && error?.name !== "AbortError") finish(run, error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  return {
    speak,
    /** @param {string} runId */
    pause: (runId) => control(runId, true),
    /** @param {string} runId */
    resume: (runId) => control(runId, false),
    /**
     * Stop the active run with DONE{outcome}. Returns false if `runId` is not the active run.
     * @param {string} runId
     * @param {"stopped"|"superseded"} [outcome]
     */
    stop(runId, outcome = OUTCOMES.STOPPED) {
      if (!session || session.runId !== runId) return false;
      finish(session, null, outcome === OUTCOMES.SUPERSEDED ? OUTCOMES.SUPERSEDED : OUTCOMES.STOPPED);
      return true;
    },
    /** @returns {{runId: string, state: "buffering"|"playing"|"paused", paused: boolean} | null} */
    activeRun() {
      if (!session) return null;
      const paused = session.gate.isPaused();
      let state = /** @type {"buffering"|"playing"|"paused"} */ ("buffering");
      if (paused) state = "paused";
      else if (session.sources.size) state = "playing";
      return { runId: session.runId, state, paused };
    },
  };
}

/** @typedef {ReturnType<typeof createEngine>} Engine */
