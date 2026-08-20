/* Open TTS v3.4 — Popup */

const $ = (id) => document.getElementById(id);
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
const stopBtnPlayback = $("stopPlaybackBtn");
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
const genCountEl = $("genCount");
const latencyEl = $("latency");
const errorBanner = $("errorBanner");
const errorText = $("errorText");
const copyDiagnosticsBtn = $("copyDiagnostics");
const versionEl = $("version");

const { DEFAULTS, MAX_HISTORY } = OpenTTSConstants;
const { unwrap, makeClientId, makeRunId } = OpenTTSProtocol;
const { syncGet, syncSet, localGet, localSet, debouncedSyncSet, debouncedLocalSet } = OpenTTSStorage;

let clientId = makeClientId();
let activeRun = null;
let playbackState = "idle";
let genCount = 0;
let cachedModels = null;
let voicePrefs = {};
let historyEnabled = true;
let pendingHistory = null;

function msg(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

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

function setServerUI(state, message) {
  statusText.textContent = message;
  const chassis = document.getElementById("app");
  if (chassis) {
    chassis.dataset.state = ({ running: "ready", stopped: "unavailable", loading: "waiting" }[state] || "unavailable");
  }
  if (state === "running") {
    setDot("online");
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else if (state === "stopped") {
    setDot("offline");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  } else if (state === "loading") {
    setDot("loading");
    startBtn.disabled = true;
    stopBtn.disabled = true;
  } else {
    setDot("offline");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function setPlaybackUI(state, label) {
  playbackState = state;
  progressEl.textContent = label || "";
  speakBtn.disabled = state === "generating";
  pauseBtn.disabled = !["playing", "paused", "generating"].includes(state);
  stopBtnPlayback.disabled = state === "idle";
  pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
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

async function loadHistory() {
  const data = await localGet(["ttsHistory", "historyEnabled"]);
  const ttsHistory = data.ttsHistory || [];
  historyEnabled = data.historyEnabled !== false;
  historyEnabledEl.checked = historyEnabled;
  renderHistory(ttsHistory);
}

function renderHistory(items) {
  historyCountEl.textContent = String(items.length);
  historyList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No history yet — stored locally on this device";
    historyList.appendChild(empty);
    return;
  }
  [...items].reverse().forEach((item) => {
    const el = document.createElement("div");
    el.className = "history-item";
    el.setAttribute("role", "listitem");

    const textSpan = document.createElement("span");
    textSpan.className = "history-text";
    textSpan.title = item.text;
    textSpan.textContent = truncate(item.text, 30);

    const timeSpan = document.createElement("span");
    timeSpan.className = "history-time";
    timeSpan.textContent = fmtTime(item.timestamp);

    const replayBtn = document.createElement("button");
    replayBtn.className = "icon-btn";
    replayBtn.type = "button";
    replayBtn.title = "Replay";
    replayBtn.setAttribute("aria-label", "Replay history item");
    replayBtn.dataset.id = item.id;
    replayBtn.textContent = "▶";

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn del";
    delBtn.type = "button";
    delBtn.title = "Delete";
    delBtn.setAttribute("aria-label", "Delete history item");
    delBtn.dataset.id = item.id;
    delBtn.textContent = "✕";

    el.append(textSpan, timeSpan, replayBtn, delBtn);
    historyList.appendChild(el);
  });

  historyList.querySelectorAll(".icon-btn:not(.del)").forEach((b) => {
    b.addEventListener("click", () => replayHistory(b.dataset.id));
  });
  historyList.querySelectorAll(".icon-btn.del").forEach((b) => {
    b.addEventListener("click", () => deleteHistory(b.dataset.id));
  });
}

async function addHistory(entry) {
  if (!historyEnabled) return;
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  ttsHistory.push(entry);
  while (ttsHistory.length > MAX_HISTORY) ttsHistory.shift();
  await localSet({ ttsHistory });
  renderHistory(ttsHistory);
}

async function deleteHistory(id) {
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  const filtered = ttsHistory.filter((i) => i.id !== id);
  await localSet({ ttsHistory: filtered });
  renderHistory(filtered);
}

async function replayHistory(id) {
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  const item = ttsHistory.find((i) => i.id === id);
  if (!item) return;
  previewText.value = item.text;
  updateCharCount();
  await localSet({ previewText: item.text });
  handleSpeak();
}

async function checkServer() {
  try {
    const health = unwrap(await msg({ type: "GET_HEALTH" }));
    if (!health.ok) {
      setServerUI("stopped", "Server offline");
      return false;
    }
    const data = health.data;
    if (data.model_warm) {
      setServerUI("running", `Connected — ${data.model}`);
      await loadModels();
      return true;
    }
    if (data.status === "ok" && !data.model_loaded) {
      setServerUI("running", "Connected — pick a model");
      await loadModels();
      return true;
    }
    if (data.model_loaded) {
      setServerUI("loading", "Warming up model...");
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const h = unwrap(await msg({ type: "GET_HEALTH" }));
        if (h.ok && h.data.model_warm) {
          setServerUI("running", `Connected — ${h.data.model}`);
          await loadModels();
          return true;
        }
      }
      setServerUI("stopped", "Server failed to warm up");
      return false;
    }
  } catch (e) {
    showError(`Health check failed: ${e.message}`);
  }
  setServerUI("stopped", "Server offline");
  return false;
}

async function handleStart() {
  hideError();
  setServerUI("loading", "Starting server...");
  try {
    const resp = unwrap(await msg({ type: "START_SERVER" }));
    if (resp.ok) {
      await loadModels();
      const d = resp.data;
      setServerUI("running", d.lazy ? "Connected — pick a model" : `Connected — ${d.model || "ready"}`);
    } else {
      setServerUI("stopped", resp.error || "Start failed");
      showError(resp.error || "Start failed", resp.raw);
    }
  } catch (e) {
    setServerUI("stopped", `Error: ${e.message}`);
    showError(e.message);
  }
}

async function handleStop() {
  setServerUI("loading", "Stopping...");
  try {
    const resp = unwrap(await msg({ type: "STOP_SERVER" }));
    if (resp.ok) {
      setServerUI("stopped", "Server offline");
      modelSelect.replaceChildren();
      const opt = document.createElement("option");
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "Start server first";
      modelSelect.appendChild(opt);
      voiceSelect.replaceChildren();
      const vopt = document.createElement("option");
      vopt.disabled = true;
      vopt.selected = true;
      vopt.textContent = "Select model first";
      voiceSelect.appendChild(vopt);
    }
  } catch (e) {
    setServerUI("stopped", `Error: ${e.message}`);
  }
}

function getPreferredVoice(modelId) {
  return OpenTTSConstants.resolveVoice(modelId, { voicePrefs });
}

async function loadModels() {
  try {
    const resp = unwrap(await msg({ type: "GET_MODELS" }));
    if (!resp.ok) return;
    cachedModels = resp;
    const data = resp.data;
    const saved = await syncGet(["model", "voicePrefs"]);
    voicePrefs = saved.voicePrefs || {};
    const preferred = saved.model || DEFAULTS.model;

    modelSelect.replaceChildren();
    data.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === preferred) opt.selected = true;
      modelSelect.appendChild(opt);
    });

    let active = data.models.find((m) => m.active) || data.models.find((m) => m.id === preferred);
    if (active) {
      modelSelect.value = active.id;
      if (!active.loaded && active.id === preferred) {
        setServerUI("loading", `Loading ${active.name}...`);
        const loadResult = unwrap(await msg({ type: "LOAD_MODEL", modelId: active.id }));
        if (!loadResult.ok) throw new Error(loadResult.error || "Model load failed");
        const refreshed = unwrap(await msg({ type: "GET_MODELS" }));
        if (refreshed.ok) {
          cachedModels = refreshed;
          active = refreshed.data.models.find((m) => m.id === active.id) || active;
        }
      }
      await loadVoices(active.id);
      updateModelMeta(active.id);
      updateModelSpecificUI(active.id);
    }
    modelSelect.disabled = false;
    voiceSelect.disabled = false;
  } catch (e) {
    console.error("[Open TTS] Load models:", e);
  }
}

