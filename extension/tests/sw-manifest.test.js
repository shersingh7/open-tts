import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const ICONS = { 16: "icon16.png", 32: "icon32.png", 48: "icon48.png", 128: "icon128.png" };

describe("manifest (v4 contract)", () => {
  it("matches the contract shape (version is bumped to 4.0.0 at integration, see NOTES-A)", () => {
    const rest = { ...manifest };
    delete rest.version;
    delete rest.description;
    expect(rest).toEqual({
      manifest_version: 3,
      name: "Open TTS",
      minimum_chrome_version: "116",
      permissions: ["storage", "nativeMessaging", "offscreen", "contextMenus"],
      host_permissions: ["http://127.0.0.1:8000/*"],
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:8000;",
      },
      background: { service_worker: "sw/main.js", type: "module" },
      action: { default_popup: "ui/popup.html", default_icon: ICONS },
      icons: ICONS,
      content_scripts: [{ matches: ["<all_urls>"], js: ["content/content.js"], run_at: "document_idle" }],
      commands: {
        "read-selection": { suggested_key: { default: "Alt+Shift+R" }, description: "Read selected text" },
        "toggle-pause": { suggested_key: { default: "Alt+Shift+P" }, description: "Pause or resume reading" },
      },
    });
  });

  it("content scripts no longer load storage helpers or content.css (token isolation, shadow-root CSS)", () => {
    const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
    expect(scripts.some((file) => file.includes("storage"))).toBe(false);
    expect(manifest.content_scripts.some((entry) => entry.css)).toBe(false);
  });

  it("does not request scripting or tabs permissions", () => {
    expect(manifest.permissions).not.toContain("scripting");
    expect(manifest.permissions).not.toContain("tabs");
  });
});
