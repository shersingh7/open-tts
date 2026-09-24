import { describe, expect, it } from "vitest";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { createSessionStore, SESSION_KEY } from "../sw/session-store.js";

const RUN = { runId: "r1", source: "popup", hostKind: "offscreen", text: "Hello world" };

function setup(initial) {
  const chrome = createFakeChrome({ storage: { session: initial || {} } });
  const store = createSessionStore({ storage: chrome.storage.session });
  return { chrome, store };
}

describe("sw/session-store", () => {
  it("starts idle at revision 0 when nothing is persisted", async () => {
    const { store } = setup();
    const session = await store.load();
    expect(session).toMatchObject({ runId: null, state: "idle", revision: 0 });
  });

  it("begin → end → end: only the first end returns true", async () => {
    const { store } = setup();
    await store.load();
    const begun = store.begin(RUN);
    expect(begun).toMatchObject({ runId: "r1", state: "preparing", source: "popup", hostKind: "offscreen" });
    expect(begun.textPreview).toBe("Hello world");
    expect(store.end("r1", "completed")).toBe(true);
    expect(store.end("r1", "failed", { error: { message: "late" } })).toBe(false);
    expect(store.current()).toMatchObject({ state: "idle", outcome: "completed", runId: "r1" });
  });

  it("revision strictly increases across begin/update/end", async () => {
    const { store } = setup();
    await store.load();
    const revisions = [store.current().revision];
    revisions.push(store.begin(RUN).revision);
    revisions.push(store.update("r1", { state: "playing", label: "Reading..." }).revision);
    store.end("r1", "stopped");
    revisions.push(store.current().revision);
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
  });

  it("update and end for a run that is not current do nothing", async () => {
    const { store } = setup();
    await store.load();
    store.begin(RUN);
    const before = store.current();
    expect(store.update("other", { state: "playing" })).toBeNull();
    expect(store.end("other", "completed")).toBe(false);
    expect(store.current()).toBe(before);
  });

  it("update cannot change runId or revision", async () => {
    const { store } = setup();
    await store.load();
    store.begin(RUN);
    const updated = store.update("r1", { runId: "x", revision: -5, state: "paused" });
    expect(updated.runId).toBe("r1");
    expect(updated.revision).toBeGreaterThan(1);
  });

  it("a new store restores the persisted session, run info and revision", async () => {
    const { chrome, store } = setup();
    await store.load();
    const info = { runId: "r1", historyText: "Hello", chars: 5, voice: "af_bella", model: "kokoro", speed: 1,
      startedAt: 1 };
    store.begin(RUN, info);
    store.update("r1", { state: "playing" });
    await store.whenPersisted();
    expect(chrome.fake.storageData.session[SESSION_KEY].session.state).toBe("playing");

    const restored = createSessionStore({ storage: chrome.storage.session });
    const session = await restored.load();
    expect(session).toEqual(store.current());
    expect(restored.runInfo()).toEqual(info);
    restored.update("r1", { state: "paused" });
    expect(restored.current().revision).toBe(store.current().revision + 1);
  });

  it("runInfo is null after the run is replaced by one without info", async () => {
    const { store } = setup();
    await store.load();
    store.begin(RUN, { runId: "r1", historyText: "", chars: 0, voice: "", model: "", speed: 1, startedAt: 0 });
    store.end("r1", "superseded");
    store.begin({ ...RUN, runId: "r2" });
    expect(store.runInfo()).toBeNull();
  });

  it("coalesces writes and persists the latest state", async () => {
    const { chrome, store } = setup();
    await store.load();
    store.begin(RUN);
    for (let i = 0; i < 10; i++) store.update("r1", { progress: { played: i, scheduled: 10 } });
    await store.whenPersisted();
    const writes = chrome.storage.session.set.calls.length;
    expect(writes).toBeLessThan(11);
    expect(chrome.fake.storageData.session[SESSION_KEY].session.progress.played).toBe(9);
  });

  it("reports persistence failures without throwing", async () => {
    const chrome = createFakeChrome();
    const errors = [];
    const store = createSessionStore({ storage: chrome.storage.session, onError: (e) => errors.push(e) });
    await store.load();
    chrome.fake.failNext("storage.session.set", "quota");
    store.begin(RUN);
    await store.whenPersisted();
    expect(errors.map((e) => e.message)).toEqual(["quota"]);
  });

  it("a mutation before load finishes keeps revision monotonic", async () => {
    const { chrome } = setup();
    chrome.fake.storageData.session[SESSION_KEY] = {
      session: { runId: "old", revision: 40, state: "idle", label: "Done", source: null, sourceTabId: null,
        sourceFrameId: null, hostKind: null, progress: null },
      runInfo: null,
    };
    const store = createSessionStore({ storage: chrome.storage.session });
    const loading = store.load();
    store.begin(RUN);
    await loading;
    expect(store.current().runId).toBe("r1");
    expect(store.current().revision).toBeGreaterThan(40);
  });

  it("truncates textPreview to 200 chars", async () => {
    const { store } = setup();
    await store.load();
    expect(store.begin({ ...RUN, text: "x".repeat(500) }).textPreview).toHaveLength(200);
  });
});
