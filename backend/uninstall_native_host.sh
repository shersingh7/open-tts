#!/bin/bash
# Uninstall the native messaging host

NATIVE_HOST_NAME="com.qwen_tts_mlx.native_host"

echo "=== Uninstalling Qwen3-TTS MLX Native Host ==="

if [[ "$OSTYPE" == "darwin"* ]]; then
    HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROMIUM_HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
    HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROMIUM_HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
fi

if [ -f "$HOST_DIR/$NATIVE_HOST_NAME.json" ]; then
    rm "$HOST_DIR/$NATIVE_HOST_NAME.json"
    echo "✓ Removed from Chrome"
fi

if [ -f "$CHROMIUM_HOST_DIR/$NATIVE_HOST_NAME.json" ]; then
    rm "$CHROMIUM_HOST_DIR/$NATIVE_HOST_NAME.json"
    echo "✓ Removed from Chromium"
fi

echo "Native messaging host uninstalled."