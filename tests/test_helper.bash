#!/usr/bin/env bash

setup_mcplayer_test() {
  export MCPLAYER_TEST_TMP
  MCPLAYER_TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcplayer-test.XXXXXX")"
  export MCPLAYER_TEST_BIN="$MCPLAYER_TEST_TMP/bin"
  export MCPLAYER_PS_FIXTURE="$MCPLAYER_TEST_TMP/ps.txt"
  export MCPLAYER_KILL_LOG="$MCPLAYER_TEST_TMP/kill.log"
  export MCPLAYER_STALE_PIDS_FILE="$MCPLAYER_TEST_TMP/stale-pids.txt"
  export MCPLAYER_LAUNCHCTL_LOG="$MCPLAYER_TEST_TMP/launchctl.log"
  export MCPLAYER_BRAINBAR_PID_FILE="$MCPLAYER_TEST_TMP/brainbar.pid"
  export MCPLAYER_LOAD_VALUE="{ 1.23 1.11 0.99 }"

  mkdir -p "$MCPLAYER_TEST_BIN"
  : > "$MCPLAYER_KILL_LOG"
  : > "$MCPLAYER_STALE_PIDS_FILE"
  : > "$MCPLAYER_LAUNCHCTL_LOG"

  create_stub ps '
cat "$MCPLAYER_PS_FIXTURE"
'

  create_stub pgrep '
if printf "%s\n" "$*" | grep -q "BrainBar"; then
  if [[ -f "$MCPLAYER_BRAINBAR_PID_FILE" ]]; then
    cat "$MCPLAYER_BRAINBAR_PID_FILE"
    exit 0
  fi
  exit 1
fi
exit 1
'

  create_stub kill '
is_stale_pid() {
  local target="$1"
  grep -Fxq "$target" "$MCPLAYER_STALE_PIDS_FILE"
}

if [[ "${1:-}" == "-0" ]]; then
  shift
  for arg in "$@"; do
    if is_stale_pid "$arg"; then
      exit 1
    fi
  done
  exit 0
fi

printf "%s\n" "$*" >> "$MCPLAYER_KILL_LOG"
for arg in "$@"; do
  if is_stale_pid "$arg"; then
    exit 1
  fi
  if [[ "$arg" == "300" ]]; then
    rm -f "$MCPLAYER_BRAINBAR_PID_FILE"
  fi
done
'

  create_stub launchctl '
printf "%s\n" "$*" >> "$MCPLAYER_LAUNCHCTL_LOG"
printf "300 BrainBar\n" > "$MCPLAYER_BRAINBAR_PID_FILE"
'

  create_stub sysctl '
if [[ "${1:-}" == "-n" && "${2:-}" == "vm.loadavg" ]]; then
  printf "%s\n" "$MCPLAYER_LOAD_VALUE"
  exit 0
fi
echo "unsupported sysctl args: $*" >&2
exit 1
'
}

teardown_mcplayer_test() {
  rm -rf "${MCPLAYER_TEST_TMP:-}"
}

create_stub() {
  local name="$1"
  local body="$2"
  local target="$MCPLAYER_TEST_BIN/$name"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'set -euo pipefail'
    printf '%s\n' "$body"
  } > "$target"
  chmod +x "$target"
}

fixture_default_processes() {
  cat > "$MCPLAYER_PS_FIXTURE" <<'EOF'
100 1 100 0.1 00:10:00 claude claude --agent coach
101 100 100 1.2 00:09:58 bun bun run /repo/cmuxlayer/src/index.ts
102 100 100 0.0 00:09:57 socat socat STDIO UNIX-CONNECT:/tmp/brainbar.sock
150 1 150 4.0 00:20:00 BrainBar /Applications/BrainBar.app/Contents/MacOS/BrainBar
200 1 200 2.4 00:05:00 bun bun run /repo/cmuxlayer/src/index.ts
201 1 201 0.7 00:04:10 node node /tmp/google-drive-mcp/index.js
250 1 250 18.0 00:30:00 syspolicyd /usr/libexec/syspolicyd
EOF
}

set_brainbar_running() {
  printf "300 BrainBar\n" > "$MCPLAYER_BRAINBAR_PID_FILE"
}

set_brainbar_stopped() {
  rm -f "$MCPLAYER_BRAINBAR_PID_FILE"
}

mark_pid_stale() {
  printf "%s\n" "$1" >> "$MCPLAYER_STALE_PIDS_FILE"
}

run_mcplayer() {
  run env PATH="$MCPLAYER_TEST_BIN:$PATH" "$BATS_TEST_DIRNAME/../bin/mcplayer" "$@"
}
