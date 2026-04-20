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

@test "mcplayer down prints the graceful shutdown order" {
  run_mcplayer down

  [ "$status" -eq 0 ]
  [[ "$output" == *"agents"* ]]
  [[ "$output" == *"mcp"* ]]
  [[ "$output" == *"brainbar"* ]]
}
