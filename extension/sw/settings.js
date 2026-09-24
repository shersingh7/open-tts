// @ts-check
// Open TTS v4 — resolve the settings a SPEAK uses, from the payload or from storage (same rules as v3 content.js).

import { DEFAULTS, resolveSpeed, resolveVoice } from "../shared/constants.js";
import { localInstruction, syncGet } from "../shared/storage.js";

/** @typedef {{model: string, voice: string, speed: number, language: string, instruct: string}} SpeakSettings */

export const SETTINGS_KEYS = ["voice", "speed", "language", "model", "voicePrefs", "fishStyle"];

/**
 * @param {object} [deps]
 * @param {(keys: string[]) => Promise<Record<string, any>>} [deps.readSync]
 * @param {() => Promise<string>} [deps.readInstruction]
 */
export function createSettingsResolver(deps = {}) {
  const readSync = deps.readSync || syncGet;
  const readInstruction = deps.readInstruction || localInstruction;

  /** @returns {Promise<string>} */
  async function instruction() {
    try {
      return await readInstruction();
    } catch {
      return "";
    }
  }

  /**
   * Settings from storage: model from sync (default kokoro), voice via resolveVoice (Fish style / per-model
   * preference / saved voice), speed clamped by resolveSpeed, language default "Auto", instruct from local storage.
   * @returns {Promise<SpeakSettings>}
   */
  async function fromStorage() {
    const data = await readSync(SETTINGS_KEYS);
    const model = data.model || DEFAULTS.model;
    return {
      model,
      voice: resolveVoice(model, data),
      speed: resolveSpeed(data.speed),
      language: data.language || DEFAULTS.language,
      instruct: await instruction(),
    };
  }

  /**
   * Use the UI-provided settings when present (normalised), otherwise resolve from storage.
   * @param {Partial<SpeakSettings>|null|undefined} provided
   * @returns {Promise<SpeakSettings>}
   */
  async function resolve(provided) {
    if (!provided || typeof provided !== "object") return fromStorage();
    const model = typeof provided.model === "string" && provided.model ? provided.model : DEFAULTS.model;
    const voice = typeof provided.voice === "string" && provided.voice
      ? provided.voice
      : resolveVoice(model, await readSync(SETTINGS_KEYS));
    return {
      model,
      voice,
      speed: resolveSpeed(provided.speed),
      language: typeof provided.language === "string" && provided.language ? provided.language : DEFAULTS.language,
      instruct: typeof provided.instruct === "string" ? provided.instruct : "",
    };
  }

  return { resolve, fromStorage };
}
