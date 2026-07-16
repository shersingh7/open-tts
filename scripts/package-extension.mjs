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

const files = walk(join(root, "extension"))
  .map((path) => path.slice(root.length + 1))
  .sort();
if (!files.length) throw new Error("No extension files found");
execFileSync("zip", ["-X", "-q", output, ...files], { cwd: root, stdio: "inherit" });
console.log(output);
