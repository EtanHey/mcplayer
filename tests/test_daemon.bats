#!/usr/bin/env bats

load ./test_helper.bash

setup() {
  export MCPLAYER_DAEMON_TEST_TMP
  MCPLAYER_DAEMON_TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcplayer-daemon-test.XXXXXX")"
  export MCPLAYER_DAEMON_SOCKET="$MCPLAYER_DAEMON_TEST_TMP/mcplayer.sock"
  export MCPLAYER_DAEMON_CONFIG="$MCPLAYER_DAEMON_TEST_TMP/config.json"
  export MCPLAYER_DAEMON_STDOUT="$MCPLAYER_DAEMON_TEST_TMP/daemon.stdout.log"
  export MCPLAYER_DAEMON_STDERR="$MCPLAYER_DAEMON_TEST_TMP/daemon.stderr.log"
  export MCPLAYER_UPSTREAM_LOG="$MCPLAYER_DAEMON_TEST_TMP/upstream.log"
  export MCPLAYER_STUB_UPSTREAM="$MCPLAYER_DAEMON_TEST_TMP/stub-upstream.py"
  export MCPLAYER_MCP_CLIENT="$MCPLAYER_DAEMON_TEST_TMP/mcp-client.py"
  export MCPLAYER_IDLE_CLIENT="$MCPLAYER_DAEMON_TEST_TMP/idle-client.py"
  export MCPLAYER_BRAINBAR_STUB="$MCPLAYER_DAEMON_TEST_TMP/brainbar-stub.py"
  export MCPLAYER_BRAINBAR_SOCKET="$MCPLAYER_DAEMON_TEST_TMP/brainbar.sock"
  export MCPLAYER_BRAINBAR_LOG="$MCPLAYER_DAEMON_TEST_TMP/brainbar.log"
  export MCPLAYER_DAEMON_PID=""
  export MCPLAYER_BRAINBAR_PID=""
  export MCPLAYER_CLIENT_A_OUT="$MCPLAYER_DAEMON_TEST_TMP/client-a.jsonl"
  export MCPLAYER_CLIENT_B_OUT="$MCPLAYER_DAEMON_TEST_TMP/client-b.jsonl"

  write_stub_upstream
  write_mcp_client
  write_idle_client
  write_brainbar_stub
  start_brainbar_stub
}

teardown() {
  stop_process "$MCPLAYER_DAEMON_PID"
  stop_process "$MCPLAYER_BRAINBAR_PID"
  rm -rf "${MCPLAYER_DAEMON_TEST_TMP:-}"
}

stop_process() {
  local pid="${1:-}"
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

write_stub_upstream() {
  cat > "$MCPLAYER_STUB_UPSTREAM" <<'EOF'
#!/usr/bin/env python3
import json
import os
import signal
import sys
import time

LOG_PATH = os.environ["MCPLAYER_UPSTREAM_LOG"]
TOOL_NAME = os.environ.get("MCPLAYER_TOOL_NAME", "unknown")

def log(kind, payload):
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind": kind, "tool": TOOL_NAME, "pid": os.getpid(), "payload": payload}, ensure_ascii=True) + "\n")

def write_message(payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

def read_message():
    headers = b""
    while b"\r\n\r\n" not in headers:
      chunk = sys.stdin.buffer.read(1)
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
    body = sys.stdin.buffer.read(content_length)
    if len(body) != content_length:
        raise RuntimeError("short read")
    return json.loads(body.decode("utf-8"))

def result_payload(message):
    args = message.get("params", {}).get("arguments", {})
    return {
        "content": [{"type": "text", "text": json.dumps(args, sort_keys=True)}],
        "structuredContent": {
            "pid": os.getpid(),
            "tool": TOOL_NAME,
            "args": args,
        },
    }

def handle_term(signum, frame):
    log("signal", {"signal": "TERM"})
    raise SystemExit(0)

signal.signal(signal.SIGTERM, handle_term)

log("start", {"argv": sys.argv[1:]})

while True:
    message = read_message()
    if message is None:
        break
    log("recv", message)
    method = message.get("method")
    if method == "initialize":
        write_message({
            "jsonrpc": "2.0",
            "id": message.get("id"),
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": f"stub-{TOOL_NAME}", "version": "1.0.0"},
            },
        })
        continue
    if method == "notifications/initialized":
        continue
    if method == "tools/call":
        name = message.get("params", {}).get("name", "")
        args = message.get("params", {}).get("arguments", {})
        if args.get("delayMs"):
            time.sleep(float(args["delayMs"]) / 1000.0)
        if name == "notify-all":
            write_message({
                "jsonrpc": "2.0",
                "method": "notifications/message",
                "params": {
                    "tool": TOOL_NAME,
                    "pid": os.getpid(),
                    "note": args.get("note", "fanout"),
                },
            })
        write_message({
            "jsonrpc": "2.0",
            "id": message.get("id"),
            "result": result_payload(message),
        })
        continue
    if message.get("id") is not None:
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "error": {"code": -32601, "message": f"unsupported method: {method}"},
        })

