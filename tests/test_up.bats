#!/usr/bin/env bats

load ./test_helper.bash

setup() {
  setup_mcplayer_test
  fixture_default_processes
  set_brainbar_stopped
}

teardown() {
  teardown_mcplayer_test
}

@test "mcplayer up starts BrainBar when it is not running" {
  run_mcplayer up

  [ "$status" -eq 0 ]
  [[ -f "$MCPLAYER_BRAINBAR_PID_FILE" ]]
  [[ -s "$MCPLAYER_LAUNCHCTL_LOG" ]]
}
