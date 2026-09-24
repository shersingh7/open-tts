// @ts-check
// Open TTS v4 — one-shot native messaging to the Open TTS native host (start / stop / status).

import { NATIVE_HOST } from "../shared/constants.js";

export const NATIVE_TIMEOUT_MS = 30000;

/**
 * @typedef {{success?: boolean, message?: string, install_token?: string|null, running?: boolean,
 *   [key: string]: unknown}} NativeResponse
 */

/**
 * Send `{command}` to the native host. Rejects on chrome.runtime.lastError or after `timeoutMs`.
 * @param {typeof chrome} chromeApi
 * @param {"start"|"stop"|"status"} command
 * @param {number} [timeoutMs]
 * @returns {Promise<NativeResponse>}
 */
export function sendNativeCommand(chromeApi, command, timeoutMs = NATIVE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native host timeout")), timeoutMs);
    chromeApi.runtime.sendNativeMessage(NATIVE_HOST, { command }, (response) => {
      clearTimeout(timer);
      const error = chromeApi.runtime.lastError;
      if (error) reject(new Error(error.message || "Native host error"));
      else resolve(response || {});
    });
  });
}
