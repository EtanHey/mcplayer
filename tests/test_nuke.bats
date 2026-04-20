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

@test "mcplayer nuke defaults to dry-run and does not call kill" {
  run_mcplayer nuke

  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [[ "$output" == *"100"* ]]
  [[ ! -s "$MCPLAYER_KILL_LOG" ]]
}

@test "mcplayer nuke --dry-run works without --yes" {
  run_mcplayer nuke --dry-run

  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
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

@test "mcplayer nuke --yes continues when an early pid is already gone" {
  mark_pid_stale 100

  run_mcplayer nuke --yes

  [ "$status" -eq 0 ]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" == *"101"* ]]
  [[ "$(cat "$MCPLAYER_KILL_LOG")" == *"201"* ]]
}