log("exit", {})
EOF
  chmod +x "$MCPLAYER_STUB_UPSTREAM"
}

write_mcp_client() {
  cat > "$MCPLAYER_MCP_CLIENT" <<'EOF'
#!/usr/bin/env python3
import json
import socket
import sys
import time

socket_path, target, scenario_path, output_path = sys.argv[1:5]
with open(scenario_path, "r", encoding="utf-8") as handle:
    scenario = json.load(handle)

def write_message(sock, payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    sock.sendall(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8") + body)

def read_message(sock):
    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = sock.recv(1)
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
        chunk = sock.recv(content_length - len(body))
        if not chunk:
            raise RuntimeError("short read")
        body += chunk
    return json.loads(body.decode("utf-8"))

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(socket_path)
sock.sendall(f"TARGET:{target}\n".encode("utf-8"))

for step in scenario.get("messages", []):
    if "sleep_ms" in step:
        time.sleep(step["sleep_ms"] / 1000.0)
    elif "send" in step:
        write_message(sock, step["send"])

received = []
receive_count = int(scenario.get("receive_count", 1))
idle_timeout_ms = int(scenario.get("idle_timeout_ms", 400))
deadline = time.time() + float(scenario.get("timeout_ms", 4000)) / 1000.0

while len(received) < receive_count and time.time() < deadline:
    sock.settimeout(idle_timeout_ms / 1000.0)
    try:
        message = read_message(sock)
    except socket.timeout:
        break
    if message is None:
        break
    received.append(message)

with open(output_path, "w", encoding="utf-8") as handle:
    for message in received:
        handle.write(json.dumps(message, ensure_ascii=True) + "\n")

sock.close()
EOF
  chmod +x "$MCPLAYER_MCP_CLIENT"
}

write_idle_client() {
  cat > "$MCPLAYER_IDLE_CLIENT" <<'EOF'
#!/usr/bin/env python3
import json
import socket
import sys
import time

socket_path, target, client_name, hold_open_ms = sys.argv[1:5]

def write_message(sock, payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    sock.sendall(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8") + body)

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(socket_path)
sock.sendall(f"TARGET:{target}\n".encode("utf-8"))
write_message(sock, {
    "jsonrpc": "2.0",
    "id": 90,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": client_name, "version": "1.0.0"},
    },
})
write_message(sock, {"jsonrpc": "2.0", "method": "notifications/initialized"})
time.sleep(float(hold_open_ms) / 1000.0)
sock.close()
EOF
  chmod +x "$MCPLAYER_IDLE_CLIENT"
}

write_brainbar_stub() {
  cat > "$MCPLAYER_BRAINBAR_STUB" <<'EOF'
#!/usr/bin/env python3
import json
import os
import socket
import sys

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
log({"kind": "brainbar-start"})

while True:
    conn, _ = server.accept()
    with conn:
        initialized = False
        while True:
            message = read_message(conn)
            if message is None:
                break
            log({"kind": "brainbar-recv", "message": message})
            if message.get("method") == "initialize":
                write_message(conn, {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "brainbar-stub", "version": "1.0.0"},
                    },
                })
                continue
            if message.get("method") == "notifications/initialized":
                initialized = True
                continue
            if initialized and message.get("method") == "tools/call":
                write_message(conn, {"jsonrpc": "2.0", "id": message.get("id"), "result": {"ok": True}})
                continue
EOF
  chmod +x "$MCPLAYER_BRAINBAR_STUB"
}

start_brainbar_stub() {
  env \
    MCPLAYER_BRAINBAR_SOCKET="$MCPLAYER_BRAINBAR_SOCKET" \
    MCPLAYER_BRAINBAR_LOG="$MCPLAYER_BRAINBAR_LOG" \
    python3 "$MCPLAYER_BRAINBAR_STUB" \
      >>"$MCPLAYER_DAEMON_TEST_TMP/brainbar.stdout.log" \
      2>>"$MCPLAYER_DAEMON_TEST_TMP/brainbar.stderr.log" &
  MCPLAYER_BRAINBAR_PID=$!
  wait_for_path "$MCPLAYER_BRAINBAR_SOCKET"
}

write_config() {
  cat > "$MCPLAYER_DAEMON_CONFIG" <<EOF
{
  "socketPath": "$MCPLAYER_DAEMON_SOCKET",
  "brainbarSocketPath": "$MCPLAYER_BRAINBAR_SOCKET",
  "servers": {
    "pooled": {
      "command": "python3",
      "args": ["$MCPLAYER_STUB_UPSTREAM"],
      "env": {
        "MCPLAYER_UPSTREAM_LOG": "$MCPLAYER_UPSTREAM_LOG",
        "MCPLAYER_TOOL_NAME": "pooled"
      }
    },
    "isolated": {
      "command": "python3",
      "args": ["$MCPLAYER_STUB_UPSTREAM"],
      "strictIsolation": true,
      "env": {
        "MCPLAYER_UPSTREAM_LOG": "$MCPLAYER_UPSTREAM_LOG",
        "MCPLAYER_TOOL_NAME": "isolated"
      }
    }
  }
}
EOF
}

start_daemon() {
  local -a extra_env=("$@")
  write_config

  local -a env_args=(
    "MCPLAYER_CONFIG_PATH=$MCPLAYER_DAEMON_CONFIG"
    "MCPLAYER_SOCKET_PATH=$MCPLAYER_DAEMON_SOCKET"
    "MCPLAYER_BRAINBAR_SOCKET_PATH=$MCPLAYER_BRAINBAR_SOCKET"
    "MCPLAYER_DISABLE_BRAINBAR_LOGS=0"
  )
  if (( ${#extra_env[@]} > 0 )); then
    env_args+=("${extra_env[@]}")
  fi

  env "${env_args[@]}" bun run src/index.ts \
    >>"$MCPLAYER_DAEMON_STDOUT" \
    2>>"$MCPLAYER_DAEMON_STDERR" &
  MCPLAYER_DAEMON_PID=$!
  wait_for_path "$MCPLAYER_DAEMON_SOCKET"
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

write_scenario() {
  local target="$1"
  local content="$2"
  printf '%s\n' "$content" > "$target"
}

json_value() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'EOF'
import json
import sys

path, expr = sys.argv[1:3]
with open(path, "r", encoding="utf-8") as handle:
    messages = [json.loads(line) for line in handle if line.strip()]

value = eval(expr, {"messages": messages})
if isinstance(value, (dict, list)):
    print(json.dumps(value, ensure_ascii=True))
else:
    print(value)
EOF
}

daemon_status_value() {
  local expr="$1"
  python3 - "$MCPLAYER_DAEMON_SOCKET" "$expr" <<'EOF'
import json
import socket
import sys

socket_path, expr = sys.argv[1:3]
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(socket_path)
sock.sendall(b"CONTROL:status\n")
payload = b""
while True:
    chunk = sock.recv(65536)
    if not chunk:
        break
    payload += chunk
sock.close()

status = json.loads(payload.decode("utf-8").strip())
value = eval(expr, {"status": status})
if isinstance(value, (dict, list)):
    print(json.dumps(value, ensure_ascii=True))
else:
    print(value)
EOF
}

@test "pooled daemon rewrites colliding ids and routes replies to the correct clients" {
  start_daemon

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/client-a.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "client-a", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"sleep_ms": 150},
    {"send": {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "echo", "arguments": {"client": "A", "delayMs": 150}}}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000
}'
  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/client-b.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "client-b", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"sleep_ms": 150},
    {"send": {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "echo", "arguments": {"client": "B", "delayMs": 150}}}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/client-a.json" "$MCPLAYER_CLIENT_A_OUT" &
  client_a_pid=$!
  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/client-b.json" "$MCPLAYER_CLIENT_B_OUT" &
  client_b_pid=$!

  wait "$client_a_pid"
  wait "$client_b_pid"

  [ "$(json_value "$MCPLAYER_CLIENT_A_OUT" 'messages[1]["id"]')" = "1" ]
  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[1]["id"]')" = "1" ]
  [[ "$(json_value "$MCPLAYER_CLIENT_A_OUT" 'messages[1]["result"]["structuredContent"]["args"]["client"]')" = "A" ]]
  [[ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[1]["result"]["structuredContent"]["args"]["client"]')" = "B" ]]
  [ "$(python3 - "$MCPLAYER_UPSTREAM_LOG" <<'EOF'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    entries = [json.loads(line) for line in handle if line.strip()]
starts = [entry for entry in entries if entry["kind"] == "start" and entry["tool"] == "pooled"]
print(len(starts))
EOF
)" = "1" ]
  python3 - "$MCPLAYER_UPSTREAM_LOG" <<'EOF'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    entries = [json.loads(line) for line in handle if line.strip()]

tool_call_ids = [
    entry["payload"]["id"]
    for entry in entries
    if entry["kind"] == "recv"
    and entry["payload"].get("method") == "tools/call"
]

assert len(tool_call_ids) == 2, tool_call_ids
assert tool_call_ids[0] != tool_call_ids[1], tool_call_ids
assert all(":::mcplayer:::1" in value for value in tool_call_ids), tool_call_ids
EOF
}

@test "pooled daemon broadcasts upstream notifications to every connected client" {
  start_daemon

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/listener.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 9, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "listener", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000,
  "idle_timeout_ms": 1500
}'
  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/emitter.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 9, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "emitter", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"sleep_ms": 150},
    {"send": {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "notify-all", "arguments": {"note": "fanout-check"}}}}
  ],
  "receive_count": 3,
  "timeout_ms": 4000,
  "idle_timeout_ms": 1500
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/listener.json" "$MCPLAYER_CLIENT_A_OUT" &
  listener_pid=$!
  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/emitter.json" "$MCPLAYER_CLIENT_B_OUT" &
  emitter_pid=$!

  wait "$listener_pid"
  wait "$emitter_pid"

  [ "$(json_value "$MCPLAYER_CLIENT_A_OUT" 'messages[1]["method"]')" = "notifications/message" ]
  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[1]["method"]')" = "notifications/message" ]
  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[2]["id"]')" = "7" ]
  [ "$(json_value "$MCPLAYER_CLIENT_A_OUT" 'messages[1]["params"]["note"]')" = "fanout-check" ]
}

