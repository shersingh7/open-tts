# Open TTS

> Apple Silicon Only — This project uses MLX, which requires an M1/M2/M3/M4 Mac. Not compatible with Intel Macs, Windows, or Linux.

Multi-model, fully local text-to-speech on Apple Silicon. Switch between **Kokoro**, Qwen3-TTS, and Fish Audio S2 Pro — all running MLX-optimized inference with zero cloud calls.

## Features

- **Multi-Model** — Switch between Kokoro, Qwen3-TTS, and Fish Audio S2 Pro on the fly
- **Local MLX inference** — Kokoro is the default lightweight model; actual latency depends on hardware, input, model and speed.
- **Lightweight default** — Kokoro is 82M parameters; first use may require a model download and warmup.
- **Private** — All processing happens locally, no cloud API
- **Model Swap** — One model in VRAM at a time; swap on demand from the extension
- **Explicit interruption handling** — Failed passages stop with an error, rather than silently skipping content or replaying the beginning.
- **Multiple Voices** — 19 voices for Kokoro (Bella, Sarah, Eric, etc.), 9 for Qwen3, SSML tags for Fish
- **Single speed owner** — Kokoro uses native synthesis speed; Qwen3/Fish use server-side pitch-preserving time stretch. The extension plays at 1x.
- **Multilingual** — English, Chinese, Japanese, Korean, and auto-detect (Qwen3); Kokoro supports multiple languages via single-letter lang codes
- **Chrome Extension** — Select text on any page and click to hear it
- **Server Control** — Start/Stop server directly from the extension popup
- **Bounded playback** — Adjacent Web Audio scheduling while buffered; controlled rebuffering after a stall instead of overlapping late audio.

## Models

| Model | Size | Sample Rate | Voices | Speed Applied | Strengths |
|-------|------|-------------|--------|---------------|-----------|
| **Kokoro (bf16)** | 170 MB | 24 kHz | 19 preset | At synthesis (natural) | Ultra-fast, lightweight, high quality |
| Qwen3-TTS (8-bit) | 2.9 GB | 24 kHz | 9 preset + instruct | Server-side time stretch | Multilingual, streaming support |
| Fish S2 Pro (8-bit) | 6.3 GB | 44.1 kHz | SSML voice tags | Server-side time stretch | High-fidelity, voice cloning ready |

Only one model is loaded at a time. Model changes serialize with generation and may require load/warmup time.

### Known Limitations

- Qwen3/Fish may generate slower than playback. Buffering cannot make a slower-than-realtime model realtime.
- Non-native speed is processed per bounded semantic unit, which trades startup latency for packet-independent pacing. Synthetic DSP tests do not establish natural speech quality.
- Kokoro uses the installed adapter's native paragraph/phoneme splitting. Source paragraph structure is preserved, but no invented pause durations are inserted.
- Fish uses non-streaming model generation inside the framed transport, with `fallback: "non-streaming"` audio metadata.
- Cancellation is cooperative between model yields. A noncooperative native MLX call cannot be forcibly interrupted safely by an HTTP request.
- The extension requires the matching backend stream contract: processed-speed metadata, ordered per-index finals and a terminal done frame. Truncation is an error.
- Real-model listening and real Chrome lifecycle checks are separate release gates; the offline suite uses fake models and a simulated audio clock.

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

### Streaming transport

`POST /v1/synthesize-stream-batch` accepts `texts`, `model`, `voice`, `speed`, `language` and optional `instruct`. `POST /v1/synthesize` with `stream: true` uses the same framing.

The response is **not a playable WAV file**: each record contains a little-endian uint32 header length, UTF-8 JSON header, uint32 audio length, and optional PCM16 mono WAV bytes. Each text index ends with `{ "index": n, "final": true }`; the response ends with `{ "done": true }`. Audio metadata includes sample rate and server-processed speed (`apply_playback_rate: false`, `playback_rate: 1`).

Non-streaming default format is WAV. Select other formats explicitly with `format` or the OpenAI endpoint's `response_format`.

