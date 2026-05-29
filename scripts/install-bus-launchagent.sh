#!/usr/bin/env bash
set -euo pipefail

# Install the always-on mcplayer durable-bus LaunchAgent.
# This is the D2+ bus server (bin/mcplayer-server on /tmp/mcplayer-bus.sock),
# NOT the legacy multiplexer broker (com.mcplayer.multiplexer / src/index.ts).

PLIST_NAME="com.mcplayer.bus.plist"
PLIST_LABEL="com.mcplayer.bus"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_PLIST="${REPO_ROOT}/launchd/${PLIST_NAME}"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${TARGET_DIR}/${PLIST_NAME}"
LAUNCH_DOMAIN="gui/$(id -u)"

if [[ ! -f "${SOURCE_PLIST}" ]]; then
  echo "error: launch agent template missing: ${SOURCE_PLIST}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
# Pre-create the durable WAL directory (DurableQueue also creates it, but make
# the intent explicit and fail early on a permissions problem).
mkdir -p "${HOME}/Library/Application Support/mcplayer"

tmp_plist="$(mktemp)"
# Substitute both the home dir AND the actual repo root, so the LaunchAgent
# points at this checkout's bin/mcplayer-server regardless of where the repo
# lives (a clone elsewhere, or a worktree).
sed "s|{{USER_HOME}}|${HOME}|g; s|{{REPO_ROOT}}|${REPO_ROOT}|g" "${SOURCE_PLIST}" > "${tmp_plist}"
mv -f "${tmp_plist}" "${TARGET_PLIST}"

launchctl bootout "${LAUNCH_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
launchctl bootstrap "${LAUNCH_DOMAIN}" "${TARGET_PLIST}"
launchctl enable "${LAUNCH_DOMAIN}/${PLIST_LABEL}"
echo "mcplayer bus launch agent installed: ${TARGET_PLIST}"
echo "socket: /tmp/mcplayer-bus.sock  wal: ${HOME}/Library/Application Support/mcplayer/queue.wal"
