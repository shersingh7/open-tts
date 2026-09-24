// @ts-check
// Open TTS v4 — keep the Reader page alive while it owns a run (including paused and buffering, when no audio
// is audible). Holding a Web Lock opts the tab out of Chrome's background freezing; the SW separately marks the
// tab non-discardable. Best effort: without `navigator.locks` this is a no-op.

export const KEEP_ALIVE_LOCK = "open-tts-reader-playback";

/**
 * @param {{request: (name: string, callback: () => Promise<void>) => Promise<unknown>} | undefined} [locks]
 */
export function createKeepAlive(locks = globalThis.navigator?.locks) {
  /** @type {(() => void) | null} */
  let release = null;
  return {
    /** Hold the lock until `release()` (idempotent). */
    hold() {
      if (release || !locks) return;
      const held = new Promise((resolve) => {
        release = () => resolve(undefined);
      });
      Promise.resolve(locks.request(KEEP_ALIVE_LOCK, () => /** @type {Promise<void>} */ (held))).catch(() => {});
    },
    release() {
      const current = release;
      release = null;
      current?.();
    },
    get held() { return release !== null; },
  };
}
