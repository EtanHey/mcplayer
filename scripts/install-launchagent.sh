#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.mcplayer.multiplexer.plist"
PLIST_LABEL="com.mcplayer.multiplexer"
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
sed "s|{{USER_HOME}}|${HOME}|g" "${SOURCE_PLIST}" > "${tmp_plist}"
mv -f "${tmp_plist}" "${TARGET_PLIST}"

launchctl bootout "${LAUNCH_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
launchctl bootstrap "${LAUNCH_DOMAIN}" "${TARGET_PLIST}"
echo "mcplayer daemon launch agent installed: ${TARGET_PLIST}"
