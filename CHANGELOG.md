# Changelog

## 0.3.0 — 2026-07-12

- **Roadmaps (the BYOK upgrade)**: with a key saved, every project's Plan tab
  becomes a generator — describe what you want to build, see the estimated
  cost before you click, and get back a phased roadmap where every task
  carries the AI model that should do it (Everyday — Haiku up to Frontier —
  Fable, plus a cross-check by Codex), a reason, and a size. The tab lists
  exactly what leaves the machine (project name, goal, redacted recent asks,
  file paths, top-level names — never file contents), shows the actual cost
  from usage afterwards, warns when new AI activity postdates the plan, and
  saves to `.membridge/plan.json`. One line — "Current roadmap: …" — is
  written into the shared memory block, so Claude Code and Codex see the
  plan too. (New: `POST /api/plan/generate`; structured-outputs request in
  `lib/advisor.js` with one retry and a 60s timeout.)
- **Settings + bring-your-own-key**: a gear in the header opens Settings —
  paste an Anthropic API key (stored only in `~/.membridge/config.json`,
  chmod 600, `ANTHROPIC_API_KEY` env honored as fallback) with a Test button
  that makes a single count_tokens request; pick the planner model in plain
  English (Fast & cheap ~1¢ / Smarter ~4¢ / Deepest ~6¢ per roadmap); and
  set the sync interval and context files, which used to require editing
  config by hand. Interval changes now apply without restarting the daemon.
  (New: `lib/advisor.js`, `GET/POST /api/settings`, `POST /api/settings/test`;
  the key is never sent to the dashboard page.)
- The project page's Plan tab now reads "Roadmap lives here" with a link to
  Settings — roadmaps themselves are the next milestone.
- **Project pages**: the Overview is now a clean projects grid (name, tool
  badges, last activity, paused state) and clicking a card opens a full
  project page — Activity (the complete ask-by-ask history with the files
  each ask touched), Memory (what gets injected where, a read-only view of
  the full memory log, pause/resume/delete), and a Plan tab that unlocks
  with an Anthropic API key once Settings ship. ✕, Esc and browser-back all
  exit. (New endpoints: `GET /api/project`, `GET /api/project/memory`.)
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