async function loadVoices(modelId) {
  const modelsResp = cachedModels || unwrap(await msg({ type: "GET_MODELS" }));
  if (!cachedModels && modelsResp.ok) cachedModels = modelsResp;
  const modelData = modelsResp?.data?.models?.find((m) => m.id === modelId);
  const prefVoice = getPreferredVoice(modelId);

  voiceSelect.replaceChildren();
  if (modelData?.voices?.length) {
    modelData.voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      if (v.id === prefVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
    if (![...voiceSelect.options].some((o) => o.selected)) {
      voiceSelect.selectedIndex = 0;
    }
  } else {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "No preset voices";
    voiceSelect.appendChild(opt);
  }
}

function updateModelMeta(modelId) {
  const m = cachedModels?.data?.models?.find((x) => x.id === modelId);
  if (!m) {
    modelMeta.textContent = "Local MLX model";
    return;
  }
  const speedNote = m.supports_native_speed ? "Speed at synthesis" : "Speed via time-stretch";
  const streamNote = m.supports_streaming ? "Streaming" : "Batch fallback";
  modelMeta.textContent = `${m.description || m.name} — ${speedNote}, ${streamNote}`;
}

function updateModelSpecificUI(modelId) {
  const m = cachedModels?.data?.models?.find((x) => x.id === modelId);
  const isFish = modelId === "fish-s2-pro";
  const isQwen = modelId === "qwen3-tts";
  fishStyleWrap.hidden = !isFish;
  instructWrap.hidden = !(isFish || isQwen);
  langSelect.disabled = isFish || modelId === "kokoro";
  if (langSelect.disabled) langSelect.value = "Auto";
  voiceSelect.parentElement.hidden = isFish;
}

async function handleModelChange() {
  const modelId = modelSelect.value;
  hideError();
  setServerUI("loading", `Switching to ${modelSelect.options[modelSelect.selectedIndex].text}...`);
  try {
    const resp = unwrap(await msg({ type: "LOAD_MODEL", modelId }));
    if (resp.ok) {
      const refreshed = unwrap(await msg({ type: "GET_MODELS" }));
      if (refreshed.ok) cachedModels = refreshed;
      await loadVoices(modelId);
      const selectedVoice = voiceSelect.value;
      if (selectedVoice && !voiceSelect.options[voiceSelect.selectedIndex]?.disabled) {
        voicePrefs[modelId] = selectedVoice;
      }
      await syncSet({ model: modelId, voicePrefs, voice: voicePrefs[modelId] || selectedVoice });
      updateModelMeta(modelId);
      updateModelSpecificUI(modelId);
      setServerUI("running", `Connected — ${modelId}`);
    } else {
      setServerUI("running", "Connected");
      showError(resp.error || "Couldn't switch models");
    }
  } catch (e) {
    setServerUI("running", "Connected");
    showError(e.message);
  }
}

async function handleSpeak() {
  hideError();
  if (activeRun?.runId) {
    pendingHistory = null;
    await msg({ type: "STOP_TTS", runId: activeRun.runId, clientId }).catch(() => {});
  }

  const text = previewText.value.trim();
  if (!text) return;

  const runId = makeRunId();
  activeRun = { clientId, runId, source: "popup" };
  setPlaybackUI("generating", "Generating...");
  const t0 = performance.now();

  try {
    const settings = await syncGet(["voice", "speed", "language", "model", "voicePrefs", "instruct", "fishStyle"]);
    voicePrefs = settings.voicePrefs || {};
    const modelId = settings.model || modelSelect.value || DEFAULTS.model;
    const voice = OpenTTSConstants.resolveVoice(modelId, {
      voicePrefs,
      voice: voiceSelect.value || settings.voice,
      fishStyle: settings.fishStyle || fishStyleSelect.value,
    });

    const speakResult = unwrap(await msg({
      type: "SPEAK",
      text,
      settings: {
        voice,
        speed: Number(settings.speed) || DEFAULTS.speed,
        language: settings.language || DEFAULTS.language,
        model: modelId,
        instruct: instructField?.value?.trim() || settings.instruct || "",
      },
      clientId,
      runId,
      source: "popup",
    }));
    if (!speakResult.ok) throw new Error(speakResult.error || "Playback failed to start");

    latencyEl.textContent = `LAT: ${Math.round(performance.now() - t0)}ms`;
    genCount++;
    genCountEl.textContent = `GEN: ${String(genCount).padStart(3, "0")}`;

    pendingHistory = {
      runId,
      id: crypto.randomUUID(),
      text,
      voice,
      model: modelId,
      speed: Number(settings.speed) || DEFAULTS.speed,
      timestamp: Date.now(),
    };
  } catch (e) {
    pendingHistory = null;
    activeRun = null;
    setPlaybackUI("idle", "Failed");
    showError(e.message);
  }
}

async function handlePauseResume() {
  if (!activeRun?.runId) return;
  if (playbackState === "paused") {
    const r = unwrap(await msg({ type: "RESUME", clientId, runId: activeRun.runId }));
    if (!r.ok) {
      showError(r.error || "Could not resume");
      return;
    }
    setPlaybackUI("playing", "Reading...");
  } else if (playbackState === "playing" || playbackState === "generating") {
    const r = unwrap(await msg({ type: "PAUSE", clientId, runId: activeRun.runId }));
    if (!r.ok) {
      showError(r.error || "Could not pause");
      return;
    }
    setPlaybackUI("paused", "Paused");
  }
}

async function handleStopPlayback() {
  if (!activeRun?.runId) return;
  pendingHistory = null;
  await msg({ type: "STOP", clientId, runId: activeRun.runId });
  activeRun = null;
  setPlaybackUI("idle", "Ready");
}

async function handleCopy() {
  try {
    await navigator.clipboard.writeText(previewText.value);
    copyBtn.classList.add("copied");
    setTimeout(() => copyBtn.classList.remove("copied"), 1200);
  } catch (e) {
    showError("Clipboard unavailable");
  }
}

async function loadSettings() {
  const data = await syncGet(["model", "voice", "speed", "language", "voicePrefs", "instruct", "fishStyle"]);
  const local = await localGet(["previewText"]);
  voicePrefs = data.voicePrefs || {};
  speedSlider.value = Number(data.speed ?? DEFAULTS.speed);
  speedVal.textContent = `${speedSlider.value}x`;
  langSelect.value = data.language || DEFAULTS.language;
  previewText.value = local.previewText || DEFAULTS.previewText;
  if (instructField) instructField.value = data.instruct || "";
  if (fishStyleSelect) fishStyleSelect.value = data.fishStyle || "whisper";
  updateCharCount();
}

function wireEvents() {
  speedSlider.addEventListener("input", () => {
    speedVal.textContent = `${speedSlider.value}x`;
    debouncedSyncSet("speed", Number(speedSlider.value));
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
  if (instructField) {
    instructField.addEventListener("input", () => debouncedSyncSet("instruct", instructField.value));
  }
  if (fishStyleSelect) {
    fishStyleSelect.addEventListener("change", () => debouncedSyncSet("fishStyle", fishStyleSelect.value));
  }
  modelSelect.addEventListener("change", handleModelChange);
  speakBtn.addEventListener("click", handleSpeak);
  pauseBtn.addEventListener("click", handlePauseResume);
  stopBtnPlayback.addEventListener("click", handleStopPlayback);
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
      event.preventDefault();
      toggleHistory();
    }
  });
  historyEnabledEl.addEventListener("change", async () => {
    historyEnabled = historyEnabledEl.checked;
    await localSet({ historyEnabled });
  });
  clearHistoryBtn.addEventListener("click", async () => {
    await localSet({ ttsHistory: [] });
    renderHistory([]);
  });
  copyDiagnosticsBtn.addEventListener("click", async () => {
    const diag = errorBanner.dataset.diagnostics || errorText.textContent;
    try { await navigator.clipboard.writeText(diag); } catch (_) {}
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg._routedByBackground) return;
    if (msg.clientId && msg.clientId !== clientId) return;
    if (activeRun?.runId && msg.runId && msg.runId !== activeRun.runId) return;
    if (msg.type === "TTS_STATUS") {
      const label = msg.label || "Generating...";
      if (playbackState === "paused" && label !== "Paused") return;
      const state = label === "Paused" ? "paused" : (/Reading|Playing/.test(label) ? "playing" : "generating");
      setPlaybackUI(state, label);
    }
    if (msg.type === "TTS_PROGRESS") {
      if (playbackState !== "paused") setPlaybackUI("playing", "Reading...");
    }
    if (msg.type === "TTS_DONE") {
      const completedHistory = pendingHistory;
      pendingHistory = null;
      if (completedHistory?.runId === msg.runId) {
        const { runId: _runId, ...entry } = completedHistory;
        addHistory(entry).catch(() => {});
      }
      activeRun = null;
      setPlaybackUI("idle", "Ready");
    }
    if (msg.type === "TTS_ERROR") {
      pendingHistory = null;
      activeRun = null;
      showError(msg.message || "Playback error");
      setPlaybackUI("idle", "Error");
    }
  });
}

async function init() {
  const manifest = chrome.runtime.getManifest();
  if (versionEl) versionEl.textContent = `v${manifest.version}`;
  await loadSettings();
  await loadHistory();
  wireEvents();
  setPlaybackUI("idle", "Ready");
  await checkServer();
}

init();