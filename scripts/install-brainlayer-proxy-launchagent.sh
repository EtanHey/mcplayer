#!/usr/bin/env bash
set -euo pipefail

# Install the always-on BrainLayer reverse-proxy LaunchAgent.
# This is the stable front door for agents; it does not repoint any .mcp.json.

PLIST_NAME="com.mcplayer.brainlayer-proxy.plist"
PLIST_LABEL="com.mcplayer.brainlayer-proxy"
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

tmp_plist="$(mktemp)"
trap 'rm -f "${tmp_plist}"' EXIT
sed "s|{{USER_HOME}}|${HOME}|g; s|{{REPO_ROOT}}|${REPO_ROOT}|g" "${SOURCE_PLIST}" > "${tmp_plist}"
mv -f "${tmp_plist}" "${TARGET_PLIST}"

launchctl bootout "${LAUNCH_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
launchctl bootstrap "${LAUNCH_DOMAIN}" "${TARGET_PLIST}"
launchctl enable "${LAUNCH_DOMAIN}/${PLIST_LABEL}"
echo "mcplayer BrainLayer proxy launch agent installed: ${TARGET_PLIST}"
echo "front: /tmp/mcplayer-brainlayer.sock  upstream: unix:/tmp/brainbar.sock"
