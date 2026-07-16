import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extension/tests/**/*.test.js"],
  },
});