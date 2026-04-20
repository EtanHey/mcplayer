#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.mcplayer.multiplexer.plist"
PLIST_LABEL="com.mcplayer.multiplexer"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${TARGET_DIR}/${PLIST_NAME}"
LAUNCH_DOMAIN="gui/$(id -u)"

launchctl bootout "${LAUNCH_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
rm -f "${TARGET_PLIST}"
echo "mcplayer daemon launch agent removed: ${TARGET_PLIST}"

