(function (root) {
  function norm(t) {
    return (t || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  function splitWithMax(clean, max) {
    if (!clean) return [];
    if (clean.length <= max) return [clean];
    const out = [];
    const flush = (c) => { if (c.trim()) out.push(c.trim()); };
    for (const para of clean.split(/\n\n+/)) {
      if (!para.trim()) continue;
      if (para.length > max) {
        for (const sent of para.split(/(?<=[.!?])\s+/)) {
          if (!sent) continue;
          if (sent.length > max) {
            let buf = "";
            for (const w of sent.split(" ")) {
              if (!w) continue;
              const next = buf ? `${buf} ${w}` : w;
              if (next.length > max && buf) { flush(buf); buf = w; }
              else buf = next;
            }
            if (buf) flush(buf);
          } else {
            const last = out[out.length - 1];
            const cand = last ? `${last} ${sent}` : sent;
            if (last && cand.length <= max) out[out.length - 1] = cand;
            else out.push(sent);
          }
        }
      } else {
        const last = out[out.length - 1];
        const cand = last ? `${last}\n\n${para}` : para;
        if (last && cand.length <= max) out[out.length - 1] = cand;
        else out.push(para);
      }
    }
    return out;
  }

  function splitText(text, max = 2000, firstMax = 400) {
    const clean = norm(text);
    if (!clean) return [];
    const pieces = splitWithMax(clean, max);
    if (!pieces.length) return [];
    if (pieces[0].length <= firstMax) return pieces;
    return splitWithMax(pieces[0], firstMax).concat(pieces.slice(1));
  }

  /**
   * Consume framed audio items and schedule each as soon as it is available.
   * The first audio item is handed to `schedule` before later items are pulled.
   */
  async function consumePlaybackStream(frameSource, { schedule, onStatus, isCancelled } = {}) {
    if (typeof schedule !== "function") throw new Error("schedule is required");
    let decoded = 0;
    let started = false;
    for await (const frame of frameSource) {
      if (isCancelled && isCancelled()) return { decoded, cancelled: true };
      if (frame && frame.error) {
        if (decoded === 0) {
          throw Object.assign(new Error(frame.error), { code: frame.code });
        }
        if (onStatus) onStatus({ error: frame.error, decoded });
        continue;
      }
      if (!frame || !frame.audio || !frame.audio.length) continue;
      const work = schedule(frame);
      decoded += 1;
      if (!started) {
        started = true;
        if (onStatus) onStatus({ started: true, decoded });
      }
      await work;
    }
    return { decoded, cancelled: false };
  }

  function speakStatus(phase) {
    if (phase === "prepare") return "Preparing...";
    if (phase === "generate") return "Generating...";
    if (phase === "retry") return "Retrying...";
    return "Reading...";
  }

  root.OpenTTSPlayback = { splitText, consumePlaybackStream, speakStatus, norm };
})(typeof globalThis !== "undefined" ? globalThis : self);
