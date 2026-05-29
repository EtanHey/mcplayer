#!/usr/bin/env bats

load ./test_helper.bash

PLIST_NAME="com.mcplayer.bus.plist"
PLIST_LABEL="com.mcplayer.bus"
SCRIPT_DIR="$BATS_TEST_DIRNAME/../scripts"
INSTALL_SCRIPT="$SCRIPT_DIR/install-bus-launchagent.sh"
UNINSTALL_SCRIPT="$SCRIPT_DIR/uninstall-bus-launchagent.sh"
PLIST_SOURCE="$BATS_TEST_DIRNAME/../launchd/$PLIST_NAME"

launchagent_path() {
  echo "$MCPLAYER_TEST_TMP/Library/LaunchAgents/$PLIST_NAME"
}

setup() {
  setup_mcplayer_test
  mkdir -p "$MCPLAYER_TEST_TMP/Library/LaunchAgents"

  create_stub launchctl '
printf "%s\n" "$*" >> "$MCPLAYER_LAUNCHCTL_LOG"
'
}

teardown() {
  teardown_mcplayer_test
}

@test "bus launchd plist validates with plutil -lint" {
  run plutil -lint "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [[ "$output" == *": OK" ]]
}

@test "bus plist runs the durable bus server, not the legacy multiplexer" {
  run plutil -extract ProgramArguments.1 raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [[ "$output" == *"bin/mcplayer-server" ]]
  [[ "$output" != *"src/index.ts" ]]
}

@test "bus plist auto-starts at load" {
  run plutil -extract RunAtLoad raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

@test "bus plist restarts on crash but stays down on a clean exit" {
  # KeepAlive => SuccessfulExit=false: relaunch on any non-zero/signal exit,
  # but a clean SIGTERM shutdown (exit 0) leaves it stopped.
  run plutil -extract KeepAlive.SuccessfulExit raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [ "$output" = "false" ]
}

@test "bus plist throttles respawns to avoid a crash-loop" {
  run plutil -extract ThrottleInterval raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

@test "bus plist pins the stable client-facing socket" {
  run plutil -extract EnvironmentVariables.MCPLAYER_SOCKET raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/mcplayer-bus.sock" ]
}

@test "bus plist points the WAL at durable storage, not /tmp" {
  run plutil -extract EnvironmentVariables.MCPLAYER_WAL raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Library/Application Support/mcplayer/"* ]]
  [[ "$output" != /tmp/* ]]
}

@test "bus install script is idempotent when run twice" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target
  plist_target="$(launchagent_path)"
  [ -f "$plist_target" ]
  cp "$plist_target" "$MCPLAYER_TEST_TMP/bus.before"

  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$plist_target" ]
  cmp -s "$MCPLAYER_TEST_TMP/bus.before" "$plist_target"

  uid="$(id -u)"
  bootout_count="$(grep -c "bootout gui/${uid}/${PLIST_LABEL}" "$MCPLAYER_LAUNCHCTL_LOG")"
  bootstrap_count="$(grep -c "bootstrap gui/${uid}" "$MCPLAYER_LAUNCHCTL_LOG")"
  [ "$bootout_count" -eq 2 ]
  [ "$bootstrap_count" -eq 2 ]
}

@test "bus install then uninstall leaves no launch agent trace" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target
  plist_target="$(launchagent_path)"
  [ -f "$plist_target" ]

  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$UNINSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -f "$plist_target" ]
}

@test "bus install substitutes the real repo root (no hardcoded path, no leftover placeholders)" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target repo_root
  plist_target="$(launchagent_path)"
  repo_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

  # No template placeholders survive into the installed plist.
  ! grep -q "{{" "$plist_target"
  # The binary path points at THIS checkout's bin/mcplayer-server.
  run plutil -extract ProgramArguments.1 raw "$plist_target"
  [ "$status" -eq 0 ]
  [ "$output" = "${repo_root}/bin/mcplayer-server" ]
}

@test "bus install creates the durable WAL directory" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ -d "$MCPLAYER_TEST_TMP/Library/Application Support/mcplayer" ]
}
