#!/bin/bash
# Native host uninstaller for Open TTS Chrome extension
set -euo pipefail

HOST_NAME="com.open_tts.native_host"

if [[ "$OSTYPE" == "darwin"* ]]; then
    HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    if [[ ! -d "$HOST_DIR" ]]; then
        HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    fi
else
    HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    if [[ ! -d "$HOST_DIR" ]]; then
        HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
    fi
fi

MANIFEST="$HOST_DIR/${HOST_NAME}.json"

if [[ -f "$MANIFEST" ]]; then
    rm "$MANIFEST"
    echo "✅ Removed native host manifest: $MANIFEST"
else
    echo "⚠️  Native host manifest not found at $MANIFEST"
fi
