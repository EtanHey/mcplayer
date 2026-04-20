#!/usr/bin/env bats

load ./test_helper.bash

PLIST_NAME="com.mcplayer.multiplexer.plist"
PLIST_LABEL="com.mcplayer.multiplexer"
SCRIPT_DIR="$BATS_TEST_DIRNAME/../scripts"
INSTALL_SCRIPT="$SCRIPT_DIR/install-launchagent.sh"
UNINSTALL_SCRIPT="$SCRIPT_DIR/uninstall-launchagent.sh"
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

@test "launchd plist validates with plutil -lint" {
  run plutil -lint "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [[ "$output" == *": OK" ]]
}

@test "install script is idempotent when run twice" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target
  plist_target="$(launchagent_path)"
  [ -f "$plist_target" ]
  cp "$plist_target" "$MCPLAYER_TEST_TMP/launchagent.before"

  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$plist_target" ]
  cmp -s "$MCPLAYER_TEST_TMP/launchagent.before" "$plist_target"

  uid="$(id -u)"
  bootout_count="$(grep -c "bootout gui/${uid}/${PLIST_LABEL}" "$MCPLAYER_LAUNCHCTL_LOG")"
  bootstrap_count="$(grep -c "bootstrap gui/${uid}" "$MCPLAYER_LAUNCHCTL_LOG")"
  [ "$bootout_count" -eq 2 ]
  [ "$bootstrap_count" -eq 2 ]
}

@test "install then uninstall leaves no launch agent trace" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target
  plist_target="$(launchagent_path)"
  [ -f "$plist_target" ]

  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$UNINSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -f "$plist_target" ]
}
