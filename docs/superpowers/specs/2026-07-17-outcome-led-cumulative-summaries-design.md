# Outcome-Led Cumulative Session Summaries

**Date:** 2026-07-17
**Status:** Approved design
**Builds on:** [2026-07-15-summary-quality-and-attribution-design.md](2026-07-15-summary-quality-and-attribution-design.md) (Part A distillation),
[2026-07-16-session-runs-and-threads-design.md](2026-07-16-session-runs-and-threads-design.md) (Stage 3 run cards)

## Principle

A card should answer "what changed in our shared project reality?", not
"what did the AI touch?". Files, commits, and chats are evidence; the unit
of meaning is the outcome a teammate would experience.

## Problem

Distilled checkpoint lines are **deltas**: the first line summarizes the
session so far, each later line covers only work since the previous one
(`blockReason`, lib/hooks.js). But every render surface — the session
widget, the session page, the catch-up digest, the CLAUDE.md `Did:` sync —
picks the **newest** distilled line as the headline (dashboard.js rep
selection; `digest.pickSummary`). So a long session's card headlines its
last increment ("fixed the test flake"), not the session's outcome. The
lines are also phrased as AI activity ("edited lib/feed.js"), not as a
change to the project.

Delivery is also intrusive: the blocked summary turn narrates itself
("Summary line appended…"), and on default permission modes the raw shell
append can raise a permission dialog — the user actively waits on, or
answers to, bookkeeping they never asked to see.

## Design

Two seams change: the Stop-hook prompt (`blockReason` in lib/hooks.js)
gets outcome-led cumulative content, and the delivery of the summary turn
becomes discreet (one auto-approved tool call, no narration). The rest of
the pipeline — storage, merge, render, team sync — moves not at all.

### 1. Outcome phrasing (all checkpoints)

`did` becomes 1–3 sentences on what changed in the project as a teammate
would experience it — "Catch-up cards now group related sessions into one
unit" — never a recital of files edited or tools run. `goal` stays the
user's ask. `decisions` and `gotchas` keep their meaning, scoped to the
whole session.

### 2. Cumulative scope (later checkpoints, n > 0)

Replace "cover ONLY the work done since your previous summary line" with:
write a fresh line summarizing the **whole session so far** — it
supersedes your earlier lines for this session; append only, never modify
existing lines.

### 3. Discreet delivery

The blocked summary turn must feel like nothing happened: no prose, no
permission dialog, one quiet tool row. Two parts:

**No commentary.** `blockReason` additionally instructs: execute exactly
ONE tool call; no commentary before or after; do not restate the summary
in the reply. The visible turn shrinks to a single command row; the only
irreducible time is generating the JSON line itself.

**A canonical, allowlistable append command.** Raw shell appends cannot be
narrowly auto-approved (Bash permission rules are prefix-matched; the
target path sits at the end) — so on default permission modes the summary
turn can degrade into a permission dialog, worse than the wait it
replaces. Instead:

- `membridge-hook.js` gains an argv-dispatched `append` mode:
  `<node> <membridge-hook.js> append <summaries-path> '<json-line>'`.
  It validates before writing — JSON parses; `session` and `did` are
  non-empty strings; the target path ends in `.membridge/summaries.jsonl`
  — creates the directory, and appends one line. Invalid input exits
  non-zero with a one-line stderr message so the agent can correct and
  retry; nothing is written. No argv → `runStop()` exactly as today.
- `blockReason` names that exact command instead of "append a line of
  JSON to <file>". This also removes the shell-quoting hazards of
  hand-built appends (summaries containing quotes currently risk
  mangling) and rejects malformed lines at write time instead of
  silently skipping them at scan time.
