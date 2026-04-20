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

@test "mcplayer nuke requires --yes before killing anything" {
  run_mcplayer nuke

  [ "$status" -eq 2 ]
  [[ "$output" == *"requires --yes"* ]]
  [[ ! -s "$MCPLAYER_KILL_LOG" ]]
}

@test "mcplayer nuke --yes skips BrainBar by default" {
  run_mcplayer nuke --yes

  [ "$status" -eq 0 ]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" == *"100"* ]]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" != *"300"* ]]
}

@test "mcplayer nuke --yes --include-brainbar includes BrainBar" {
  run_mcplayer nuke --yes --include-brainbar

  [ "$status" -eq 0 ]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" == *"300"* ]]
}
