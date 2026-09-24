import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extension/tests/**/*.test.js"],
    // e2e/ runs real Chrome against a fake backend with its own runner; never under vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
