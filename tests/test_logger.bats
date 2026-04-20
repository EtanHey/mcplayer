#!/usr/bin/env bats

setup() {
  export MCPLAYER_LOGGER_TEST_TMP
  MCPLAYER_LOGGER_TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcplayer-logger-test.XXXXXX")"
  export MCPLAYER_BRAINBAR_STUB="$MCPLAYER_LOGGER_TEST_TMP/brainbar-stub.py"
  export MCPLAYER_BRAINBAR_SOCKET="$MCPLAYER_LOGGER_TEST_TMP/brainbar.sock"
  export MCPLAYER_BRAINBAR_LOG="$MCPLAYER_LOGGER_TEST_TMP/brainbar.log"
  export MCPLAYER_BRAINBAR_PID=""

  write_brainbar_stub
  start_brainbar_stub
}

teardown() {
  stop_process "$MCPLAYER_BRAINBAR_PID"
  rm -rf "${MCPLAYER_LOGGER_TEST_TMP:-}"
}

stop_process() {
  local pid="${1:-}"
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

wait_for_path() {
  local path="$1"
  local deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    if [[ -S "$path" || -e "$path" ]]; then
      return 0
    fi
    sleep 0.1
  done
  echo "timed out waiting for $path" >&2
  return 1
}

write_brainbar_stub() {
  cat > "$MCPLAYER_BRAINBAR_STUB" <<'PY'
#!/usr/bin/env python3
import json
import os
import socket
import threading
import time

socket_path = os.environ["MCPLAYER_BRAINBAR_SOCKET"]
log_path = os.environ["MCPLAYER_BRAINBAR_LOG"]


def log(payload):
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def read_message(conn):
    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = conn.recv(1)
        if not chunk:
            return None
        headers += chunk
    content_length = None
    for line in headers.decode("utf-8").split("\r\n"):
        if line.lower().startswith("content-length:"):
            content_length = int(line.split(":", 1)[1].strip())
            break
    if content_length is None:
        raise RuntimeError("missing Content-Length header")
    body = b""
    while len(body) < content_length:
        chunk = conn.recv(content_length - len(body))
        if not chunk:
            raise RuntimeError("short read")
        body += chunk
    return json.loads(body.decode("utf-8"))


def write_message(conn, payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    conn.sendall(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8") + body)


if os.path.exists(socket_path):
    os.unlink(socket_path)

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen(8)

connection_index = 0


def handle_client(conn, connection_number):
    with conn:
        while True:
            message = read_message(conn)
            if message is None:
                break
            log({"connection": connection_number, "message": message})
            if message.get("method") == "initialize":
                write_message(
                    conn,
                    {
                        "jsonrpc": "2.0",
                        "id": message.get("id"),
                        "result": {
                            "protocolVersion": "2025-03-26",
                            "capabilities": {"tools": {"listChanged": False}},
                            "serverInfo": {"name": "brainbar-stub", "version": "1.0.0"},
                        },
                    },
                )
                continue
            if message.get("method") == "notifications/initialized":
                continue
            if message.get("method") == "tools/call":
                if connection_number == 1:
                    time.sleep(1.0)
                    continue
                write_message(conn, {"jsonrpc": "2.0", "id": message.get("id"), "result": {"ok": True}})


while True:
    conn, _ = server.accept()
    connection_index += 1
    thread = threading.Thread(target=handle_client, args=(conn, connection_index), daemon=True)
    thread.start()
PY
  chmod +x "$MCPLAYER_BRAINBAR_STUB"
}

start_brainbar_stub() {
  env \
    MCPLAYER_BRAINBAR_SOCKET="$MCPLAYER_BRAINBAR_SOCKET" \
    MCPLAYER_BRAINBAR_LOG="$MCPLAYER_BRAINBAR_LOG" \
    python3 "$MCPLAYER_BRAINBAR_STUB" \
      >>"$MCPLAYER_LOGGER_TEST_TMP/brainbar.stdout.log" \
      2>>"$MCPLAYER_LOGGER_TEST_TMP/brainbar.stderr.log" &
  MCPLAYER_BRAINBAR_PID=$!
  wait_for_path "$MCPLAYER_BRAINBAR_SOCKET"
}

@test "logger recovers after a brainbar disconnect during tools/call" {
  run env MCPLAYER_BRAINBAR_SOCKET_PATH="$MCPLAYER_BRAINBAR_SOCKET" bun --cwd "$BATS_TEST_DIRNAME/.." --eval '
import net from "node:net";
import { defaultConfig } from "./src/config";
import { McplayerLogger } from "./src/logger";

const nativeSetTimeout = globalThis.setTimeout;
const nativeWrite = net.Socket.prototype.write;

globalThis.setTimeout = ((handler, timeout, ...args) => {
  if (timeout === 750) {
    return nativeSetTimeout(handler, 30, ...args);
  }
  return nativeSetTimeout(handler, timeout, ...args);
}) as typeof setTimeout;

let writeCount = 0;
net.Socket.prototype.write = function (...args) {
  writeCount += 1;
  const result = Reflect.apply(nativeWrite, this, args);
  if (writeCount === 2) {
    nativeSetTimeout(() => {
      this.emit("drain");
    }, 60);
    return false;
  }
  return result;
};

const config = defaultConfig();
config.brainbarSocketPath = process.env.MCPLAYER_BRAINBAR_SOCKET_PATH!;

const logger = new McplayerLogger(config);
logger.info("first-log", { step: 1 });
await new Promise((resolve) => setTimeout(resolve, 50));
logger.info("second-log", { step: 2 });
await new Promise((resolve) => setTimeout(resolve, 400));

net.Socket.prototype.write = nativeWrite;
globalThis.setTimeout = nativeSetTimeout;
'

  [ "$status" -eq 0 ]

  run python3 - "$MCPLAYER_BRAINBAR_LOG" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    messages = [json.loads(line) for line in handle if line.strip()]

tool_calls = [
    json.loads(entry["message"]["params"]["arguments"]["content"])
    for entry in messages
    if entry["message"].get("method") == "tools/call"
]

assert len(tool_calls) == 2, tool_calls
assert tool_calls[0]["event"] == "first-log", tool_calls
assert tool_calls[1]["event"] == "second-log", tool_calls
PY

  [ "$status" -eq 0 ]
}
