#!/usr/bin/env bats

load ./test_helper.bash

setup() {
  setup_mcplayer_test
  fixture_default_processes
  set_brainbar_running
}

teardown() {
  teardown_mcplayer_test
}

@test "mcplayer clean defaults to dry-run and does not call kill" {
  run_mcplayer clean

  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [[ "$output" == *"200"* ]]
  [[ ! -s "$MCPLAYER_KILL_LOG" ]]
}

@test "mcplayer clean --yes kills orphan runtimes" {
  run_mcplayer clean --yes

  [ "$status" -eq 0 ]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" == *"200"* ]]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" == *"201"* ]]
}
