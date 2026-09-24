// @ts-check
// Open TTS v4 — API token handling. The token lives only in chrome.storage.session restricted to trusted
// (extension) contexts, so content scripts in web page renderers can never read it (finding #3, plan 1.2).

import { sendNativeCommand } from "./native.js";

export const TOKEN_KEY = "installToken";
export const TOKEN_HEADER = "X-Open-TTS-Token";

/**
 * @param {object} options
 * @param {typeof chrome} options.chrome
 * @param {(command: "status") => Promise<{install_token?: string|null}>} [options.native]
 */
export function createAuth({ chrome: chromeApi, native }) {
  const nativeCommand = native || ((command) => sendNativeCommand(chromeApi, command));
  /** @type {Promise<string>|null} */
  let refreshing = null;

  /** @param {string} token */
  async function storeToken(token) {
    if (token) await chromeApi.storage.session.set({ [TOKEN_KEY]: token });
  }

  /**
   * Ask the native host for the current install token and store it. Concurrent callers share one request.
   * Resolves "" when the host is missing or the server is not running.
   * @returns {Promise<string>}
   */
  function refreshToken() {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const status = await nativeCommand("status");
          const token = typeof status?.install_token === "string" ? status.install_token : "";
          await storeToken(token);
          return token;
        } catch {
          return "";
        }
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  /** @returns {Promise<string>} the stored token, fetched from the native host on a miss ("" if unavailable) */
  async function getToken() {
    const stored = await chromeApi.storage.session.get(TOKEN_KEY).catch(() => ({}));
    const token = /** @type {Record<string, unknown>} */ (stored)[TOKEN_KEY];
    if (typeof token === "string" && token) return token;
    return refreshToken();
  }

  return {
    /**
     * Run once at service-worker start: restrict storage.session to extension contexts and remove the v3 token
     * copy from storage.local (idempotent migration). Never rejects.
     */
    async init() {
      await Promise.allSettled([
        chromeApi.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
        chromeApi.storage.local.remove(TOKEN_KEY),
      ]);
    },
    storeToken,
    refreshToken,
    getToken,
    /**
     * @param {{json?: boolean}} [options]
     * @returns {Promise<Record<string, string>>}
     */
    async authHeaders({ json = false } = {}) {
      /** @type {Record<string, string>} */
      const headers = {};
      if (json) headers["Content-Type"] = "application/json";
      const token = await getToken();
      if (token) headers[TOKEN_HEADER] = token;
      return headers;
    },
  };
}

/** @typedef {ReturnType<typeof createAuth>} Auth */
