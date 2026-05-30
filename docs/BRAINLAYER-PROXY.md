# BrainLayer reverse-proxy (Track B / L1)

mcplayer sits in front of BrainBar so agents connect to **one stable front socket**
instead of each binding the raw `/tmp/brainbar.sock` via `socat`. When BrainBar
restarts, each front client reconnects its own managed upstream independently.
Agent front connections never drop, so the whole fleet no longer reconnect-storms.
This is mcplayer's founding job ("stop agents from spawning their own socat
bridges").

## Why (the SPOF)

Every agent `.mcp.json` registers BrainLayer as
`{"command":"socat","args":["STDIO","UNIX-CONNECT:/tmp/brainbar.sock"]}` — a raw
per-agent bridge to `BrainBarD`. **22 repos** carry it. A BrainBar rebuild/restart
kills `/tmp/brainbar.sock` → every socat breaks at once → fleet-wide MCP drop,
silent degradation to vanilla LLM.

## Ground truth (audited in code — `BrainBarServer.swift`)

- **Framing is dual, auto-detected per client** (`:143-144`): newline-delimited
  JSON-RPC (Claude Code v2.1+ / MCP 2025-11-25) or Content-Length (LSP). Modern
  agents use **newline**; the proxy relays newline frames transparently both sides.
- **Session model is stateless for the mainline** (`:462-491`): `initialize`,
  `tools/list`, `tools/call`, and all `brain_*` go through `router.handle(request)`
  with **no per-connection "initialized?" gate**. So a fresh upstream connection
  answers immediately — **no `initialize` replay needed on reconnect.** (Verified
  live: a newline `initialize` to `/tmp/brainbar.sock` returns
  `serverInfo.name=brainbar`.)
- **Per-connection state exists only for subscriptions** (`brain_subscribe` /
  `watch-brain-bus` push). Most agents never subscribe (that's the BrainBar UI
  path). Re-subscribe-on-reconnect is the one stateful edge — tracked for a
  follow-up; the mainline request/response path is fully transparent.

## Design

```text
  agent .mcp.json: socat STDIO UNIX-CONNECT:/tmp/mcplayer-brainlayer.sock   (1-line change ×22)
         │  (N agents, N stable front connections)
         ▼
  BrainlayerProxy  (src/brainlayer-proxy)
    ├─ front: node:net UDS server on a stable path
    ├─ per front-client: a MANAGED upstream connection to BrainBar
    ├─ relay: bytes both ways (newline JSON-RPC passes through transparently)
    ├─ reconnect: on upstream close/error, reconnect with capped backoff
    │             WITHOUT tearing down the front connection
    └─ buffering: client bytes held while (re)connecting, flushed in order on
                  recovery — a request sent during the down window still lands
         │
         ▼
  BrainBar  upstream = unix:/tmp/brainbar.sock   (today)
                     | tcp:host:port             (Track-C two-Mac hub, same proxy)
```

### API

```ts
new BrainlayerProxy({
  frontSocketPath: "/tmp/mcplayer-brainlayer.sock",
  upstream: { kind: "unix", path: "/tmp/brainbar.sock" },  // | { kind: "tcp", host, port }
  reconnectDelayMs?: number,      // initial backoff, default 250
  maxReconnectDelayMs?: number,   // backoff ceiling, default 2000
})
await proxy.start();     // binds the front UDS
await proxy.shutdown();  // closes server + all connections
```

## Transport-pluggable upstream (the Track-C seam — built once)

The upstream target is `unix | tcp`. Relocating the BrainLayer engine to the M1 Pro
hub (Track C) is then a **config change** (`MCPLAYER_BRAINLAYER_UPSTREAM=tcp:host:port`
over Tailscale), not a proxy rewrite. P2 wires the env contract + a TCP functional
proof; this P0 layer already accepts a `tcp` upstream target.

## Verification

- `tests/contract/brainlayer-proxy.test.ts` — transparent relay (single +
  concurrent clients) and **reconnect-survival** against a fake BrainBar
  (request → kill upstream → restart → same client reconnects to the new instance).
- `tests/contract/brainlayer-proxy-real-execution.ts` — **FUNCTIONAL** proof
  against the **real** BrainBar via a disposable `socat` bridge (BrainBarD is never
  killed — hard rule #4). Marker:
  `PROXY_RECONNECT_SURVIVED front_stable=1 reconnected=1 brainbar=real`.

## Scope / what's next

- **This PR (P0.2 + P0.3):** the proxy core + reconnect-survival, fake + real
  functional proof. Not yet wired into agent `.mcp.json` (no live cutover here).
- **P1:** LOUD degradation while the upstream is down (never-silent) + bounded
  hold/retry semantics + the cutover of the 22 `.mcp.json` entries.
- **P2:** the `tcp` transport env contract + a network functional proof (Track C).
- **Subscriptions:** re-subscribe-on-reconnect (the one stateful edge).
