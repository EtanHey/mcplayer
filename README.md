# mcplayer

> MCP process lifecycle layer for local macOS multi-agent AI coding environments.

## Why

5+ concurrent AI coding agents (Claude Code, Codex CLI, Gemini CLI, Cursor) on a single Mac spawn **73+ MCP subprocesses** — each getting code-signed by `syspolicyd`. Aggregate CPU contention starves WindowServer → watchdog timeout → GUI crash. **3 Mac crashes in 48 hours** (measured 2026-04-20).

`mcplayer` consolidates this. One CLI to manage it all. Phase 2 adds a daemon that collapses N×M MCP processes to ~N+M.

## Status

- **Phase 1 (CLI)** — in progress. Ships today. Pure `zsh + ps + awk`, zero deps.
- **Phase 2 (daemon)** — architecture pending R01 research (Gemini Pro 3.1 Deep Research).
- **Phase 3 (MCP-as-MCP proxy)** — deferred.

## Install (Phase 1)

```bash
git clone git@github.com:EtanHey/mcplayer.git ~/Gits/mcplayer
ln -s ~/Gits/mcplayer/bin/mcplayer ~/bin/mcplayer
# Optional: alias panic='mcplayer nuke --yes && mcplayer up'
```

## Usage

```bash
mcplayer status      # one-screen dashboard: counts, load, syspolicyd %, ALARM if elevated
mcplayer list        # tree: each Claude/Codex → its MCP children
mcplayer orphans     # orphans only (ppid=1, agent-less)
mcplayer clean       # kill orphans (SAFE — only ppid=1 stuff). --dry-run default.
mcplayer nuke        # 🚨 PANIC BUTTON: kill ALL MCP+agent procs. --yes to confirm.
mcplayer up          # ensure brainbar daemon running + healthy
mcplayer down        # graceful shutdown: agents → MCPs → brainbar
```

## Architecture

See `docs.local/` and the orchestrator's research docs at `~/Gits/orchestrator/docs.local/claude-web/projects/mcplayer/`.

## License

MIT

## Install the daemon

To run the regression gate before every push, configure Git hooks once:

```bash
git config core.hooksPath .githooks
```

The durable bus runs as an always-on LaunchAgent (`com.mcplayer.bus` →
`bin/mcplayer-server` on `/tmp/mcplayer-bus.sock`). Install it with:

```bash
./scripts/install-bus-launchagent.sh
```

The script installs `launchd/com.mcplayer.bus.plist` into `~/Library/LaunchAgents`,
substitutes `{{USER_HOME}}` / `{{REPO_ROOT}}` in the plist template, and boots the
service in the GUI user launchd domain (auto-start at login, restart-on-crash). See
[docs/DAEMON.md](docs/DAEMON.md) for status/busy semantics and how to stack an engine.

To remove the LaunchAgent (the durable WAL is left intact):

```bash
./scripts/uninstall-bus-launchagent.sh
```

> The legacy Phase-2 multiplexer broker daemon (`com.mcplayer.multiplexer` →
> `src/index.ts` on `/tmp/mcplayer.sock`) was **retired** once the durable bus
> subsumed it (no live consumers). The broker code remains in `src/` pending the
> Phase-3 unified-proxy decision; only its always-on LaunchAgent deployment was
> removed.

Regression load tests require k6 for the fan-out timeout path:

```bash
brew install k6
# or
brew bundle
```
