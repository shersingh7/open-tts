#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
const dist = join(root, "dist");
const output = join(dist, `open-tts-extension-v${manifest.version}.zip`);
mkdirSync(dist, { recursive: true });
rmSync(output, { force: true });

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name);
    if (name === "tests" || name.startsWith(".")) return [];
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

const extensionDir = join(root, "extension");
// Paths are relative to extension/ so manifest.json sits at the zip root (required by Chrome / the Web Store).
const files = walk(extensionDir)
  .map((path) => path.slice(extensionDir.length + 1))
  .sort();
if (!files.includes("manifest.json")) throw new Error("manifest.json missing from extension files");
execFileSync("zip", ["-X", "-q", output, ...files], { cwd: extensionDir, stdio: "inherit" });
console.log(output);
