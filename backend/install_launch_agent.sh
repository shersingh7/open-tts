#!/bin/bash
# Install launch agent for auto-starting the Open TTS server on login
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLIST_NAME="com.open-tts.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
PYTHON_BIN="$SCRIPT_DIR/venv/bin/python"

if [[ ! -f "$PYTHON_BIN" ]]; then
  echo "Error: venv python not found at $PYTHON_BIN — run ./setup.sh"
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/server.py" ]]; then
  echo "Error: server.py missing"
  exit 1
fi

AUTOSTART=false
for arg in "$@"; do
  case "$arg" in
    --auto-start) AUTOSTART=true ;;
    *) printf "Unknown option: %s\nUsage: %s [--auto-start]\n" "$arg" "$0" >&2; exit 2 ;;
  esac
done
UID_NUM="$(id -u)"
mkdir -p "$(dirname "$PLIST_PATH")"
OLD_PLIST="$HOME/Library/LaunchAgents/com.qwen-tts.server.plist"
if [[ -f "$OLD_PLIST" ]]; then
  launchctl bootout "gui/$UID_NUM" "$OLD_PLIST" 2>/dev/null || true
  rm -f "$OLD_PLIST"
fi

if [[ -f "$PLIST_PATH" ]]; then
  launchctl bootout "gui/$UID_NUM" "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$SCRIPT_DIR/server.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>RunAtLoad</key>
    <$AUTOSTART/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/stderr.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST_PATH" >/dev/null
launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"
if [[ "$AUTOSTART" == true ]]; then
  launchctl kickstart -k "gui/$UID_NUM/$PLIST_NAME"
fi
launchctl print "gui/$UID_NUM/$PLIST_NAME" >/dev/null

echo "✓ Launch agent installed (auto-start=$AUTOSTART): $PLIST_PATH"
echo "Stop: launchctl bootout gui/$UID_NUM $PLIST_PATH"