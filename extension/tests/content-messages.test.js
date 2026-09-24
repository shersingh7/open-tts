import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MSG } from "../shared/messages.js";

const contentPath = fileURLToPath(new URL("../content/content.js", import.meta.url));

describe("content script MSG mirror", () => {
  it("declares a local MSG object matching shared/messages.js for every key it uses", () => {
    const source = readFileSync(contentPath, "utf8");
    const match = source.match(/const MSG = \{([\s\S]*?)\n {2}\};/);
    expect(match, "content.js should declare `const MSG = {...}`").not.toBeNull();
    const pairs = [...match[1].matchAll(/(\w+):\s*"([^"]+)"/g)];
    expect(pairs.length).toBeGreaterThan(0);
    for (const [, key, value] of pairs) {
      expect(MSG[key], `MSG.${key} should equal shared/messages.js MSG.${key}`).toBe(value);
    }
  });
});