While a slow semantic unit is generating, the server sends an empty `{ "keepalive": true }` frame every 15 seconds. This maintains network liveness without treating it as audio, advancing text completion, or resetting the inference budget. The extension still rejects a disconnected/stalled transport after 60 seconds without a read. A native call that does not return remains cooperatively cancellable only; the response timeout cannot forcibly stop MLX.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPEN_TTS_DEFAULT_MODEL` | `kokoro` | Preferred default model |
| `OPEN_TTS_HOST` | `127.0.0.1` | Bind address |
| `OPEN_TTS_PORT` | `8000` | Bind port |
| `OPEN_TTS_GEN_TIMEOUT` | `300` | Generation budget; playback backpressure excluded from streamed model iteration |
| `OPEN_TTS_MAX_TEXT` | `50000` | Per-text API character limit |
| `OPEN_TTS_MAX_BATCH_CHARS` | `200000` | Aggregate batch character limit |
| `OPEN_TTS_STREAM_QUEUE_MAX` | `32` | Bounded backend transport queue |
| `OPEN_TTS_STREAM_FRAME_TIMEOUT` | `60` | Inference-idle floor; effective generated-frame timeout is the larger of this value and `OPEN_TTS_GEN_TIMEOUT`. Consumer backpressure is excluded. |
| `OPEN_TTS_STREAMING_INTERVAL` | `1.0` | Model streaming interval where supported |
| `OPEN_TTS_STREAM_FIRST_CHARS` / `OPEN_TTS_STREAM_REST_CHARS` | `4000` | Semantic generation-unit caps |
| `OPEN_TTS_STREAM_MAX_EMIT_SECONDS` | `20` | Maximum emitted PCM duration; do not increase beyond the extension's frame cap |

The extension bounds scheduled audio to 20 seconds plus 250 ms scheduling lead and decoded PCM to 16 MiB. It reserves memory before decoding, retains at most one decode in flight, and stops consuming frames when over budget. Non-native semantic PCM accumulation is limited to 32 MiB; a full non-streaming response is limited to 128 MiB of processed PCM. These are application buffer limits, not a bound on a model's own MLX allocation or total process RSS.

## Architecture

```text
content.js / popup.js: text + UI + playback controls
  → background.js: on-demand server lifecycle, routing, run ownership
    → offscreen.js: direct HTTP stream, validation, decode, bounded playback
      → backend/open_tts/api.py: framed transport and disconnect handling
        → coordinator.py: serialized model lifecycle / semantic generation units
          → audio.py: sample-preserving native PCM / semantic time stretch
```

Audio never travels through Chrome runtime messages. Each offscreen run owns its controller, AudioContext, sources, timers and completion state. A replacement tears down only its predecessor. The background worker can recover playback state from an existing offscreen document after restart without creating one for an idle status check.

There is **no automatic whole-document fallback**. Invalid, interrupted or failed audio stops with a visible error; a user-initiated retry is a new run. This avoids hidden replay and all-audio JSON accumulation.

## Verification and upgrading

```bash
npm test
npm run package:extension
git diff --check
```

The offline suite loads the real extension scripts with controlled Chrome/Web Audio/fetch substitutes and the real Python coordinator with fake model adapters. It includes a 2,000-frame simulated playback soak, cancellation interleavings, strict framing, text preservation and synthetic DSP tests. It is not a real-model latency benchmark or a listening verdict.

See [implementation plan](docs/plans/long-text-audio-reliability.md) and [verification report](docs/reports/long-text-audio-implementation.md). Version 3.4.3 is a source/package candidate, not an automatically installed release. Reload the unpacked extension and restart the matching backend **only when existing audio work is idle and after authorizing that operation**. No model or lifecycle tests should interrupt another audio job.

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
  install_launch_agent.sh  # On-demand launch-agent installation
  uninstall_launch_agent.sh # Remove launch agent
  uninstall_native_host.sh # Remove native host
extension/
  manifest.json       # Chrome MV3 extension config
  background.js       # Service worker: routing and server lifecycle
  content.js          # Content script: selection and widget
  offscreen.js        # Run-scoped audio transport/decode/playback
  shared/             # Bounded playback sessions, text and framing helpers
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