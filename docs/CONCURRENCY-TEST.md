# mcplayer N=10 concurrency / load proof (fleet-bus make-or-break)

> Etan: "would this work with 10 agents at the same time?" Being the shared bus for N concurrent
> agents IS mcplayer's reason to exist. Until this passes with literal numbers, "works at scale" is
> UNPROVEN — do NOT advertise the bus as fleet-ready.

## The test (real execution, not mocked)
Boot ONE real `mcplayer-server` on a temp socket + temp WAL. Drive **N=10 concurrent publishers +
10 concurrent subscribers** over the live UDS (separate connections), then assert:

- **(a) ZERO message loss** — every published message is received by its subscriber; receipts
  verified == messages sent. Report `sent=… received=… lost=…`.
- **(b) Per-channel ordering + correlation integrity** — within each channel, offsets/messages are
  delivered in publish order; no cross-channel bleed; each message correlates to its publisher.
  Report any reordering.
- **(c) NO WAL / lock-contention stall** under 10 concurrent writers — the run completes within a
  bounded time; no deadlock/hang. (This is the SAME failure mode that took BrainLayer down: 74K
  enrichment vs the write lock. Prove mcplayer's single-writer serialization (#runQueueOperation /
  WAL) does NOT stall under 10 writers.) Report wall-clock + that it terminated.
- **(d) Backpressure handled gracefully** — under burst beyond a bounded WAL cap, `publish` returns
  `-32004` BUSY nacks (NOT silent drop, NOT deadlock); after draining/acks, throughput resumes.
  Report nack count + that no message was silently lost.

## Report (literal — paste in PR)
- messages sent vs receipts verified (per channel + total), lost count, reordered count
- p50 / p99 publish→deliver latency
- wall-clock for the full run; confirmation it terminated (no stall)
- backpressure: nacks observed under burst + recovery confirmed

## Shape
- `tests/load/concurrency.ts` (or tests/contract/): a real harness that boots mcplayer-server,
  opens 10 client connections, fans out concurrent publish + subscribe, collects receipts, computes
  the metrics, and prints a single machine-greppable line, e.g.
  `CONCURRENCY_N10_OK sent=1000 received=1000 lost=0 reordered=0 p50_ms=… p99_ms=… nacks=… wall_ms=…`
- Add a `bun run test:load` script. Keep it deterministic enough to assert (seeded ids, fixed N).
- Do NOT weaken existing guarantees; this is additive (new test + maybe a small harness export).
