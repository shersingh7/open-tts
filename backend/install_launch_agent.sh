#!/bin/bash
# Install launch agent for auto-starting the Open TTS server on login

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLIST_NAME="com.open-tts.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Installing Open TTS launch agent..."

# Unload old plist if it exists (migration from old name)
OLD_PLIST_NAME="com.qwen-tts.server"
OLD_PLIST_PATH="$HOME/Library/LaunchAgents/$OLD_PLIST_NAME.plist"
if [ -f "$OLD_PLIST_PATH" ]; then
    launchctl unload "$OLD_PLIST_PATH" 2>/dev/null || true
    rm "$OLD_PLIST_PATH"
    echo "✓ Removed old launch agent (com.qwen-tts.server)"
fi

# Unload current if exists
if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Create the plist file
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$SCRIPT_DIR/venv/bin/python</string>
        <string>server.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/stderr.log</string>
</dict>
</plist>
EOF

echo "✓ Created $PLIST_PATH"

# Load the launch agent
launchctl load "$PLIST_PATH" 2>/dev/null || true

echo "✓ Launch agent loaded"
echo ""
echo "The Open TTS server will start on login (but won't auto-restart if it crashes)."
echo "To start it now: launchctl start $PLIST_NAME"
echo "To stop it: launchctl stop $PLIST_NAME"
echo "To uninstall: ./uninstall_launch_agent.sh"