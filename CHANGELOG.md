# Changelog

## 0.2.0 — 2026-07-10

- **Tray app**: MemBridge now runs as a macOS menu-bar app (dock-hidden) and
  Windows/Linux system-tray app. Status at a glance, open dashboard, sync now,
  pause, start at login, quit. Built with Electron; the CLI daemon is unchanged
  and the app takes over cleanly if the CLI daemon is already running.
- **Per-project memory database**: every AI update is recorded as a structured
  entry in `<project>/.membridge/memory.json` — what was asked, by which tool,
  and exactly which files it touched — rendered for humans and agents as
  `.membridge/memory.md`. The DB also maintains an index of the project's
  local files (path, size, mtime; ignore-aware, capped) so memory entries can
  point any other LLM at the right files.
- The injected context block now links to `.membridge/memory.md` for the full
  log; `membridge remove` also deletes the `.membridge` folder.
- macOS app builds (unsigned `.dmg` / `.zip`) are produced by CI on every
  release via the "Build app" workflow.

## 0.1.0 — 2026-07-09

Initial release.

- Background daemon syncing a brief per-project "shared AI memory" into
  `CLAUDE.md` / `AGENTS.md` (configurable targets)
- Adapters: Claude Code, Codex, plus a config-driven custom adapter for any
  JSONL-logging tool
- Incremental transcript reading (byte offsets, partial-write safe)
- Local web dashboard on `127.0.0.1:7437` (status, per-project memory,
  pause/resume, sync now)
- Secret redaction before injection; per-project exclude / `.membridge-off`
- `remove` command strips injected blocks cleanly
- Autostart at login on Windows, macOS, Linux (no admin required)
- Zero runtime dependencies; Node 18+; 20-check end-to-end test suite
