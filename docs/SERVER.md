# mcplayer server wiring (D2)

> Composes the two planes into the live UDS server that speaks the co-signed 5-method
> contract (docs/PROTOCOL.md) over NDJSON + JSON-RPC 2.0. This is the layer MCL,
> BrainLayer, and VoiceLayer actually connect to. D0 = protocol surface (src/protocol),
> D1 = durable queue (src/wal). D2 = the server that wires them onto a socket.

## The server (`src/server/`)

A Bun `Bun.listen({ unix })` server on `MCPLAYER_SOCKET` (default `/tmp/mcplayer-bus.sock`) that:
- Frames with the D0 NDJSON codec (`src/protocol` NdjsonDecoder/encodeLine).
- Dispatches JSON-RPC 2.0 requests to the 5 methods; ignores notifications per `classify`.
- Backs publish/subscribe/ack with the D1 `DurableQueue`.

### Method wiring (docs/PROTOCOL.md is the contract)
1. `connect({client_id})` → `{session_id}`. Idempotent by client_id; session survives engine
   resets. MUST NOT block on engine availability.
2. `publish({channel,message_id,payload,durable})` → `{enqueued:true,offset}` from
   `DurableQueue.append`; on `WalFullError` return JSON-RPC error **-32004** (BUSY nack).
3. `subscribe({channel,from_offset})` → ack `{subscribed:true}`, then stream
   `mcplayer.message` notifications (from `DurableQueue.readFrom`, in order) + live tail as new
   messages are published. Resumes from offset across engine AND mcplayer restart.
4. `ack({channel,message_id})` → `{acked:true}` via `DurableQueue.ack`.
5. `status({engine?})` → `{state:"up"|"busy"|"building"|"not-up",since?}`. Answerable while the
   engine is down. (Engine-health tracking can start as a simple registry; D3 deepens reset-survival.)

### Reserved errors (pinned): -32001 unknown session · -32002 unknown channel · -32003 engine not-up · -32004 WAL-full.

## Two-plane invariant (A1 — MUST hold)
The connection/status plane (accept loop, `connect`, `status`) MUST stay responsive even if the
queue plane faults: wrap queue calls so a `DurableQueue` error becomes a typed JSON-RPC error
(e.g. -32004 / -32603), never an unhandled throw that drops the listener. `connect`/`status` never
touch the WAL critical path.

## Socket lifecycle
- On boot: remove a stale socket file, `Bun.listen({unix: MCPLAYER_SOCKET})`, `chmod 0600`.
- Clean unlink on shutdown. A LaunchAgent plist (launchd/) keeps it alive (KeepAlive) — D2 may
  stub the plist; D3/lifecycle hardens it.
- This D2 message-bus socket is intentionally distinct from `/tmp/mcplayer.sock`, which is owned by
  the existing `src/broker.ts` Content-Length/LSP MCP proxy surface.

## CRITICAL — unblock MCL (orc directive)
When the server is listening, **post the socket path + the `MCPLAYER_SOCKET` value to
`GEN-10-MASTER-COLLAB.md` ## CROSS-TRACK with `@MCL`** — MCL (metacomlayer) is BLOCKED waiting on
exactly this for its live round-trip (mock→real swap). Include a one-line "how to connect" (UDS +
NDJSON + the 5 JSON-RPC methods, reads path from `MCPLAYER_SOCKET`).

## Real-execution verification (REQUIRED before "done")
Not "tests pass" — actually run the socket:
1. Boot the server; from a separate client process, `connect` → `publish` → `subscribe` → receive
   the `mcplayer.message` → `ack`. Paste the literal round-trip stdout.
2. Restart the server mid-session; confirm a `subscribe(from_offset)` replays un-acked messages
   (durability through D1 WAL) and the client did NOT have to reconnect by hand to a new socket.
3. `status` returns a valid state while no engine is attached.
Capture the literal stdout as PR evidence.

## Also sweep (from D1 review)
- Cursor LOW on src/wal: redundant `nextOffset` update after addRecord (src/wal/index.ts ~L167) —
  remove the redundant assignment.
