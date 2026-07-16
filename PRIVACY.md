# Open TTS Privacy

Open TTS processes all speech synthesis locally on your Mac. No text or audio is sent to cloud services.

## Data stored on your device

| Data | Location | Purpose |
|------|----------|---------|
| Model/voice/speed settings | `chrome.storage.sync` | Restore preferences across signed-in Chrome profiles |
| Preview text | `chrome.storage.local` | Restore popup draft without syncing spoken text to Chrome cloud storage |
| Playback history (max 20 items) | `chrome.storage.local` | Replay recent phrases — never synced |
| API install token | `chrome.storage.local` + `backend/.open_tts_token` | Authenticate local API requests |

## Network access

The extension communicates only with `http://127.0.0.1:8000` on your machine via the local FastAPI server.

Browser-originated `/v1/*` requests require the per-install token. Loopback CLI clients that send no
`Origin` header may use the OpenAI-compatible API without a token; they remain subject to rate limits.

## Permissions

- **storage** — save settings and local history
- **nativeMessaging** — start/stop the local server via the installed native host
- **offscreen** — decode and play synthesized audio
- **host_permissions (127.0.0.1:8000)** — call the local TTS API

The extension does not request `tabs`, `activeTab`, or `scripting`.