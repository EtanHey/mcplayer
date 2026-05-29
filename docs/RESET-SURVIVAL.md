# mcplayer engine-reset survival (D3 — THE HEADLINE)

> The whole point of mcplayer: the local-MCP socket STAYS CONNECTED even when the backing
> engine (BrainLayer, VoiceLayer, …) resets or crashes. Clients never hang on engine startup and
> never reconnect by hand — you fix/wake the ENGINE, not the CONNECTION. mcplayer reports engine
> health (up/busy/building/not-up) on the still-live socket; durable messages (D1 WAL) replay when
> the engine returns.

## What "engine" means here
An engine is a backing service mcplayer fronts. mcplayer does NOT die with it. D2 already binds the
socket and serves the 5 methods off the WAL independent of any engine. D3 adds an **engine
supervisor** that tracks one engine's health and drives `status()`:
- `building` — engine is starting/restarting (warming up).
- `up` — engine healthy.
- `busy` — engine up but saturated (optional; may map to up+flag initially).
- `not-up` — no engine / engine down/crashed.

Health is observed without coupling the listener to the engine: e.g. a health probe (ping a health
endpoint / check a pid / check the engine's own socket) on an interval, plus explicit
`building→up` transition signals. Engine faults must surface as `status` changes, NEVER as a
dropped client connection or a crashed listener (two-plane A1).

## The invariant (acceptance — prove by REAL execution, not unit asserts)
1. **Socket survives engine reset.** A client `connect`ed to mcplayer stays connected across an
   engine kill+restart. No reconnect, no new socket, no client-visible disconnect.
2. **status reflects the engine live.** While the engine is down: `status → not-up`/`building`,
   answerable instantly on the still-connected socket (A1: never blocks on the engine). On
   recovery: `status → up`.
3. **Durable replay on recovery.** Messages `publish`ed (durable) while the engine was down are
   WAL-persisted (D1) and, when a subscriber is reading, delivered in order from its offset once
   the engine is back — at-least-once, no loss, no client action.
4. **connect never blocks on the engine.** A fresh `connect`/`status` succeeds even with `not-up`.

## Suggested shape (worker may refine)
- `src/server/engine.ts`: `EngineSupervisor` with `state()`, `markBuilding()/markUp()/markDown()`,
  and a pluggable health probe (interval). Server `status()` reads `EngineSupervisor.state()`.
- A way to attach an engine descriptor (cmd / health-probe / socket) — config or a `setEngine()`.
- Keep the queue/socket planes untouched; this is additive on the connection/status plane.

## Real-execution verification (REQUIRED before "done" — orc mandate)
Actually run it (capture literal stdout as PR evidence):
1. Boot mcplayer + attach a MOCK engine (a tiny process with a health signal). Client connects +
   subscribes. Assert `status → up`.
2. `kill -9` the engine. Assert: the CLIENT SOCKET IS STILL CONNECTED (same fd, no reconnect),
   `status → not-up`/`building`, and a `publish` during-down still returns `enqueued:true` (WAL).
3. Restart the engine. Assert `status → up` and the subscriber receives the during-down messages
   in order from its offset (replay). Print e.g. `ENGINE_RESET_SURVIVED socket=stable status=up replayed=N`.
4. Bonus: prove a SECOND client can `connect` while the engine is `building` (never blocks).
