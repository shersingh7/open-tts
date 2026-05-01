#!/bin/bash
# Native host installer for Open TTS Chrome extension
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.open_tts.native_host"

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
else
    echo "Unsupported OS: $OSTYPE"
    exit 1
fi

# Find Chrome NativeMessagingHosts directory
if [[ "$OS" == "macos" ]]; then
    HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    # Also try Chromium
    if [[ ! -d "$HOST_DIR" ]]; then
        HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    fi
else
    HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    if [[ ! -d "$HOST_DIR" ]]; then
        HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
    fi
fi

if [[ ! -d "$HOST_DIR" ]]; then
    echo "Creating NativeMessagingHosts directory..."
    mkdir -p "$HOST_DIR"
fi

# Determine Python executable
if [[ -f "$SCRIPT_DIR/backend/venv/bin/python" ]]; then
    PYTHON="$SCRIPT_DIR/backend/venv/bin/python"
else
    PYTHON="$(command -v python3)"
fi

# Write manifest
MANIFEST="$HOST_DIR/${HOST_NAME}.json"
cat > "$MANIFEST" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Native Messaging Host for Open TTS",
  "path": "${SCRIPT_DIR}/backend/native_host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://*/"
  ]
}
EOF

# Make native host executable
chmod +x "$SCRIPT_DIR/backend/native_host.py"

echo "✅ Native host installed to:"
echo "   $MANIFEST"
echo ""
echo "   Python: $PYTHON"
echo "   Native host: $SCRIPT_DIR/backend/native_host.py"
echo ""
echo "Now load the extension in chrome://extensions (Developer mode → Load unpacked)"
