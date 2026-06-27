/* ═══════════════════════════════════════════════════
   Open TTS v3.1 — Popup Script
   ═══════════════════════════════════════════════════ */

// ─── DOM ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const modelSelect = $("model"), voiceSelect = $("voice"), langSelect = $("language");
const speedSlider = $("speed"), speedVal = $("speedValue");
const previewText = $("previewText"), charCount = $("charCount");
const speakBtn = $("speakBtn"), copyBtn = $("copyBtn");
const startBtn = $("startBtn"), stopBtn = $("stopBtn");
const statusDot = $("statusDot"), statusText = $("statusText");
const modelMeta = $("modelMeta");
const vizWrap = $("vizWrap"), vizCanvas = $("visualizer"), vizText = $("vizText");
const historyToggle = $("historyToggle"), historyPanel = $("historyPanel");
const historyList = $("historyList"), historyCountEl = $("historyCount");
const clearHistoryBtn = $("clearHistory");
const genCountEl = $("genCount"), latencyEl = $("latency");

const DEFAULTS = { model: "kokoro", voice: "af_bella", speed: 1.5, language: "Auto", previewText: "Hello! Open TTS is ready." };

let previewAudio = null;
let audioCtx = null, analyser = null, vizRAF = null;
let genCount = 0;
let cachedModels = null;

// ─── Storage helpers ─────────────────────────────────
const syncGet = (keys) => new Promise(r => chrome.storage.sync.get(keys, r));
const syncSet = (obj) => new Promise(r => chrome.storage.sync.set(obj, r));
const localGet = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
const localSet = (obj) => new Promise(r => chrome.storage.local.set(obj, r));

function msg(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(resp);
    });
  });
}

// ─── Status ──────────────────────────────────────────

function setDot(state) { statusDot.className = `dot ${state}`; }

function setServerUI(state, message) {
  statusText.textContent = message;
  if (state === "running") {
    setDot("online"); startBtn.disabled = true; stopBtn.disabled = false;
  } else if (state === "stopped") {
    setDot("offline"); startBtn.disabled = false; stopBtn.disabled = true;
  } else if (state === "loading") {
    setDot("loading"); startBtn.disabled = true; stopBtn.disabled = true;
  } else {
    setDot("offline"); startBtn.disabled = false; stopBtn.disabled = true;
  }
}

// ─── Visualizer ──────────────────────────────────────

const vctx = vizCanvas.getContext("2d");

function resizeViz() {
  const r = vizWrap.getBoundingClientRect();
  vizCanvas.width = r.width; vizCanvas.height = r.height;
}
window.addEventListener("resize", resizeViz);
resizeViz();

function drawViz(data) {
  const w = vizCanvas.width, h = vizCanvas.height;
  vctx.clearRect(0, 0, w, h);
  const bars = 32, barW = w / bars, gap = 1;
  for (let i = 0; i < bars; i++) {
    let val;
    if (data && data.length) {
      const idx = Math.floor((i / bars) * data.length);
      val = data[idx] / 255;
    } else {
      val = (Math.sin(Date.now() / 200 + i * 0.3) + 1) * 0.08;
    }
    const barH = Math.max(2, val * h * 0.85);
    const x = i * barW, y = (h - barH) / 2;
    const grad = vctx.createLinearGradient(0, y, 0, y + barH);
    grad.addColorStop(0, "#6c5ce7");
    grad.addColorStop(1, "rgba(108,92,231,0.1)");
    vctx.fillStyle = grad;
    vctx.fillRect(x + gap/2, y, barW - gap, barH);
  }
}

