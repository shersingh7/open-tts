// @ts-check
// Open TTS v4 — Popup. Port-driven rewrite of the v3 popup: renders only from SESSION / SERVER_STATE /
// MODEL_STATE snapshots delivered over `ui:popup`. Never sends LOAD_MODEL on open — only on an explicit
// model change (finding #5 / plan 1.3). See docs/plans/v4-contract.md "Popup".

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

/**
 * @param {{doc?: any, win?: any, chromeApi?: any}} [deps]
 */
export async function init(deps = {}) {
  const doc = deps.doc || globalThis.document;
  const win = deps.win || globalThis.window;
  const chromeApi = deps.chromeApi || globalThis.chrome;

  const $ = (id) => doc.getElementById(id);
  const modelSelect = $("model");
  const voiceSelect = $("voice");
  const langSelect = $("language");
  const instructField = $("instruct");
  const instructWrap = $("instructWrap");
  const fishStyleWrap = $("fishStyleWrap");
  const fishStyleSelect = $("fishStyle");
  const speedSlider = $("speed");
  const speedVal = $("speedValue");
  const previewText = $("previewText");
  const charCount = $("charCount");
  const speakBtn = $("speakBtn");
  const pauseBtn = $("pauseBtn");
  const stopPlaybackBtn = $("stopPlaybackBtn");
  const copyBtn = $("copyBtn");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const modelMeta = $("modelMeta");
  const progressEl = $("progress");
  const historyToggle = $("historyToggle");
  const historyPanel = $("historyPanel");
  const historyList = $("historyList");
  const historyCountEl = $("historyCount");
  const clearHistoryBtn = $("clearHistory");
  const historyEnabledEl = $("historyEnabled");
  const errorBanner = $("errorBanner");
  const errorText = $("errorText");
  const copyDiagnosticsBtn = $("copyDiagnostics");
  const versionEl = $("version");
  const appEl = $("app");
  const firstAudioMetric = $("firstAudioMetric");
  const hideSiteRow = $("hideSiteRow");
  const hideSiteToggle = $("hideSiteToggle");
  const hideSiteHost = $("hideSiteHost");

  let cachedModels = null;
  let voicePrefs = {};
  let latestSession = { runId: null, state: "idle", label: "Ready" };
  let controllable = true;

  // ---------- small helpers ----------

  function setDot(state) {
    statusDot.className = `dot ${state}`;
    statusDot.setAttribute("aria-label", `Server ${state}`);
  }

  function showError(message, diagnostics) {
    errorText.textContent = message;
    errorBanner.hidden = false;
    errorBanner.dataset.diagnostics = diagnostics || message;
  }

  function hideError() {
    errorBanner.hidden = true;
  }

  function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function updateCharCount() {
    const len = previewText.value.length;
    charCount.textContent = `${len} char${len !== 1 ? "s" : ""}`;
  }

  // ---------- history ----------

  async function loadHistory() {
    const data = await localGet(["ttsHistory", "historyEnabled"]);
    const ttsHistory = data.ttsHistory || [];
    historyEnabledEl.checked = data.historyEnabled === true;
    renderHistory(ttsHistory);
  }

  function renderHistory(items) {
    historyCountEl.textContent = String(items.length);
    historyList.replaceChildren();
    if (!items.length) {
      const empty = doc.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No history yet — stored locally on this device";
      historyList.appendChild(empty);
      return;
    }
    [...items].reverse().forEach((item) => {
      const el = doc.createElement("div");
      el.className = "history-item";
      el.setAttribute("role", "listitem");

      const textSpan = doc.createElement("span");
      textSpan.className = "history-text";
      textSpan.title = item.text;
      textSpan.textContent = truncate(item.text, 30);

      const timeSpan = doc.createElement("span");
      timeSpan.className = "history-time";
      timeSpan.textContent = fmtTime(item.timestamp);

      const replayBtn = doc.createElement("button");
      replayBtn.className = "icon-btn";
      replayBtn.type = "button";
      replayBtn.title = "Replay";
      replayBtn.setAttribute("aria-label", "Replay history item");
      replayBtn.dataset.id = item.id;
      replayBtn.textContent = "▶";
      replayBtn.addEventListener("click", () => replayHistory(item.id));

      const delBtn = doc.createElement("button");
      delBtn.className = "icon-btn del";
      delBtn.type = "button";
      delBtn.title = "Delete";
      delBtn.setAttribute("aria-label", "Delete history item");
      delBtn.dataset.id = item.id;
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => deleteHistory(item.id));

      el.append(textSpan, timeSpan);
      if (item.truncated) {
        const truncatedSpan = doc.createElement("span");
        truncatedSpan.className = "history-truncated";
        truncatedSpan.textContent = "(first 2,000 chars)";
        el.append(truncatedSpan);
      }
      el.append(replayBtn, delBtn);
      historyList.appendChild(el);
    });
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
    previewText.value = item.text;
    updateCharCount();
    await localSet({ previewText: item.text });
    handleSpeak();
  }

  // ---------- models ----------

  function resetModelSelectsToPlaceholder() {
    modelSelect.replaceChildren();
    const opt = doc.createElement("option");
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "Start server first";
    modelSelect.appendChild(opt);
    modelSelect.disabled = true;
    voiceSelect.replaceChildren();
    const vopt = doc.createElement("option");
    vopt.disabled = true;
    vopt.selected = true;
    vopt.textContent = "Select model first";
    voiceSelect.appendChild(vopt);
    voiceSelect.disabled = true;
  }

  function loadVoicesFor(modelObj) {
    const prefVoice = resolveVoice(modelObj.id, { voicePrefs });
    voiceSelect.replaceChildren();
    if (modelObj.voices?.length) {
      modelObj.voices.forEach((v) => {
        const opt = doc.createElement("option");
        opt.value = v.id;
        opt.textContent = v.name;
        if (v.id === prefVoice) opt.selected = true;
        voiceSelect.appendChild(opt);
      });
    } else {
      const opt = doc.createElement("option");
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "No preset voices";
      voiceSelect.appendChild(opt);
    }
  }

  function updateModelMeta(modelId) {
    const m = cachedModels?.models?.find((x) => x.id === modelId);
    if (!m) {
      modelMeta.textContent = "Local MLX model";
      return;
    }
    if (!m.loaded) {
      modelMeta.textContent = `${m.name} — loads on first Speak`;
      return;
    }
    const speedNote = m.supports_native_speed ? "Speed at synthesis" : "Speed via time-stretch";
    const streamNote = m.supports_streaming ? "Streaming" : "Batch fallback";
    modelMeta.textContent = `${m.description || m.name} — ${speedNote}, ${streamNote}`;
  }

  function updateModelSpecificUI(modelId) {
    const isFish = modelId === "fish-s2-pro";
    const isQwen = modelId === "qwen3-tts";
    fishStyleWrap.hidden = !isFish;
    instructWrap.hidden = !(isFish || isQwen);
    langSelect.disabled = isFish || modelId === "kokoro";
    if (langSelect.disabled) langSelect.value = "Auto";
    voiceSelect.parentElement.hidden = isFish;
  }

  async function refreshModels() {
    let data;
    try {
      data = await ui.request({ type: MSG.GET_MODELS });
    } catch {
      return;
    }
    cachedModels = data;
    const models = data?.models || [];
    if (!models.length) return;
    const saved = await syncGet(["model", "voicePrefs"]);
    voicePrefs = saved.voicePrefs || {};
    const preferred = saved.model || DEFAULTS.model;
    modelSelect.replaceChildren();
    models.forEach((m) => {
      const opt = doc.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === preferred) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    modelSelect.disabled = false;
    voiceSelect.disabled = false;
    const active = models.find((m) => m.id === preferred) || models[0];
    if (active) {
      modelSelect.value = active.id;
      loadVoicesFor(active);
      updateModelMeta(active.id);
      updateModelSpecificUI(active.id);
    }
  }

  async function handleModelChange() {
    const modelId = modelSelect.value;
    hideError();
    modelMeta.textContent = `Loading ${modelId}...`;
    try {
      await ui.request({ type: MSG.LOAD_MODEL, modelId });
      const data = await ui.request({ type: MSG.GET_MODELS });
      cachedModels = data;
      const m = data?.models?.find((x) => x.id === modelId);
      if (m) {
        loadVoicesFor(m);
        const selectedVoice = voiceSelect.value;
        if (selectedVoice) voicePrefs[modelId] = selectedVoice;
        await syncSet({ model: modelId, voicePrefs, voice: voicePrefs[modelId] || selectedVoice });
        updateModelMeta(modelId);
        updateModelSpecificUI(modelId);
      }
    } catch (err) {
      showError(err.message || "Couldn't switch models");
      updateModelMeta(modelId);
    }
  }

  // ---------- server ----------

  function renderServerState(message) {
    const { state, message: text } = message;
    statusText.textContent = text || "";
    const chassisState = {
      ready: "ready",
      offline: "unavailable",
      failed: "unavailable",
      starting: "waiting",
      warming: "waiting",
      unknown: "waiting",
    }[state] || "unavailable";
    appEl.dataset.state = chassisState;

    if (state === "ready") {
      setDot("online");
      startBtn.disabled = true;
      stopBtn.disabled = false;
      if (!cachedModels) refreshModels();
    } else if (state === "starting" || state === "warming" || state === "unknown") {
      setDot("loading");
      startBtn.disabled = true;
      stopBtn.disabled = true;
      if (state === "warming" && !cachedModels) refreshModels();
    } else {
      setDot(state === "failed" ? "loading" : "offline");
      startBtn.disabled = false;
      stopBtn.disabled = true;
      cachedModels = null;
      resetModelSelectsToPlaceholder();
      if (state === "failed" && text) showError(text);
    }
  }

  function renderModelState(message) {
    if (message.state === "failed") {
      showError(message.message || "Model failed to load");
      return;
    }
    if (message.modelId === modelSelect.value && message.state === "loading") {
      modelMeta.textContent = message.message || `Loading ${message.modelId}...`;
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

  function renderFirstAudioMetric(session) {
    const metrics = session?.metrics;
    const start = metrics?.firstAudioClockStartedAt;
    const accepted = metrics?.acceptedAt;
    if (typeof start === "number" && typeof accepted === "number" && start >= accepted) {
      firstAudioMetric.textContent = `First audio: ${((start - accepted) / 1000).toFixed(1)}s`;
    } else {
      firstAudioMetric.textContent = "";
    }
  }

  function renderSession(message) {
    const session = message.session;
    latestSession = session;
    controllable = message.controllable;
    progressEl.textContent = session.label || "";
    const canControl = controllable && session.state !== "idle";
    pauseBtn.disabled = !canControl;
    stopPlaybackBtn.disabled = !canControl;
    pauseBtn.textContent = session.state === "paused" ? "Resume" : "Pause";
    speakBtn.disabled = session.state === "preparing";
    if (session.state === "idle" && session.outcome === "failed" && session.error) {
      showError(session.error.message);
    }
    if (session.state === "idle" && session.outcome === "completed") {
      loadHistory().catch((err) => showError(err.message));
    }
    renderFirstAudioMetric(session);
  }

  async function handleSpeak() {
    hideError();
    const text = previewText.value.trim();
    if (!text) return;
    if (text.length > MAX_CHARS) {
      showError(`Text exceeds ${MAX_CHARS} characters`);
      return;
    }
    const runId = makeRunId();
    const modelId = modelSelect.value || DEFAULTS.model;
    const voice = resolveVoice(modelId, {
      voicePrefs,
      voice: voiceSelect.value,
      fishStyle: fishStyleSelect?.value,
    });
    const settings = {
      model: modelId,
      voice,
      speed: resolveSpeed(speedSlider.value),
      language: langSelect.value || DEFAULTS.language,
      instruct: instructField?.value?.trim() || "",
    };
    try {
      await ui.request({ type: MSG.SPEAK, runId, text, settings });
    } catch (err) {
      showError(err.message || "Playback failed to start");
    }
  }

  async function handlePauseResume() {
    const runId = latestSession?.runId;
    if (!runId) return;
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

  async function handleCopy() {
    try {
      await (win?.navigator || globalThis.navigator).clipboard.writeText(previewText.value);
      copyBtn.classList.add("copied");
      setTimeout(() => copyBtn.classList.remove("copied"), 1200);
    } catch {
      showError("Clipboard unavailable");
    }
  }

  // ---------- hide-per-site toggle (plan 4.3) ----------

  async function setupHideSiteToggle() {
    if (!hideSiteRow) return;
    try {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab) return;
      const reply = await chromeApi.tabs.sendMessage(tab.id, { type: MSG.CONTENT_GET_HOST });
      const host = reply?.host;
      if (!host) return;
      hideSiteHost.textContent = host;
      const stored = await syncGet([HIDDEN_SITES_KEY]);
      const hiddenSites = stored[HIDDEN_SITES_KEY] || [];
      hideSiteToggle.checked = hiddenSites.includes(host);
      hideSiteRow.hidden = false;
      hideSiteToggle.addEventListener("change", async () => {
        const current = (await syncGet([HIDDEN_SITES_KEY]))[HIDDEN_SITES_KEY] || [];
        const next = hideSiteToggle.checked
          ? Array.from(new Set([...current, host]))
          : current.filter((h) => h !== host);
        await syncSet({ [HIDDEN_SITES_KEY]: next });
      });
    } catch {
      // No content script answered (restricted page, chrome://, etc): leave the toggle hidden.
    }
  }

  // ---------- settings ----------

  async function loadSettings() {
    const data = await syncGet(["model", "voice", "speed", "language", "voicePrefs", "fishStyle"]);
    const instruction = await localInstruction();
    const local = await localGet(["previewText"]);
    voicePrefs = data.voicePrefs || {};
    speedSlider.value = String(resolveSpeed(data.speed));
    speedVal.textContent = `${speedSlider.value}x`;
    langSelect.value = data.language || DEFAULTS.language;
    previewText.value = local.previewText || DEFAULTS.previewText;
    if (instructField) instructField.value = instruction;
    if (fishStyleSelect) fishStyleSelect.value = data.fishStyle || "whisper";
    updateCharCount();
  }

  function wireEvents() {
    setStorageErrorHandler((err) => showError(err.message));
    speedSlider.addEventListener("input", () => {
      speedVal.textContent = `${speedSlider.value}x`;
      debouncedSyncSet("speed", resolveSpeed(speedSlider.value));
    });
    speedSlider.addEventListener("change", () => {
      syncSet({ speed: resolveSpeed(speedSlider.value) });
    });
    voiceSelect.addEventListener("change", async () => {
      const modelId = modelSelect.value;
      voicePrefs[modelId] = voiceSelect.value;
      await syncSet({ voicePrefs, voice: voiceSelect.value });
    });
    langSelect.addEventListener("change", () => debouncedSyncSet("language", langSelect.value));
    previewText.addEventListener("input", () => {
      updateCharCount();
      debouncedLocalSet("previewText", previewText.value);
    });
    instructField?.addEventListener("input", () => debouncedLocalSet("instruct", instructField.value));
    fishStyleSelect?.addEventListener("change", () => debouncedSyncSet("fishStyle", fishStyleSelect.value));
    modelSelect.addEventListener("change", handleModelChange);
    speakBtn.addEventListener("click", handleSpeak);
    pauseBtn.addEventListener("click", handlePauseResume);
    stopPlaybackBtn.addEventListener("click", handleStopPlayback);
    copyBtn.addEventListener("click", handleCopy);
    startBtn.addEventListener("click", handleStart);
    stopBtn.addEventListener("click", handleStop);
    const toggleHistory = () => {
      const collapsed = historyPanel.classList.toggle("collapsed");
      historyToggle.setAttribute("aria-expanded", String(!collapsed));
    };
    historyToggle.addEventListener("click", toggleHistory);
    historyToggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        toggleHistory();
      }
    });
    historyEnabledEl.addEventListener("change", async () => {
      await localSet({ historyEnabled: historyEnabledEl.checked });
    });
    clearHistoryBtn.addEventListener("click", async () => {
      await localSet({ ttsHistory: [] });
      renderHistory([]);
    });
    copyDiagnosticsBtn?.addEventListener("click", async () => {
      const diag = errorBanner.dataset.diagnostics || errorText.textContent;
      try {
        await (win?.navigator || globalThis.navigator).clipboard.writeText(diag);
      } catch {
        // clipboard unavailable
      }
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

  versionEl.textContent = `v${chromeApi.runtime.getManifest().version}`;
  wireEvents();
  await loadSettings();
  await loadHistory();
  await setupHideSiteToggle();

  return { ui };
}

if (typeof document !== "undefined") {
  init().catch((err) => console.error("Open TTS popup failed to start", err));
}
