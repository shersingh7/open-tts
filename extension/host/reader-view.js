// @ts-check
// Open TTS v4 — Reader rendering. Pure: SESSION snapshot + what this page knows locally → view model → DOM.

export const REJECT_TEXT = "Reader already open in another tab";
export const WAITING_TEXT = "Waiting for a reading from the extension.";
export const DEFAULT_DETAIL = "Audio starts with a small opening passage, then generates ahead.";
const NO_METRICS = "No run yet.";

/** @type {Record<string, string>} */
const OUTCOME_TEXT = {
  completed: "Completed",
  stopped: "Stopped",
  superseded: "Replaced by a new reading",
  failed: "Failed",
  owner_lost: "Playback host closed",
};

/** Outcomes after which "Retry from interrupted passage" is offered (v3: any non-completed Reader run). */
const RETRY_OUTCOMES = ["stopped", "failed"];

/** @type {Record<string, string>} */
const STATE_TEXT = {
  preparing: "Preparing...",
  buffering: "Buffering...",
  playing: "Reading...",
  paused: "Paused",
};

/**
 * @typedef {object} LocalRun what this Reader knows about the run it hosts (from HOST_SPEAK and the engine)
 * @property {string} runId
 * @property {string} text
 * @property {string[]} parts engine transport partitions (see engine.partitionText)
 * @property {{model?: string, voice?: string, speed?: number, language?: string, instruct?: string}} settings
 * @property {string} retryText
 * @property {string|null} outcome
 */

/**
 * @typedef {object} ReaderState
 * @property {any} session latest SESSION.session (null before the first snapshot)
 * @property {boolean} controllable
 * @property {LocalRun|null} local
 * @property {string|null} rejected HOST_REJECT reason, or null
 * @property {{runId: string, message: string}|null} [historyError]
 * @property {string|null} [commandError]
 */

/**
 * @typedef {object} ReaderView
 * @property {string} status
 * @property {string} model
 * @property {string} detail
 * @property {string} passage
 * @property {number} progress 0–100
 * @property {string} pauseLabel
 * @property {boolean} pauseDisabled
 * @property {boolean} stopDisabled
 * @property {boolean} retryHidden
 * @property {string} error
 * @property {string} metrics
 * @property {string} text
 * @property {boolean} busy
 */

/**
 * @param {string} text
 * @returns {number} length in code points (PROGRESS offsets are code points)
 */
function codePoints(text) {
  return Array.from(text).length;
}

/**
 * Passage (paragraph) counter and percentage for a played position.
 * @param {string[]} parts transport partitions
 * @param {number} index partition index from PROGRESS
 * @param {number} end code-point offset in that partition that is fully played
 * @returns {{current: number, total: number, percent: number}}
 */
export function passageInfo(parts, index, end) {
  /** @type {number[]} global code-point offsets where each paragraph's text ends */
  const paragraphEnds = [];
  let offset = 0;
  let playedOffset = 0;
  parts.forEach((part, partIndex) => {
    if (partIndex < index) playedOffset += codePoints(part);
    if (partIndex === index) playedOffset += end;
    let cursor = 0;
    for (const match of part.matchAll(/\n\s*\n/g)) {
      const paragraph = part.slice(cursor, match.index);
      if (paragraph.trim()) paragraphEnds.push(offset + codePoints(part.slice(0, match.index)));
      cursor = (match.index ?? 0) + match[0].length;
    }
    if (part.slice(cursor).trim()) paragraphEnds.push(offset + codePoints(part));
    offset += codePoints(part);
  });
  const total = paragraphEnds.length;
  if (!total || !offset) return { current: 0, total: 0, percent: 0 };
  const done = paragraphEnds.filter((paragraphEnd) => paragraphEnd <= playedOffset).length;
  return {
    current: Math.min(total, done + 1),
    total,
    percent: Math.min(100, (100 * playedOffset) / offset),
  };
}

/**
 * v3 model line: "<model> · <voice> · <speed>×".
 * @param {LocalRun["settings"]} settings
 */
export function describeRunSettings(settings) {
  return `${settings.model || "kokoro"} · ${settings.voice || "default voice"} · ${settings.speed || 1}×`;
}

/**
 * Build the view model.
 * @param {ReaderState} state
 * @returns {ReaderView}
 */
