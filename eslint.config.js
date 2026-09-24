import js from "@eslint/js";
import globals from "globals";

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
    // content.js is a classic (non-module) content script.
    files: ["extension/content/content.js"],
    languageOptions: { sourceType: "script" },
  },
];
