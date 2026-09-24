// @ts-check
// Open TTS v4 — shared constants (ESM). Behaviour mirrors constants-umd.js minus dead chunking constants.

export const SERVER_URL = "http://127.0.0.1:8000";
export const NATIVE_HOST = "com.open_tts.native_host";
export const MAX_HISTORY = 20;
export const MAX_CHARS = 200000;
export const MAX_BATCH_TEXTS = 50;
export const LOAD_MODEL_TIMEOUT_MS = 300000;
export const PLAYBACK_HIGH_WATER_SECONDS = 20;
export const PLAYBACK_LOW_WATER_SECONDS = 10;
export const PLAYBACK_MAX_DECODED_BYTES = 16 * 1024 * 1024;
export const PLAYBACK_STARTUP_LEAD = 0.25;
export const STREAM_IDLE_TIMEOUT_MS = 60000;

// v4 additions (see docs/plans/v4-contract.md).
export const READER_TEXT_THRESHOLD = 4000;
export const SLOW_MODELS = ["qwen3-tts", "fish-s2-pro"];
export const SLOW_MODEL_READER_THRESHOLD = 600;
export const SLOW_START_TIMEOUT_MS = 25000;
export const HISTORY_TEXT_CAP = 2000;
export const HISTORY_MAX_BYTES = 256000;
export const HEARTBEAT_MS = 20000;
export const HIDDEN_SITES_KEY = "hiddenSites";

/**
 * @typedef {{model: string, voice: string, speed: number, language: string, previewText: string}} Defaults
 */

/** @type {Defaults} */
export const DEFAULTS = {
  model: "kokoro",
  voice: "af_bella",
  speed: 1.5,
  language: "Auto",
  previewText: "Hello! Open TTS is ready.",
};

/** @type {Record<string, string>} */
export const MODEL_DEFAULT_VOICES = {
  kokoro: "af_bella",
  "qwen3-tts": "ryan",
  "fish-s2-pro": "whisper",
};

/** @type {Record<string, string[]>} */
export const MODEL_VOICES = {
  kokoro: [
    "af_bella", "af_sarah", "af_nova", "af_heart", "af_jessica",
    "af_alloy", "af_sky", "af_river", "af_aoede", "af_kore",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa",
  ],
  "qwen3-tts": [
    "serena", "vivian", "uncle_fu", "dylan", "eric", "ryan", "aiden", "ono_anna", "sohee",
  ],
};

/**
 * Clamp a playback speed to [0.5, 3]; non-numeric input returns `fallback` (default DEFAULTS.speed).
 * @param {unknown} value
 * @param {number | null} [fallback]
 * @returns {number}
 */
export function resolveSpeed(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback == null ? DEFAULTS.speed : fallback;
  return Math.min(3, Math.max(0.5, n));
}

/**
 * Pick a voice valid for `model`: Fish style, then per-model preference, then a compatible saved voice,
 * then the model default.
 * @param {string | null | undefined} model
 * @param {{voice?: string, voicePrefs?: Record<string, string>, fishStyle?: string} | null} [settings]
 * @returns {string}
 */
export function resolveVoice(model, settings) {
  settings = settings || {};
  const modelId = model || DEFAULTS.model;
  if (modelId === "fish-s2-pro") {
    return settings.fishStyle || MODEL_DEFAULT_VOICES[modelId];
  }
  const prefs = settings.voicePrefs || {};
  if (prefs[modelId]) return prefs[modelId];
  const candidate = settings.voice;
  const allowed = MODEL_VOICES[modelId] || [];
  const lowered = candidate ? String(candidate).toLowerCase() : "";
  if (lowered && allowed.includes(lowered)) return lowered;
  return MODEL_DEFAULT_VOICES[modelId] || DEFAULTS.voice;
}
