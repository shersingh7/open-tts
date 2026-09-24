// host/reader-view.js — pure Reader rendering from SESSION snapshots plus the Reader's local run knowledge.
import { describe, expect, it } from "vitest";
import { partitionText } from "../host/engine.js";
import {
  applyView, describeRunSettings, passageInfo, REJECT_TEXT, renderReader,
} from "../host/reader-view.js";
import { idleSession } from "../shared/messages.js";

const TEXT = "First paragraph here.\n\nSecond one.\n\nThird and last.";

function session(patch = {}) {
  return { ...idleSession(3), ...patch };
}

function local(patch = {}) {
  return {
    runId: "r1",
    text: TEXT,
    parts: partitionText(TEXT),
    settings: { model: "kokoro", voice: "af_bella", speed: 1.5 },
    retryText: "",
    outcome: null,
    ...patch,
  };
}

const active = (patch = {}) => session({
  runId: "r1", state: "playing", label: "Reading...", source: "reader", hostKind: "reader",
  progress: { played: 0, scheduled: 1 }, ...patch,
});

describe("passageInfo", () => {
  const parts = partitionText(TEXT);
  it("counts paragraphs as passages and locates the played offset", () => {
    expect(passageInfo(parts, 0, 0)).toEqual({ current: 1, total: 3, percent: 0 });
    expect(passageInfo(parts, 0, 21)).toMatchObject({ current: 2, total: 3 });
    const all = Array.from(parts.join("")).length;
    expect(passageInfo(parts, 0, all)).toEqual({ current: 3, total: 3, percent: 100 });
  });

  it("sums earlier partitions for a later index", () => {
    const two = ["Alpha.\n\nBeta.", "Gamma."];
    expect(passageInfo(two, 1, 3)).toMatchObject({ current: 3, total: 3 });
    expect(passageInfo(two, 1, 3).percent).toBeCloseTo((100 * (13 + 3)) / 19, 5);
  });

  it("handles missing text", () => {
    expect(passageInfo([], 0, 0)).toEqual({ current: 0, total: 0, percent: 0 });
  });
});