export function renderReader(state) {
  /** @type {ReaderView} */
  const view = {
    status: "Ready",
    model: WAITING_TEXT,
    detail: DEFAULT_DETAIL,
    passage: "",
    progress: 0,
    pauseLabel: "Pause",
    pauseDisabled: true,
    stopDisabled: true,
    retryHidden: true,
    error: "",
    metrics: NO_METRICS,
    text: "",
    busy: false,
  };
  if (state.rejected) {
    view.status = REJECT_TEXT;
    view.model = "Use the Reader tab that is already open.";
    view.detail = state.rejected === REJECT_TEXT ? "" : state.rejected;
    return view;
  }
  const session = state.session;
  // A run this page hosts is shown right away, even before the SW's snapshot for it arrives.
  const hostingNow = Boolean(state.local && state.local.outcome === null);
  const local = state.local && (state.local.runId === session?.runId || hostingNow) ? state.local : null;
  if (local) {
    view.text = local.text;
    view.model = describeRunSettings(local.settings || {});
  }
  if (!session) return view;

  const sameRun = Boolean(local && local.runId === session.runId);
  const isActive = session.state !== "idle";
  view.busy = isActive || hostingNow;
  if (!local) view.text = session.textPreview || "";
  if (session.metrics) view.metrics = JSON.stringify(session.metrics, null, 2);

  if (isActive) {
    view.status = session.label || STATE_TEXT[session.state] || "Reading...";
    view.pauseLabel = session.state === "paused" ? "Resume" : "Pause";
    view.pauseDisabled = !state.controllable;
    view.stopDisabled = !state.controllable;
    view.error = state.commandError || "";
  } else if (session.outcome) {
    view.status = OUTCOME_TEXT[session.outcome] || session.outcome;
    view.error = session.error?.message || "";
    const retryText = sameRun ? local.retryText : "";
    view.retryHidden = !(retryText && RETRY_OUTCOMES.includes(session.outcome));
  } else {
    view.status = session.label || "Ready";
  }

  if (sameRun && local.parts.length) {
    const progress = session.progress || {};
    const hasPosition = typeof progress.end === "number";
    const info = passageInfo(local.parts, hasPosition ? progress.index || 0 : 0, hasPosition ? progress.end : 0);
    view.passage = info.total ? `Passage ${info.current} of ${info.total}` : "";
    view.progress = info.percent;
    if (hasPosition) view.detail = `${Math.round(info.percent)}% of text fully played`;
  }
  if (session.outcome === "completed") view.progress = 100;
  if (typeof session.progress?.bufferedSeconds === "number" && isActive) {
    view.detail = `${session.progress.bufferedSeconds.toFixed(1)} seconds buffered ahead`;
  }
  const historyError = state.historyError;
  if (historyError && historyError.runId === session.runId) {
    view.error = `Audio completed, but history could not be saved: ${historyError.message}`;
  }
  return view;
}

/**
 * Write a view model into the Reader page. Only touches `textContent`, `value`, `disabled`, `hidden` and
 * attributes, so it is CSP-safe and works with any `getElementById`-shaped document.
 * @param {{getElementById: (id: string) => any}} doc
 * @param {ReaderView} view
 */
export function applyView(doc, view) {
  /** @param {string} id */
  const node = (id) => doc.getElementById(id);
  /**
   * @param {string} id
   * @param {string} text
   */
  const setText = (id, text) => {
    const element = node(id);
    if (element && element.textContent !== text) element.textContent = text;
  };
  setText("status", view.status);
  setText("model", view.model);
  setText("detail", view.detail);
  setText("passage", view.passage);
  setText("error", view.error);
  setText("metrics", view.metrics);
  setText("pause", view.pauseLabel);
  const progress = node("progress");
  if (progress) progress.value = view.progress;
  const pause = node("pause");
  if (pause) pause.disabled = view.pauseDisabled;
  const stop = node("stop");
  if (stop) stop.disabled = view.stopDisabled;
  const retry = node("retry");
  if (retry) retry.hidden = view.retryHidden;
  const text = node("text");
  if (text && text.value !== view.text) text.value = view.text;
  const root = node("reader");
  if (root) root.setAttribute("aria-busy", view.busy ? "true" : "false");
}