function startViz(mode = "sim") {
  stopViz();
  vizWrap.classList.add("active");
  if (mode === "audio" && previewAudio && audioCtx) {
    try {
      if (!analyser) {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        const src = audioCtx.createMediaElementSource(previewAudio);
        src.connect(analyser); analyser.connect(audioCtx.destination);
      }
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const render = () => { if (!vizRAF) return; analyser.getByteFrequencyData(buf); drawViz(buf); vizRAF = requestAnimationFrame(render); };
      vizRAF = requestAnimationFrame(render);
      return;
    } catch (e) {}
  }
  const renderSim = () => {
    if (!vizRAF) return;
    const sim = new Uint8Array(32);
    const t = Date.now() / 250;
    for (let i = 0; i < 32; i++) sim[i] = Math.abs(Math.sin(t + i * 0.35)) * 50 + Math.random() * 40;
    drawViz(sim); vizRAF = requestAnimationFrame(renderSim);
  };
  vizRAF = requestAnimationFrame(renderSim);
}

function stopViz() {
  if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
  vctx && vctx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
  vizWrap.classList.remove("active");
}

// ─── History ─────────────────────────────────────────

const MAX_HISTORY = 20;

async function loadHistory() {
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  renderHistory(ttsHistory);
}

function renderHistory(items) {
  historyCountEl.textContent = items.length;
  if (!items.length) { historyList.innerHTML = '<div class="history-empty">No history yet</div>'; return; }
  historyList.innerHTML = "";
  [...items].reverse().forEach(item => {
    const el = document.createElement("div");
    el.className = "history-item";
    el.innerHTML = `<span class="history-text" title="${esc(item.text)}">${esc(truncate(item.text, 30))}</span><span class="history-time">${fmtTime(item.timestamp)}</span><button class="icon-btn" data-id="${item.id}" title="Replay">▶</button><button class="icon-btn del" data-id="${item.id}" title="Delete">✕</button>`;
    historyList.appendChild(el);
  });
  historyList.querySelectorAll(".icon-btn:not(.del)").forEach(b => b.addEventListener("click", () => replayHistory(Number(b.dataset.id))));
  historyList.querySelectorAll(".icon-btn.del").forEach(b => b.addEventListener("click", () => deleteHistory(Number(b.dataset.id))));
}

async function addHistory(entry) {
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  ttsHistory.push(entry);
  if (ttsHistory.length > MAX_HISTORY) ttsHistory.shift();
  await localSet({ ttsHistory });
  renderHistory(ttsHistory);
}

async function deleteHistory(id) {
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  const filtered = ttsHistory.filter(i => i.id !== id);
  await localSet({ ttsHistory: filtered });
  renderHistory(filtered);
}

async function replayHistory(id) {
  const { ttsHistory = [] } = await localGet(["ttsHistory"]);
  const item = ttsHistory.find(i => i.id === id);
  if (!item) return;
  previewText.value = item.text; updateCharCount();
  await syncSet({ previewText: item.text });
  handleSpeak();
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function fmtTime(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }

function updateCharCount() {
  const len = previewText.value.length;
  charCount.textContent = `${len} char${len !== 1 ? "s" : ""}`;
}

// ─── Server management ───────────────────────────────

async function checkServer() {
  try {
    const health = await msg({ type: "GET_HEALTH" });
    if (health?.success?.data?.model_warm) {
      setServerUI("running", `Connected — ${health.data.model}`);
      await loadModels();
      return true;
    } else if (health?.success?.data?.model_loaded) {
      setServerUI("loading", "Warming up model...");
      // Poll until warm
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const h = await msg({ type: "GET_HEALTH" });
        if (h?.success?.data?.model_warm) {
          setServerUI("running", `Connected — ${h.data.model}`);
          await loadModels();
          return true;
        }
      }
      setServerUI("stopped", "Server failed to warm up");
      return false;
    }
  } catch (e) {}
  setServerUI("stopped", "Server offline");
  return false;
}

async function handleStart() {
  setServerUI("loading", "Starting server...");
  try {
    const resp = await msg({ type: "START_SERVER" });
    if (resp?.success) {
      setServerUI("loading", `Loading ${resp.model || "model"}...`);
      // Server is ready — load models
      await loadModels();
      setServerUI("running", `Connected — ${resp.model || "kokoro"}`);
    } else {
      setServerUI("stopped", resp?.error || resp?.message || "Start failed");
    }
  } catch (e) {
    setServerUI("stopped", `Error: ${e.message}`);
  }
}

