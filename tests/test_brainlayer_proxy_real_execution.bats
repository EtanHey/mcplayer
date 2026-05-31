#!/usr/bin/env bats

@test "brainlayer proxy survives bridge restart and reports LOUD degradation with real BrainBar" {
  # LOCAL real-execution proof: drives a disposable socat bridge backed by the
  # REAL BrainBar on /tmp/brainbar.sock. CI runners have no BrainBar, so skip
  # there — the bun contract suite (brainlayer-proxy-p1b.test.ts) covers the same
  # degradation/timeout logic against fake upstreams and DOES run in CI. Skip is
  # explicit + visible in TAP output, never a silent pass.
  [ -S /tmp/brainbar.sock ] || skip "real BrainBar (/tmp/brainbar.sock) not present — local-only proof"

  run bun run tests/contract/brainlayer-proxy-real-execution.ts

  [ "$status" -eq 0 ]
  [[ "$output" == *"PROXY_RECONNECT_SURVIVED front_stable=1 reconnected=1 brainbar=real"* ]]
  [[ "$output" == *"BRAINLAYER_DEGRADED_LOUD signalled=1 recovered=1 silent=0"* ]]
}
