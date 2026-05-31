#!/usr/bin/env bats

@test "brainlayer proxy survives bridge restart and reports LOUD degradation with real BrainBar" {
  run bun run tests/contract/brainlayer-proxy-real-execution.ts

  [ "$status" -eq 0 ]
  [[ "$output" == *"PROXY_RECONNECT_SURVIVED front_stable=1 reconnected=1 brainbar=real"* ]]
  [[ "$output" == *"BRAINLAYER_DEGRADED_LOUD signalled=1 recovered=1 silent=0"* ]]
}