@test "strictIsolation spawns a sidecar per client instead of sharing a pool" {
  start_daemon

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/strict-a.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "strict-a", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"send": {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "echo", "arguments": {"client": "strict-a"}}}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000
}'
  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/strict-b.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "strict-b", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"send": {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "echo", "arguments": {"client": "strict-b"}}}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" isolated "$MCPLAYER_DAEMON_TEST_TMP/strict-a.json" "$MCPLAYER_CLIENT_A_OUT"
  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" isolated "$MCPLAYER_DAEMON_TEST_TMP/strict-b.json" "$MCPLAYER_CLIENT_B_OUT"

  first_pid="$(json_value "$MCPLAYER_CLIENT_A_OUT" 'messages[1]["result"]["structuredContent"]["pid"]')"
  second_pid="$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[1]["result"]["structuredContent"]["pid"]')"

  [ "$first_pid" != "$second_pid" ]
  [ "$(python3 - "$MCPLAYER_UPSTREAM_LOG" <<'EOF'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    entries = [json.loads(line) for line in handle if line.strip()]
starts = [entry for entry in entries if entry["kind"] == "start" and entry["tool"] == "isolated"]
print(len(starts))
EOF
)" = "2" ]
}

@test "mcplayer daemon status reads pool state from the live daemon socket" {
  start_daemon

  run env MCPLAYER_SOCKET_PATH="$MCPLAYER_DAEMON_SOCKET" "$BATS_TEST_DIRNAME/../bin/mcplayer" daemon status

  [ "$status" -eq 0 ]
  [[ "$output" == *"mcplayer daemon status"* ]]
  [[ "$output" == *"\"pooled\""* ]]
  [[ "$output" == *"\"isolated\""* ]]
}

