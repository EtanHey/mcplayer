#!/usr/bin/env bash
set -u

EXIT_STATUS=0
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_PATH="$REPO_ROOT/tests/fixtures/fanout_timeout_payload.json"
TEMP_BASE="$(mktemp -d)"

run_k6_fanout_load() {
  local temp_dir
  local config_path
  local daemon_log
  local proxy_log
  local socket_path
  local daemon_pid
  local proxy_pid
  local proxy_url
  local bun_path
  local exit_code=0

  temp_dir="${TEMP_BASE}/p5c"
  config_path="$temp_dir/fanout-load-config.json"
  daemon_log="$temp_dir/daemon.log"
  proxy_log="$temp_dir/proxy.log"
  socket_path="/tmp/mcplayer-fanout-load.sock"
  bun_path="${BUN_BINARY:-$(command -v bun || true)}"
  if [[ -z "$bun_path" ]]; then
    bun_path="bun"
  fi
  rm -f "$socket_path"
  mkdir -p "$temp_dir"

  cat > "$config_path" <<JSON
{
  "socketPath": "$socket_path",
  "servers": {
    "fanout-timeout": {
      "command": "$bun_path",
      "args": ["run", "$REPO_ROOT/tests/integration/fanout-timeout-upstream.ts"],
      "env": {}
    }
  }
}
JSON

  MCPLAYER_CONFIG_PATH="$config_path" \
  MCPLAYER_DISABLE_BRAINBAR_LOGS="1" \
  MCPLAYER_SOCKET_PATH="$socket_path" \
  "$bun_path" run src/index.ts >"$daemon_log" 2>&1 &
  daemon_pid=$!

  for _ in $(seq 1 100); do
    if [[ -S "$socket_path" ]]; then
      break
    fi
    sleep 0.1
  done

  if ! kill -0 "$daemon_pid" >/dev/null 2>&1; then
    echo "mcplayer fanout load setup failed: daemon did not stay alive"
    cat "$daemon_log" >&2
    exit_code=1
  else
    MCPLAYER_SOCKET_PATH="$socket_path" \
    MCPLAYER_FANOUT_PROXY_PORT="0" \
    MCPLAYER_FANOUT_TARGET="fanout-timeout" \
    MCPLAYER_FANOUT_REQUEST_TIMEOUT_MS="500" \
    bun run tests/regression/fanout_load_proxy.ts >"$proxy_log" 2>&1 &
    proxy_pid=$!

    for _ in $(seq 1 100); do
      proxy_url="$(grep -m 1 "MCPLAYER_FANOUT_PROXY_URL=" "$proxy_log" | sed 's/MCPLAYER_FANOUT_PROXY_URL=//')"
      if [[ -n "$proxy_url" ]]; then
        break
      fi
      sleep 0.1
    done

    if [[ -z "$proxy_url" ]]; then
      echo "mcplayer fanout proxy did not start"
      cat "$proxy_log" >&2
      exit_code=1
    elif ! k6 run --quiet --no-summary --env MCPLAYER_FANOUT_TIMEOUT_PAYLOAD="$FIXTURE_PATH" --env MCPLAYER_FANOUT_PROXY_URL="$proxy_url" tests/regression/fanout_load.js; then
      exit_code=1
    fi
  fi

  if [[ -n "${daemon_pid:-}" ]] && kill -0 "$daemon_pid" >/dev/null 2>&1; then
    kill "$daemon_pid" >/dev/null 2>&1 || true
    wait "$daemon_pid" >/dev/null 2>&1 || true
  fi

  if [[ -n "${proxy_pid:-}" ]] && kill -0 "$proxy_pid" >/dev/null 2>&1; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi

  return "$exit_code"
}

if [ ! -f "$FIXTURE_PATH" ]; then
  echo "mcplayer run_tests: missing fixture $FIXTURE_PATH"
  ((EXIT_STATUS |= 1))
elif command -v k6 >/dev/null 2>&1; then
  if ! run_k6_fanout_load; then
    ((EXIT_STATUS |= 2))
  fi
else
  echo "k6 not found; using bun load-test substitute for fanout-timeout fixture"
  if ! bun test ./tests/integration/test_fanout_timeout.ts; then
    ((EXIT_STATUS |= 2))
  fi
fi

if ! bun test ./tests/integration/test_fanout_timeout.ts; then
  ((EXIT_STATUS |= 4))
fi

rm -rf "$TEMP_BASE"

echo "mcplayer run_tests.sh finished with exit status $EXIT_STATUS"

if [ "$EXIT_STATUS" -ne 0 ]; then
  exit "$EXIT_STATUS"
fi
