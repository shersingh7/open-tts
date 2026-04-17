const voiceSelect = document.getElementById("voice");
const languageSelect = document.getElementById("language");
const speedInput = document.getElementById("speed");
const speedValue = document.getElementById("speedValue");
const statusDiv = document.getElementById("status");
const modelInfo = document.getElementById("modelInfo");
const previewText = document.getElementById("previewText");
const previewBtn = document.getElementById("previewBtn");
const startServerBtn = document.getElementById("startServerBtn");
const stopServerBtn = document.getElementById("stopServerBtn");
const serverStatus = document.getElementById("serverStatus");
const modelSelect = document.getElementById("model");

const DEFAULTS = {
  model: "qwen3-tts",
  voice: "ryan",
  speed: 1.0,
  language: "Auto",
  previewText: "Hello! Open TTS is ready. Multiple local models running entirely on your Mac.",
};

let currentPreviewAudio = null;
let currentModelId = null;

function setStatus(connected, text) {
  statusDiv.textContent = text;
  statusDiv.className = `status ${connected ? "connected" : "disconnected"}`;
}

function setServerUI(state, message) {
  if (state === "running") {
    startServerBtn.disabled = true;
    stopServerBtn.disabled = false;
  } else if (state === "stopped") {
    startServerBtn.disabled = false;
    stopServerBtn.disabled = true;
  } else {
    startServerBtn.disabled = true;
    stopServerBtn.disabled = true;
  }
  serverStatus.textContent = message;
  serverStatus.className = `server-status ${state}`;
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}

function runtimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

// Stop any active TTS in all tabs before starting new audio
async function stopAllTabsTTS() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "STOP_TTS" });
      } catch (e) {
        // Tab might not have content script — ignore
      }
    }
  } catch (e) {}
}

async function handleStartServer() {
  setServerUI("starting", "Starting server...");
  try {
    const response = await runtimeMessage({ type: "START_SERVER" });
    if (response?.success) {
      // Wait for server to be ready (with retries)
      let ready = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const health = await runtimeMessage({ type: "GET_HEALTH" }).catch(() => null);
        if (health?.success && health?.data?.model_loaded) {
          ready = true;
          break;
        }
      }
      if (ready) {
        await Promise.all([refreshHealth(), loadModels()]);
        setServerUI("running", "Server running");
      } else {
        setServerUI("running", "Server starting (model loading...)");
        // Keep checking
        pollServerReady();
      }
    } else {
      setServerUI("error", response?.message || "Failed to start");
    }
  } catch (error) {
    setServerUI("error", `Error: ${error.message}`);
  }
}

function pollServerReady() {
  let attempts = 0;
  const maxAttempts = 20;
  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      setServerUI("error", "Server failed to start");
      return;
    }
    try {
      const health = await runtimeMessage({ type: "GET_HEALTH" });
      if (health?.success && health?.data?.model_loaded) {
        clearInterval(interval);
        await Promise.all([refreshHealth(), loadModels()]);
        setServerUI("running", "Server running");
      }
    } catch (e) {}
  }, 1500);
}

async function handleStopServer() {
  setServerUI("starting", "Stopping server...");
  try {
    const response = await runtimeMessage({ type: "STOP_SERVER" });
    if (response?.success) {
      setServerUI("stopped", "Server stopped");
      setStatus(false, "Server stopped");
      modelInfo.textContent = "Start server to use TTS";
      voiceSelect.innerHTML = "<option disabled selected>Start server first</option>";
      modelSelect.innerHTML = "<option disabled selected>Start server first</option>";
    } else {
      setServerUI("error", response?.message || "Failed to stop");
    }
  } catch (error) {
    setServerUI("error", `Error: ${error.message}`);
  }
}

async function checkServerStatus() {
  try {
    const healthResponse = await runtimeMessage({ type: "GET_HEALTH" });
    if (healthResponse?.success) {
      if (healthResponse?.data?.model_loaded) {
        setServerUI("running", "Server running");
        return true;
      } else if (healthResponse?.data?.load_error) {
        setServerUI("error", "Model load failed — try reloading");
        return false;
      }
      // Server up but model not loaded yet
      setServerUI("starting", "Server starting (model loading...)");
      pollServerReady();
      return false;
    }
  } catch (error) {}
  setServerUI("stopped", "Server not running");
  return false;
}

async function loadSettings() {
  const data = await storageGet(["model", "voice", "speed", "language", "previewText"]);

  const speed = Number(data.speed ?? DEFAULTS.speed);
  speedInput.value = speed.toFixed(1);
  speedValue.textContent = `${speed.toFixed(1)}x`;

  languageSelect.value = data.language || DEFAULTS.language;
  previewText.value = data.previewText || DEFAULTS.previewText;
  currentModelId = data.model || DEFAULTS.model;
}

