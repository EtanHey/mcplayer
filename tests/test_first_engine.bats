#!/usr/bin/env bats

@test "D4 reference engine stacks on mcplayer and survives reset" {
  run bun run tests/contract/first-engine-real-execution.ts

  [ "$status" -eq 0 ]
  [[ "$output" == *"FIRST_ENGINE_STACKED engine=ref status_up→down→up replayed=1 socket=stable"* ]]
}
