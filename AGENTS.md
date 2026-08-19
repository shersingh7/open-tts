# Open TTS — Agent Context

## What this is

Local multi-model text-to-speech for Apple Silicon (MLX). Architecture:

- **Chrome extension** (`extension/`) — select-to-speak UI, Web Audio playback
- **Python backend** (`backend/`) — FastAPI-style server at `http://127.0.0.1:8000`, one model in VRAM at a time (Kokoro / Qwen3-TTS / Fish S2 Pro)
- **Native messaging host** (`backend/native_host.py`) — Start/Stop from the extension

No cloud TTS path. Models and inference stay local.

## Commands (discovered; do not invent)

From repo root (`~/github/open-tts`):

```bash
# Install / setup (one-time; uses backend/venv, Python 3.12+)
cd backend && ./setup.sh
# Optional models: ./setup.sh --with-qwen | --with-fish | --all-models

# Unit tests (preferred gate for ordinary code changes)
npm test                    # JS (vitest) + backend (pytest)
npm run test:js             # vitest run
npm run test:backend        # backend/venv pytest -q
npm run test:extension      # extension/tests only

# Package extension zip
npm run package:extension   # node scripts/package-extension.mjs

# Model matrix (heavy; real models; not a default PR check)
npm run test:model-matrix
```

Native host / launch agent (only when that surface is in scope):

```bash
cd backend && ./install_native_host.sh
cd backend && ./uninstall_native_host.sh
cd backend && ./install_launch_agent.sh
cd backend && ./uninstall_launch_agent.sh
```

Manual server (only when authorized):

```bash
./start-server.sh
# or: cd backend && source venv/bin/activate && python server.py
```

Health check (when the server is already running):

```bash
curl -s http://127.0.0.1:8000/health
```

## Lifecycle guard (non-negotiable)

Ordinary build/refactor work **must not**:

- Start or stop the live production server / launch agent
- Switch the active real model on a live instance
- Synthesize real user audio or run long real-model matrices without current authorization
- Run disruptive browser / native-host E2E against the user’s Chrome profile without authorization

Prefer unit tests (`npm test`) over live synthesis. Treat `backend/venv/` and large model trees as runtime assets, not format targets.

## Source of truth / do not modify lightly

| Path | Role |
|------|------|
| `extension/` | MV3 extension UI + messaging |
| `backend/open_tts/` | Core library (adapters, API, protocol, security) |
| `backend/server.py` | Server entry |
| `backend/tests/`, `extension/tests/` | Unit coverage |
| `package.json`, `vitest.config.js` | Test orchestration |
| `backend/venv/`, `backend/models/`, `node_modules/` | Generated / large assets — do not commit churn |

Do not edit `backend/server.log`, `stdout.log`, `stderr.log`, or packaged `dist/` as source.

## Definition of done

1. Scoped verification passes (`npm test` for code changes that touch JS or backend).
2. Behavior checked when the change is behavioral (protocol, security, adapters).
3. Unrelated files stay untouched; no mass-format, stash, clean, or commit unless David asks.
4. No secrets, tokens, or `.open_tts_token` content in diffs or logs.

## Preferred implementation path

Grok Build may implement substantive coding. Hermes independently reviews and verifies with the commands above.