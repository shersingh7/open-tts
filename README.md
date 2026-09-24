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
- **Right-click & shortcuts** — "Read with Open TTS" on any selection (works in PDFs); Alt+Shift+R reads the selection, Alt+Shift+P pauses/resumes
- **Per-site widget hiding** — hide the on-page button on a site from the popup
- **Server Control** — Start/Stop server directly from the extension popup
- **Bounded playback** — Adjacent Web Audio scheduling while buffered; controlled rebuffering after a stall instead of overlapping late audio.

## Models

| Model | Size | Sample Rate | Voices | Speed Applied | Strengths |
|-------|------|-------------|--------|---------------|-----------|
| **Kokoro (bf16)** | 170 MB | 24 kHz | 19 preset | At synthesis (natural) | Ultra-fast, lightweight, high quality |
| Qwen3-TTS (8-bit) | 2.9 GB | 24 kHz | 9 preset + instruct | Server-side time stretch | Multilingual, streaming support |
| Fish S2 Pro (8-bit) | 6.3 GB | 44.1 kHz | SSML voice tags | Server-side time stretch | High-fidelity, voice cloning ready |

Only one model is loaded at a time. A model change while work is active is rejected as busy; stop the current reading first. Loading and warmup run on the same model-owner thread as inference.

### Known Limitations

- Qwen3/Fish may generate slower than playback. Buffering cannot make a slower-than-realtime model realtime.
- Non-native speed is processed per bounded semantic unit, which trades startup latency for packet-independent pacing. Synthetic DSP tests do not establish natural speech quality.
- Kokoro uses the installed adapter's native paragraph/phoneme splitting. Source paragraph structure is preserved, but no invented pause durations are inserted.
- Fish uses non-streaming model generation inside the framed transport, with `fallback: "non-streaming"` audio metadata.
- Cancellation is cooperative between model yields. A noncooperative native MLX call cannot be forcibly interrupted safely by an HTTP request.
- The extension requires the matching backend stream contract: processed-speed metadata, ordered per-index finals and a terminal done frame. Truncation is an error.
- Real-model listening and real Chrome lifecycle checks are separate release gates; the offline suite uses fake models and a simulated audio clock.

## Progressive reading

Chrome **116+** and the matching backend are required. Short selections use the lightweight offscreen player. Selections over 4,000 characters, and Qwen3/Fish selections over 600 characters, use a visible **Reader tab** (only one Reader can host playback at a time; Chrome is asked not to discard it while reading). Short Qwen3/Fish previews stay offscreen and fail with a "slow to start" message if no audio arrives within 25 s. Keep that tab open while listening. Closing/discarding the owner is an interruption, not completion.

The backend separates large HTTP text partitions from small generation passages and roughly two-second audio packets:

| Model | First target / hard maximum | Later target / hard maximum |
|---|---|---|
| Kokoro | 300 / 600 characters | 900 / 1,200 characters |
| Qwen3 | 160 / 320 characters | 480 / 720 characters |
| Fish | 160 / 300 characters | 300 / 500 characters |

These are deterministic starting profiles, **not measured naturalness or latency claims**. Boundaries prefer sentences/words; source coverage uses Unicode code points. Reader progress means fully played passages, not merely generated text. Stop, replacement, failure and owner loss never create completed history.

`GET /v1/capabilities` advertises protocol versions and resource limits. The extension explicitly requests `protocol_version: 2`, requires the matching response header, validates increasing frame sequences and exact source coverage, and rejects an incompatible backend. Legacy API clients may still request v1. V2 adds unit IDs/source offsets, sample counts, per-unit generation timings and explicit terminal outcomes.

### Resource and API contracts

