# mcplayer — Repo Context

> `mcplayer` is the MCP process lifecycle layer. Phase 1 is a pure-zsh CLI (this file, `bin/mcplayer`). Phase 2 is a bun daemon. Phase 3 is a unified MCP-as-MCP proxy.

## Hard rules for this repo

1. **Phase 1 stays zsh-only.** No Node/bun/Python deps in the CLI. Must run on a bare macOS without any package manager installed. `bin/mcplayer` = `#!/usr/bin/env zsh`.
2. **Kill commands default to dry-run.** `clean` and `nuke` both require `--yes` to actually kill. Default output shows what would be killed.
3. **Never kill agent processes without `--yes`.** Killing a Claude/Codex agent loses session state. Be explicit.
4. **Never kill BrainBar.** BrainBar is the Swift menubar daemon at `/tmp/brainbar.sock`. Restarting it breaks every running agent. `mcplayer down` can stop it (graceful), but `mcplayer clean` and `mcplayer nuke` must skip it unless `--include-brainbar --yes` is passed.
5. **Tests in `tests/` use bats-core OR plain bash assertions.** No test framework dependency.
6. **PR Loop.** Every change goes through a PR. No direct commits to `master`. See `/pr-loop` skill.
7. **TDD.** Write a failing test first, then implement. See `/superpowers:test-driven-development`.

## Architecture (Phase 1)

```
~/Gits/mcplayer/
├── bin/mcplayer          # zsh CLI (executable)
├── src/                  # Phase 2 daemon (empty for now, src/index.ts stub)
├── tests/                # bats-core test files: test_status.bats, test_clean.bats, etc.
├── docs.local/           # plans, notes (gitignored)
├── README.md
├── CLAUDE.md             # this file
└── package.json          # Phase 2 metadata (bun daemon later)
```

## Relation to other *layer repos

- `~/Gits/brainlayer/` — memory MCP (BrainBar Swift app on `/tmp/brainbar.sock`). mcplayer's job is to stop agents from spawning their own socat bridges to it.
- `~/Gits/voicelayer/` — TTS/STT on `/tmp/voicelayer.sock`. Similar pattern.
- `~/Gits/cmuxlayer/` — terminal/agent management bun MCP. Phase 2 may absorb its MCP-spawning role.

## Who works on this

- **orcClaude** — orchestrates Phase 1 scaffold, Phase 2 after R01 research returns.
- **mcplayerCodex** — implements Phase 1 CLI and Phase 2 daemon (when launcher exists).
- **cmuxlayerCodex** — handles cmuxlayer integration in Phase 2.
- **brainlayerCodex** — drops the socat middleman in Phase 2.
- **voicelayerCodex** — adapter for Phase 2.

## Skills to invoke

- Creating a PR: `/pr-loop`
- Writing code: `/superpowers:test-driven-development`
- Claiming "done": `/superpowers:verification-before-completion`
- Dispatching agents: `/cmux-agents`
- 2+ agents same repo: `/worktrees`

## Baseline at start of repo (for posterity)

- 2026-04-20 — 73 MCP-related procs at 5 active agents, syspolicyd 54% CPU, 7 orphan bun procs (post-Phase 0 kill: 0), WindowServer watchdog crash at 02:01:35 IDT.
- macOS 26.3 (25D125) on MacBookPro18,3 (M1 Pro/Max 14"/16").