@test "SIGTERM reaps pooled children within five seconds" {
  start_daemon

  child_pid="$(python3 - "$MCPLAYER_UPSTREAM_LOG" <<'EOF'
import json
import sys
import time

deadline = time.time() + 5
while time.time() < deadline:
    try:
        with open(sys.argv[1], 'r', encoding='utf-8') as handle:
            entries = [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        time.sleep(0.1)
        continue
    starts = [entry for entry in entries if entry["kind"] == "start" and entry["tool"] == "pooled"]
    if starts:
        print(starts[0]["pid"])
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(1)
EOF
)"

  kill -TERM "$MCPLAYER_DAEMON_PID"
  wait "$MCPLAYER_DAEMON_PID" || true
  MCPLAYER_DAEMON_PID=""

  deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$child_pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  echo "Child process $child_pid was not reaped within five seconds" >&2
  return 1
}

@test "daemon retries socket writes when a test-forced backpressure event returns zero" {
  start_daemon "MCPLAYER_TEST_FORCE_SOCKET_WRITE_ZERO_ONCE=1"

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/backpressure.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 11, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "backpressure", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"send": {"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "echo", "arguments": {"client": "backpressure"}}}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/backpressure.json" "$MCPLAYER_CLIENT_A_OUT"

  [ "$(json_value "$MCPLAYER_CLIENT_A_OUT" 'messages[1]["result"]["structuredContent"]["args"]["client"]')" = "backpressure" ]
  grep -q '"event":"socket-backpressure"' "$MCPLAYER_DAEMON_STDOUT"
}

@test "failed client write does not drop a later multiplexed result for a healthy client" {
  start_daemon "MCPLAYER_TEST_FORCE_FIRST_CLIENT_WRITE_FAIL_ONCE=1"

  python3 "$MCPLAYER_IDLE_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled listener 1200 &
  listener_pid=$!
  sleep 0.2

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/emitter-after-write-failure.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 30, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "emitter", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"sleep_ms": 150},
    {"send": {"jsonrpc": "2.0", "id": 31, "method": "tools/call", "params": {"name": "notify-all", "arguments": {"note": "chain-survives"}}}}
  ],
  "receive_count": 3,
  "timeout_ms": 4000,
  "idle_timeout_ms": 1500
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/emitter-after-write-failure.json" "$MCPLAYER_CLIENT_B_OUT"
  wait "$listener_pid" || true

  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'len(messages)')" = "3" ]
  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[1]["method"]')" = "notifications/message" ]
  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[2]["id"]')" = "31" ]
  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[2]["result"]["structuredContent"]["args"]["note"]')" = "chain-survives" ]
  grep -q '"event":"client-write-failed"' "$MCPLAYER_DAEMON_STDOUT"
}

