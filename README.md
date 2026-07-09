# MemBridge

**Shared memory across your AI coding tools.**

You ask Claude Code to build a feature. An hour later you open Codex in the same
project — and it has no idea what just happened. Every AI coding tool keeps its
own siloed history. MemBridge fixes that with a tiny background daemon that
watches all of them and keeps every tool briefed on what the others did.

```
Claude Code sessions ─┐                       ┌─> CLAUDE.md   (read by Claude Code)
Codex sessions ───────┼─> brief per-project ──┼─> AGENTS.md   (read by Codex & most agents)
any other tool ───────┘    "shared memory"    └─> GEMINI.md…  (configurable)
```

No accounts, no cloud, no API keys. Everything stays on your machine.

## How it works

Every major AI coding tool already does two convenient things:

1. **Writes session transcripts** to a known folder (`~/.claude/projects`, `~/.codex/sessions`, …)
2. **Reads a per-project context file** at startup (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …)

MemBridge connects the two. Every 60 seconds it incrementally reads whatever
was appended to the transcripts, distills a brief per-project memory (recent
asks + files the AIs touched), and injects it into each context file inside a
clearly-delimited block:

```markdown
<!-- membridge:begin -->
## Shared AI memory (MemBridge)

Recent asks across tools:
- 2026-07-09 10:00 · Claude Code: Build the login page with OAuth
- 2026-07-09 10:06 · Codex: Add unit tests for the login form

Files recently modified by AI tools: src/login.js
<!-- membridge:end -->
```

The rest of your file is never touched, and `membridge remove` strips the
blocks cleanly.

## Quick start

Requires Node.js 18+.

```bash
npm install -g membridge

membridge scan       # read-only: see what it found on your machine
membridge start      # run the background daemon
membridge dashboard  # open the local web dashboard
```

Optional: `membridge enable-autostart` makes it launch at login
(Startup folder on Windows, launchd on macOS, systemd user unit on Linux —
no admin rights needed).

## Commands

| Command | What it does |
| --- | --- |
| `membridge start` / `stop` / `status` | Manage the background daemon |
| `membridge dashboard` | Open the web UI at `http://127.0.0.1:7437` |
| `membridge sync [--dry-run] [--project <path>]` | One sync pass right now |
| `membridge scan` | Read-only report of discovered tools and projects |
| `membridge remove [--project <path>]` | Strip injected memory blocks |
| `membridge enable-autostart` / `disable-autostart` | Run at login |

## Configuration

`~/.membridge/config.json` (created on first run):

```jsonc
{
  "intervalSec": 60,                     // how often to sync
  "dashboardPort": 7437,
  "targets": ["CLAUDE.md", "AGENTS.md"], // add "GEMINI.md" etc.
  "exclude": ["C:\\work\\secret-project", "*archive*"],
  "redact": ["sk-[A-Za-z0-9_-]{8,}", "..."],  // scrubbed before injection
  "maxPrompts": 8,
  "maxFiles": 10,
  "adapters": {
    "claude-code": { "enabled": true },
    "codex": { "enabled": true },
    "custom": []
  }
}
```

To pause a single project you can also just drop an empty `.membridge-off`
file in its root, or click Pause in the dashboard.

### Adding any other tool (custom adapters)

If a tool logs its sessions as JSONL anywhere on disk, you can wire it up in
config — no code required:

```jsonc
"custom": [{
  "id": "mytool",
  "displayName": "MyTool",
  "dir": "/home/me/.mytool/sessions",
  "fields": {
    "project": "dir",        // dot-path to the project path on each line
    "timestamp": "when",     // dot-path to an ISO timestamp
    "text": "say",           // dot-path to the user's message
    "role": "who",           // optional filter field...
    "roleValue": "user"      // ...and required value
  }
}]
```

Dot-paths work for nested fields (`payload.cwd`). If the project path appears
only once per file (like Codex's `session_meta`), MemBridge carries it forward
automatically.

## Privacy and safety

- 100% local. The daemon binds to `127.0.0.1` only; nothing ever leaves your machine.
- Common secret shapes (`sk-…`, `AKIA…`, `ghp_…`, `key=value`) are redacted
  before anything is written into a context file; add your own patterns in config.
- Transcripts are only ever **read** (incrementally, by byte offset). The only
  files MemBridge writes are the configured context files, inside its own
  markers, plus its own state in `~/.membridge`.

## Development

```bash
node test/run-tests.js   # zero-dependency end-to-end suite (temp dirs only)
```

## Roadmap

- LLM-powered summaries (optional API key): richer memory in fewer lines
- First-class adapters for Gemini CLI, Cursor, opencode, Copilot CLI
- Team sync: share project memory across machines
- System tray app

## License

MIT
