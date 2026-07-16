(function (root) {
  const MAX_HEADER_BYTES = 64 * 1024;
  const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

  class FrameDecoder {
    constructor() {
      this.buffer = new Uint8Array(0);
    }

    push(chunk) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
      const frames = [];
      let offset = 0;
      while (this.buffer.length - offset >= 8) {
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset);
        const headerLength = view.getUint32(0, true);
        if (headerLength > MAX_HEADER_BYTES) throw new Error("Stream frame header is too large");
        if (this.buffer.length - offset < 4 + headerLength + 4) break;
        const audioLength = view.getUint32(4 + headerLength, true);
        if (audioLength > MAX_AUDIO_BYTES) throw new Error("Stream frame audio is too large");
        const total = 4 + headerLength + 4 + audioLength;
        if (this.buffer.length - offset < total) break;
        const headerBytes = this.buffer.slice(offset + 4, offset + 4 + headerLength);
        const header = JSON.parse(new TextDecoder().decode(headerBytes));
        const audio = this.buffer.slice(offset + 4 + headerLength + 4, offset + total);
        frames.push({ header, audio });
        offset += total;
      }
      this.buffer = this.buffer.slice(offset);
      return frames;
    }

    finish() {
      if (this.buffer.length) throw new Error("Stream ended with a truncated frame");
    }
  }

  root.OpenTTSStream = { FrameDecoder, MAX_HEADER_BYTES, MAX_AUDIO_BYTES };
})(typeof globalThis !== "undefined" ? globalThis : self);