async function handleStop() {
  setServerUI("loading", "Stopping...");
  try {
    const resp = await msg({ type: "STOP_SERVER" });
    if (resp?.success) {
      setServerUI("stopped", "Server offline");
      modelSelect.innerHTML = '<option disabled selected>Start server first</option>';
      voiceSelect.innerHTML = '<option disabled selected>Select model first</option>';
    }
  } catch (e) { setServerUI("stopped", `Error: ${e.message}`); }
}

// ─── Models / Voices ─────────────────────────────────

async function loadModels() {
  try {
    const resp = await msg({ type: "GET_MODELS" });
    if (!resp?.success) return;
    cachedModels = resp;
    const data = resp.data;
    const saved = await syncGet(["model"]);
    const preferred = saved.model || DEFAULTS.model;

    modelSelect.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id; opt.textContent = m.name;
      if (m.id === preferred) opt.selected = true;
      modelSelect.appendChild(opt);
    });

    const active = data.models.find(m => m.active) || data.models.find(m => m.id === preferred);
    if (active) {
      modelSelect.value = active.id;
      await loadVoices(active.id);
      updateModelMeta(active.id);
      updateLangVisibility(active.id);
    }
    modelSelect.disabled = false;
    voiceSelect.disabled = false;
  } catch (e) { console.error("[Open TTS] Load models:", e); }
}

async function loadVoices(modelId) {
  const modelsResp = cachedModels || await msg({ type: "GET_MODELS" });
  if (!cachedModels) cachedModels = modelsResp;
  const modelData = modelsResp?.data?.models?.find(m => m.id === modelId);
  const saved = await syncGet(["voice"]);
  const prefVoice = saved.voice || DEFAULTS.voice;

  voiceSelect.innerHTML = "";
  if (modelData?.voices?.length) {
    modelData.voices.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id; opt.textContent = v.name;
      if (v.id === prefVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
  } else {
    voiceSelect.innerHTML = '<option disabled selected>No voices</option>';
  }
}

function updateModelMeta(modelId) {
  const meta = {
    "kokoro": "Kokoro 82M — Ultra-fast local MLX",
    "qwen3-tts": "Qwen3-TTS 1.7B — Multilingual",
    "fish-s2-pro": "Fish Audio S2 Pro — Voice cloning",
  };
  modelMeta.textContent = meta[modelId] || "Local model";
}

function updateLangVisibility(modelId) {
  langSelect.disabled = (modelId === "fish-s2-pro" || modelId === "kokoro");
  if (langSelect.disabled) langSelect.value = "Auto";
}

async function handleModelChange() {
  const modelId = modelSelect.value;
  setServerUI("loading", `Switching to ${modelSelect.options[modelSelect.selectedIndex].text}...`);
  try {
    const resp = await msg({ type: "LOAD_MODEL", modelId });
    if (resp?.success) {
      await loadVoices(modelId);
      updateModelMeta(modelId);
      updateLangVisibility(modelId);
      setServerUI("running", "Connected");
    } else { setServerUI("error", resp?.error || "Switch failed"); }
  } catch (e) { setServerUI("error", `Error: ${e.message}`); }
}

// ─── Speak (popup preview) ───────────────────────────

async function stopAllTabs() {
  try { await msg({ type: "STOP_TTS" }); } catch (e) {}
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try { await chrome.tabs.sendMessage(tab.id, { type: "STOP_TTS" }); } catch (e) {}
    }
  } catch (e) {}
}

