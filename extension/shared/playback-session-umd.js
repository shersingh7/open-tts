(function (root) {
  const C = root.OpenTTSConstants || {};
  function abortError() { return Object.assign(new Error("Playback cancelled"), { name: "AbortError" }); }
  function bufferDecodedBytes(buf) { return buf.length * buf.numberOfChannels * 4; }

  // One owner for resources and asynchronous continuations. Contexts are never
  // shared between runs: a late resume/decode cannot touch a replacement run.
  function createPlaybackRun(opts = {}) {
    const high = opts.highWaterSeconds ?? C.PLAYBACK_HIGH_WATER_SECONDS ?? 20;
    const low = opts.lowWaterSeconds ?? C.PLAYBACK_LOW_WATER_SECONDS ?? 10;
    const maxBytes = opts.maxDecodedBytes ?? C.PLAYBACK_MAX_DECODED_BYTES ?? 16 * 1024 * 1024;
    const lead = opts.startupLead ?? C.PLAYBACK_STARTUP_LEAD ?? 0.25;
    const controller = new AbortController();
    const clock = root.OpenTTSPlayback.createPlaybackClock(lead);
    const gate = root.OpenTTSPlayback.createPlaybackGate();
    const sources = new Set(), waiters = new Set();
    let queuedSeconds = 0, decodedBytes = 0, scheduledCount = 0, endedCount = 0;
    let peakBytes = 0, peakHorizon = 0, generationComplete = false, terminal = false;
    let decoding = false, context = null, pendingBytes = 0;
    const remaining = () => controller.signal.aborted || !context ? 0 : Math.max(0, clock.peekNext() - context.currentTime);
    const notify = () => { for (const check of [...waiters]) check(); };
    if (!(high > low && low >= 0 && maxBytes > 0 && Number.isFinite(high))) throw new Error("Invalid playback limits");
    controller.signal.addEventListener("abort", notify, { once: true });
    const run = {
      ...opts, controller, clock, gate, sources, maxBytes,
      get signal() { return controller.signal; },
      get context() { return context; },
      setContext(ctx) { context = ctx; },
      get scheduledAny() { return scheduledCount > 0; },
      get scheduledCount() { return scheduledCount; },
      get endedCount() { return endedCount; },
      get queuedSeconds() { return remaining(); },
      get decodedBytes() { return decodedBytes + pendingBytes; },
      get peakBytes() { return peakBytes; },
      get peakHorizon() { return peakHorizon; },
      get terminalEmitted() { return terminal; },
      assertActive() { if (controller.signal.aborted || terminal) throw abortError(); },
      async waitForBudget(seconds = 0, bytes = 0) {
        run.assertActive();
        if (seconds > high || bytes > maxBytes) throw new Error("Audio frame exceeds playback budget");
        let throttled = remaining() + seconds > high + lead || decodedBytes + bytes > maxBytes;
        if (!throttled) return;
        await new Promise((resolve, reject) => {
          let timer = null;
          const finish = (error) => {
            clearTimeout(timer); waiters.delete(check);
            error ? reject(error) : resolve();
          };
          const check = () => {
            clearTimeout(timer);
            if (controller.signal.aborted) { finish(abortError()); return; }
            const secondsLeft = remaining();
            if (secondsLeft <= low && secondsLeft + seconds <= high + lead && decodedBytes + bytes <= maxBytes) {
              finish(); return;
            }
            timer = setTimeout(check, 50);
          };
          waiters.add(check); check();
        });
        run.assertActive();
      },
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
        } finally { decoding = false; pendingBytes = 0; }
      },
      async scheduleBuffer(ctx, buf, rate = 1, hooks = {}) {
        run.assertActive();
        if (rate !== 1) throw new Error("Server must apply audio speed exactly once");
        const duration = buf.duration, bytes = bufferDecodedBytes(buf);
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
        src.buffer = buf; src.playbackRate.value = 1; src.connect(ctx.destination);
        src.onended = () => {
          if (!sources.delete(src)) return;
          src.onended = null;
          try { src.disconnect(); } catch (_) {}
          src.buffer = null;
          endedCount++; queuedSeconds = Math.max(0, queuedSeconds - duration);
          decodedBytes = Math.max(0, decodedBytes - bytes); notify();
          if (!controller.signal.aborted && hooks.onEnded) hooks.onEnded();
        };
        sources.add(src); scheduledCount++; queuedSeconds += duration; decodedBytes += bytes;
        peakBytes = Math.max(peakBytes, decodedBytes);
        peakHorizon = Math.max(peakHorizon, clock.horizon(ctx.currentTime));
        try { src.start(startAt); } catch (e) { run.teardown(); throw e; }
        return { startAt, endAt: startAt + duration, rebuffered: wasUnderflow };
      },
      markGenerationComplete() { generationComplete = true; },
      playbackDrained() { return generationComplete && scheduledCount > 0 && sources.size === 0 && !decoding; },
      markTerminal() { if (terminal) return false; terminal = true; return true; },
      teardown() {
        controller.abort();
        for (const src of sources) {
          src.onended = null;
          try { src.stop(); src.disconnect(); } catch (_) {}
          src.buffer = null;
        }
        sources.clear(); queuedSeconds = 0; decodedBytes = 0;
        run.authToken = "";
        if (context) { const old = context; context = null; Promise.resolve(old.close()).catch(() => {}); }
        notify();
      },
    };
    return run;
  }

  function readWithIdleTimeout(reader, signal, idleMs = C.STREAM_IDLE_TIMEOUT_MS || 60000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(value);
      };
      const onAbort = () => finish(reject, abortError());
      const timer = setTimeout(() => finish(reject, Object.assign(new Error("Stream idle timeout"), { code: "stream_timeout" })), idleMs);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => reader.read()).then(v => finish(resolve, v), e => finish(reject, e));
    });
  }
  root.OpenTTSPlaybackSession = { createPlaybackRun, readWithIdleTimeout, bufferDecodedBytes };
})(globalThis);
