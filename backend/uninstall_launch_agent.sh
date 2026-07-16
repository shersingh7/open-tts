#!/bin/bash
# Uninstall the Open TTS launch agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_NAME="com.open-tts.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Uninstalling Open TTS launch agent..."
UID_NUM="$(id -u)"

# Also clean up old naming convention (pre-migration)
OLD_PLIST_NAME="com.qwen-tts.server"
OLD_PLIST_PATH="$HOME/Library/LaunchAgents/$OLD_PLIST_NAME.plist"
if [ -f "$OLD_PLIST_PATH" ]; then
    launchctl bootout "gui/$UID_NUM/$OLD_PLIST_NAME" 2>/dev/null || \
      launchctl bootout "gui/$UID_NUM" "$OLD_PLIST_PATH" 2>/dev/null || true
    rm -f "$OLD_PLIST_PATH"
    echo "✓ Removed old launch agent ($OLD_PLIST_NAME)"
fi

# Stop and unload current
if [ -f "$PLIST_PATH" ]; then
    launchctl bootout "gui/$UID_NUM/$PLIST_NAME" 2>/dev/null || \
      launchctl bootout "gui/$UID_NUM" "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✓ Removed launch agent ($PLIST_NAME)"
fi

rm -f "$SCRIPT_DIR/stdout.log" "$SCRIPT_DIR/stderr.log"

echo "✓ Launch agent uninstalled"