- `setup-hooks` installs, alongside the Stop hook, one narrow
  `permissions.allow` prefix rule for that command in
  ~/.claude/settings.json; `remove-hooks` removes it. Same discipline as
  the hook entries: never touch user rules. Removal matches only
  MemBridge's own append rule (a rule mentioning both 'membridge' and
  'append'), not any rule that merely contains 'membridge', so a user rule
  under a Membridge-named path survives. The allowlisted surface stays
  narrow by two
  mechanisms together: `runAppend` validates its input (well-formed line,
  a real `.membridge/summaries.jsonl` target), so a matched call can only
  append a summary line; and Claude Code evaluates compound shell commands
  per-segment, so trailing shell operators after a matched `append …`
  prefix (`&& …`, `; …`, pipes) are not covered by the rule and still
  require approval. The prefix rule is narrow because of these two
  properties, not merely because of the prefix string.

### Why nothing else changes

- **Storage:** summaries.jsonl stays append-only; a session's lines become
  successive whole-session snapshots instead of increments. No schema
  field, no migration — old delta-shaped lines render exactly as today,
  new sessions are cumulative from their next checkpoint.
- **Merge:** scan.js `scanSummaries` already carries `did`/`goal`/
  `decisions`/`gotchas`/`highlights` per line. Unchanged.
- **Render:** every surface already implements newest-wins (newest
  distilled line beats older and beats harvested). The cumulative line
  lands as the headline automatically; older snapshots remain in the
  expanded history as a natural progress log.
- **Team sync:** teammates' surfaces use the same pick. Unchanged.

### Cadence (unchanged, deliberate)

Edit-gated: first checkpoint at `minEdits` (default 1) edits, another
every `checkpointEvery` (default 4) edits. Gating on edits — not prompts —
is the admission principle itself: a stretch of pure Q&A changes nothing
in shared reality and produces no update.

## Cost

The summarizer is the session's own agent via the Stop hook — MemBridge
spends no API tokens. Per checkpoint: input is a warm prompt-cache read of
the session plus the ~250-token instruction; output is one short turn
writing one JSON line. Cumulative lines add ~100–200 output tokens over
deltas. Order of magnitude: ~2–3¢ API-equivalent per checkpoint at 100K
context on Sonnet-class pricing; on a Claude subscription, a sliver of
quota. The expensive alternative — daemon-side BYOK re-summarization (no
cache, digest re-fed per update, metered key) — is deliberately avoided.

## Error handling

The stop path is unchanged: it fails open (any internal error logs and
allows the stop). Malformed lines are skipped by `countSummaryLines` and
`scanSummaries` exactly as today. The `append` mode is the one deliberate
exception: it is agent-facing, not stop-blocking, so it fails loudly —
invalid input exits non-zero with a one-line stderr message and writes
nothing, letting the agent correct and retry within its summary turn.

## Testing

Custom harness (test/run-tests.js), per seam:

`blockReason`:
- n = 0: instruction asks for outcome-phrased `did` (what-changed-in-the-
  project wording present; no file-list phrasing requested).
- n > 0: instruction asks for a whole-session-so-far line that supersedes
  earlier lines, and still forbids modifying existing lines.
- Both variants name the canonical `append` command and the no-commentary
  instruction.

`append` mode:
- Valid line → appended verbatim (one line, newline-terminated), directory
  created when missing, exit 0.
- Invalid JSON / empty `session` or `did` / target path not ending in
  `.membridge/summaries.jsonl` → exit non-zero, stderr message, file
  untouched.

`setup-hooks` / `remove-hooks`:
- setup installs the allow rule alongside the hook; remove deletes both;
  user-owned permission entries are never touched; re-running setup is
  idempotent and upgrades a stale command path in the rule.

Existing gate/count/merge tests unchanged and stay green.

## Out of scope (YAGNI)

- Fully silent generation via a background/daemon-run headless distiller
  (`claude -p` over transcript tails) — considered and declined for now
  in favor of discreet blocking: the live agent summarizes with full
  context and warm cache, and no new process management enters the hook
  path. Revisit if the discreet turn still feels intrusive in practice.
- Demoting or folding no-delta sessions in the feed (admission bite —
  parked).
- Making threads the feed unit sooner (unit bite — stays gated on the
  Stage 4 matcher proving out).
- A `covers` marker field or any backfill of historical delta lines
  (newest-wins makes it unnecessary).
- Daemon-side LLM summarization of sessions.
