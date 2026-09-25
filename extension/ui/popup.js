// @ts-check
// Open TTS — popup. Rebuilt UI (tabs: Listen / Voice / History / Settings) on the unchanged v4 port contract:
// renders only from SESSION / SERVER_STATE / MODEL_STATE snapshots delivered over `ui:popup`, and never sends
// LOAD_MODEL on open — only when the user explicitly picks a different model. See docs/plans/v4-contract.md.

import { connectUi } from "./ui-port.js";
import { MSG, PORTS } from "../shared/messages.js";
import { DEFAULTS, MAX_CHARS, HIDDEN_SITES_KEY, resolveSpeed, resolveVoice } from "../shared/constants.js";
import { makeRunId } from "../shared/protocol.js";
import {
  syncGet,
  syncSet,
  localGet,
  localSet,
  debouncedSyncSet,
  debouncedLocalSet,
  flushPending,
  setStorageErrorHandler,
  localInstruction,
} from "../shared/storage.js";

export const VIEWS = ["listen", "voice", "history", "settings"];

/** Friendly names used before the engine has reported its model list. */
const MODEL_NAMES = { kokoro: "Kokoro", "qwen3-tts": "Qwen3-TTS", "fish-s2-pro": "Fish S2 Pro" };

/** Short badges shown on the model cards. */
const MODEL_TAGS = {
  kokoro: [["Fastest", "fast"], ["Live", "live"]],
  "qwen3-tts": [["Multilingual", ""], ["Styles", ""]],
  "fish-s2-pro": [["Expressive", ""], ["Slow", ""]],
};

/** Kokoro voice-id prefixes → group labels. */
const VOICE_GROUPS = {
  af: "American · Female",
  am: "American · Male",
  bf: "British · Female",
  bm: "British · Male",
};

/** Words per minute at 1× — used only for the "~N min" listening estimate. */
const WORDS_PER_MINUTE = 160;
/** Approximate engine transport partition size (engine.js TRANSPORT_PARTITION_CHARS). */
const PARTITION_CHARS = 40000;

const SERVER_PILL = {
  ready: "Ready",
  warming: "Warming up…",
  starting: "Starting…",
  unknown: "Checking…",
  offline: "Engine off",
  failed: "Engine error",
};

const NATIVE_HOST_PATTERN = /native messaging host|native host|Specified native/i;

