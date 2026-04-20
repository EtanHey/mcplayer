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

@test "mcplayer list groups MCP children under their agent pgid" {
  run_mcplayer list

  [ "$status" -eq 0 ]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"bun run /repo/cmuxlayer/src/index.ts"* ]]
  [[ "$output" == *"socat STDIO UNIX-CONNECT:/tmp/brainbar.sock"* ]]
}

@test "mcplayer list labels the BrainBar socket distinctly" {
  run_mcplayer list

  [ "$status" -eq 0 ]
  [[ "$output" == *"brainbar-socket [102]"* ]]
  [[ "$output" != *"BrainBar [102]"* ]]
}
