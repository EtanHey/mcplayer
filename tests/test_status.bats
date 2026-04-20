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

@test "mcplayer status prints the dashboard headers" {
  run_mcplayer status

  [ "$status" -eq 0 ]
  [[ "$output" == *"MCP procs:"* ]]
  [[ "$output" == *"syspolicyd:"* ]]
  [[ "$output" == *"load:"* ]]
}