- Raw JSON upload: 4 MiB, at most four concurrent body handlers; per-text 50,000 and aggregate 200,000 characters by default, at most 50 batch texts; instructions at most 2,000 characters.
- One model owner, one active job plus one pending job. Cancellation retains the lease until native work actually returns. Model switches require an idle owner.
- Server transport queue: both item and 8 MiB byte bounds. Extension: incremental parser, one decode, 16 MiB decoded reservation budget and 20 seconds of remaining audio plus 250 ms lead.
- Semantic PCM: 32 MiB. Full response PCM: 128 MiB. Batch base64 output: 128 MiB. These exclude MLX/model allocations and are not total-process RSS guarantees.
- `/v1/synthesize` defaults to a complete WAV. Use `stream:true` for framed output, not a directly playable file. `/v1/audio/speech` and `/v1/speech` return complete files and **reject** `stream:true` with guidance to the framed endpoint.
- The old `OPEN_TTS_STREAM_FIRST_CHARS` / `OPEN_TTS_STREAM_REST_CHARS` knobs are legacy helper settings; model-aware generation now uses the profiles above.

### Qualification without disturbing live audio

`npm test` is offline. Real synthesis, Chrome lifecycle and listening are separate gates. The guarded HTTP runner never launches/stops a server or switches an already loaded different model. On a separately authorized, already-running isolated instance:

```bash
env -u PYTHONPATH backend/venv/bin/python scripts/verify-long-text.py \
  --authorize-real-audio --base-url http://127.0.0.1:18001 \
  --runtime-dir /absolute/path/to/isolated-runtime \
  --text-file /absolute/path/to/synthetic-fixture.txt --model kokoro --speed 1.5 \
  --output /absolute/path/to/http-qualification.json
```

The runner refuses default port 8000 and the production runtime directory. No source text, instructions or token enter the JSON report. HTTP arrival timing is not proof of audible Chrome playback. The larger model-matrix script now also requires explicit URL/runtime/model/audio opt-in, with an additional flag for model switching.

Reader diagnostics distinguish first packet, first scheduled source, observed audio-clock start, generation finish, terminal time, normalized generation/audio RTF and underflow counters. Audio-clock start is **not** an acoustic speaker measurement. Native cancellation-release time is available in capability runtime diagnostics.

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
- Install the dependencies pinned in `backend/requirements.txt`
- Download Kokoro by default. Add `--with-qwen`, `--with-fish`, or `--all-models` for optional models.

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
- **Adjust speed** — 0.5x - 3.0x (Kokoro: native synthesis speed; Qwen3/Fish: server-side pitch-preserving stretch; browser always 1×)

## Optional LaunchAgent (macOS, on-demand by default)

```bash
cd backend
./install_launch_agent.sh  # installs without starting the server
# Explicit opt-in only: ./install_launch_agent.sh --auto-start
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
  --output output.wav

# Fish S2 Pro with SSML voice tag
curl -X POST http://127.0.0.1:8000/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model": "fish-s2-pro", "voice": "whisper"}' \
  --output output.wav
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
| `OPEN_TTS_RUNTIME_DIR` | `backend/` | Token/lock/PID/log directory; use a separate directory for an authorized isolated runtime |
| `OPEN_TTS_STREAM_MAX_EMIT_SECONDS` | `2` | Maximum emitted PCM duration, validated in `(0, 4]` |

The extension bounds scheduled audio to 20 seconds plus 250 ms scheduling lead and decoded PCM to 16 MiB. It reserves memory before decoding, retains at most one decode in flight, and stops consuming frames when over budget. Non-native semantic PCM accumulation is limited to 32 MiB; a full non-streaming response is limited to 128 MiB of processed PCM. These are application buffer limits, not a bound on a model's own MLX allocation or total process RSS.

## Architecture

```text
content/content.js (closed-shadow widget) · ui/popup · host/reader UI · right-click menu · Alt+Shift+R / Alt+Shift+P
  ⇄ long-lived named ports (ui:popup, ui:content, ui:reader)
