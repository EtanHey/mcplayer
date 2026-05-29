# Always-On Bus Daemon

The mcplayer durable bus (`bin/mcplayer-server`, the D2+ server on
`/tmp/mcplayer-bus.sock`) is meant to be a single, long-lived, local endpoint
that every layer stacks on. This document describes how it runs as an
always-on macOS LaunchAgent so layers can *depend* on it persistently instead
of each agent spawning its own throwaway MCP server (the per-session
proliferation that caused the RAM-freeze + DB-lock incidents).

> This is the **bus** daemon (`com.mcplayer.bus` → `bin/mcplayer-server`). It is
> distinct from the legacy Phase-2 multiplexer broker
> (`com.mcplayer.multiplexer` → `src/index.ts` on `/tmp/mcplayer.sock`).

## Install / uninstall

```bash
scripts/install-bus-launchagent.sh     # bootstrap + enable the LaunchAgent
scripts/uninstall-bus-launchagent.sh   # bootout + remove (WAL is left intact)
```

Install copies `launchd/com.mcplayer.bus.plist` into
`~/Library/LaunchAgents/`, substitutes `{{USER_HOME}}`, and
`launchctl bootstrap`s it into the `gui/<uid>` domain. It is idempotent.

## LaunchAgent semantics

| Key | Value | Why |
| --- | --- | --- |
| `RunAtLoad` | `true` | **Auto-start** — the bus is up at login without a manual launch. |
| `KeepAlive` | `{SuccessfulExit: false}` | **Restart-on-crash.** Any non-zero / signal exit is relaunched; a clean SIGTERM shutdown (`mcplayer down` / `launchctl bootout` → `exit 0`) stays down. |
| `ThrottleInterval` | `10` | Back off between respawns so a crash-loop can't hammer the machine. |
| `MCPLAYER_SOCKET` | `/tmp/mcplayer-bus.sock` | The stable client-facing socket every layer connects to. |
| `MCPLAYER_WAL` | `~/Library/Application Support/mcplayer/queue.wal` | **Durable** WAL — survives a reboot, not just a process restart (`/tmp` is cleared on reboot). |

A clean `kill -9` of the daemon is recovered automatically by launchd, and the
durable WAL means unacked messages are replayed to clients that reconnect after
the respawn. See the proof below.

## Status semantics (building / up / busy / not-up)

`mcplayer.status` reports the **engine** plane; the connection plane (connect /
status / WAL-backed publish) never blocks on it (two-plane A1).

- **`building`** — the engine has not yet reported healthy (initial state).
- **`up`** — the engine heartbeat is fresh.
- **`busy`** — the engine is up but signaling backpressure; **clients should
  back off rather than pile on** (the failure mode that took down BrainLayer:
  N writers vs. a write lock). Delivery still proceeds (`busy` is a delivering
  state) — `busy` is advisory, not a stop.
- **`not-up`** — the engine heartbeat is stale/absent. With *no* engine
  configured, the bus-only daemon reports `not-up` honestly (there is no engine
  yet); the bus plane still serves connect/publish/subscribe/ack.

### Content-aware heartbeat — how an engine declares `busy`

`MCPLAYER_ENGINE_HEARTBEAT_FILE` is polled by a heartbeat probe. The engine
keeps the file fresh (mtime within `MCPLAYER_ENGINE_HEARTBEAT_STALE_MS`) and may
write a **state token** as the first word of the file to declare its state:

```bash
echo up   > "$HEARTBEAT"   # healthy
echo busy > "$HEARTBEAT"   # up but overloaded -> clients back off
echo building > "$HEARTBEAT"
# a bare timestamp (or empty) is treated as a plain freshness signal => up
```

- Fresh + recognized token (`up`/`busy`/`building`/`not-up`) → that state.
- Fresh + tokenless (timestamp/empty) → `up` (backward-compatible).
- Stale / missing → `not-up`.

Tokens are trimmed and case-insensitive, and the engine may append detail after
the token (`busy draining 74k backlog`).

## Stacking an engine

To put a real engine behind the always-on bus, add its heartbeat to the
LaunchAgent's `EnvironmentVariables` (see `docs/FIRST-ENGINE.md` for the engine
side):

```xml
<key>MCPLAYER_ENGINE_HEARTBEAT_FILE</key>
<string>{{USER_HOME}}/Library/Application Support/mcplayer/engine.heartbeat</string>
```

The bus-only default plist ships **without** an engine heartbeat (the bus is the
always-on piece; engines stack on top).

## Real-execution proof

`tests/contract/daemon-keepalive-real-execution.ts` drives **real launchd**
with an isolated LaunchAgent (distinct label + temp socket/WAL/heartbeat — it
never touches the canonical `com.mcplayer.bus`, the multiplexer, or BrainBar):

1. Bootstrap the daemon; capture its launchd PID.
2. Publish a durable message and leave it unacked.
3. `kill -9` the daemon → prove launchd respawns it under a **new PID**.
4. Reconnect a fresh client → prove the durable WAL **replays** the unacked
   message from the respawned process.
5. Flip the heartbeat token → prove `status` goes `up → busy → up` live.

Required success marker:

```text
DAEMON_ALWAYS_ON_OK keepalive_restart=1 wal_replay=1 busy_state=1 socket=stable
```

Run it:

```bash
bun run tests/contract/daemon-keepalive-real-execution.ts
```
