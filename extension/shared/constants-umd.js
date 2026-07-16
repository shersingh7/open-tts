(function (root) {
  root.OpenTTSConstants = {
    SERVER_URL: "http://127.0.0.1:8000",
    NATIVE_HOST: "com.open_tts.native_host",
    CHUNK_TARGET: 8000,
    MAX_HISTORY: 20,
    MAX_CHARS: 200000,
    DEFAULTS: {
      model: "kokoro",
      voice: "af_bella",
      speed: 1.5,
      language: "Auto",
      previewText: "Hello! Open TTS is ready.",
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : self);