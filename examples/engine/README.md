# mcplayer reference engine

This is a tiny real backing process for the D4 stacking proof. It represents the
engine side of the contract: while it is alive, it writes a heartbeat file on an
interval. `mcplayer-server` watches that file via `MCPLAYER_ENGINE_HEARTBEAT_FILE`
and reports `mcplayer.status` as `up` while the heartbeat is fresh.

Run it with:

```bash
export MCPLAYER_REF_ENGINE_HEARTBEAT=/tmp/mcplayer-ref-engine.heartbeat
bun run examples/engine/ref-engine.ts
```

Then start `mcplayer-server` in another shell with:

```bash
export MCPLAYER_ENGINE_HEARTBEAT_FILE=/tmp/mcplayer-ref-engine.heartbeat
mcplayer-server
```

Kill and restart the engine process to exercise the reset boundary. The
mcplayer socket remains the client-facing stable endpoint; only
`mcplayer.status` changes while the engine is gone.
