(function (root) {
  const MAX_HEADER_BYTES = 64 * 1024;
  const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

  // Each incoming byte is copied once into a bounded destination. No repeated
  // concatenation of a growing partial WAV on fragmented network reads.
  class FrameDecoder {
    constructor() { this.reset(); }
    reset() { this.kind = "headerLength"; this.block = new Uint8Array(4); this.used = 0; this.header = null; }
    push(chunk) {
      const frames = []; let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(this.block.length - this.used, chunk.length - offset);
        this.block.set(chunk.subarray(offset, offset + count), this.used);
        this.used += count; offset += count;
        if (this.used < this.block.length) continue;
        if (this.kind === "headerLength") {
          const length = new DataView(this.block.buffer).getUint32(0, true);
          if (length > MAX_HEADER_BYTES || length === 0) throw new Error("Stream frame header is too large or empty");
          this.kind = "header"; this.block = new Uint8Array(length);
        } else if (this.kind === "header") {
          this.header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.block));
          this.kind = "audioLength"; this.block = new Uint8Array(4);
        } else if (this.kind === "audioLength") {
          const length = new DataView(this.block.buffer).getUint32(0, true);
          if (length > MAX_AUDIO_BYTES) throw new Error("Stream frame audio is too large");
          if (!length) { frames.push({header:this.header,audio:new Uint8Array()}); this.reset(); continue; }
          this.kind = "audio"; this.block = new Uint8Array(length);
        } else {
          frames.push({header:this.header,audio:this.block}); this.reset(); continue;
        }
        this.used = 0;
      }
      return frames;
    }
    finish() {
      if (this.kind !== "headerLength" || this.used) throw new Error("Stream ended with a truncated frame");
    }
  }

  class StreamCursor {
    constructor(expectedCount) {
      this.expectedCount = expectedCount; this.nextIndex = 0;
      this.done = false; this.rate = null; this.hasAudio = false;
    }
    accept(header, audio) {
      if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("Malformed stream header");
      if (this.done) throw new Error("Payload after terminal done");
      if (header.error) throw Object.assign(new Error(String(header.error)), { code: header.code });
      if (header.keepalive === true) {
        if (audio.length || Object.keys(header).some(key => key !== "keepalive")) throw new Error("Invalid keepalive frame");
        return; // Transport liveness is neither audio nor a finalized text unit.
      }
      if (header.done === true) {
        if (audio.length || this.nextIndex !== this.expectedCount) throw new Error("Missing final before done");
        this.done = true; return;
      }
      if (!Number.isInteger(header.index) || header.index !== this.nextIndex || this.nextIndex >= this.expectedCount) throw new Error("Out-of-order stream index");
      if (header.final === true) {
        if (audio.length || !this.hasAudio) throw new Error("Invalid final or empty text audio");
        this.nextIndex++; this.hasAudio = false; return;
      }
      if (!audio.length) throw new Error("Empty non-final frame");
      if (!Number.isInteger(header.sample_rate) || header.sample_rate < 8000 || header.sample_rate > 192000) throw new Error("Invalid sample rate");
      if (this.rate !== null && this.rate !== header.sample_rate) throw new Error("Sample rate changed");
      this.rate = header.sample_rate;
      if (header.apply_playback_rate !== false || header.playback_rate !== 1 ||
          !Number.isFinite(header.speed) || header.speed < 0.5 || header.speed > 3) throw new Error("Invalid speed ownership metadata");
      this.hasAudio = true;
    }
    finishEof() {
      if (!this.done || this.nextIndex !== this.expectedCount) throw new Error("Stream ended without final/done");
    }
  }

  root.OpenTTSStream = { FrameDecoder, StreamCursor, MAX_HEADER_BYTES, MAX_AUDIO_BYTES };
})(typeof globalThis !== "undefined" ? globalThis : self);
