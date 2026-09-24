import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestVersion = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")).version;
const VERSION_PATTERN = /\bv(\d+\.\d+(?:\.\d+)?)\b/g;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name);
    if (name === "tests" || name.startsWith(".")) return [];
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return /\.(js|css|html)$/.test(name) ? [absolute] : [];
  });
}

describe("version sync", () => {
  it("every v<semver> header in extension sources equals manifest.version", () => {
    const mismatches = [];
    for (const file of sourceFiles(extensionDir)) {
      for (const match of readFileSync(file, "utf8").matchAll(VERSION_PATTERN)) {
        if (match[1] !== manifestVersion) mismatches.push(`${relative(extensionDir, file)}: ${match[0]}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("popup.html has no hardcoded version (popup sets it from the manifest)", () => {
    const popups = sourceFiles(extensionDir).filter((file) => file.endsWith("popup.html"));
    expect(popups.length).toBeGreaterThan(0);
    for (const file of popups) {
      const html = readFileSync(file, "utf8");
      expect(html).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
    }
  });
});
