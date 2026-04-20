#!/usr/bin/env bats

load ./test_helper.bash

setup() {
  setup_mcplayer_test
  BRAINBAR_TEST_SOCKET="$MCPLAYER_TEST_TMP/mcplayer-brainbar.sock"
  BRAINBAR_TEST_SERVER_LOG="$MCPLAYER_TEST_TMP/mcplayer-brainbar-server.log"
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
    python3 "$script_path" >/tmp/mcplayer-brainbar-server-stderr.log 2>&1
  ) &
  BRAINBAR_TEST_SERVER_PID=$!
  sleep 0.2
}

@test "brainbar-adapter pipes stdin through unix socket to stdout" {
  start_brainbar_server echo

  run bash -c "printf 'ping-stdio' | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter"

  [ "$status" -eq 0 ]
  [ "$output" = "ping-stdio" ]
  grep -q "data:ping-stdio" "$BRAINBAR_TEST_SERVER_LOG"
}

@test "brainbar-adapter exits 1 when socket is missing" {
  run bash -c "printf 'orphan' | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter"

  [ "$status" -eq 1 ]
  [[ "$stderr" == *"connect"* ]] || [[ "$output" == *"connect"* ]]
}

@test "brainbar-adapter closes socket on stdin EOF" {
  start_brainbar_server close-after-data

  run bash -c "printf 'close-on-eof' | BRAINBAR_SOCKET_PATH='$BRAINBAR_TEST_SOCKET' '$BATS_TEST_DIRNAME'/../bin/brainbar-adapter"

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
