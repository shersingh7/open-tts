# Open TTS

> Apple Silicon Only — This project uses MLX, which requires an M1/M2/M3/M4 Mac. Not compatible with Intel Macs, Windows, or Linux.

Multi-model, fully local text-to-speech on Apple Silicon. Switch between **Kokoro**, Qwen3-TTS, and Fish Audio S2 Pro — all running MLX-optimized inference with zero cloud calls.

## Features

- **Multi-Model** — Switch between Kokoro, Qwen3-TTS, and Fish Audio S2 Pro on the fly
- **Fast** — Kokoro delivers RTF ~0.05x on M2 Pro (~10x faster than Qwen3); all models are MLX-optimized for Apple Silicon
- **Ultra-Lightweight** — Kokoro is only 82M parameters (~170 MB), loads instantly, no download wait
- **Private** — All processing happens locally, no cloud API
- **Model Swap** — One model in VRAM at a time; swap on demand from the extension
- **Auto-Recovery** — Model reload on failure, request retry on transient errors, server cache invalidation
- **Multiple Voices** — 19 voices for Kokoro (Bella, Sarah, Eric, etc.), 9 for Qwen3, SSML tags for Fish
- **Speed at Synthesis** — Kokoro applies speed during generation (natural-sounding 0.5x–3.0x); Qwen3 applies it client-side via playbackRate
- **Multilingual** — English, Chinese, Japanese, Korean, and auto-detect (Qwen3); Kokoro supports multiple languages via single-letter lang codes
- **Chrome Extension** — Select text on any page and click to hear it
- **Server Control** — Start/Stop server directly from the extension popup
- **Gapless Playback** — Web Audio API scheduling with playbackRate support (0.5x–3.0x)

## Models

| Model | Size | Sample Rate | Voices | Speed Applied | Strengths |
|-------|------|-------------|--------|---------------|-----------|
| **Kokoro (bf16)** | 170 MB | 24 kHz | 19 preset | At synthesis (natural) | Ultra-fast, lightweight, high quality |
| Qwen3-TTS (8-bit) | 2.9 GB | 24 kHz | 9 preset + instruct | Client-side (playbackRate) | Multilingual, streaming support |
| Fish S2 Pro (8-bit) | 6.3 GB | 44.1 kHz | SSML voice tags | Not supported | High-fidelity, voice cloning ready |

Only one model is loaded at a time. Swap instantly from the extension or API.

### Known Limitations

- **Fish S2 Pro doesn't support streaming** — If streaming is requested, the server auto-falls back to non-streaming and returns a `X-TTS-Fallback: non-streaming` header. The extension handles this transparently.
- **Fish S2 Pro is slow** — 3+ min generation on M2 Pro. No preset voices; requires `ref_audio` for voice cloning. SSML voice tags in the popup are style tags, not actual voices.
- **GPU is single-threaded** — Only one `model.generate()` runs at a time. A `gpu_lock` serializes all inference.
- **Qwen3-TTS `generate()` ignores `speed`** — Speed is applied client-side via `playbackRate`.
- **Chrome MV3 service workers** — No `URL.createObjectURL` or `FileReader` in service workers. Audio passes as base64 through messaging.

## Requirements

- Mac with Apple Silicon (M1/M2/M3/M4)
- macOS 14.0+ (Sonoma or later)
- Python 3.12+
- ~10 GB disk space for both models (or ~4 GB for one)

## Quick Start

### 1. Setup (one-time)

```bash
cd backend
chmod +x setup.sh
./setup.sh
```

This will:
- Create a Python virtual environment
- Install dependencies (mlx-audio >= 0.4.2, kokoro-mlx)
- Download models (Kokoro bf16 + Qwen3-TTS 8-bit + Fish S2 Pro 8-bit)

### 2. Install Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension` folder

### 3. Install Native Messaging Host (required for Start/Stop buttons)

```bash
cd backend
./install_native_host.sh
```

When prompted, enter your Chrome extension ID (visible on `chrome://extensions/` page).

**To uninstall:**
```bash
./uninstall_native_host.sh
```

### 4. Use It

