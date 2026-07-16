#!/bin/bash
# Install the native messaging host for Chrome/Chromium
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NATIVE_HOST_NAME="com.open_tts.native_host"
NATIVE_HOST_SCRIPT="$SCRIPT_DIR/native_host.py"
MANIFEST_TEMPLATE="$SCRIPT_DIR/com.open_tts.native_host.json"
EXTENSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 --extension-id <chrome_extension_id>"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ -z "$EXTENSION_ID" ]; then
  echo "Enter your Chrome extension ID (chrome://extensions, Developer mode):"
  read -r EXTENSION_ID
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "Error: Extension ID is required"
  exit 1
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: invalid Chrome extension ID: $EXTENSION_ID" >&2
  exit 1
fi

if [[ ! -x "$SCRIPT_DIR/venv/bin/python" ]] && [[ ! -f "$SCRIPT_DIR/venv/bin/python" ]]; then
  echo "Error: backend venv missing. Run ./setup.sh first."
  exit 1
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
  HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  CHROME_TESTING_HOST_DIR="$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
  CHROMIUM_HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
  HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  CHROME_TESTING_HOST_DIR="$HOME/.config/google-chrome-for-testing/NativeMessagingHosts"
  CHROMIUM_HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
else
  echo "Error: Unsupported OS: $OSTYPE"
  exit 1
fi

mkdir -p "$HOST_DIR"
MANIFEST_CONTENT=$(sed "s|__PATH__|$NATIVE_HOST_SCRIPT|g; s|__EXTENSION_ID__|$EXTENSION_ID|g" "$MANIFEST_TEMPLATE")
MANIFEST_DEST="$HOST_DIR/$NATIVE_HOST_NAME.json"
printf '%s\n' "$MANIFEST_CONTENT" > "$MANIFEST_DEST"
chmod +x "$NATIVE_HOST_SCRIPT"

OLD_HOST="$HOST_DIR/com.qwen_tts_mlx.native_host.json"
if [ -f "$OLD_HOST" ]; then
  rm "$OLD_HOST"
  echo "✓ Removed legacy native host manifest"
fi

if [ -d "$(dirname "$CHROMIUM_HOST_DIR")" ]; then
  mkdir -p "$CHROMIUM_HOST_DIR"
  printf '%s\n' "$MANIFEST_CONTENT" > "$CHROMIUM_HOST_DIR/$NATIVE_HOST_NAME.json"
  echo "✓ Also installed for Chromium"
fi

if [ -d "$(dirname "$CHROME_TESTING_HOST_DIR")" ]; then
  mkdir -p "$CHROME_TESTING_HOST_DIR"
  printf '%s\n' "$MANIFEST_CONTENT" > "$CHROME_TESTING_HOST_DIR/$NATIVE_HOST_NAME.json"
  echo "✓ Also installed for Chrome for Testing"
fi

echo "✓ Native messaging host installed: $MANIFEST_DEST"
echo "Reload the extension in chrome://extensions/"