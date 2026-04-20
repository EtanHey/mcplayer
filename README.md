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