function wireEvents() {
  speedInput.addEventListener("input", async () => {
    const speed = Number(speedInput.value);
    speedValue.textContent = `${speed.toFixed(1)}x`;
    await storageSet({ speed });
  });

  voiceSelect.addEventListener("change", async () => {
    await storageSet({ voice: voiceSelect.value });
  });

  languageSelect.addEventListener("change", async () => {
    await storageSet({ language: languageSelect.value });
  });

  previewText.addEventListener("input", async () => {
    await storageSet({ previewText: previewText.value });
  });

  modelSelect.addEventListener("change", async () => {
    const selectedModel = modelSelect.value;
    currentModelId = selectedModel;
    await storageSet({ model: selectedModel });

    setServerUI("starting", `Switching to ${modelSelect.options[modelSelect.selectedIndex].text}...`);
    try {
      const response = await runtimeMessage({ type: "LOAD_MODEL", modelId: selectedModel });
      if (response?.success) {
        await loadVoices(selectedModel);
        setServerUI("running", "Server running");
        updateLanguageVisibility(selectedModel);
      } else {
        setServerUI("error", response?.error || "Failed to switch model");
      }
    } catch (error) {
      setServerUI("error", `Error switching: ${error.message}`);
    }
  });

  previewBtn.addEventListener("click", handlePreview);
  startServerBtn.addEventListener("click", handleStartServer);
  stopServerBtn.addEventListener("click", handleStopServer);
}

function updateLanguageVisibility(modelId) {
  if (modelId === "fish-s2-pro") {
    languageSelect.disabled = true;
    languageSelect.value = "Auto";
  } else {
    languageSelect.disabled = false;
  }
}

async function loadModels() {
  const response = await runtimeMessage({ type: "GET_MODELS" });
  if (!response?.success) {
    throw new Error(response?.error || "Unable to load models");
  }

  const data = response.data;
  const saved = await storageGet(["model"]);
  const preferred = saved.model || DEFAULTS.model;

  modelSelect.innerHTML = "";
  data.models.forEach((m) => {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.name}${m.active ? " ●" : ""}`;
    if (m.id === preferred) option.selected = true;
    modelSelect.appendChild(option);
  });

  // Load voices for the active (or preferred) model
  const activeModel = data.models.find((m) => m.active) || data.models.find((m) => m.id === preferred);
  if (activeModel) {
    await loadVoices(activeModel.id);
    updateLanguageVisibility(activeModel.id);
    currentModelId = activeModel.id;
  }
}

async function loadVoices(modelId) {
  // Use voices from the models endpoint (already included)
  const modelsResponse = await runtimeMessage({ type: "GET_MODELS" });
  const modelData = modelsResponse?.data?.models?.find((m) => m.id === modelId);

  const saved = await storageGet(["voice"]);
  const preferredVoice = saved.voice || DEFAULTS.voice;

  voiceSelect.innerHTML = "";

  if (modelData?.voices?.length) {
    modelData.voices.forEach((v) => {
      const option = document.createElement("option");
      option.value = v.id;
      option.textContent = v.name;
      if (v.id === preferredVoice) option.selected = true;
      voiceSelect.appendChild(option);
    });
  } else {
    voiceSelect.innerHTML = "<option disabled selected>No voices available</option>";
  }
}

async function refreshHealth() {
  try {
    const response = await runtimeMessage({ type: "GET_HEALTH" });
    if (response?.success && response?.data?.model_loaded) {
      const model = response.data.model || DEFAULTS.model;
      const reg = { "qwen3-tts": "Qwen3-TTS 1.7B", "fish-s2-pro": "Fish Audio S2 Pro" };
      setStatus(true, `Connected — ${reg[model] || model}`);
      modelInfo.textContent = `Model: ${reg[model] || model}`;
    } else if (response?.success) {
      setStatus(false, "Server up, model not loaded");
      modelInfo.textContent = response.data?.load_error || "Model not loaded";
    } else {
      setStatus(false, "Server unreachable");
      modelInfo.textContent = "—";
    }
  } catch (e) {
    setStatus(false, "Server unreachable");
    modelInfo.textContent = "—";
  }
}

async function handlePreview() {
  // Stop any active TTS first
  await stopAllTabsTTS();

  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio.src = "";
    currentPreviewAudio = null;
  }

  const text = previewText.value.trim();
  if (!text) return;

  previewBtn.disabled = true;
  previewBtn.textContent = "Generating…";

  try {
    const settings = await storageGet(["voice", "speed", "language", "model"]);
    const response = await runtimeMessage({
      type: "TTS_REQUEST",
      text,
      voice: settings.voice || DEFAULTS.voice,
      speed: Number(settings.speed) || DEFAULTS.speed,
      language: settings.language || DEFAULTS.language,
      model: settings.model || DEFAULTS.model,
    });

    if (response?.success) {
      const dataUrl = response.audioData;
      currentPreviewAudio = new Audio(dataUrl);
      currentPreviewAudio.playbackRate = Number(settings.speed) || 1.0;
      currentPreviewAudio.preservesPitch = true;
      currentPreviewAudio.onended = () => {
        previewBtn.disabled = false;
        previewBtn.textContent = "▶ Play preview";
      };
      currentPreviewAudio.onerror = () => {
        previewBtn.disabled = false;
        previewBtn.textContent = "▶ Play preview";
      };
      await currentPreviewAudio.play();
    } else {
      previewBtn.disabled = false;
      previewBtn.textContent = "▶ Play preview";
      setStatus(false, response?.error || "TTS failed");
    }
  } catch (error) {
    previewBtn.disabled = false;
    previewBtn.textContent = "▶ Play preview";
    setStatus(false, `Error: ${error.message}`);
  }
}

// Initialization
async function init() {
  await loadSettings();
  wireEvents();
  const isUp = await checkServerStatus();
  if (isUp) {
    await loadModels();
    await refreshHealth();
  }
}

init();