export const SERVER_URL = "http://127.0.0.1:8000";
export const NATIVE_HOST = "com.open_tts.native_host";
export const CHUNK_TARGET = 4000;
export const FIRST_CHUNK_TARGET = 4000;
export const MAX_HISTORY = 20;
export const MAX_CHARS = 200000;
export const MAX_BATCH_TEXTS = 50;
export const LOAD_MODEL_TIMEOUT_MS = 300000;
export const PLAYBACK_HIGH_WATER_SECONDS = 20;
export const PLAYBACK_LOW_WATER_SECONDS = 10;
export const PLAYBACK_MAX_DECODED_BYTES = 16 * 1024 * 1024;
export const PLAYBACK_STARTUP_LEAD = 0.25;
export const STREAM_IDLE_TIMEOUT_MS = 60000;
export const FALLBACK_WINDOW = 4;
export const DEFAULTS = {
  model: "kokoro",
  voice: "af_bella",
  speed: 1.5,
  language: "Auto",
  previewText: "Hello! Open TTS is ready.",
};
export const MODEL_DEFAULT_VOICES = {
  kokoro: "af_bella",
  "qwen3-tts": "ryan",
  "fish-s2-pro": "whisper",
};
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

export function resolveSpeed(value, fallback = DEFAULTS.speed) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(3, Math.max(0.5, n));
}

export function resolveVoice(model, settings = {}) {
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