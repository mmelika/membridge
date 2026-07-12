# Changelog

## 0.4.0 — 2026-07-12

- **Team sync (beta)**: link a project to a team and every member's MemBridge
  pushes its redacted per-project memory entries to a shared Supabase backend
  (yours — run `supabase/schema.sql` in a free project) and pulls teammates'
  entries down. The injected context block gains a "Teammates' AI activity"
  section with author attribution, so your Claude Code knows what a
  teammate's Codex did. New commands: `team setup/create/join/link/unlink/
  list`, `signup`, `login`, `logout`. Invite-code joins; clones map to one
  project row via the normalized git remote (name fallback). Row-level
  security restricts every row to team members; only already-redacted digest
  entries ever leave the machine, and only for explicitly linked projects.
  Auth tokens live in `~/.membridge/credentials.json` (chmod 600). Team sync
  is best-effort on top of local sync: an unreachable backend never blocks
  local syncing. (New: `lib/teamsync.js`, `supabase/schema.sql`; the suite
  gains an offline mock Supabase and now has 60 checks.)

## 0.3.0 — 2026-07-12

- **Project pages**: the Overview is now a clean projects grid (name, tool
  badges, last activity, paused state) and clicking a card opens a full
  project page — Activity (the complete ask-by-ask history with the files
  each ask touched) and Memory (what gets injected where, a read-only view
  of the full memory log, pause/resume/delete). ✕, Esc and browser-back all
  exit. (New endpoints: `GET /api/project`, `GET /api/project/memory`.)
- **Neural map**: a second dashboard tab with a force-directed 3D map of
  every chat across every project, linked by shared files and TF-IDF idea
  similarity. Events now carry per-chat session ids (state v2 triggers a
  one-time full rescan from the transcripts). (New: `lib/graph.js`,
  `GET /api/graph`.)
- **Settings**: a gear in the header opens Settings — set the sync interval
  and context files, which used to require editing config by hand. Interval
  changes now apply without restarting the daemon. (New:
  `GET/POST /api/settings`.)
- **Copy for AI**: every project page has a Copy for AI button that puts a
  trimmed, redacted digest of recent AI activity on the clipboard, ready to
  paste into ChatGPT / claude.ai / any web AI that can't see your disk. The
  manual bridge until importers/MCP land. (New endpoint:
  `POST /api/projects/copy`.)
- Fix: a fast `stop` → `start` could leave the new daemon running with a dead
  dashboard when the port was still held by the dying process. The dashboard
  now retries the bind (EADDRINUSE) for up to ~10s before giving up, and says
  so in the log if it does.

## 0.2.1 — 2026-07-10

- Fix: macOS build was reported as "damaged" and refused to launch on
  Apple Silicon. Root cause: the app had zero code signature, and arm64
  Gatekeeper reports fully unsigned apps as damaged instead of the usual
  unidentified-developer warning. The build now ad-hoc signs the app
  bundle after packaging (`scripts/afterPack.js`). Still unsigned by a
  real Apple Developer certificate, so first launch needs right-click > Open.

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
