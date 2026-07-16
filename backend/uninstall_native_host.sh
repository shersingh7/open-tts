#!/bin/bash
# Uninstall the native messaging host
set -euo pipefail

NATIVE_HOST_NAME="com.open_tts.native_host"
HOST_DIR=""
CHROME_TESTING_HOST_DIR=""
CHROMIUM_HOST_DIR=""

# Also clean up legacy name from older installs
OLD_HOST_NAME="com.qwen_tts_mlx.native_host"

echo "=== Uninstalling Open TTS Native Host ==="

if [[ "$OSTYPE" == "darwin"* ]]; then
    HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROME_TESTING_HOST_DIR="$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
    CHROMIUM_HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
    HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROME_TESTING_HOST_DIR="$HOME/.config/google-chrome-for-testing/NativeMessagingHosts"
    CHROMIUM_HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
else
    echo "Unsupported OS: $OSTYPE" >&2
    exit 1
fi

if [ -f "$HOST_DIR/$NATIVE_HOST_NAME.json" ]; then
    rm "$HOST_DIR/$NATIVE_HOST_NAME.json"
    echo "✓ Removed from Chrome"
fi

if [ -f "$CHROMIUM_HOST_DIR/$NATIVE_HOST_NAME.json" ]; then
    rm "$CHROMIUM_HOST_DIR/$NATIVE_HOST_NAME.json"
    echo "✓ Removed from Chromium"
fi

if [ -f "$CHROME_TESTING_HOST_DIR/$NATIVE_HOST_NAME.json" ]; then
    rm "$CHROME_TESTING_HOST_DIR/$NATIVE_HOST_NAME.json"
    echo "✓ Removed from Chrome for Testing"
fi

# Clean up legacy name too (same browser targets as install)
if [ -f "$HOST_DIR/$OLD_HOST_NAME.json" ]; then
    rm "$HOST_DIR/$OLD_HOST_NAME.json"
    echo "✓ Removed legacy host from Chrome"
fi

if [ -f "$CHROMIUM_HOST_DIR/$OLD_HOST_NAME.json" ]; then
    rm "$CHROMIUM_HOST_DIR/$OLD_HOST_NAME.json"
    echo "✓ Removed legacy host from Chromium"
fi

if [ -f "$CHROME_TESTING_HOST_DIR/$OLD_HOST_NAME.json" ]; then
    rm "$CHROME_TESTING_HOST_DIR/$OLD_HOST_NAME.json"
    echo "✓ Removed legacy host from Chrome for Testing"
fi

echo "Native messaging host uninstalled."