// Test harness for host/engine.js: fake AudioContext, scripted fetch responses and v1/v2 stream frame builders.
// Self-contained port of the v3 pipeline-harness.js (which targets the classic offscreen.js via node:vm).

import { createEngine } from "../host/engine.js";
import { MSG } from "../shared/messages.js";

export const TERMINAL_TYPES = [MSG.DONE, MSG.ERROR];

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Settle queued microtasks. */
export async function flush(rounds = 60) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Mono 16-bit PCM WAV of `seconds` at `sampleRate`. */
export function wav(seconds = 0.1, sampleRate = 24000) {
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

/** One wire frame: u32le header length, JSON header, u32le audio length, audio. */
export function frame(header, audio = new Uint8Array()) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(head.length + audio.length + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, head.length, true);
  bytes.set(head, 4);
  view.setUint32(head.length + 4, audio.length, true);
  bytes.set(audio, head.length + 8);
  return bytes;
}

const SPEED_FIELDS = { sample_rate: 24000, speed: 1, apply_playback_rate: false, playback_rate: 1 };

/** Protocol v1 audio frame. */
export function audioFrame(seconds = 0.1, index = 0) {
  return frame({ index, ...SPEED_FIELDS, final: false }, wav(seconds));
}

/** Protocol v1 partition final + done. */
export function ending(index = 0) {
  return [frame({ index, final: true }), frame({ done: true })];
}

/** A complete protocol v2 stream for one partition with one unit of `seconds` audio. */
export function v2Frames(text = "Hello", seconds = 1) {
  const unit = { protocol_version: 2, index: 0, unit_id: 0, start: 0, end: Array.from(text).length };
  return [
    frame({ ...unit, sequence: 0, samples: Math.round(seconds * 24000), ...SPEED_FIELDS }, wav(seconds)),
    frame({ ...unit, sequence: 1, unit_final: true }),
    frame({ protocol_version: 2, sequence: 2, index: 0, final: true }),
    frame({ protocol_version: 2, sequence: 3, done: true, outcome: "completed" }),
  ];
}

/** A fetch Response-like object streaming `parts` (Uint8Arrays or promises of them). */
export function response(parts, headers = {}) {
  let next = 0;
  const reader = {
    cancelled: false,
    released: false,
    async read() {
      if (next < parts.length) return { value: await parts[next++], done: false };
      return { done: true };
    },
    cancel() {
      this.cancelled = true;
      return Promise.resolve();
    },
    releaseLock() {
      this.released = true;
    },
  };
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: { getReader: () => reader },
    reader,
  };
}

export function v2Response(parts) {
  return response(parts, { "x-tts-protocol-version": "2" });
}

/**
 * Fake AudioContext class. `hooks.resume/suspend/decode(ctx)` may return promises to delay or fail those calls.
 * Sources never end on their own: call `source.end()`.
 */
export function makeContextClass(hooks = {}, contexts = []) {
  return class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.sampleRate = 24000;
      this.destination = {};
      this.sources = [];
      contexts.push(this);
    }
    resume() {
      this.state = "running";
      return hooks.resume ? hooks.resume(this) : Promise.resolve();
    }
    suspend() {
      this.state = "suspended";
      return hooks.suspend ? hooks.suspend(this) : Promise.resolve();
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
    async decodeAudioData(arrayBuffer) {
      if (hooks.decode) await hooks.decode(this);
      const length = (arrayBuffer.byteLength - 44) / 2;
      return { duration: length / 24000, length, numberOfChannels: 1, sampleRate: 24000 };
    }
    createBufferSource() {
      const context = this;
      return {
        buffer: null,
        playbackRate: { value: 1 },
        connect() {},
        disconnect() {
          this.disconnected = true;
        },
        start(at) {
          this.startAt = at;
          this.endAt = at + this.buffer.duration;
          context.sources.push(this);
        },
        stop() {
          this.stopped = true;
        },
        end() {
          context.currentTime = Math.max(context.currentTime, this.endAt);
          this.onended?.();
        },
      };
    }
  };
}

/**
 * Engine under test with recorded emits, contexts and fetch requests.
 * @param {object} [opts]
 * @param {"offscreen"|"reader"} [opts.hostKind]
 * @param {(url: string, init: object) => any} [opts.fetch] returns a response (default: one v1 frame + ending)
 * @param {(ctx: any) => any} [opts.resume]
 * @param {(ctx: any) => any} [opts.suspend]
 * @param {(ctx: any) => any} [opts.decode]
 * @param {(info: object) => void} [opts.onTerminal]
 * @param {object} [opts.engine] extra createEngine options (now, setTimeout, clearTimeout, heartbeatMs)
 */
export function engineHarness(opts = {}) {
  const events = [];
  const contexts = [];
  const requests = [];
  const Context = makeContextClass(opts, contexts);
  const hostKind = opts.hostKind || "offscreen";
  const engine = createEngine({
    emit: (message) => events.push(message),
    hostKind,
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      if (opts.fetch) return opts.fetch(url, init);
      return response([audioFrame(), ...ending()]);
    },
    audioContextFactory: () => new Context(),
    onTerminal: opts.onTerminal,
    ...opts.engine,
  });

  /** Deliver a HOST_SPEAK-shaped command. */
  const speak = (runId = "A", text = "Hello.\n\nNext paragraph.", extra = {}) => engine.speak({
    type: MSG.HOST_SPEAK,
    run: { runId, source: "popup", sourceTabId: null, sourceFrameId: null },
    text,
    settings: { speed: 1 },
    authToken: "",
    firstAudioDeadlineMs: null,
    ...extra,
  });
  const speakV2 = (runId = "A", text = "Hello", extra = {}) => speak(runId, text, { protocolVersion: 2, ...extra });
  const terminals = () => events.filter((event) => TERMINAL_TYPES.includes(event.type));
  const ofType = (type) => events.filter((event) => event.type === type);
  return { engine, events, contexts, requests, Context, speak, speakV2, terminals, ofType };
}