/** @param {string} id */
export function prettyVoiceName(id) {
  if (!id) return "Default";
  const bare = String(id).replace(/^[a-z]{2}_/, "");
  return bare.split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** @param {string} id */
function voiceGender(id) {
  const m = /^[a-z]([fm])_/.exec(String(id || ""));
  if (m) return m[1];
  const female = ["serena", "vivian", "ono_anna", "sohee"];
  const male = ["uncle_fu", "dylan", "eric", "ryan", "aiden"];
  if (female.includes(id)) return "f";
  if (male.includes(id)) return "m";
  return "n";
}

/**
 * @param {number} chars
 * @param {number} speed
 */
export function listenEstimate(chars, speed) {
  if (!chars) return "";
  const words = chars / 5.6;
  const minutes = words / (WORDS_PER_MINUTE * (speed || 1));
  if (minutes < 1) return `~${Math.max(5, Math.round((minutes * 60) / 5) * 5)} sec`;
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  return `~${h} h ${Math.round(minutes - h * 60)} min`;
}

/** @param {number} ts */
function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * @param {{doc?: any, win?: any, chromeApi?: any}} [deps]
 */
export async function init(deps = {}) {
  const doc = deps.doc || globalThis.document;
  const win = deps.win || globalThis.window;
  const chromeApi = deps.chromeApi || globalThis.chrome;

  const $ = (id) => doc.getElementById(id);
  const el = {
    app: $("app"),
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    enginePill: $("enginePill"),
    errorBanner: $("errorBanner"),
    errorText: $("errorText"),
    errorHelp: $("errorHelp"),
    installCmd: $("installCmd"),
    copyInstall: $("copyInstall"),
    copyDiagnostics: $("copyDiagnostics"),
    dismissError: $("dismissError"),
    speakBtn: $("speakBtn"),
    stopPlaybackBtn: $("stopPlaybackBtn"),
    progress: $("progress"),
    nowPlaying: $("nowPlaying"),
    firstAudioMetric: $("firstAudioMetric"),
    playerBarFill: $("playerBarFill"),
    previewText: $("previewText"),
    charCount: $("charCount"),
    grabSelection: $("grabSelection"),
    grabLabel: $("grabLabel"),
    copyBtn: $("copyBtn"),
    clearText: $("clearText"),
    voiceSummary: $("voiceSummary"),
    voiceAvatar: $("voiceAvatar"),
    voiceSummaryName: $("voiceSummaryName"),
    voiceSummaryMeta: $("voiceSummaryMeta"),
    modKey: $("modKey"),
    modelCards: $("modelCards"),
    modelMeta: $("modelMeta"),
    voiceGroup: $("voiceGroup"),
    voice: $("voice"),
    previewVoice: $("previewVoice"),
    fishStyleWrap: $("fishStyleWrap"),
    fishStyle: $("fishStyle"),
    speed: $("speed"),
    speedValue: $("speedValue"),
    speedPresets: $("speedPresets"),
    languageGroup: $("languageGroup"),
    language: $("language"),
    instructWrap: $("instructWrap"),
    instruct: $("instruct"),
    historyEnabled: $("historyEnabled"),
    clearHistory: $("clearHistory"),
    historyList: $("historyList"),
    historyCount: $("historyCount"),
    engineState: $("engineState"),
    engineNote: $("engineNote"),
    startBtn: $("startBtn"),
    stopBtn: $("stopBtn"),
    hideSiteRow: $("hideSiteRow"),
    hideSiteToggle: $("hideSiteToggle"),
    hideSiteHost: $("hideSiteHost"),
    editShortcuts: $("editShortcuts"),
    shortcutList: $("shortcutList"),
    version: $("version"),
  };

  /** @type {{models: any[]}|null} */
  let cachedModels = null;
  /** @type {Record<string, string>} */
  let voicePrefs = {};
  let currentModel = DEFAULTS.model;
  let currentVoice = DEFAULTS.voice;
  let loadingModel = /** @type {string|null} */ (null);
  /** @type {any} latest SESSION.session snapshot */
  let latestSession = { runId: null, state: "idle", label: "Ready" };
  let controllable = true;
  let serverState = "unknown";
  let pageSelection = "";
  /** Text and runId of the last reading started from this popup (for the progress bar). */
  let ownRun = /** @type {{runId: string, chars: number}|null} */ (null);

  // ---------- small helpers ----------

  const clipboard = () => (win?.navigator || globalThis.navigator).clipboard;

  function flash(button) {
    button?.classList.add("copied");
    setTimeout(() => button?.classList.remove("copied"), 1200);
  }

  function showError(message, diagnostics) {
    el.errorText.textContent = message;
    el.errorBanner.hidden = false;
    el.errorBanner.classList?.remove("info");
    el.errorBanner.dataset.diagnostics = diagnostics || message;
    const needsInstall = NATIVE_HOST_PATTERN.test(message || "");
    if (el.errorHelp) el.errorHelp.hidden = !needsInstall;
    if (el.copyInstall) el.copyInstall.hidden = !needsInstall;
    if (needsInstall && el.installCmd) {
      el.installCmd.textContent = `backend/install_native_host.sh --extension-id ${chromeApi.runtime.id || "YOUR_ID"}`;
    }
  }

  function hideError() {
    el.errorBanner.hidden = true;
  }

  function currentSpeed() {
    return resolveSpeed(el.speed.value);
  }

  function fmtSpeed(value) {
    return `${Number(value).toFixed(2).replace(/\.?0+$/, "")}×`;
  }

  function modelInfo(id) {
    return cachedModels?.models?.find((m) => m.id === id) || null;
  }

  function modelName(id) {
    return modelInfo(id)?.name || MODEL_NAMES[id] || id;
  }

  function supportsLanguage(id) {
    const m = modelInfo(id);
    return m ? Boolean(m.supports_lang_code) : id === "qwen3-tts";
  }

  function supportsInstruct(id) {
    const m = modelInfo(id);
    return m ? Boolean(m.supports_instruct) : id === "qwen3-tts" || id === "fish-s2-pro";
  }

  function hasPresetVoices(id) {
    const m = modelInfo(id);
    return m ? m.has_preset_voices !== false && (m.voices?.length ?? 0) > 0 : id !== "fish-s2-pro";
  }

  function voiceDisplayName(id) {
    const v = modelInfo(currentModel)?.voices?.find((x) => x.id === id);
    return v?.name || prettyVoiceName(id);
  }

  // ---------- tabs ----------

  let activeView = "listen";

  /** @param {string} view @param {boolean} [focus] */
  function showView(view, focus = false) {
    if (!VIEWS.includes(view)) return;
    activeView = view;
    for (const name of VIEWS) {
      const tab = $(`tab-${name}`);
      const panel = $(`view-${name}`);
      const selected = name === view;
      tab?.setAttribute("aria-selected", String(selected));
      if (tab) tab.tabIndex = selected ? 0 : -1;
      if (panel) panel.hidden = !selected;
      if (selected && focus) tab?.focus?.();
    }
  }

  function wireTabs() {
    for (const name of VIEWS) {
      const tab = $(`tab-${name}`);
      tab?.addEventListener("click", () => showView(name));
      tab?.addEventListener("keydown", (event) => {
        const idx = VIEWS.indexOf(activeView);
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault?.();
          const step = event.key === "ArrowRight" ? 1 : -1;
          showView(VIEWS[(idx + step + VIEWS.length) % VIEWS.length], true);
        }
      });
    }
  }

  // ---------- composer ----------

  function updateCharCount() {
    const len = el.previewText.value.length;
    const est = listenEstimate(el.previewText.value.trim().length, currentSpeed());
    el.charCount.textContent = est ? `${len.toLocaleString()} · ${est}` : `${len.toLocaleString()} char${len !== 1 ? "s" : ""}`;
    el.charCount.title = `${len.toLocaleString()} characters${est ? `, about ${est.slice(1)} to listen` : ""}`;
    el.charCount.classList?.toggle("over", len > MAX_CHARS);
    renderPlayer();
  }

  function setText(text) {
    el.previewText.value = text;
    updateCharCount();
    debouncedLocalSet("previewText", text);
  }

  async function detectPageSelection() {
    try {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab) return;
      const reply = await chromeApi.tabs.sendMessage(tab.id, { type: MSG.CONTENT_GET_SELECTION });
      pageSelection = typeof reply?.text === "string" ? reply.text : "";
    } catch {
      pageSelection = "";
    }
    renderGrab();
  }

  function renderGrab() {
    if (!el.grabSelection) return;
    el.grabSelection.hidden = !pageSelection;
    if (pageSelection && el.grabLabel) {
      el.grabLabel.textContent = `Use selection (${pageSelection.length.toLocaleString()})`;
    }
  }

  // ---------- voice summary ----------

  function renderVoiceSummary() {
    const isFish = currentModel === "fish-s2-pro";
    const name = isFish ? `${prettyVoiceName(el.fishStyle?.value || "whisper")} style` : voiceDisplayName(currentVoice);
    el.voiceSummaryName.textContent = name;
    el.voiceSummaryMeta.textContent = `${modelName(currentModel)} · ${fmtSpeed(currentSpeed())}`;
    el.voiceAvatar.textContent = name.charAt(0).toUpperCase();
    el.voiceAvatar.className = `avatar ${isFish ? "n" : voiceGender(currentVoice)}`;
  }

  // ---------- history ----------

  async function loadHistory() {
    const data = await localGet(["ttsHistory", "historyEnabled"]);
    const ttsHistory = data.ttsHistory || [];
    el.historyEnabled.checked = data.historyEnabled === true;
    renderHistory(ttsHistory);
  }

  function renderHistory(items) {
    el.historyCount.textContent = String(items.length);
    el.historyCount.hidden = items.length === 0;
    el.clearHistory.hidden = items.length === 0;
    el.historyList.replaceChildren();
    if (!items.length) {
      const empty = doc.createElement("li");
      empty.className = "history-empty";
      empty.textContent = el.historyEnabled.checked
        ? "Nothing yet — finished readings will show up here."
        : "History is off. Turn it on to replay past readings.";
      el.historyList.appendChild(empty);
      return;
    }
    [...items].reverse().forEach((item) => {
      const li = doc.createElement("li");
      li.className = "history-item";

      const replayBtn = doc.createElement("button");
      replayBtn.className = "history-play";
      replayBtn.type = "button";
      replayBtn.title = "Replay";
      replayBtn.setAttribute("aria-label", "Replay");
      replayBtn.dataset.id = item.id;
      replayBtn.appendChild(svgIcon("M8 5.1v13.8a1 1 0 0 0 1.5.86l11-6.9a1 1 0 0 0 0-1.72l-11-6.9A1 1 0 0 0 8 5.1Z"));
      replayBtn.addEventListener("click", () => replayHistory(item.id));

      const main = doc.createElement("div");
      main.className = "history-main";
      const textSpan = doc.createElement("span");
      textSpan.className = "history-text";
      textSpan.title = item.text;
      textSpan.textContent = String(item.text || "").replace(/\s+/g, " ").trim();
      const sub = doc.createElement("span");
      sub.className = "history-sub";
      const timeSpan = doc.createElement("span");
      timeSpan.className = "history-time";
      timeSpan.textContent = relativeTime(item.timestamp);
      sub.append(timeSpan);
      if (item.voice) {
        const voiceSpan = doc.createElement("span");
        voiceSpan.textContent = `· ${prettyVoiceName(item.voice)}`;
        sub.append(voiceSpan);
      }
      if (item.truncated) {
        const truncatedSpan = doc.createElement("span");
        truncatedSpan.className = "history-truncated";
        truncatedSpan.textContent = "(first 2,000 chars)";
        sub.append(truncatedSpan);
      }
      main.append(textSpan, sub);

      const delBtn = doc.createElement("button");
      delBtn.className = "icon-btn small del";
      delBtn.type = "button";
      delBtn.title = "Delete";
      delBtn.setAttribute("aria-label", "Delete from history");
      delBtn.dataset.id = item.id;
      delBtn.appendChild(svgIcon("M18 6 6 18M6 6l12 12", true));
      delBtn.addEventListener("click", () => deleteHistory(item.id));

      li.append(replayBtn, main, delBtn);
      el.historyList.appendChild(li);
    });
  }

  /** @param {string} d @param {boolean} [stroke] */
  function svgIcon(d, stroke = false) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS ? doc.createElementNS(NS, "svg") : doc.createElement("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS ? doc.createElementNS(NS, "path") : doc.createElement("path");
    path.setAttribute("d", d);
    if (!stroke) svg.setAttribute("class", "filled");
    svg.appendChild(path);
    return svg;
  }

  async function deleteHistory(id) {
    const { ttsHistory = [] } = await localGet(["ttsHistory"]);
    const filtered = ttsHistory.filter((item) => item.id !== id);
    await localSet({ ttsHistory: filtered });
    renderHistory(filtered);
  }

  async function replayHistory(id) {
    const { ttsHistory = [] } = await localGet(["ttsHistory"]);
    const item = ttsHistory.find((entry) => entry.id === id);
    if (!item) return;
    el.previewText.value = item.text;
    updateCharCount();
    await localSet({ previewText: item.text });
    showView("listen");
    await speakText(item.text);
  }

  // ---------- models & voices ----------

  function renderModelCards() {
    el.modelCards.replaceChildren();
    const models = cachedModels?.models || [];
    if (!models.length) {
      const p = doc.createElement("p");
      p.className = "empty-note";
      p.textContent = serverState === "offline" || serverState === "failed"
        ? "Start the engine to see models."
        : "Loading models…";
      el.modelCards.appendChild(p);
      return;
    }
    models.forEach((m) => {
      const card = doc.createElement("button");
      card.type = "button";
      card.className = `model-card${loadingModel === m.id ? " loading" : ""}`;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(m.id === currentModel));
      card.tabIndex = m.id === currentModel ? 0 : -1;
      card.dataset.model = m.id;

      const radio = doc.createElement("span");
      radio.className = "model-radio";
      radio.setAttribute("aria-hidden", "true");
      const text = doc.createElement("span");
      text.className = "model-text";
      const name = doc.createElement("span");
      name.className = "model-name";
      name.textContent = m.name;
      const desc = doc.createElement("span");
      desc.className = "model-desc";
      desc.textContent = loadingModel === m.id ? "Loading…" : m.description || "";
      text.append(name, desc);
      const tags = doc.createElement("span");
      tags.className = "model-tags";
      for (const [label, kind] of MODEL_TAGS[m.id] || []) {
        const tag = doc.createElement("span");
        tag.className = `tag${kind ? ` ${kind}` : ""}`;
        tag.textContent = label;
        tags.appendChild(tag);
      }
      card.append(radio, text, tags);
      card.addEventListener("click", () => selectModel(m.id));
      card.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault?.();
        const idx = models.findIndex((x) => x.id === currentModel);
        const next = models[(idx + (event.key === "ArrowDown" ? 1 : -1) + models.length) % models.length];
        void selectModel(next.id).then(() => {
          const target = el.modelCards.querySelector?.(`[data-model="${next.id}"]`);
          target?.focus?.();
        });
      });
      el.modelCards.appendChild(card);
    });
  }

  function loadVoicesFor(modelObj) {
    const prefVoice = resolveVoice(modelObj.id, { voicePrefs });
    el.voice.replaceChildren();
    const voices = modelObj.voices || [];
    if (!voices.length) {
      const opt = doc.createElement("option");
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "No preset voices";
      el.voice.appendChild(opt);
      el.voice.disabled = true;
      return;
    }
    el.voice.disabled = false;
    /** @type {Map<string, any>} */
    const groups = new Map();
    const appendOption = (parent, v) => {
      const opt = doc.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      if (v.id === prefVoice) opt.selected = true;
      parent.appendChild(opt);
    };
    voices.forEach((v) => {
      const prefix = String(v.id).slice(0, 2);
      const label = /^[a-z]{2}_/.test(v.id) ? VOICE_GROUPS[prefix] : null;
      if (!label) {
        appendOption(el.voice, v);
        return;
      }
      if (!groups.has(label)) {
        const group = doc.createElement("optgroup");
        group.label = label;
        groups.set(label, group);
        el.voice.appendChild(group);
      }
      appendOption(groups.get(label), v);
    });
    el.voice.value = voices.some((v) => v.id === prefVoice) ? prefVoice : voices[0].id;
    currentVoice = el.voice.value || prefVoice;
  }

  function updateModelMeta() {
    const m = modelInfo(currentModel);
    if (loadingModel) {
      el.modelMeta.textContent = `Loading ${modelName(loadingModel)}…`;
      return;
    }
    if (!m) {
      el.modelMeta.textContent = "Local MLX model";
      return;
    }
    if (!m.loaded) {
      el.modelMeta.textContent = `${m.name} — loads on first Speak`;
      return;
    }
    el.modelMeta.textContent = m.supports_streaming ? "Loaded · streams as it speaks" : "Loaded · generates then plays";
  }

  function updateModelSpecificUI() {
    const isFish = currentModel === "fish-s2-pro";
    el.fishStyleWrap.hidden = !isFish;
    el.voiceGroup.hidden = !hasPresetVoices(currentModel) && isFish;
    el.instructWrap.hidden = !supportsInstruct(currentModel);
    el.languageGroup.hidden = !supportsLanguage(currentModel);
    if (el.languageGroup.hidden) el.language.value = "Auto";
    renderVoiceSummary();
  }

  async function refreshModels() {
    let data;
    try {
      data = await ui.request({ type: MSG.GET_MODELS });
    } catch {
      return;
    }
    const models = data?.models || [];
    if (!models.length) return;
    cachedModels = data;
    const saved = await syncGet(["model", "voicePrefs"]);
    voicePrefs = saved.voicePrefs || {};
    const preferred = saved.model || DEFAULTS.model;
    const active = models.find((m) => m.id === preferred) || models[0];
    currentModel = active.id;
    loadVoicesFor(active);
    renderModelCards();
    updateModelMeta();
    updateModelSpecificUI();
  }

  /** Explicit user choice → LOAD_MODEL (never on open). */
  async function selectModel(modelId) {
    if (modelId === currentModel && !loadingModel && modelInfo(modelId)?.loaded) return;
    hideError();
    const previous = currentModel;
    currentModel = modelId;
    loadingModel = modelId;
    const m = modelInfo(modelId);
    if (m) loadVoicesFor(m);
    renderModelCards();
    updateModelMeta();
    updateModelSpecificUI();
    try {
      await ui.request({ type: MSG.LOAD_MODEL, modelId });
      const data = await ui.request({ type: MSG.GET_MODELS });
      if (data?.models?.length) cachedModels = data;
      const fresh = modelInfo(modelId);
      if (fresh) loadVoicesFor(fresh);
      const selectedVoice = el.voice.value;
      if (selectedVoice && !el.voice.disabled) voicePrefs[modelId] = selectedVoice;
      await syncSet({ model: modelId, voicePrefs, voice: voicePrefs[modelId] || selectedVoice });
    } catch (err) {
      showError(err.message || "Couldn't switch models");
      if (!modelInfo(modelId)) currentModel = previous;
    } finally {
      if (loadingModel === modelId) loadingModel = null;
      renderModelCards();
      updateModelMeta();
      updateModelSpecificUI();
    }
  }

  // ---------- server ----------

  function renderServerState(message) {
    const { state, message: text } = message;
    serverState = state;
    el.app.dataset.server = state;
    el.statusText.textContent = SERVER_PILL[state] || text || state;
    el.enginePill.title = text || "";
    el.engineState.textContent = text || SERVER_PILL[state] || "";

    const dot = {
      ready: "online",
      warming: "loading",
      starting: "loading",
      unknown: "loading",
      failed: "failed",
    }[state] || "offline";
    el.statusDot.className = `engine-dot ${dot}`;

    if (state === "ready") {
      el.startBtn.disabled = true;
      el.stopBtn.disabled = false;
      el.engineNote.textContent = "Running on this Mac. Stop it to free memory when you're done.";
      if (!cachedModels) refreshModels();
    } else if (state === "starting" || state === "warming" || state === "unknown") {
      el.startBtn.disabled = true;
      el.stopBtn.disabled = true;
      el.engineNote.textContent = "Getting ready — this takes a few seconds.";
      if (state === "warming" && !cachedModels) refreshModels();
    } else {
      el.startBtn.disabled = false;
      el.stopBtn.disabled = true;
      el.engineNote.textContent = "Starts by itself when you press play.";
      cachedModels = null;
      el.voice.disabled = true;
      renderModelCards();
      if (state === "failed" && text) showError(text);
    }
  }

  function renderModelState(message) {
    if (message.state === "failed") {
      loadingModel = null;
      renderModelCards();
      showError(message.message || "Model failed to load");
      return;
    }
    if (message.state === "loading" && message.modelId === currentModel) {
      el.modelMeta.textContent = `Loading ${modelName(message.modelId)}…`;
    }
  }

  async function handleStart() {
    hideError();
    try {
      await ui.request({ type: MSG.START_SERVER });
    } catch (err) {
      showError(err.message || "Start failed");
    }
  }

  async function handleStop() {
    try {
      await ui.request({ type: MSG.STOP_SERVER });
    } catch (err) {
      showError(err.message || "Stop failed");
    }
  }

  // ---------- playback ----------

  function playbackMode(session) {
    const state = session?.state || "idle";
    if (state === "preparing" || state === "buffering") return "loading";
    if (state === "playing") return "playing";
    if (state === "paused") return "paused";
    return "idle";
  }

  function renderPlayer() {
    /** @type {any} */
    const session = latestSession || { state: "idle" };
    const mode = playbackMode(session);
    const active = mode !== "idle";
    el.app.dataset.playback = mode;

    const label = session.state === "idle" && session.outcome === "completed" ? "Finished" : session.label || "Ready";
    el.progress.textContent = active ? (mode === "paused" ? "Paused" : label) : label;

    if (active && session.textPreview) {
      el.nowPlaying.textContent = String(session.textPreview).replace(/\s+/g, " ").trim();
    } else if (!el.previewText.value.trim()) {
      el.nowPlaying.textContent = pageSelection
        ? "Selected text found — use it below ↓"
        : "Type or paste text below, then press play.";
    } else {
      el.nowPlaying.textContent = `${voiceDisplayName(currentVoice)} · ${fmtSpeed(currentSpeed())}`;
    }

    // Play button: idle → read; playing → pause; paused → resume; preparing → wait.
    const canControl = controllable && active;
    let aria = "Read aloud";
    if (mode === "playing") aria = "Pause";
    else if (mode === "paused") aria = "Resume";
    else if (mode === "loading") aria = session.state === "buffering" ? "Pause" : "Preparing…";
    el.speakBtn.setAttribute("aria-label", aria);
    el.speakBtn.title = aria;
    el.speakBtn.disabled = session.state === "preparing" || (active && !canControl);
    el.stopPlaybackBtn.disabled = !canControl;

    // Progress bar for readings started here (the popup knows their length).
    const prog = session.progress;
    let pct = 0;
    if (session.outcome === "completed" && ownRun?.runId === session.runId) pct = 100;
    else if (ownRun && ownRun.runId === session.runId && prog && typeof prog.end === "number") {
      pct = Math.min(100, (100 * ((prog.index || 0) * PARTITION_CHARS + prog.end)) / Math.max(1, ownRun.chars));
    }
    el.playerBarFill?.style?.setProperty?.("width", mode === "loading" ? "" : `${pct}%`);
  }

  function renderFirstAudioMetric(session) {
    const metrics = session?.metrics;
    const start = metrics?.firstAudioClockStartedAt;
    const accepted = metrics?.acceptedAt;
    if (typeof start === "number" && typeof accepted === "number" && start >= accepted) {
      el.firstAudioMetric.textContent = `First audio: ${((start - accepted) / 1000).toFixed(1)}s`;
    } else {
      el.firstAudioMetric.textContent = "";
    }
  }

  function renderSession(message) {
    const session = message.session;
    latestSession = session;
    controllable = message.controllable;
    if (session.state === "idle" && session.outcome === "failed" && session.error) {
      showError(session.error.message);
    }
    if (session.state === "idle" && session.outcome === "completed") {
      loadHistory().catch((err) => showError(err.message));
    }
    renderPlayer();
    renderFirstAudioMetric(session);
  }

  function currentSettings() {
    const voice = resolveVoice(currentModel, {
      voicePrefs,
      voice: el.voice.disabled ? undefined : el.voice.value,
      fishStyle: el.fishStyle?.value,
    });
    return {
      model: currentModel || DEFAULTS.model,
      voice,
      speed: currentSpeed(),
      language: el.language.value || DEFAULTS.language,
      instruct: el.instruct?.value?.trim() || "",
    };
  }

  /** @param {string} text */
  async function speakText(text) {
    hideError();
    if (!text) {
      el.previewText.focus?.();
      return;
    }
    if (text.length > MAX_CHARS) {
      showError(`Text is too long — the limit is ${MAX_CHARS.toLocaleString()} characters`);
      return;
    }
    const runId = makeRunId();
    ownRun = { runId, chars: text.length };
    try {
      await ui.request({ type: MSG.SPEAK, runId, text, settings: currentSettings() });
    } catch (err) {
      showError(err.message || "Playback failed to start");
    }
  }

  function handleSpeak() {
    return speakText(el.previewText.value.trim());
  }

  /** Main button: start, or pause/resume the active reading. */
  async function handlePrimary() {
    const mode = playbackMode(latestSession);
    if (mode === "idle") return handleSpeak();
    return handlePauseResume();
  }

  async function handlePauseResume() {
    const runId = latestSession?.runId;
    if (!runId || latestSession.state === "idle") return;
    const pause = latestSession.state !== "paused";
    try {
      await ui.request({ type: pause ? MSG.PAUSE : MSG.RESUME, runId });
    } catch (err) {
      showError(err.message || "Playback control failed");
    }
  }

  async function handleStopPlayback() {
    const runId = latestSession?.runId;
    if (!runId) return;
    try {
      await ui.request({ type: MSG.STOP, runId });
    } catch (err) {
      showError(err.message || "Could not stop playback");
    }
  }

  async function handlePreviewVoice() {
    const name = currentModel === "fish-s2-pro" ? "Open TTS" : voiceDisplayName(currentVoice);
    await speakText(`Hi, I'm ${name}. This is how I sound at this speed.`);
  }

  async function handleCopy() {
    try {
      await clipboard().writeText(el.previewText.value);
      flash(el.copyBtn);
    } catch {
      showError("Clipboard unavailable");
    }
  }

  // ---------- hide-per-site toggle ----------

  async function setupHideSiteToggle() {
    if (!el.hideSiteRow) return;
    try {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab) return;
      const reply = await chromeApi.tabs.sendMessage(tab.id, { type: MSG.CONTENT_GET_HOST });
      const host = reply?.host;
      if (!host) return;
      el.hideSiteHost.textContent = host;
      const stored = await syncGet([HIDDEN_SITES_KEY]);
      const hiddenSites = stored[HIDDEN_SITES_KEY] || [];
      el.hideSiteToggle.checked = hiddenSites.includes(host);
      el.hideSiteRow.hidden = false;
      el.hideSiteToggle.addEventListener("change", async () => {
        const current = (await syncGet([HIDDEN_SITES_KEY]))[HIDDEN_SITES_KEY] || [];
        const next = el.hideSiteToggle.checked
          ? Array.from(new Set([...current, host]))
          : current.filter((h) => h !== host);
        await syncSet({ [HIDDEN_SITES_KEY]: next });
      });
    } catch {
      // No content script answered (restricted page, chrome://, etc.): leave the toggle hidden.
    }
  }

  async function renderShortcuts() {
    try {
      const commands = await chromeApi.commands?.getAll?.();
      if (!Array.isArray(commands)) return;
      for (const command of commands) {
        const kbd = el.shortcutList?.querySelector?.(`[data-command="${command.name}"]`);
        if (kbd) kbd.textContent = command.shortcut || "Not set";
      }
    } catch {
      // commands API unavailable: keep the defaults in the markup.
    }
  }

  // ---------- settings ----------

  function renderSpeed() {
    const value = currentSpeed();
    el.speedValue.textContent = fmtSpeed(value);
    const min = Number(el.speed.min || 0.5);
    const max = Number(el.speed.max || 3);
    el.speed.style?.setProperty?.("--fill", `${((value - min) / (max - min)) * 100}%`);
    const presets = el.speedPresets?.querySelectorAll?.("[data-speed]") || [];
    for (const btn of presets) btn.classList.toggle("active", Math.abs(Number(btn.dataset.speed) - value) < 0.001);
    renderVoiceSummary();
    updateCharCount();
  }

  async function loadSettings() {
    const data = await syncGet(["model", "voice", "speed", "language", "voicePrefs", "fishStyle"]);
    const instruction = await localInstruction();
    const local = await localGet(["previewText"]);
    voicePrefs = data.voicePrefs || {};
    currentModel = data.model || DEFAULTS.model;
    currentVoice = resolveVoice(currentModel, data);
    el.speed.value = String(resolveSpeed(data.speed));
    el.language.value = data.language || DEFAULTS.language;
    el.previewText.value = local.previewText ?? DEFAULTS.previewText;
    if (el.instruct) el.instruct.value = instruction;
    if (el.fishStyle) el.fishStyle.value = data.fishStyle || "whisper";
    renderSpeed();
    updateModelSpecificUI();
  }

  function wireEvents() {
    setStorageErrorHandler((err) => showError(err.message));
    wireTabs();

    el.speed.addEventListener("input", () => {
      renderSpeed();
      debouncedSyncSet("speed", currentSpeed());
    });
    el.speed.addEventListener("change", () => {
      syncSet({ speed: currentSpeed() });
    });
    const presets = el.speedPresets?.querySelectorAll?.("[data-speed]") || [];
    for (const btn of presets) {
      btn.addEventListener("click", () => {
        el.speed.value = btn.dataset.speed;
        renderSpeed();
        syncSet({ speed: currentSpeed() });
      });
    }
    el.voice.addEventListener("change", async () => {
      currentVoice = el.voice.value;
      voicePrefs[currentModel] = el.voice.value;
      renderVoiceSummary();
      renderPlayer();
      await syncSet({ voicePrefs, voice: el.voice.value });
    });
    el.language.addEventListener("change", () => debouncedSyncSet("language", el.language.value));
    el.previewText.addEventListener("input", () => {
      updateCharCount();
      debouncedLocalSet("previewText", el.previewText.value);
    });
    el.previewText.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault?.();
        handleSpeak();
      }
    });
    el.instruct?.addEventListener("input", () => debouncedLocalSet("instruct", el.instruct.value));
    el.fishStyle?.addEventListener("change", () => {
      debouncedSyncSet("fishStyle", el.fishStyle.value);
      renderVoiceSummary();
    });

    el.speakBtn.addEventListener("click", handlePrimary);
    el.stopPlaybackBtn.addEventListener("click", handleStopPlayback);
    el.copyBtn.addEventListener("click", handleCopy);
    el.clearText?.addEventListener("click", () => {
      setText("");
      el.previewText.focus?.();
    });
    el.grabSelection?.addEventListener("click", () => {
      if (!pageSelection) return;
      setText(pageSelection);
    });
    el.voiceSummary?.addEventListener("click", () => showView("voice", true));
    el.enginePill?.addEventListener("click", () => showView("settings", true));
    el.previewVoice?.addEventListener("click", handlePreviewVoice);
    el.startBtn.addEventListener("click", handleStart);
    el.stopBtn.addEventListener("click", handleStop);

    el.historyEnabled.addEventListener("change", async () => {
      await localSet({ historyEnabled: el.historyEnabled.checked });
      await loadHistory();
    });
    el.clearHistory.addEventListener("click", async () => {
      await localSet({ ttsHistory: [] });
      renderHistory([]);
    });

    el.dismissError?.addEventListener("click", hideError);
    el.copyDiagnostics?.addEventListener("click", async () => {
      const diag = el.errorBanner.dataset.diagnostics || el.errorText.textContent;
      try {
        await clipboard().writeText(diag);
        flash(el.copyDiagnostics);
      } catch {
        // clipboard unavailable
      }
    });
    el.copyInstall?.addEventListener("click", async () => {
      try {
        await clipboard().writeText(el.installCmd.textContent);
        flash(el.copyInstall);
      } catch {
        // clipboard unavailable
      }
    });
    el.editShortcuts?.addEventListener("click", () => {
      chromeApi.tabs?.create?.({ url: "chrome://extensions/shortcuts" });
    });

    // Space toggles pause when focus isn't in a text field.
    doc.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.code !== "Space") return;
      const tag = String(doc.activeElement?.tagName || "").toUpperCase();
      if (["TEXTAREA", "INPUT", "SELECT", "BUTTON"].includes(tag)) return;
      if (playbackMode(latestSession) === "idle") return;
      event.preventDefault?.();
      handlePauseResume();
    });

    win?.addEventListener?.("pagehide", () => {
      flushPending();
    });
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") flushPending();
    });
  }

  // ---------- boot ----------

  const ui = connectUi({
    name: PORTS.UI_POPUP,
    onSnapshot: (message) => {
      if (message.type === MSG.SESSION) renderSession(message);
      else if (message.type === MSG.SERVER_STATE) renderServerState(message);
      else if (message.type === MSG.MODEL_STATE) renderModelState(message);
      else if (message.type === MSG.HISTORY_ERROR) {
        showError(`Audio completed, but history could not be saved: ${message.message}`);
      }
    },
    connect: chromeApi.runtime.connect,
  });

  el.version.textContent = `Open TTS v${chromeApi.runtime.getManifest().version}`;
  const platform = String(win?.navigator?.platform || globalThis.navigator?.platform || "");
  if (el.modKey && !/Mac|iP/.test(platform)) el.modKey.textContent = "Ctrl";
  showView("listen");
  wireEvents();
  await loadSettings();
  await loadHistory();
  await Promise.all([setupHideSiteToggle(), detectPageSelection(), renderShortcuts()]);
  renderPlayer();

  return { ui, showView, selectModel };
}

if (typeof document !== "undefined") {
  init().catch((err) => console.error("Open TTS popup failed to start", err));
}
