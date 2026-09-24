import { afterEach, describe, expect, it } from "vitest";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { createHistory, trimHistory } from "../sw/history.js";
import { HISTORY_MAX_BYTES, HISTORY_TEXT_CAP, MAX_HISTORY } from "../shared/constants.js";

afterEach(() => {
  delete globalThis.chrome;
});

const run = (id, text = "hello") => ({ id, text, voice: "af_bella", model: "kokoro", speed: 1.5, timestamp: 1 });

describe("sw/history", () => {
  it("writes nothing when historyEnabled is unset (off by default)", async () => {
    const chrome = (globalThis.chrome = createFakeChrome());
    expect(await createHistory().persistCompletion(run("a"))).toBe(false);
    expect(chrome.storage.local.set.calls).toHaveLength(0);
  });

  it("writes nothing when historyEnabled is false", async () => {
    const chrome = (globalThis.chrome = createFakeChrome({ storage: { local: { historyEnabled: false } } }));
    await createHistory().persistCompletion(run("a"));
    expect(chrome.fake.storageData.local.ttsHistory).toBeUndefined();
  });

  it("stores a capped entry when enabled", async () => {
    const chrome = (globalThis.chrome = createFakeChrome({ storage: { local: { historyEnabled: true } } }));
    await createHistory().persistCompletion(run("a", "x".repeat(5000)));
    const [entry] = chrome.fake.storageData.local.ttsHistory;
    expect(entry).toEqual({ id: "a", text: "x".repeat(HISTORY_TEXT_CAP), chars: 5000, truncated: true,
      voice: "af_bella", model: "kokoro", speed: 1.5, timestamp: 1 });
  });

  it("short text is not truncated; chars override is honoured for pre-capped text", async () => {
    const chrome = (globalThis.chrome = createFakeChrome({ storage: { local: { historyEnabled: true } } }));
    const history = createHistory();
    await history.persistCompletion(run("a", "short"));
    await history.persistCompletion({ ...run("b", "y".repeat(HISTORY_TEXT_CAP)), chars: 9000 });
    const [a, b] = chrome.fake.storageData.local.ttsHistory;
    expect(a).toMatchObject({ chars: 5, truncated: false });
    expect(b).toMatchObject({ chars: 9000, truncated: true });
  });

  it("20 completed runs of 200k chars stay under 256 KB and at most MAX_HISTORY entries", async () => {
    const chrome = (globalThis.chrome = createFakeChrome({ storage: { local: { historyEnabled: true } } }));
    const history = createHistory();
    await Promise.all(Array.from({ length: 25 }, (_, i) => history.persistCompletion(run(`r${i}`, "z".repeat(200000)))));
    const list = chrome.fake.storageData.local.ttsHistory;
    expect(list.length).toBeLessThanOrEqual(MAX_HISTORY);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(list.at(-1).id).toBe("r24");
  });

  it("serializes writes so concurrent completions are all kept", async () => {
    const chrome = (globalThis.chrome = createFakeChrome({ storage: { local: { historyEnabled: true } } }));
    const history = createHistory();
    await Promise.all(["a", "b", "c"].map((id) => history.persistCompletion(run(id))));
    expect(chrome.fake.storageData.local.ttsHistory.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("trims oversized legacy entries on the next write", () => {
    const legacy = Array.from({ length: 3 }, (_, i) => ({ ...run(`old${i}`, "q".repeat(200000)), chars: 200000 }));
    const trimmed = trimHistory([...legacy, { ...run("new"), chars: 5, truncated: false }]);
    expect(trimmed.map((entry) => entry.id)).toEqual(["old2", "new"]);
  });

  it("reports failures as HISTORY_ERROR and keeps working", async () => {
    const chrome = (globalThis.chrome = createFakeChrome({ storage: { local: { historyEnabled: true } } }));
    const errors = [];
    const history = createHistory({ onError: (runId, message) => errors.push({ runId, message }) });
    chrome.fake.failNext("storage.local.set", "QUOTA_BYTES quota exceeded");
    expect(await history.persistCompletion(run("a"))).toBe(false);
    expect(errors).toEqual([{ runId: "a", message: expect.stringMatching(/history could not be saved: QUOTA/) }]);
    expect(await history.persistCompletion(run("b"))).toBe(true);
  });
});