describe("renderReader", () => {
  it("shows the waiting state before any snapshot", () => {
    const view = renderReader({ session: null, controllable: false, local: null, rejected: null });
    expect(view.status).toBe("Ready");
    expect(view.model).toBe("Waiting for a reading from the extension.");
    expect(view.pauseDisabled).toBe(true);
    expect(view.stopDisabled).toBe(true);
    expect(view.retryHidden).toBe(true);
    expect(view.metrics).toBe("No run yet.");
  });

  it("renders an active local run: label, controls, model line, passage counter and progress", () => {
    const view = renderReader({
      session: active({ progress: { played: 1, scheduled: 2, index: 0, end: 21, unitId: 0 } }),
      controllable: true,
      local: local(),
      rejected: null,
    });
    expect(view.status).toBe("Reading...");
    expect(view.pauseLabel).toBe("Pause");
    expect(view.pauseDisabled).toBe(false);
    expect(view.stopDisabled).toBe(false);
    expect(view.passage).toBe("Passage 2 of 3");
    expect(view.progress).toBeCloseTo((100 * 21) / Array.from(TEXT).length, 5);
    expect(view.detail).toMatch(/^\d+% of text fully played$/);
    expect(view.model).toBe("kokoro · af_bella · 1.5×");
    expect(view.text).toBe(TEXT);
    expect(view.busy).toBe(true);
  });

  it("starts at passage 1 before any unit is fully played", () => {
    const view = renderReader({ session: active(), controllable: true, local: local(), rejected: null });
    expect(view.passage).toBe("Passage 1 of 3");
    expect(view.progress).toBe(0);
    expect(view.detail).toBe("Audio starts with a small opening passage, then generates ahead.");
  });

  it("shows the hosted run's text before the SW snapshot for it arrives", () => {
    const view = renderReader({ session: session(), controllable: true, local: local(), rejected: null });
    expect(view.text).toBe(TEXT);
    expect(view.model).toBe("kokoro · af_bella · 1.5×");
    expect(view.busy).toBe(true);
    expect(view.pauseDisabled).toBe(true);
  });

  it("paused shows Resume", () => {
    const view = renderReader({
      session: active({ state: "paused", label: "Paused" }), controllable: true, local: local(), rejected: null,
    });
    expect(view.status).toBe("Paused");
    expect(view.pauseLabel).toBe("Resume");
  });

  it("disables controls when the port may not control the run", () => {
    const view = renderReader({ session: active(), controllable: false, local: local(), rejected: null });
    expect(view.pauseDisabled).toBe(true);
    expect(view.stopDisabled).toBe(true);
  });

  it("uses textPreview and no counter for a run hosted elsewhere", () => {
    const view = renderReader({
      session: active({ hostKind: "offscreen", runId: "other", textPreview: "Short preview" }),
      controllable: true,
      local: local({ outcome: "superseded" }),
      rejected: null,
    });
    expect(view.text).toBe("Short preview");
    expect(view.passage).toBe("");
    expect(view.progress).toBe(0);
  });

  it("completed run: outcome text, full progress, controls off, no retry", () => {
    const view = renderReader({
      session: session({ runId: "r1", outcome: "completed", metrics: { acceptedAt: 1 } }),
      controllable: true,
      local: local({ outcome: "completed" }),
      rejected: null,
    });
    expect(view.status).toBe("Completed");
    expect(view.progress).toBe(100);
    expect(view.pauseDisabled).toBe(true);
    expect(view.retryHidden).toBe(true);
    expect(view.metrics).toBe(JSON.stringify({ acceptedAt: 1 }, null, 2));
    expect(view.busy).toBe(false);
  });

  it("failed run shows the error and offers Retry from the interrupted passage", () => {
    const view = renderReader({
      session: session({ runId: "r1", outcome: "failed", error: { message: "Stream idle timeout" } }),
      controllable: true,
      local: local({ retryText: "Second one.\n\nThird and last.", outcome: "failed" }),
      rejected: null,
    });
    expect(view.status).toBe("Failed");
    expect(view.error).toBe("Stream idle timeout");
    expect(view.retryHidden).toBe(false);
  });

  it("stopped run offers Retry; superseded and other runs do not", () => {
    const stopped = renderReader({
      session: session({ runId: "r1", outcome: "stopped" }),
      controllable: true,
      local: local({ retryText: "Third and last.", outcome: "stopped" }),
      rejected: null,
    });
    expect(stopped.status).toBe("Stopped");
    expect(stopped.retryHidden).toBe(false);
    const superseded = renderReader({
      session: session({ runId: "r1", outcome: "superseded" }),
      controllable: true,
      local: local({ retryText: "Third and last.", outcome: "superseded" }),
      rejected: null,
    });
    expect(superseded.retryHidden).toBe(true);
    const otherRun = renderReader({
      session: session({ runId: "r2", outcome: "failed" }),
      controllable: true,
      local: local({ retryText: "Third and last.", outcome: "failed" }),
      rejected: null,
    });
    expect(otherRun.retryHidden).toBe(true);
  });

  it("owner_lost shows a readable status", () => {
    const view = renderReader({
      session: session({ runId: "r9", outcome: "owner_lost", error: { message: "Playback host closed" } }),
      controllable: true, local: null, rejected: null,
    });
    expect(view.status).toBe("Playback host closed");
    expect(view.error).toBe("Playback host closed");
  });

  it("history error for the shown run is surfaced", () => {
    const view = renderReader({
      session: session({ runId: "r1", outcome: "completed" }),
      controllable: true,
      local: local(),
      rejected: null,
      historyError: { runId: "r1", message: "quota" },
    });
    expect(view.error).toBe("Audio completed, but history could not be saved: quota");
  });

  it("a failed command reply is surfaced while the run is active", () => {
    const view = renderReader({
      session: active(), controllable: true, local: local(), rejected: null, commandError: "Not allowed",
    });
    expect(view.error).toBe("Not allowed");
  });

  it("rejected Reader is inert and says why", () => {
    const view = renderReader({ session: active(), controllable: true, local: null, rejected: REJECT_TEXT });
    expect(REJECT_TEXT).toBe("Reader already open in another tab");
    expect(view.status).toBe(REJECT_TEXT);
    expect(view.pauseDisabled).toBe(true);
    expect(view.stopDisabled).toBe(true);
    expect(view.retryHidden).toBe(true);
    expect(view.text).toBe("");
    const custom = renderReader({ session: null, controllable: false, local: null, rejected: "Other reason" });
    expect(custom.status).toBe(REJECT_TEXT);
    expect(custom.detail).toBe("Other reason");
  });

  it("describeRunSettings falls back like v3", () => {
    expect(describeRunSettings({})).toBe("kokoro · default voice · 1×");
  });
});

describe("applyView", () => {
  function fakeDocument() {
    const elements = {};
    for (const id of ["status", "model", "detail", "passage", "progress", "pause", "stop", "retry", "error",
      "metrics", "text", "reader"]) {
      elements[id] = { id, textContent: "", value: "", disabled: false, hidden: false, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; } };
    }
    return { elements, getElementById: (id) => elements[id] || null };
  }

  it("writes the view model into the elements", () => {
    const doc = fakeDocument();
    const view = renderReader({
      session: active({ state: "paused", label: "Paused", progress: { played: 1, scheduled: 1, index: 0, end: 21 } }),
      controllable: true,
      local: local(),
      rejected: null,
    });
    applyView(doc, view);
    const { elements } = doc;
    expect(elements.status.textContent).toBe("Paused");
    expect(elements.pause.textContent).toBe("Resume");
    expect(elements.pause.disabled).toBe(false);
    expect(elements.passage.textContent).toBe("Passage 2 of 3");
    expect(elements.progress.value).toBeCloseTo(view.progress, 5);
    expect(elements.retry.hidden).toBe(true);
    expect(elements.text.value).toBe(TEXT);
    expect(elements.reader.attributes["aria-busy"]).toBe("true");
  });

  it("does not rewrite unchanged text (keeps the user's scroll position)", () => {
    const doc = fakeDocument();
    let writes = 0;
    let value = "";
    Object.defineProperty(doc.elements.text, "value", {
      get: () => value,
      set: (next) => {
        writes++;
        value = next;
      },
    });
    const view = renderReader({ session: active(), controllable: true, local: local(), rejected: null });
    applyView(doc, view);
    applyView(doc, view);
    expect(writes).toBe(1);
  });
});
