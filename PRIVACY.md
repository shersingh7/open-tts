# Open TTS Privacy

Open TTS processes all speech synthesis locally on your Mac. No text or audio is sent to cloud services.

## Data stored on your device

| Data | Location | Purpose |
|------|----------|---------|
| Model/voice/speed settings | `chrome.storage.sync` | Restore preferences across signed-in Chrome profiles |
| Free-form voice instructions | `chrome.storage.local` | Keep direction text local; legacy sync values are copied, verified locally, then removed from sync |
| Preview text | `chrome.storage.local` | Restore popup draft without syncing spoken text to Chrome cloud storage |
| Completed playback history (**off by default**; when enabled: max 20 items, first 2,000 characters of each, 256 KB total) | `chrome.storage.local` | Written by the service worker only after actual playback completion; stops, errors and replacements are not saved |
| Hidden-widget sites | `chrome.storage.sync` | Hostnames where you chose to hide the on-page button |
| Current reading state | `chrome.storage.session` | In-memory only, cleared when the browser closes |
| API install token | `chrome.storage.session` (restricted to extension pages; content scripts cannot read it) + `backend/.open_tts_token` | Authenticate local API requests. Fetched from the native host on demand; older versions' `chrome.storage.local` copy is deleted on upgrade |

The visible Reader holds the current text in page memory. Local timing diagnostics contain counters/timestamps, not selected text, voice instructions or the API token. Deleting a legacy synced instruction stops this extension from retaining that sync key; it cannot promise deletion from prior provider backups.

## Network access

The extension communicates only with `http://127.0.0.1:8000` on your machine via the local FastAPI server. The server rejects requests whose `Host` header is not `127.0.0.1` or `localhost`, which blocks DNS-rebinding attempts from web pages.

Browser-originated `/v1/*` requests require the per-install token. Loopback CLI clients that send no
`Origin` header may use the OpenAI-compatible API without a token; they remain subject to rate limits.

## Permissions

- **storage** — save settings and local history
- **nativeMessaging** — start/stop the local server via the installed native host
- **offscreen** — decode and play synthesized audio
- **contextMenus** — the "Read with Open TTS" right-click item
- **host_permissions (127.0.0.1:8000)** — call the local TTS API

The extension does not request `tabs`, `activeTab`, or `scripting`.