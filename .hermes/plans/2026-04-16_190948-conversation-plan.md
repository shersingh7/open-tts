# Plan: Fix Open TTS Native Messaging Host

## Problem
Chrome extension "Open TTS" fails with: `Specified native messaging host not found`. The native host manifest is missing from Chrome's NativeMessagingHosts directory.

## Root Cause
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` exists but is empty — no `com.open_tts.native_host.json` was ever installed. The `install_native_host.sh` script requires interactive input for the extension ID and was never run.

## Fix
Install the native messaging host manifest manually (no interactive script needed).

### Step 1: Get Extension ID
Open `chrome://extensions/` with Developer Mode enabled. Find "Open TTS" and copy its ID (32-char string like `abcdefghijklmnopqrstuvwxyz123456`).

### Step 2: Create Manifest
Write `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.open_tts.native_host.json` with:
```json
{
  "name": "com.open_tts.native_host",
  "description": "Native Messaging Host for Open TTS - manages the local TTS server",
  "path": "/Users/shersingh/github/open-tts/backend/native_host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<EXTENSION_ID>/"
  ]
}
```

Replace `<EXTENSION_ID>` with the real ID from Step 1.

### Step 3: Make native_host.py Executable
```bash
chmod +x /Users/shersingh/github/open-tts/backend/native_host.py
```

### Step 4: Verify native_host.py Shebang
Already present: `#!/usr/bin/env python3` — correct.

### Step 5: Reload Extension
Go to `chrome://extensions/` and click the refresh icon on Open TTS.

### Step 6: Test
Click the extension popup, hit Start Server. Should no longer show native messaging error.

## Files Changed
- **CREATE**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.open_tts.native_host.json`
- **CHMOD**: `/Users/shersingh/github/open-tts/backend/native_host.py` (ensure +x)

## Risks
- If the venv python at `backend/venv/bin/python` isn't used, native_host.py will fall back to `sys.executable` which may not have `mlx_audio` installed. The venv check on line 78 handles this.
- Chrome must be fully restarted (quit + reopen) if manifest changes aren't picked up after extension reload.

## Also Noted (secondary, not blocking)
- Old manifest template `com.qwen_tts_mlx.native_host.json` still exists in `backend/` — harmless but stale.
- The `install_native_host.sh` script is interactive (uses `read`) which makes it hard to automate. Could add a `--extension-id` CLI arg for non-interactive use.