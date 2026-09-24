import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, createPortPair } from "./helpers/fake-chrome.js";
import { chooseHostKind, createHostManager, createHostRegistry, firstAudioDeadlineMs, READER_PATH }
  from "../sw/host-manager.js";

describe("chooseHostKind", () => {
  const table = [
    // [chars, model, expected]
    [5, "kokoro", "offscreen"],
    [600, "kokoro", "offscreen"],
    [601, "kokoro", "offscreen"],
    [5000, "kokoro", "reader"],
    [5, "qwen3-tts", "offscreen"],
    [600, "qwen3-tts", "offscreen"],
    [601, "qwen3-tts", "reader"],
    [5000, "qwen3-tts", "reader"],
    [5, "fish-s2-pro", "offscreen"],
    [600, "fish-s2-pro", "offscreen"],
    [601, "fish-s2-pro", "reader"],
    [5000, "fish-s2-pro", "reader"],
  ];
  it.each(table)("%i chars × %s → %s", (textLength, model, expected) => {
    expect(chooseHostKind({ textLength, model, source: "popup" })).toBe(expected);
  });

  it("4000 chars stays offscreen for kokoro; 4001 goes to the Reader", () => {
    expect(chooseHostKind({ textLength: 4000, model: "kokoro", source: "content" })).toBe("offscreen");
    expect(chooseHostKind({ textLength: 4001, model: "kokoro", source: "content" })).toBe("reader");
  });

  it("runs started from the Reader stay in the Reader", () => {
    expect(chooseHostKind({ textLength: 5, model: "kokoro", source: "reader" })).toBe("reader");
  });

  it("slow models on offscreen get the first-audio deadline", () => {
    expect(firstAudioDeadlineMs("offscreen", "qwen3-tts")).toBe(25000);
    expect(firstAudioDeadlineMs("offscreen", "fish-s2-pro")).toBe(25000);
    expect(firstAudioDeadlineMs("offscreen", "kokoro")).toBeNull();
    expect(firstAudioDeadlineMs("reader", "qwen3-tts")).toBeNull();
  });
});

describe("host registry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waitFor resolves when the host registers", async () => {
    const registry = createHostRegistry();
    const { server } = createPortPair("host:offscreen");
    const waiting = registry.waitFor("offscreen", 1000);
    registry.set("offscreen", server);
    await expect(waiting).resolves.toBe(server);
    await expect(registry.waitFor("offscreen")).resolves.toBe(server);
  });

  it("waitFor times out with host_unavailable", async () => {
    vi.useFakeTimers();
    const registry = createHostRegistry();
    const waiting = registry.waitFor("reader", 500);
    const assertion = expect(waiting).rejects.toMatchObject({ code: "host_unavailable", message: "Reader did not start" });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it("remove only forgets the registered port", () => {
    const registry = createHostRegistry();
    const a = createPortPair("host:reader", { tab: { id: 7 } }).server;
    const b = createPortPair("host:reader", { tab: { id: 8 } }).server;
    registry.set("reader", a);
    expect(registry.remove(b)).toBeNull();
    expect(registry.readerTabId()).toBe(7);
    expect(registry.remove(a)).toBe("reader");
    expect(registry.get("reader")).toBeNull();
  });
});

describe("host manager", () => {
  function setup() {
    const chrome = createFakeChrome();
    const registry = createHostRegistry();
    const manager = createHostManager({ chrome, registry, readyTimeoutMs: 1000 });
    return { chrome, registry, manager };
  }

  it("creates the offscreen document once with AUDIO_PLAYBACK", async () => {
    const { chrome, manager } = setup();
    await Promise.all([manager.ensureOffscreen(), manager.ensureOffscreen()]);
    await manager.ensureOffscreen();
    expect(chrome.offscreen.createDocument.calls).toHaveLength(1);
    expect(chrome.offscreen.createDocument.calls[0][0]).toMatchObject({
      url: "host/offscreen.html", reasons: ["AUDIO_PLAYBACK"],
    });
  });

  it("tolerates a creation race when the document exists afterwards", async () => {
    const { chrome, manager } = setup();
    chrome.offscreen.createDocument.impl = () => {
      chrome.fake.contexts.push({ contextType: "OFFSCREEN_DOCUMENT",
        documentUrl: chrome.runtime.getURL("host/offscreen.html") });
      throw new Error("Only a single offscreen document may be created.");
    };
    await expect(manager.ensureOffscreen()).resolves.toBeUndefined();
  });

  it("propagates a real creation failure", async () => {
    const { chrome, manager } = setup();
    chrome.fake.failNext("offscreen.createDocument", "boom");
    await expect(manager.ensureOffscreen()).rejects.toThrow("boom");
  });

  it("opens one Reader tab, pins it, and reuses it", async () => {
    const { chrome, manager } = setup();
    const [a, b] = await Promise.all([manager.ensureReader(), manager.ensureReader()]);
    expect(a).toBe(b);
    const again = await manager.ensureReader();
    expect(again).toBe(a);
    expect(chrome.tabs.create.calls).toHaveLength(1);
    expect(chrome.tabs.create.calls[0][0]).toEqual({ url: chrome.runtime.getURL(READER_PATH), active: true });
    expect(chrome.fake.tabs.get(a).autoDiscardable).toBe(false);
  });

  it("reuses an existing Reader tab found through getContexts", async () => {
    const { chrome, manager } = setup();
    chrome.fake.addTab({ id: 42, url: chrome.runtime.getURL(READER_PATH) });
    chrome.fake.contexts.push({ contextType: "TAB", documentUrl: chrome.runtime.getURL(READER_PATH), tabId: 42 });
    expect(await manager.ensureReader()).toBe(42);
    expect(chrome.tabs.create.calls).toHaveLength(0);
    expect(chrome.tabs.update.calls[0]).toEqual([42, { autoDiscardable: false }]);
  });

  it("releaseReader restores autoDiscardable and ignores closed tabs", async () => {
    const { chrome, manager } = setup();
    const tabId = await manager.ensureReader();
    await manager.releaseReader();
    expect(chrome.fake.tabs.get(tabId).autoDiscardable).toBe(true);
    await chrome.tabs.remove(tabId);
    await expect(manager.releaseReader()).resolves.toBeUndefined();
  });

  it("ensureHost waits for the host HOST_HELLO registration", async () => {
    const { registry, manager } = setup();
    const port = createPortPair("host:offscreen").server;
    const pending = manager.ensureHost("offscreen");
    await new Promise((resolve) => setTimeout(resolve, 0));
    registry.set("offscreen", port);
    await expect(pending).resolves.toBe(port);
  });

  it("pinReader pins the accepted Reader tab", async () => {
    const { chrome, registry, manager } = setup();
    chrome.fake.addTab({ id: 9, autoDiscardable: true });
    registry.set("reader", createPortPair("host:reader", { tab: { id: 9 } }).server);
    await manager.pinReader();
    expect(chrome.fake.tabs.get(9).autoDiscardable).toBe(false);
  });
});