1. Click the extension icon in Chrome
2. Select your **model** (Kokoro, Qwen3-TTS, or Fish S2 Pro)
3. Click **"▶ Start Server"** — wait for "Server running" status
4. Select any text on any webpage and click the speaker icon to hear it
5. Click **"⏹ Stop Server"** when done

**That's it!** No need to run any terminal commands.

---

<details>
<summary>Manual Server Start (Alternative)</summary>

If you prefer running the server manually from the terminal:

```bash
cd backend
source venv/bin/activate
python server.py
```

The server will start at `http://127.0.0.1:8000`

</details>

### Settings

Click the extension icon to:
- **Select model** — Kokoro, Qwen3-TTS, or Fish S2 Pro (auto-swaps on demand)
- **Select voice** — 19 preset voices for Kokoro (Bella default), 9 for Qwen3, SSML tags for Fish
- **Select language** — Auto, English, Chinese, Japanese, Korean (Qwen3 only; Kokoro uses internal lang codes)
- **Adjust speed** — 0.5x - 3.0x (Kokoro: natural speed at synthesis; Qwen3: playbackRate)

## Auto-Start on Login (macOS)

```bash
cd backend
./install_launch_agent.sh
```

To uninstall:
```bash
./uninstall_launch_agent.sh
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health, model status, load errors, GPU lock state |
| `/v1/models` | GET | List available models and their voices |
| `/v1/voices` | GET | List voices for current or specified model |
| `/v1/load-model` | POST | Swap the active model (`?force=true` to force-reload after errors) |
| `/v1/synthesize` | POST | Synthesize speech (supports `stream: true` for Qwen3-TTS) |

### Example: List Models

```bash
curl http://127.0.0.1:8000/v1/models
```

### Example: Swap Model

```bash
curl -X POST "http://127.0.0.1:8000/v1/load-model?model_id=fish-s2-pro"
```

### Example: Force-Reload After Error

```bash
curl -X POST "http://127.0.0.1:8000/v1/load-model?model_id=qwen3-tts&force=true"
```

### Example: Synthesize Speech (Non-Streaming)

```bash
# Kokoro with preset voice (default)
curl -X POST http://127.0.0.1:8000/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model": "kokoro", "voice": "af_bella", "speed": 1.5}' \
  --output output.wav

# Qwen3-TTS with preset voice
curl -X POST http://127.0.0.1:8000/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model": "qwen3-tts", "voice": "ryan", "speed": 1.0}' \
  --output output.ogg

# Fish S2 Pro with SSML voice tag
curl -X POST http://127.0.0.1:8000/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model": "fish-s2-pro", "voice": "whisper"}' \
  --output output.ogg
```

### Example: Synthesize Speech (Streaming — Qwen3-TTS only)

```bash
curl -X POST http://127.0.0.1:8000/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "This is a longer text that benefits from streaming.", "model": "qwen3-tts", "voice": "ryan", "stream": true}' \
  --output stream.wav
```

Streaming returns concatenated WAV segments. Each segment is a valid WAV file. First audio arrives in ~0.5s. **Note:** Kokoro and Fish S2 Pro do not support streaming; non-streaming WAV/Opus is used instead.

Audio formats: `opus` (default), `mp3`, `wav`.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPEN_TTS_DEFAULT_MODEL` | `kokoro` | Model to load at startup |
| `OPEN_TTS_HOST` | `127.0.0.1` | Server host |
| `OPEN_TTS_PORT` | `8000` | Server port |
| `OPEN_TTS_AUDIO_FORMAT` | `opus` | Default output format |
| `OPEN_TTS_OPUS_BITRATE` | `64k` | Opus encoding bitrate |
| `OPEN_TTS_STREAMING_INTERVAL` | `0.5` | Seconds between streaming chunks (Qwen3 only) |

## Architecture

### Streaming Pipeline

```
User selects text → content.js splits into chunks (2000 chars)
  → For each chunk: background.js sends TTS_STREAM_REQUEST
    → Server generates audio with streaming (0.5s intervals)
      → WAV segments flow back as base64 through Chrome messaging
        → content.js decodes via AudioContext.decodeAudioData
          → Schedules with Web Audio API (gapless, with playbackRate)
```

- First audio plays in <0.5s (warm model)
- Sequential chunk generation (GPU lock prevents concurrent inference)
- 30s idle timeout on stream reads
- 1 retry with 1s delay on 5xx/network errors

