#!/usr/bin/env bats

load ./test_helper.bash

setup() {
  setup_mcplayer_test
  export MCPLAYER_NOTIFY_LOG="$MCPLAYER_TEST_TMP/notify.log"
  : > "$MCPLAYER_NOTIFY_LOG"

  create_stub terminal-notifier '
printf "%s\n" "terminal-notifier" >> "$MCPLAYER_NOTIFY_LOG"
for arg in "$@"; do
  printf "%s\n" "$arg" >> "$MCPLAYER_NOTIFY_LOG"
done
'

  create_stub osascript '
printf "%s\n" "osascript" >> "$MCPLAYER_NOTIFY_LOG"
for arg in "$@"; do
  printf "%s\n" "$arg" >> "$MCPLAYER_NOTIFY_LOG"
done
'
}

teardown() {
  teardown_mcplayer_test
}

@test "mcplayer notify uses terminal-notifier when available" {
  run env \
    PATH="$MCPLAYER_TEST_BIN:$PATH" \
    MCPLAYER_NOTIFY_TERMINAL_NOTIFIER_BIN="$MCPLAYER_TEST_BIN/terminal-notifier" \
    MCPLAYER_NOTIFY_OSASCRIPT_BIN="$MCPLAYER_TEST_BIN/osascript" \
    "$BATS_TEST_DIRNAME/../bin/mcplayer" \
    notify \
    --title "Build done" \
    --body "All green" \
    --subtitle "Phase 2" \
    --sound default \
    --open "https://example.com"

  [ "$status" -eq 0 ]
  grep -Fxq "terminal-notifier" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq -- "-title" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq "Build done" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq -- "-message" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq "All green" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq -- "-subtitle" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq "Phase 2" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq -- "-sound" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq "default" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq -- "-open" "$MCPLAYER_NOTIFY_LOG"
  grep -Fxq "https://example.com" "$MCPLAYER_NOTIFY_LOG"
}

@test "mcplayer notify falls back to osascript when terminal-notifier is unavailable" {
  run env \
    PATH="$MCPLAYER_TEST_BIN:$PATH" \
    MCPLAYER_NOTIFY_TERMINAL_NOTIFIER_BIN="$MCPLAYER_TEST_TMP/missing-terminal-notifier" \
    MCPLAYER_NOTIFY_OSASCRIPT_BIN="$MCPLAYER_TEST_BIN/osascript" \
    "$BATS_TEST_DIRNAME/../bin/mcplayer" \
    notify \
    --title "Fallback" \
    --body "Built in" \
    --sound Frog

  [ "$status" -eq 0 ]
  grep -Fxq "osascript" "$MCPLAYER_NOTIFY_LOG"
  grep -Fq 'display notification "Built in" with title "Fallback" sound name "Frog"' "$MCPLAYER_NOTIFY_LOG"
}

@test "mcplayer notify rejects click actions without terminal-notifier" {
  run bash -lc '
    env \
      PATH="'"$MCPLAYER_TEST_BIN"':$PATH" \
      MCPLAYER_NOTIFY_TERMINAL_NOTIFIER_BIN="'"$MCPLAYER_TEST_TMP"'/missing-terminal-notifier" \
      MCPLAYER_NOTIFY_OSASCRIPT_BIN="'"$MCPLAYER_TEST_BIN"'/osascript" \
      "'"$BATS_TEST_DIRNAME"'/../bin/mcplayer" \
      notify \
      --title "Needs click" \
      --body "Open this" \
      --open "https://example.com" \
      2>&1
  '

  [ "$status" -eq 1 ]
}
