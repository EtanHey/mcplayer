#!/usr/bin/env bats

load ./test_helper.bash

setup() {
  setup_mcplayer_test
  BRAINBAR_TEST_SOCKET="$MCPLAYER_TEST_TMP/mcplayer-brainbar.sock"
  BRAINBAR_TEST_SERVER_LOG="$MCPLAYER_TEST_TMP/mcplayer-brainbar-server.log"
  BRAINBAR_TEST_SERVER_STDERR="$MCPLAYER_TEST_TMP/mcplayer-brainbar-server.stderr.log"
  rm -f "$BRAINBAR_TEST_SOCKET" "$BRAINBAR_TEST_SERVER_LOG"
  BRAINBAR_TEST_SERVER_PID=""
}

teardown() {
  if [[ -n "$BRAINBAR_TEST_SERVER_PID" ]]; then
    kill "$BRAINBAR_TEST_SERVER_PID" >/dev/null 2>&1 || true
    wait "$BRAINBAR_TEST_SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$BRAINBAR_TEST_SOCKET"
  teardown_mcplayer_test
}

start_brainbar_server() {
  local mode="$1"
  local script_path="$MCPLAYER_TEST_TMP/brainbar-server.py"

  cat > "$script_path" <<'EOF_SERVER'
import os
import socket

socket_path = os.environ["BRAINBAR_TEST_SOCKET"]
mode = os.environ["BRAINBAR_TEST_SERVER_MODE"]
log_path = os.environ.get("MCPLAYER_TEST_SERVER_LOG", "")

def log(line):
    if not log_path:
        return
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"{line}\n")

if os.path.exists(socket_path):
    os.unlink(socket_path)

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen(1)
log(f"listening:{socket_path}")

conn, _ = server.accept()
log("open")

if mode == "remote-close":
    conn.close()
    server.close()
    raise SystemExit(0)

while True:
    data = conn.recv(4096)
    if not data:
        break
    log(f"data:{data.decode('utf-8', errors='replace')}")
    if mode in ("echo", "close-after-data"):
        conn.sendall(data)
    if mode == "close-after-data":
        break

conn.close()
server.close()
log("close")
EOF_SERVER

  (
    BRAINBAR_TEST_SOCKET="$BRAINBAR_TEST_SOCKET" \
    BRAINBAR_TEST_SERVER_MODE="$mode" \
    MCPLAYER_TEST_SERVER_LOG="$BRAINBAR_TEST_SERVER_LOG" \
    python3 "$script_path" >"$BRAINBAR_TEST_SERVER_STDERR" 2>&1
  ) &
  BRAINBAR_TEST_SERVER_PID=$!
  wait_for_brainbar_server "$BRAINBAR_TEST_SOCKET"
}

wait_for_brainbar_server() {
  local socket_path="$1"
  local deadline=$((SECONDS + 10))

  while (( SECONDS < deadline )); do
    if [[ -S "$socket_path" ]]; then
      return 0
    fi

    if [[ -n "$BRAINBAR_TEST_SERVER_PID" ]] && ! kill -0 "$BRAINBAR_TEST_SERVER_PID" >/dev/null 2>&1; then
      echo "brainbar test server exited before binding $socket_path" >&2
      [[ -f "$BRAINBAR_TEST_SERVER_STDERR" ]] && cat "$BRAINBAR_TEST_SERVER_STDERR" >&2
      return 1
    fi

    sleep 0.05
  done

  echo "timed out waiting for brainbar test server socket $socket_path" >&2
  [[ -f "$BRAINBAR_TEST_SERVER_STDERR" ]] && cat "$BRAINBAR_TEST_SERVER_STDERR" >&2
  return 1
}

@test "brainbar-adapter pipes stdin through unix socket to stdout" {
  start_brainbar_server echo

  run bash -c "( printf 'ping-stdio'; sleep 0.2 ) | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter"

  [ "$status" -eq 0 ]
  [ "$output" = "ping-stdio" ]
  grep -q "data:ping-stdio" "$BRAINBAR_TEST_SERVER_LOG"
}

@test "brainbar-adapter exits 1 when socket is missing" {
  # bash -c redirects stderr and stdout into bats's $output (combined stream).
  # We don't use `run --separate-stderr` (BATS 1.5+) because the combined check is sufficient here.
  run bash -c "printf 'orphan' | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter 2>&1"

  [ "$status" -eq 1 ]
  [[ "$output" == *"connect"* ]]
}

@test "brainbar-adapter closes socket on stdin EOF" {
  start_brainbar_server close-after-data

  run bash -c "( printf 'close-on-eof'; sleep 0.2 ) | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter"

  [ "$status" -eq 0 ]
  [ "$output" = "close-on-eof" ]
  grep -q "close" "$BRAINBAR_TEST_SERVER_LOG"
}

@test "brainbar-adapter exits 0 when socket closes remotely" {
  start_brainbar_server remote-close

  run bash -c ": | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter"

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
