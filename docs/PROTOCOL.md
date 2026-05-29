# mcplayer durable-contract protocol (v0)

> The client-facing control/queue surface of mcplayer. Stable, co-signed with the MCL track
> (`metacomm`) — MCL builds against a mock of this; the mock→real swap must be zero-MCL-change.
> This is SEPARATE from the broker↔upstream-MCP proxy framing (which uses Content-Length/LSP
> framing per the MCP stdio spec). Clients of THIS surface use NDJSON + JSON-RPC 2.0.

## Why mcplayer

The backing engine (BrainLayer, VoiceLayer, …) may reset or crash. mcplayer keeps the **socket
connected** regardless and reports engine health (`up`/`busy`/`building`/`not-up`). Clients never
hang on engine startup and never reconnect by hand — you fix/wake the **engine**, not the
**connection**. Durable messages survive engine AND mcplayer restarts (WAL, at-least-once).

## Wire

- **Transport:** Unix Domain Socket. Default path `/tmp/mcplayer-bus.sock` (clients read it from
  config/env `MCPLAYER_SOCKET`, never hardcode).
- **Framing:** NDJSON — exactly one JSON value per line, messages separated by `\n`. Slice on `\n`.
- **RPC:** JSON-RPC 2.0, strict. A message **with** `id` is a Request and receives exactly one
  Response. A message **without** `id` is a Notification and the server MUST NOT respond.
- **Server→client push** (subscription delivery) is a JSON-RPC **Notification** `mcplayer.message`.

## Two planes (stability invariant A1)

- **Connection/status plane** — `connect`, `status`. MUST stay functional even if the queue plane
  faults or the engine is down. `connect` never blocks on engine availability; `status` is
  answerable while the engine is down.
- **Durable-queue plane** — `publish`, `subscribe`, `ack`. WAL-backed; a queue fault is contained
  and MUST NOT break the connection/status plane.

## Methods (the entire coupling surface)

### 1. `mcplayer.connect`
- params: `{ "client_id": string }`
- result: `{ "session_id": string }`
- Idempotent by `client_id`: reconnecting with the same id resumes the logical session. Session
  **survives engine resets**. Never blocks on engine availability.

### 2. `mcplayer.publish`
- params: `{ "channel": string, "message_id": string, "payload": any, "durable"?: boolean }`
- result: `{ "enqueued": true, "offset": number }`  **OR** error `-32004` (BUSY/backpressure)
- WAL-persisted, **at-least-once**. The ack is an **ENQUEUE** ack — NOT a delivery guarantee.
- **Idempotent on `message_id`** within a channel (re-publish returns the existing offset).
- **Bounded WAL:** when full, return the `-32004` BUSY nack — **NEVER silently drop-oldest.**
  Clients MUST handle the nack (surface backpressure, retry/DLQ).

### 3. `mcplayer.subscribe`
- params: `{ "channel": string, "from_offset"?: number }`
- result: ack `{ "subscribed": true }`, then a stream of Notifications:
  `mcplayer.message({ "channel", "message_id", "payload", "offset" })`
- **Per-channel ordering**; **monotonic offsets**. `from_offset` replays un-acked messages and
  resumes correctly after an **engine restart AND an mcplayer restart**.

### 4. `mcplayer.ack`
- params: `{ "channel": string, "message_id": string }`
- result: `{ "acked": true }`
- Purges the message from the WAL / advances the consumer offset.

### 5. `mcplayer.status`
- params: `{ "engine"?: string }`
- result: `{ "state": "up" | "busy" | "building" | "not-up", "since"?: string }`
- Reports **engine** health while the **socket stays connected**. Answerable while the engine is
  down. `building` = engine is starting; `busy` = engine up but saturated; `not-up` = no engine.

## Reserved error codes (pinned for cross-language parser stability)

| code | meaning |
|------|---------|
| `-32001` | unknown session |
| `-32002` | unknown channel |
| `-32003` | engine not-up |
| `-32004` | WAL-full / backpressure (BUSY nack) |

Standard JSON-RPC codes (`-32700` parse error, `-32600` invalid request, `-32601` method not
found, `-32602` invalid params, `-32603` internal error) apply otherwise.

## Versioning

This is v0. Any breaking change to a method signature or error code requires a coordinated bump
with the MCL track (`metacomm`) so the mock stays in sync.
