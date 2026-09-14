(function (root) {
  const ZERO_WIDTH = /[\u200B\uFEFF]/g;
  const ABBREVIATIONS = new Set([
    "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "vs", "etc", "inc", "ltd",
    "st", "ave", "rd", "blvd", "dept", "univ", "est", "fig", "al", "eg", "ie",
    "no", "vol", "pp", "ch", "gen", "col", "lt", "sgt", "rev", "hon", "sen",
    "rep", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
    "oct", "nov", "dec",
  ]);
  const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+/;

  function nonWhitespaceKey(text) {
    return String(text || "").replace(/\s+/g, "");
  }

  function joinSoftWraps(para) {
    const lines = para.split("\n");
    if (lines.length === 1) {
      return LIST_LINE.test(lines[0]) ? lines[0].replace(/\s+$/, "") : lines[0].trim();
    }
    const out = [];
    let buf = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (LIST_LINE.test(raw) || LIST_LINE.test(line)) {
        if (buf) out.push(buf);
        buf = "";
        out.push(line);
        continue;
      }
      if (!line) continue;
      buf = buf ? `${buf} ${line}` : line;
    }
    if (buf) out.push(buf);
    return out.join("\n");
  }

  function normalizeText(text) {
    let t = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    t = t.replace(ZERO_WIDTH, "").trim();
    if (!t) return "";
    return t.split(/\n[ \t]*\n+/).map(joinSoftWraps).filter(Boolean).join("\n\n");
  }

  function wordBeforePeriod(text, i) {
    let k = i - 1;
    while (k >= 0 && /[A-Za-z]/.test(text[k])) k -= 1;
    return text.slice(k + 1, i);
  }

  function isSentenceEnd(text, i) {
    const ch = text[i];
    const n = text.length;
    if (ch === ".") {
      if (i > 0 && /\d/.test(text[i - 1]) && i + 1 < n && /\d/.test(text[i + 1])) return false;
      const word = wordBeforePeriod(text, i).toLowerCase();
      if (ABBREVIATIONS.has(word) || word.length === 1) return false;
      const lookback = text.slice(Math.max(0, i - 32), i).toLowerCase();
      if ((lookback.includes("www.") || lookback.includes("://")) && i + 1 < n && !/\s/.test(text[i + 1])) {
        return false;
      }
    }
    const nxt = i + 1 < n ? text[i + 1] : "";
    return nxt === "" || /\s/.test(nxt) || /["'”’)\]>]/.test(nxt);
  }

  function sentenceUnits(text) {
    if (!text) return [];
    const units = [];
    let start = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (".!?".includes(ch) && isSentenceEnd(text, i)) {
        let j = i + 1;
        while (j < n && /["'”’)\]>]/.test(text[j])) j += 1;
        let k = j;
        while (k < n && /\s/.test(text[k]) && text[k] !== "\n") k += 1;
        let p = k;
        while (p < n && /\s/.test(text[p])) p += 1;
        const nxt = p < n ? text[p] : "";
        if (nxt && nxt === nxt.toLowerCase() && nxt !== nxt.toUpperCase()) {
          i += 1;
          continue;
        }
        units.push(text.slice(start, k));
        start = k;
        i = k;
        continue;
      }
      i += 1;
    }
    if (start < n) units.push(text.slice(start));
    return units;
  }

  function hardSplit(text, maxChars) {
    if (!text) return [];
    if (maxChars <= 0) throw new Error("maxChars must be positive");
    if (text.length <= maxChars) return [text];
    const parts = [];
    let remaining = text;
    while (remaining) {
      if (remaining.length <= maxChars) {
        parts.push(remaining);
        break;
      }
      const window = remaining.slice(0, maxChars);
      let splitAt = window.lastIndexOf("\n\n");
      if (splitAt < maxChars / 4) {
        splitAt = -1;
        for (let i = window.length - 1; i > maxChars / 4; i -= 1) {
          if (".!?".includes(window[i - 1]) && /\s/.test(window[i])) {
            splitAt = i;
            break;
          }
        }
        if (splitAt < 0) {
          splitAt = window.lastIndexOf(" ");
          if (splitAt < maxChars / 4) splitAt = maxChars;
        }
      }
      if (splitAt <= 0) splitAt = maxChars;
      const last = remaining.charCodeAt(splitAt - 1), next = remaining.charCodeAt(splitAt);
      if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        if (splitAt === 1) throw new Error("Partition cap cannot fit a Unicode character");
        splitAt--;
      }
      parts.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return parts;
  }

  function packGenerationUnits(text, firstMax, restMax) {
    if (!text) return [];
    const sentences = sentenceUnits(text);
    if (!sentences.length) return text.length > restMax ? hardSplit(text, restMax) : [text];
    const out = [];
    let buf = "";
    let firstOpen = true;
    const cap = () => (firstOpen && !out.length ? firstMax : restMax);
    const commit = () => {
      if (buf) {
        out.push(buf);
        buf = "";
        firstOpen = false;
      }
    };
    for (const sent of sentences) {
      const limit = cap();
      if (!buf) {
        if (sent.length <= limit) {
          buf = sent;
          continue;
        }
        const pieces = hardSplit(sent, limit);
        if (firstOpen) {
          out.push(pieces[0]);
          firstOpen = false;
          for (const piece of pieces.slice(1)) {
            if (piece.length > restMax) {
              const hard = hardSplit(piece, restMax);
              if (buf) out.push(buf);
              out.push(...hard.slice(0, -1));
              buf = hard[hard.length - 1];
            } else if (buf && buf.length + piece.length <= restMax) {
              buf += piece;
            } else {
              if (buf) out.push(buf);
              buf = piece;
            }
          }
        } else {
          out.push(...pieces.slice(0, -1));
          buf = pieces[pieces.length - 1];
        }
        continue;
      }
      if (buf.length + sent.length <= limit) {
        buf += sent;
      } else {
        commit();
        if (sent.length <= restMax) buf = sent;
        else {
          const pieces = hardSplit(sent, restMax);
          out.push(...pieces.slice(0, -1));
          buf = pieces[pieces.length - 1];
        }
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  function splitText(text, max = 4000, firstMax = 4000) {
    const clean = normalizeText(text);
    if (!clean) return [];
    const maxChars = (root.OpenTTSConstants && root.OpenTTSConstants.MAX_CHARS) || 200000;
    const maxBatch = (root.OpenTTSConstants && root.OpenTTSConstants.MAX_BATCH_TEXTS) || 50;
    if (clean.length > maxChars) {
      throw Object.assign(new Error(`Text exceeds maximum length of ${maxChars}`), { code: "validation_error" });
    }
    const pieces = packGenerationUnits(clean, firstMax, max);
    if (pieces.length > maxBatch) {
      throw Object.assign(new Error(`Text requires ${pieces.length} partitions; maximum is ${maxBatch}`), {
        code: "batch_too_large",
      });
    }
    return pieces;
  }

  /**
   * Consume framed audio items and schedule each as soon as it is available.
   * The first audio item is handed to `schedule` before later items are pulled.
   * Any error frame terminates the loop; already-scheduled audio is left playing.
   */
  async function consumePlaybackStream(frameSource, { schedule, onStatus, isCancelled, onFrame } = {}) {
    if (typeof schedule !== "function") throw new Error("schedule is required");
    let decoded = 0;
    let started = false;
    for await (const frame of frameSource) {
      if (isCancelled && isCancelled()) return { decoded, cancelled: true };
      if (onFrame) onFrame(frame);
      if (frame && frame.error) {
        throw Object.assign(new Error(frame.error), {
          code: frame.code,
          decoded,
          afterAudio: decoded > 0,
        });
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

  function createPlaybackGate() {
    let paused = false;
    const listeners = new Set();
    return {
      isPaused() { return paused; },
      pause() {
        paused = true;
        listeners.forEach((fn) => fn());
      },
      resume() {
        paused = false;
        listeners.forEach((fn) => fn());
      },
      reset() {
        paused = false;
        listeners.forEach((fn) => fn());
      },
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      shouldResumeContext(state) {
        return !paused && state === "suspended";
      },
      canStart(state) {
        if (state === "closed") return false;
        if (paused) return state === "suspended" || state === "running";
        return state === "running";
      },
    };
  }

  function createPlaybackClock(lead = 0.25, recoveryLead) {
    const startupLead = Number(lead) || 0;
    const recover = recoveryLead == null ? startupLead : Number(recoveryLead) || 0;
    let nextStart = 0;
    let started = false;
    return {
      schedule(duration, currentTime) {
        const dur = Number(duration) || 0;
        const now = Number(currentTime) || 0;
        let startAt;
        if (!started) {
          startAt = now + startupLead;
          started = true;
        } else if (now >= nextStart) {
          startAt = Math.max(nextStart, now + recover);
        } else {
          startAt = nextStart;
        }
        nextStart = startAt + dur;
        return startAt;
      },
      peekNext() { return nextStart; },
      horizon(currentTime) { return Math.max(0, nextStart - (Number(currentTime) || 0)); },
      reset() {
        nextStart = 0;
        started = false;
      },
    };
  }

  function speakStatus(phase) {
    if (phase === "prepare") return "Preparing...";
    if (phase === "generate") return "Generating...";
    if (phase === "buffer") return "Buffering...";
    if (phase === "retry") return "Retrying...";
    if (phase === "interrupt") return "Interrupted";
    return "Reading...";
  }

  root.OpenTTSPlayback = {
    splitText,
    consumePlaybackStream,
    createPlaybackClock,
    createPlaybackGate,
    speakStatus,
    norm: normalizeText,
    normalizeText,
    packGenerationUnits,
    sentenceUnits,
    hardSplit,
    nonWhitespaceKey,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