@test "daemon bounds sustained socket backpressure and recovers for later clients" {
  start_daemon \
    "MCPLAYER_TEST_FORCE_FIRST_CLIENT_WRITE_ZERO_ALWAYS=1" \
    "MCPLAYER_TEST_SOCKET_WRITE_MAX_RETRIES=5"

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/stuck-client.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 40, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "stuck", "version": "1.0.0"}}}}
  ],
  "receive_count": 1,
  "timeout_ms": 700,
  "idle_timeout_ms": 150
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/stuck-client.json" "$MCPLAYER_CLIENT_A_OUT"
  sleep 0.2

  grep -q '"event":"socket-backpressure-timeout"' "$MCPLAYER_DAEMON_STDOUT"
  [ "$(daemon_status_value 'status["clientCount"]')" = "1" ]

  write_scenario "$MCPLAYER_DAEMON_TEST_TMP/healthy-after-timeout.json" '{
  "messages": [
    {"send": {"jsonrpc": "2.0", "id": 41, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "healthy", "version": "1.0.0"}}}},
    {"send": {"jsonrpc": "2.0", "method": "notifications/initialized"}},
    {"send": {"jsonrpc": "2.0", "id": 42, "method": "tools/call", "params": {"name": "echo", "arguments": {"client": "healthy"}}}}
  ],
  "receive_count": 2,
  "timeout_ms": 4000
}'

  python3 "$MCPLAYER_MCP_CLIENT" "$MCPLAYER_DAEMON_SOCKET" pooled "$MCPLAYER_DAEMON_TEST_TMP/healthy-after-timeout.json" "$MCPLAYER_CLIENT_B_OUT"

  [ "$(json_value "$MCPLAYER_CLIENT_B_OUT" 'messages[1]["result"]["structuredContent"]["args"]["client"]')" = "healthy" ]
}
