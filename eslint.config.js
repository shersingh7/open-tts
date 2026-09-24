import js from "@eslint/js";
import globals from "globals";

// v3 files that are deleted at v4 integration. They are written in a dense, minified-like style,
// so a few rules that only fire because of that style are relaxed for them.
const LEGACY_V3_FILES = [
  "extension/background.js",
  "extension/offscreen.js",
  "extension/popup.js",
  "extension/content.js",
  "extension/reader.js",
  "extension/shared/*-umd.js",
  "extension/tests/background.test.js",
  "extension/tests/constants.test.js",
  "extension/tests/content.test.js",
  "extension/tests/offscreen.test.js",
  "extension/tests/pipeline-harness.js",
  "extension/tests/playback.test.js",
  "extension/tests/popup-lifecycle.test.js",
  "extension/tests/popup.test.js",
  "extension/tests/progressive.test.js",
  "extension/tests/protocol.test.js",
  "extension/tests/storage.test.js",
  "extension/tests/stream-decoder.test.js",
];

export default [
  {
    ignores: [
      "backend/**",
      "dist/**",
      "node_modules/**",
      "**/node_modules/**",
      "graphify-out/**",
      "artifacts/**",
      ".artifacts/**",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      "no-unused-vars": "error",
    },
  },
  {
    files: ["scripts/**", "e2e/**", "*.config.js", "*.config.mjs", "extension/tests/**"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: LEGACY_V3_FILES,
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        OpenTTSConstants: "readonly",
        OpenTTSProtocol: "readonly",
        OpenTTSStorage: "readonly",
        OpenTTSStream: "readonly",
        OpenTTSPlayback: "readonly",
        OpenTTSPlaybackSession: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
];
