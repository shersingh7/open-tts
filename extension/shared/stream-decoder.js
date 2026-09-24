// @ts-check
// Open TTS v4 — framed audio stream decoding (ESM). Behaviour mirrors stream-decoder-umd.js.
//
// Wire format per frame: u32le headerLength, JSON header, u32le audioLength, audio bytes.

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** @typedef {{header: Record<string, any>, audio: Uint8Array}} StreamFrame */

/**
 * Incremental frame decoder. Each incoming byte is copied once into a bounded destination; there is no
 * repeated concatenation of a growing partial WAV on fragmented network reads.
 */
export class FrameDecoder {
  constructor() {
    /** Largest transient byte footprint seen, for budget diagnostics. */
    this.peakBytes = 0;
    /** @type {"headerLength"|"header"|"audioLength"|"audio"} */
    this.kind = "headerLength";
    /** @type {Uint8Array} */
    this.block = new Uint8Array(4);
    this.used = 0;
    /** @type {Record<string, any> | null} */
    this.header = null;
    this.reset();
  }

  /**
   * @param {number} length
   * @param {number} incoming
   * @returns {Uint8Array}
   */
  allocate(length, incoming) {
    if (length + incoming > MAX_AUDIO_BYTES) throw new Error("Encoded backlog exceeds budget");
    this.peakBytes = Math.max(this.peakBytes, length + incoming);
    return new Uint8Array(length);
  }

  reset() {
    this.kind = "headerLength";
    this.block = new Uint8Array(4);
    this.used = 0;
    this.header = null;
  }

  /**
   * Decode every complete frame in `chunk`.
   * @param {Uint8Array} chunk
   * @returns {StreamFrame[]}
   */
  push(chunk) {
    return Array.from(this.frames(chunk));
  }

  /**
   * Lazily yield complete frames from `chunk`; partial frames are kept for the next call.
   * @param {Uint8Array} chunk
   * @returns {Generator<StreamFrame>}
   */
  *frames(chunk) {
    if (chunk.length + this.block.length > MAX_AUDIO_BYTES) throw new Error("Encoded backlog exceeds budget");
    this.peakBytes = Math.max(this.peakBytes, chunk.length + this.block.length);
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(this.block.length - this.used, chunk.length - offset);
      this.block.set(chunk.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used < this.block.length) continue;
      if (this.kind === "headerLength") {
        const length = new DataView(this.block.buffer).getUint32(0, true);
        if (length > MAX_HEADER_BYTES || length === 0) throw new Error("Stream frame header is too large or empty");
        this.kind = "header";
        this.block = this.allocate(length, chunk.length);
      } else if (this.kind === "header") {
        this.header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.block));
        this.kind = "audioLength";
        this.block = new Uint8Array(4);
      } else if (this.kind === "audioLength") {
        const length = new DataView(this.block.buffer).getUint32(0, true);
        if (length > MAX_AUDIO_BYTES) throw new Error("Stream frame audio is too large");
        if (!length) {
          const frame = { header: /** @type {Record<string, any>} */ (this.header), audio: new Uint8Array() };
          this.reset();
          yield frame;
          continue;
        }
        if (length + chunk.length > MAX_AUDIO_BYTES) throw new Error("Encoded backlog exceeds budget");
        this.kind = "audio";
        this.block = this.allocate(length, chunk.length);
      } else {
        const frame = { header: /** @type {Record<string, any>} */ (this.header), audio: this.block };
        this.reset();
        yield frame;
        continue;
      }
      this.used = 0;
    }
  }

  /** Throws if the stream ended in the middle of a frame. */
  finish() {
    if (this.kind !== "headerLength" || this.used) throw new Error("Stream ended with a truncated frame");
  }
}

/**
 * Validates frame ordering, protocol v2 sequencing/source coverage, sample rates and speed ownership.
 */
