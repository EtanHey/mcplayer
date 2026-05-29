#!/usr/bin/env bash
set -euo pipefail

# Remove the always-on mcplayer durable-bus LaunchAgent.
# The durable WAL under Application Support is left intact (uninstalling the
# daemon must not destroy queued, unacked messages).

PLIST_NAME="com.mcplayer.bus.plist"
PLIST_LABEL="com.mcplayer.bus"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${TARGET_DIR}/${PLIST_NAME}"
LAUNCH_DOMAIN="gui/$(id -u)"

launchctl bootout "${LAUNCH_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
rm -f "${TARGET_PLIST}"
echo "mcplayer bus launch agent removed: ${TARGET_PLIST}"
echo "note: durable WAL at ${HOME}/Library/Application Support/mcplayer/queue.wal left intact"
