#!/bin/bash
# Uninstall the Open TTS launch agent

set -e

PLIST_NAME="com.open-tts.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Uninstalling Open TTS launch agent..."

# Also clean up old naming convention (pre-migration)
OLD_PLIST_NAME="com.qwen-tts.server"
OLD_PLIST_PATH="$HOME/Library/LaunchAgents/$OLD_PLIST_NAME.plist"
if [ -f "$OLD_PLIST_PATH" ]; then
    launchctl unload "$OLD_PLIST_PATH" 2>/dev/null || true
    rm -f "$OLD_PLIST_PATH"
    echo "✓ Removed old launch agent ($OLD_PLIST_NAME)"
fi

# Stop and unload current
if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✓ Removed launch agent ($PLIST_NAME)"
fi

echo "✓ Launch agent uninstalled"