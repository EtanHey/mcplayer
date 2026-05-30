#!/usr/bin/env bash
set -euo pipefail

# Remove the always-on BrainLayer reverse-proxy LaunchAgent.

PLIST_NAME="com.mcplayer.brainlayer-proxy.plist"
PLIST_LABEL="com.mcplayer.brainlayer-proxy"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${TARGET_DIR}/${PLIST_NAME}"
LAUNCH_DOMAIN="gui/$(id -u)"

launchctl bootout "${LAUNCH_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
rm -f "${TARGET_PLIST}"
echo "mcplayer BrainLayer proxy launch agent removed: ${TARGET_PLIST}"