export class StreamCursor {
  /**
   * @param {number} expectedCount number of text partitions requested
   * @param {number} [version] stream protocol version (1 or 2)
   * @param {number[] | null} [sourceLengths] per-partition code-point lengths, for v2 coverage checks
   */
  constructor(expectedCount, version = 1, sourceLengths = null) {
    this.sourceLengths = sourceLengths;
    this.version = version;
    this.sequence = 0;
    this.unitId = 0;
    /** @type {{start: number, end: number} | null} */
    this.unit = null;
    this.unitEnd = 0;
    this.expectedCount = expectedCount;
    this.nextIndex = 0;
    this.done = false;
    /** @type {number | null} */
    this.rate = null;
    this.hasAudio = false;
  }

  /**
   * Validate one frame; throws on any protocol violation.
   * @param {any} header
   * @param {Uint8Array} audio
   */
  accept(header, audio) {
    if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("Malformed stream header");
    if (this.done) throw new Error("Payload after terminal done");
    if (this.version === 2 && (header.protocol_version !== 2 || header.sequence !== this.sequence++)) {
      throw new Error("Stream protocol/sequence mismatch");
    }
    if (header.error) throw Object.assign(new Error(String(header.error)), { code: header.code });
    if (header.keepalive === true) {
      const allowed = ["keepalive", ...(this.version === 2 ? ["protocol_version", "sequence"] : [])];
      if (audio.length || Object.keys(header).some((key) => !allowed.includes(key))) {
        throw new Error("Invalid keepalive frame");
      }
      return; // Transport liveness is neither audio nor a finalized text unit.
    }
    if (header.done === true) {
      const incomplete = this.nextIndex !== this.expectedCount || this.unit;
      if (audio.length || incomplete || (this.version === 2 && header.outcome !== "completed")) {
        throw new Error("Missing final before done");
      }
      this.done = true;
      return;
    }
    if (!Number.isInteger(header.index) || header.index !== this.nextIndex || this.nextIndex >= this.expectedCount) {
      throw new Error("Out-of-order stream index");
    }
    if (this.version === 2 && header.final !== true) {
      if (header.unit_id !== this.unitId || !Number.isInteger(header.start) || !Number.isInteger(header.end)
          || header.start !== this.unitEnd || header.end <= header.start) {
        throw new Error("Invalid unit source coverage");
      }
      if (this.unit && (this.unit.start !== header.start || this.unit.end !== header.end)) {
        throw new Error("Unit metadata changed");
      }
      if (header.unit_final === true) {
        if (audio.length || !this.unit) throw new Error("Empty or malformed unit final");
        this.unitEnd = header.end;
        this.unitId++;
        this.unit = null;
        return;
      }
      if (!Number.isInteger(header.samples) || header.samples <= 0) throw new Error("Invalid sample count");
      this.unit = { start: header.start, end: header.end };
    }
    if (header.final === true) {
      if (audio.length || !this.hasAudio || this.unit) throw new Error("Invalid final or empty text audio");
      if (this.version === 2 && this.sourceLengths && this.unitEnd !== this.sourceLengths[this.nextIndex]) {
        throw new Error("Incomplete source text coverage");
      }
      this.unitEnd = 0;
      this.nextIndex++;
      this.hasAudio = false;
      return;
    }
    if (!audio.length) throw new Error("Empty non-final frame");
    if (!Number.isInteger(header.sample_rate) || header.sample_rate < 8000 || header.sample_rate > 192000) {
      throw new Error("Invalid sample rate");
    }
    if (this.rate !== null && this.rate !== header.sample_rate) throw new Error("Sample rate changed");
    this.rate = header.sample_rate;
    if (header.apply_playback_rate !== false || header.playback_rate !== 1
        || !Number.isFinite(header.speed) || header.speed < 0.5 || header.speed > 3) {
      throw new Error("Invalid speed ownership metadata");
    }
    this.hasAudio = true;
  }

  /** Throws unless the stream reached `done` after every expected partition. */
  finishEof() {
    if (!this.done || this.nextIndex !== this.expectedCount) throw new Error("Stream ended without final/done");
  }
}
