// @ts-check
// Open TTS v4 — offscreen playback host: the shared engine behind a host:offscreen port.

import { createEngine } from "./engine.js";
import { connectHost } from "./host-port.js";

/**
 * Wire the engine to the service worker. Options are injectable for tests.
 * @param {{connect?: (info: {name: string}) => chrome.runtime.Port, engineOptions?: Record<string, any>}} [options]
 */
export function startOffscreenHost(options = {}) {
  /** @type {import("./host-port.js").HostPort | null} */
  let hostPort = null;
  const engine = createEngine({
    hostKind: "offscreen",
    emit: (message) => hostPort?.forward(message),
    ...options.engineOptions,
  });
  hostPort = connectHost({ kind: "offscreen", engine, ...(options.connect ? { connect: options.connect } : {}) });
  return { engine, hostPort };
}

if (typeof document !== "undefined" && globalThis.chrome?.runtime?.id) startOffscreenHost();
