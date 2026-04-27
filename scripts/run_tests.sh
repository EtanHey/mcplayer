#!/usr/bin/env bash
set -u

EXIT_STATUS=0
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_PATH="$REPO_ROOT/tests/fixtures/fanout_timeout_payload.json"

if [ ! -f "$FIXTURE_PATH" ]; then
  echo "mcplayer run_tests: missing fixture $FIXTURE_PATH"
  ((EXIT_STATUS |= 1))
elif command -v k6 >/dev/null 2>&1; then
  K6_SCRIPT_PATH="$(mktemp)"

  cat > "$K6_SCRIPT_PATH" <<'K6SCRIPT'
import { check, fail } from "k6";

const fixture = JSON.parse(open(__ENV.MCPLAYER_FANOUT_TIMEOUT_PAYLOAD));

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const isValid = check(fixture, {
    "fixture has 100 requests": () => fixture.requests.length === 100,
    "fixture timeout is 500ms": () => fixture.request_timeout_ms === 500,
    "fixture target exists": () => fixture.target === "fanout-timeout",
  });

  if (!isValid) {
    fail("phase-2d fixture contract check failed");
  }
}
K6SCRIPT

  if ! k6 run --quiet --env MCPLAYER_FANOUT_TIMEOUT_PAYLOAD="$FIXTURE_PATH" "$K6_SCRIPT_PATH"; then
    ((EXIT_STATUS |= 2))
  fi

  rm -f "$K6_SCRIPT_PATH"
else
  echo "k6 not found; using bun load-test substitute for fanout-timeout fixture"
  if ! bun test ./tests/integration/test_fanout_timeout.ts; then
    ((EXIT_STATUS |= 2))
  fi
fi

if ! bun test ./tests/integration/test_fanout_timeout.ts; then
  ((EXIT_STATUS |= 4))
fi

echo "mcplayer run_tests.sh finished with exit status $EXIT_STATUS"

if [ "$EXIT_STATUS" -ne 0 ]; then
  exit "$EXIT_STATUS"
fi
