import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(root, "..", "shared", "storage-umd.js"), "utf8");

function loadStorage() {
  const syncSet = vi.fn((_obj, cb) => cb?.());
  const localSet = vi.fn((_obj, cb) => cb?.());
  const chrome = {
    storage: {
      sync: { get: vi.fn((_keys, cb) => cb({})), set: syncSet },
      local: { get: vi.fn((_keys, cb) => cb({})), set: localSet },
    },
  };
  const global = { chrome };
  new Function("globalThis", "chrome", code)(global, chrome);
  return { storage: global.OpenTTSStorage, syncSet, localSet };
}

afterEach(() => vi.useRealTimers());

describe("storage privacy and debounce", () => {
  it("debounces draft text into local storage only", async () => {
    vi.useFakeTimers();
    const { storage, syncSet, localSet } = loadStorage();
    storage.debouncedLocalSet("previewText", "first", 50);
    storage.debouncedLocalSet("previewText", "private phrase", 50);
    await vi.advanceTimersByTimeAsync(51);
    expect(localSet).toHaveBeenCalledTimes(1);
    expect(localSet).toHaveBeenCalledWith({ previewText: "private phrase" }, expect.any(Function));
    expect(syncSet).not.toHaveBeenCalled();
  });

  it("stores only the install token in local storage", async () => {
    const { storage, localSet } = loadStorage();
    await storage.storeInstallToken("token-value");
    expect(localSet).toHaveBeenCalledWith({ installToken: "token-value" }, expect.any(Function));
  });
});
