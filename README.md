# Qwen3-TTS MLX Local Server

> Apple Silicon Only - This project uses MLX, which requires an M1/M2/M3/M4 Mac. Not compatible with Intel Macs, Windows, or Linux.

Fast, local text-to-speech using Qwen3-TTS on Apple Silicon. Runs entirely on your Mac with no cloud API calls.

## Features

- Fast - MLX-optimized for Apple Silicon (M1/M2/M3/M4)
- Private - All processing happens locally, no cloud API
- Multiple Voices - 9 built-in voices (Serena, Vivian, Ryan, etc.)
- Multilingual - Supports English, Chinese, Japanese, Korean, and auto-detect
- Chrome Extension - Select text on any page and click to hear it
- Server Control - Start/Stop server directly from the extension popup

## Requirements

- Mac with Apple Silicon (M1/M2/M3/M4) - This project uses MLX, which is optimized for Apple Silicon. It will NOT work on Intel Macs or Windows/Linux.
- macOS 14.0+ (Sonoma or later)
- Python 3.12
- ~4GB disk space for the model

> Note: This project uses Apple's MLX framework, which is exclusive to Apple Silicon. If you're on an Intel Mac or another platform, this won't work.

## Quick Start

### 1. Setup (one-time)

```bash
cd backend
chmod +x setup.sh
./setup.sh
```

This will:
- Create a Python virtual environment
- Install dependencies
- Download the Qwen3-TTS model (~1.7B parameters, 8-bit quantized)

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

### 4. Use It (Easiest Way)

Just use the Start/Stop buttons in the extension:

1. Click the extension icon in Chrome
2. Click **"▶ Start Server"** - wait for "Server running" status
3. Select any text on any webpage and click the speaker icon to hear it
4. Click **"⏹ Stop Server"** when done

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
- Select voice (9 options: Serena, Vivian, Ryan, etc.)
- Select language (Auto, English, Chinese, Japanese, Korean)
- Adjust playback speed (0.5x - 3.0x)

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
| `/health` | GET | Server health and model status |
| `/v1/voices` | GET | List available voices |
| `/v1/synthesize` | POST | Synthesize speech |

### Example: Synthesize Speech

```bash
curl -X POST http://127.0.0.1:8000/v1/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "voice": "ryan", "speed": 1.0}' \
  --output output.wav
```

## Available Voices

- Serena
- Vivian
- Uncle Fu
- Dylan
- Eric
- Ryan
- Aiden
- Ono Anna
- Sohee

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_MLX_MODEL` | `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` | Model to use |
| `QWEN_TTS_HOST` | `127.0.0.1` | Server host |
| `QWEN_TTS_PORT` | `8000` | Server port |

## Project Structure

```
backend/
  server.py           # FastAPI server
  native_host.py      # Native messaging host for extension
  requirements.txt    # Python dependencies
  setup.sh            # Setup script
  install_native_host.sh   # Install native host for Start/Stop buttons
  install_launch_agent.sh  # Auto-start on login
extension/
  manifest.json       # Chrome extension config
  background.js       # Service worker
  content.js          # Content script (page interaction)
  popup.html/js/css   # Extension popup
```

## How It Works

1. **Extension** detects text selection on any page
2. **Background script** forwards requests to local server
3. **Server** uses MLX to run Qwen3-TTS model
4. **Audio** is generated and played in the browser

For the Start/Stop Server feature:
1. **Extension** sends command to native messaging host
2. **Native host** (Python script) starts/stops the server process
3. **Extension** polls health endpoint to confirm server status

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
  huggingface-cli download mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit
  ```

### Extension shows "Disconnected"
- Make sure the server is running
- Check `http://127.0.0.1:8000/health` in browser

## Credits

- Model: [Qwen3-TTS](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit)
- Framework: [MLX Audio](https://github.com/Blaizzy/mlx-audio)

## License

MIT License - Use freely for personal or commercial projects.

---

Created by [shersingh7](https://github.com/shersingh7) | Vibe coded with AI assistance