sw/ service worker — the single owner of playback state
  router.js        ownership rules, SPEAK flow, command routing, SESSION snapshots to every UI
  session-store.js authoritative run record in chrome.storage.session (survives SW restarts)
  server-manager   one single-flight ensureServer / model load (progress survives popup close)
  auth.js          API token in chrome.storage.session (extension pages only; never content scripts)
  ⇄ host ports (host:offscreen, host:reader) — exactly one playback host per run
host/engine.js — run-scoped transport/decode/playback (offscreen document or Reader tab)
  → backend/open_tts/api.py: framed transport, Host-header check, disconnect handling
    → coordinator.py: serialized model lifecycle / semantic generation units
      → audio.py: sample-preserving native PCM / semantic time stretch
```

The service worker is the only place that knows which run is active. UIs render the latest `SESSION` snapshot and send commands; hosts report `STATUS`/`PROGRESS`/`DONE`/`ERROR` and a heartbeat. A web page's widget can only control the reading it started (same tab and frame). If the owning host's port disconnects and does not reconnect within 2 s, the run ends once as `owner_lost`. A second Reader tab is refused, so a restored/duplicated Reader can never synthesize the same reading twice. Audio never travels through Chrome runtime messages.

There is **no automatic whole-document fallback**. Invalid, interrupted or failed audio stops with a visible error; a user-initiated retry is a new run. This avoids hidden replay and all-audio JSON accumulation.

## Verification and upgrading

```bash
npm test
npm run package:extension
git diff --check
```

The offline suite loads the real extension scripts with controlled Chrome/Web Audio/fetch substitutes and the real Python coordinator with fake model adapters. It includes a 2,000-frame simulated playback soak, cancellation interleavings, strict framing, text preservation and synthetic DSP tests. It is not a real-model latency benchmark or a listening verdict.

See [progressive implementation plan](docs/plans/2026-09-15-progressive-long-form-tts.md) and [verification report](docs/reports/progressive-long-form-verification.md). Version 4.0.0 is a source/package candidate, not an automatically installed release. Reload the unpacked extension and restart the matching backend **only when existing audio work is idle and after authorizing that operation**. No model or lifecycle tests should interrupt another audio job.

## Project Structure

```
backend/
  server.py           # FastAPI server (multi-model, lazy loading, streaming)
  native_host.py      # Native messaging host for extension (start/stop/status)
  requirements.txt    # Python dependencies
  setup.sh            # Setup script (Kokoro default; optional models via flags)
  models/             # Downloaded model files
    kokoro-82M/         # Kokoro 82M bf16 (~170 MB)
    qwen3-tts-8bit/     # Qwen3-TTS 8-bit (~2.9 GB)
    fish-audio-s2-pro-8bit/  # Fish S2 Pro 8-bit (~6.3 GB)
  install_native_host.sh   # Install native host for Start/Stop buttons
  install_launch_agent.sh  # On-demand launch-agent installation
  uninstall_launch_agent.sh # Remove launch agent
  uninstall_native_host.sh # Remove native host
extension/
  manifest.json       # Chrome MV3 extension config (module service worker, menus, commands)
  sw/                 # Service worker: router, session store, server/host managers, auth, history, menus
  host/               # Playback engine + offscreen document + Reader tab
  ui/                 # Popup and its port client
  content/content.js  # Content script: selection widget in a closed shadow root
  shared/             # ESM: constants, messages, stream decoder, playback helpers, storage
  icon*.png           # Extension icons
```

## Troubleshooting

### Server won't start
```bash
# Check if port is in use
lsof -i :8000

# Inspect ownership; never kill an unrelated port owner.
# Stop Open TTS through its native host only after ongoing audio work is idle.
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
- Check the Reader status and local timing diagnostics. The transport idle limit is 60 seconds; inference keepalives are not completion.
- Fish generates one bounded passage at a time inside the streaming transport. Slower-than-realtime inference can still cause genuine buffering.
- After an error, Reader retry restarts at the last fully played passage boundary; it may repeat the interrupted passage. No whole-essay retry happens automatically.

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