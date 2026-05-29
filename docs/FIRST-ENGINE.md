# Stack Your Engine On mcplayer

mcplayer is the stable client-facing socket in front of an engine process. The
engine may start slowly, reset, or crash. The mcplayer socket stays up, reports
engine health through `mcplayer.status`, and keeps durable pub/sub messages in
the WAL until subscribers can receive them.

D4 adds the first complete reference: `examples/engine/ref-engine.ts`.

## Reference Engine

The reference engine is intentionally small and real:

- It is a separate process.
- It writes a heartbeat file on an interval.
- It does not import private engine repos or services.
- It can be killed and restarted while clients keep the same mcplayer socket.

Start the reference engine:

```bash
export MCPLAYER_REF_ENGINE_HEARTBEAT=/tmp/mcplayer-ref-engine.heartbeat
bun run examples/engine/ref-engine.ts
```

Then start mcplayer against that heartbeat:

```bash
export MCPLAYER_SOCKET=/tmp/mcplayer-ref-engine.sock
export MCPLAYER_WAL=/tmp/mcplayer-ref-engine.wal
export MCPLAYER_ENGINE_HEARTBEAT_FILE=/tmp/mcplayer-ref-engine.heartbeat
mcplayer-server
```

`src/server/cli.ts` turns `MCPLAYER_ENGINE_HEARTBEAT_FILE` into a D3
`EngineSupervisor`. While the heartbeat file is fresh, `mcplayer.status` returns
`up`. If the engine stops writing the file, status becomes `not-up` after the
stale window, but `mcplayer.connect`, `mcplayer.status`, and WAL-backed
`mcplayer.publish` remain available on the same socket.

## Stack A Real Engine

To put your own engine behind mcplayer:

1. Pick a heartbeat file path owned by your engine.
2. Have the engine create the parent directory and write or touch the heartbeat
   file at a steady interval while it is healthy.
3. Start `mcplayer-server` with `MCPLAYER_ENGINE_HEARTBEAT_FILE` pointing at
   that heartbeat file.
4. Set `MCPLAYER_ENGINE_HEARTBEAT_STALE_MS` and
   `MCPLAYER_ENGINE_PROBE_INTERVAL_MS` if the defaults do not fit your startup
   and reset timing.
5. Keep clients pointed at `MCPLAYER_SOCKET`; they should not connect directly
   to the engine for the durable bus contract.

The heartbeat file is a health signal, not a data channel. Engine-specific APIs
can evolve independently behind the process boundary. mcplayer's stable surface
is still the JSON-RPC methods in `docs/PROTOCOL.md`.

## Reset Contract

The reference proof in `tests/contract/first-engine-real-execution.ts` executes
the full reset path:

1. Boot reference engine and mcplayer-server.
2. Wait for `mcplayer.status` to report `up`.
3. Subscribe and prove a live publish reaches the client.
4. `kill -9` the engine.
5. Prove the client socket stays connected and status becomes `not-up` or
   `building`.
6. Publish while the engine is down; the message is WAL-enqueued but not
   delivered early.
7. Restart the engine.
8. Prove status returns to `up` and the subscriber receives the queued message.

The required success marker is:

```text
FIRST_ENGINE_STACKED engine=ref status_up→down→up replayed=1 socket=stable
```

In that marker, `down` is shorthand for the reset phase where
`mcplayer.status` reports one of the protocol states `not-up` or `building`.
