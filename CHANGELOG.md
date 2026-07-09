# Changelog

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
