#!/usr/bin/env bats

load ./test_helper.bash

PLIST_NAME="com.mcplayer.brainlayer-proxy.plist"
PLIST_LABEL="com.mcplayer.brainlayer-proxy"
SCRIPT_DIR="$BATS_TEST_DIRNAME/../scripts"
INSTALL_SCRIPT="$SCRIPT_DIR/install-brainlayer-proxy-launchagent.sh"
UNINSTALL_SCRIPT="$SCRIPT_DIR/uninstall-brainlayer-proxy-launchagent.sh"
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

@test "brainlayer proxy launchd plist validates with plutil -lint" {
  run plutil -lint "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [[ "$output" == *": OK" ]]
}

@test "brainlayer proxy plist runs the proxy daemon entrypoint" {
  run plutil -extract ProgramArguments.1 raw "$PLIST_SOURCE"

  [ "$status" -eq 0 ]
  [[ "$output" == *"bin/mcplayer-brainlayer-proxy" ]]
}

@test "brainlayer proxy plist auto-starts and restarts on crash" {
  run plutil -extract RunAtLoad raw "$PLIST_SOURCE"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]

  run plutil -extract KeepAlive.SuccessfulExit raw "$PLIST_SOURCE"
  [ "$status" -eq 0 ]
  [ "$output" = "false" ]

  run plutil -extract ThrottleInterval raw "$PLIST_SOURCE"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

@test "brainlayer proxy plist pins the stable front and upstream env defaults" {
  run plutil -extract EnvironmentVariables.MCPLAYER_BRAINLAYER_FRONT raw "$PLIST_SOURCE"
  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/mcplayer-brainlayer.sock" ]

  run plutil -extract EnvironmentVariables.MCPLAYER_BRAINLAYER_UPSTREAM raw "$PLIST_SOURCE"
  [ "$status" -eq 0 ]
  [ "$output" = "unix:/tmp/brainbar.sock" ]
}

@test "brainlayer proxy install script is idempotent when run twice" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target
  plist_target="$(launchagent_path)"
  [ -f "$plist_target" ]
  cp "$plist_target" "$MCPLAYER_TEST_TMP/proxy.before"

  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$plist_target" ]
  cmp -s "$MCPLAYER_TEST_TMP/proxy.before" "$plist_target"

  uid="$(id -u)"
  bootout_count="$(grep -c "bootout gui/${uid}/${PLIST_LABEL}" "$MCPLAYER_LAUNCHCTL_LOG")"
  bootstrap_count="$(grep -c "bootstrap gui/${uid}" "$MCPLAYER_LAUNCHCTL_LOG")"
  [ "$bootout_count" -eq 2 ]
  [ "$bootstrap_count" -eq 2 ]
}

@test "brainlayer proxy install then uninstall leaves no launch agent trace" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target
  plist_target="$(launchagent_path)"
  [ -f "$plist_target" ]

  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$UNINSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -f "$plist_target" ]
}

@test "brainlayer proxy install substitutes the real repo root" {
  run env HOME="$MCPLAYER_TEST_TMP" PATH="$MCPLAYER_TEST_BIN:$PATH" "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  local plist_target repo_root
  plist_target="$(launchagent_path)"
  repo_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

  ! grep -q "{{" "$plist_target"
  run plutil -extract ProgramArguments.1 raw "$plist_target"
  [ "$status" -eq 0 ]
  [ "$output" = "${repo_root}/bin/mcplayer-brainlayer-proxy" ]
}