async function handleSpeak() {
  await stopAllTabs();
  if (previewAudio) { previewAudio.pause(); previewAudio.src = ""; previewAudio = null; }

  const text = previewText.value.trim();
  if (!text) return;

  speakBtn.disabled = true;
  vizText.textContent = "GENERATING";
  startViz("sim");

  const t0 = performance.now();

  try {
    const settings = await syncGet(["voice", "speed", "language", "model"]);
    const resp = await msg({
      type: "TTS_REQUEST",
      text,
      voice: settings.voice || DEFAULTS.voice,
      speed: Number(settings.speed) || DEFAULTS.speed,
      language: settings.language || DEFAULTS.language,
      model: settings.model || DEFAULTS.model,
    });

    latencyEl.textContent = `LAT: ${Math.round(performance.now() - t0)}ms`;

    if (resp?.success?.audioData) {
      let playbackRate = 1.0;
      const modelId = settings.model || DEFAULTS.model;
      const modelInfo = cachedModels?.data?.models?.find(m => m.id === modelId);
      if (modelInfo && !modelInfo.supports_native_speed) {
        playbackRate = Number(settings.speed) || 1.5;
      }

      previewAudio = new Audio(resp.audioData);
      previewAudio.playbackRate = playbackRate;

      genCount++;
      genCountEl.textContent = `GEN: ${String(genCount).padStart(3, "0")}`;

      await addHistory({
        id: Date.now(), text,
        voice: settings.voice || DEFAULTS.voice,
        model: settings.model || DEFAULTS.model,
        speed: Number(settings.speed) || DEFAULTS.speed,
        timestamp: Date.now(),
      });

      previewAudio.onplay = () => { vizText.textContent = "PLAYING"; startViz("audio"); };
      previewAudio.onended = () => { speakBtn.disabled = false; stopViz(); vizText.textContent = "Ready"; };
      previewAudio.onerror = () => { speakBtn.disabled = false; stopViz(); vizText.textContent = "Error"; };

      // Set up audio context for visualizer
      if (!audioCtx) {
        try { audioCtx = new AudioContext(); } catch (e) {}
      }

      await previewAudio.play();
    } else {
      speakBtn.disabled = false; stopViz(); vizText.textContent = "Failed";
      statusText.textContent = resp?.error || "TTS failed";
    }
  } catch (e) {
    speakBtn.disabled = false; stopViz(); vizText.textContent = "Error";
    statusText.textContent = `Error: ${e.message}`;
  }
}

async function handleCopy() {
  try {
    await navigator.clipboard.writeText(previewText.value);
    copyBtn.classList.add("copied");
    setTimeout(() => copyBtn.classList.remove("copied"), 1200);
  } catch (e) {}
}

async function loadSettings() {
  const data = await syncGet(["model", "voice", "speed", "language", "previewText"]);
  speedSlider.value = Number(data.speed ?? DEFAULTS.speed);
  speedVal.textContent = `${speedSlider.value}x`;
  langSelect.value = data.language || DEFAULTS.language;
  previewText.value = data.previewText || DEFAULTS.previewText;
  updateCharCount();
}

function wireEvents() {
  speedSlider.addEventListener("input", async () => {
    speedVal.textContent = `${speedSlider.value}x`;
    await syncSet({ speed: Number(speedSlider.value) });
  });
  voiceSelect.addEventListener("change", () => syncSet({ voice: voiceSelect.value }));
  langSelect.addEventListener("change", () => syncSet({ language: langSelect.value }));
  previewText.addEventListener("input", async () => { updateCharCount(); await syncSet({ previewText: previewText.value }); });
  modelSelect.addEventListener("change", handleModelChange);
  speakBtn.addEventListener("click", handleSpeak);
  copyBtn.addEventListener("click", handleCopy);
  startBtn.addEventListener("click", handleStart);
  stopBtn.addEventListener("click", handleStop);
  historyToggle.addEventListener("click", () => historyPanel.classList.toggle("collapsed"));
  clearHistoryBtn.addEventListener("click", async () => { await localSet({ ttsHistory: [] }); renderHistory([]); });
}

async function init() {
  await loadSettings();
  loadHistory();
  wireEvents();
  await checkServer();
}

init();