### Auto-Recovery

- **Model reload**: If `model.generate()` fails, `load_error` is set and the model reference is cleared. Next request triggers a full reload. `/health` shows `load_error`. `/v1/load-model?force=true` force-reloads.
- **Request retry**: Transient 5xx errors and network timeouts are retried once after 1s. Client errors (4xx) are not retried.
- **Server cache invalidation**: Any non-2xx response or network error immediately invalidates the `_serverKnownRunning` cache, so the next request re-checks server health.
- **Port binding**: The native host checks for stale processes on the configured port and kills them before starting. FD leaks are handled with proper cleanup.

## Project Structure

```
backend/
  server.py           # FastAPI server (multi-model, lazy loading, streaming)
  native_host.py      # Native messaging host for extension (start/stop/status)
  requirements.txt    # Python dependencies
  setup.sh            # Setup script (downloads all models)
  models/             # Downloaded model files
    kokoro-82M/         # Kokoro 82M bf16 (~170 MB)
    qwen3-tts-8bit/     # Qwen3-TTS 8-bit (~2.9 GB)
    fish-audio-s2-pro-8bit/  # Fish S2 Pro 8-bit (~6.3 GB)
  install_native_host.sh   # Install native host for Start/Stop buttons
  install_launch_agent.sh  # Auto-start on login
  uninstall_launch_agent.sh # Remove launch agent
  uninstall_native_host.sh # Remove native host
extension/
  manifest.json       # Chrome extension config (Open TTS v2.3.0)
  background.js       # Service worker (TTS requests, streaming, retry, server management)
  content.js          # Content script (widget, Web Audio API, chunk scheduling)
  popup.html/js/css   # Extension popup with model selector
  content.css         # Widget styling
  icon*.png           # Extension icons
```

## Troubleshooting

### Server won't start
```bash
# Check if port is in use
lsof -i :8000

# Kill existing process
kill -9 <PID>
```

### Native messaging error
If you see "Native messaging error" when clicking Start/Stop:
1. Make sure you ran `./install_native_host.sh`
2. Make sure you entered the correct extension ID
3. Reload the extension in `chrome://extensions/`

### Model fails to download
- Check internet connection
- Try manual download:
  ```bash
  pip install huggingface-hub
  # Kokoro (lightweight, loads instantly)
  huggingface-cli download mlx-community/Kokoro-82M-bf16 --local-dir backend/models/kokoro-82M
  # Qwen3-TTS (2.9 GB)
  huggingface-cli download mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit --local-dir backend/models/qwen3-tts-8bit
  # Fish S2 Pro (6.3 GB)
  huggingface-cli download mlx-community/fish-audio-s2-pro-8bit --local-dir backend/models/fish-audio-s2-pro-8bit
  ```

### Extension shows "Disconnected" or "Server not running"
- Make sure the server is running
- Check `http://127.0.0.1:8000/health` in browser
- If `/health` shows `load_error`, force-reload from the extension popup or:
  ```bash
  curl -X POST "http://127.0.0.1:8000/v1/load-model?force=true"
  ```

### Streaming audio cuts off
- Check console for "Stream read timeout" — the 30s idle timeout may be too short for very long text on slow hardware
- Fish S2 Pro doesn't support streaming — it auto-falls back to non-streaming

### "resource_tracker: leaked semaphore" warning in server logs
This is a known Python multiprocessing issue, not our bug. Safe to ignore.

## Credits

- **Kokoro**: [mlx-community/Kokoro-82M-bf16](https://huggingface.co/mlx-community/Kokoro-82M-bf16) — Ultra-fast lightweight TTS
- **Qwen3-TTS**: [mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit)
- **Fish S2 Pro**: [mlx-community/fish-audio-s2-pro-8bit](https://huggingface.co/mlx-community/fish-audio-s2-pro-8bit)
- **Framework**: [MLX Audio](https://github.com/Blaiziinger/mlx-audio), [Kokoro-MLX](https://github.com/severian42/Kokoro-MLX)

## License

MIT License — Use freely for personal or commercial projects.

---

Created by [shersingh7](https://github.com/shersingh7) | Vibe coded with AI assistance