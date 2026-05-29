# mcplayer WAL durable-queue (D1)

> Plane 2 of mcplayer (see docs/PROTOCOL.md). The durable queue that backs
> `mcplayer.publish/subscribe/ack`. WAL-persisted, at-least-once, per-channel
> ordered. Internal to mcplayer; not a client-facing API itself, but its
> guarantees ARE the contract publish/subscribe/ack expose to MCL/BrainLayer/VoiceLayer.

## Guarantees (acceptance — must be proven by a REAL execution test, not just unit asserts)

1. **Durability across restart.** A message appended (and not yet acked) is still
   present and replayable after the process is killed and restarted from the WAL on
   disk. RED→GREEN proof: append N msgs → `kill -9` the writer → reopen → all N replay.
2. **At-least-once delivery.** A message is delivered to a subscriber at least once;
   it is only removed from the WAL after an explicit `ack`. Unacked-at-crash ⇒ replayed.
3. **Per-channel FIFO ordering.** Within a channel, messages are delivered in append
   order. Offsets are **monotonic** per channel (strictly increasing, no reuse).
4. **Resume from offset.** `readFrom(channel, offset)` returns messages with
   `offset >= from` in order — survives both engine restart AND mcplayer restart.
5. **Idempotent append on `message_id`.** Re-appending an existing `(channel, message_id)`
   returns the existing offset; no duplicate is stored.
6. **Bounded WAL backpressure.** A configurable max (bytes or count) per channel/global;
   when full, `append` REJECTS with a typed `WalFullError` (→ surfaces as JSON-RPC
   `-32004` BUSY nack at the server layer). **NEVER silent drop-oldest.**
7. **ack purges / advances.** `ack(channel, message_id)` removes that message from the
   live WAL (or advances the consumer offset) so it is not replayed after the next restart.

## Suggested API (TypeScript, Bun) — worker may refine, keep guarantees intact

```ts
interface WalRecord { channel: string; message_id: string; payload: unknown; offset: number; }
class DurableQueue {
  constructor(opts: { path: string; maxBytesPerChannel?: number; maxRecordsPerChannel?: number });
  append(channel: string, message_id: string, payload: unknown): { offset: number };  // throws WalFullError
  readFrom(channel: string, fromOffset: number): WalRecord[];   // ordered, offset >= fromOffset
  ack(channel: string, message_id: string): boolean;
  close(): void;                 // flush + fsync
  static open(opts): DurableQueue; // crash-recovery: rebuild in-memory index from the on-disk WAL
}
```

## Implementation notes

- Persist with `fsync`-on-append durability (or SQLite WAL mode with busy_timeout, single
  writer). Crash-recovery = replay/scan the log to rebuild the per-channel offset index.
- The 0x0A-delimited NDJSON record format may reuse `src/protocol` encodeLine for on-disk lines;
  keep the on-disk format documented + versioned.
- Two-plane invariant (A1): a WAL fault must NOT break the connection/status plane — surface
  errors as typed exceptions the server maps to nacks, never crash the listener.

## Shipped D1 on-disk format

D1 uses a single append-only NDJSON file, one JSON record per `0x0A` line, encoded through
`src/protocol.encodeLine`. Every appended line includes `v: 1`; future incompatible changes must
use a new version number.

Append record:

```json
{"v":1,"type":"append","channel":"jobs","message_id":"m1","payload":{"n":1},"offset":1}
```

Ack record:

```json
{"v":1,"type":"ack","channel":"jobs","message_id":"m1"}
```

`DurableQueue.open()` scans the log from the start and rebuilds the live in-memory index:
`append` creates a replayable record unless the `(channel, message_id)` is already live, and `ack`
removes that live record. Per-channel `nextOffset` is rebuilt from the highest seen append offset,
so offsets are never reused after ack/restart.

Bounded-WAL options:

- `maxBytesPerChannel`: rejects a new live append when its encoded append record would exceed the
  per-channel live-byte cap. An append that exactly reaches the cap is accepted.
- `maxRecordsPerChannel`: rejects a new live append when the per-channel live-record count is at
  the cap.

Both caps reject with typed `WalFullError` and preserve existing live messages; D1 never drops the
oldest record to make space.

## D1 operational constraints

- `DurableQueue` is a single-writer, single-owner object. Do not call `close()` concurrently with
  `append()`, `readFrom()`, or `ack()` on the same instance.
- D1 does not compact the WAL file. Ack tombstones remain on disk so crash recovery can rebuild the
  live index correctly. A later phase can add snapshot/compaction once server wiring defines the
  operational lifecycle.
- Replay skips malformed version-1 entries that are missing required append/ack fields and ignores
  one trailing partial line, which is the expected artifact of a crash during a write.

## Real-execution verification (REQUIRED before "done" — orc mandate)

Not "tests pass" — actually run it:
1. Spin a DurableQueue on a temp path; append a batch; `kill -9` the process; reopen; assert full replay.
2. Prove at-least-once: deliver, crash before ack, restart, confirm redelivery; ack, restart, confirm NOT redelivered.
3. Bounded-WAL: fill to the cap, assert `append` throws `WalFullError` (no silent drop).
4. Capture the literal stdout / log of the kill→restart→replay run as evidence in the PR.
