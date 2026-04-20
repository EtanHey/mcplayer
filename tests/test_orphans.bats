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

@test "mcplayer orphans shows only ppid=1 runtimes and their uptime" {
  run_mcplayer orphans

  [ "$status" -eq 0 ]
  [[ "$output" == *"200"* ]]
  [[ "$output" == *"201"* ]]
  [[ "$output" == *"00:05:00"* ]]
  [[ "$output" != *"100"* ]]
}
