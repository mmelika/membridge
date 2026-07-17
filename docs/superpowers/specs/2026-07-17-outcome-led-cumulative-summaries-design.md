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

## Design

One seam changes: the Stop-hook prompt (`blockReason` in lib/hooks.js).
Two edits to it; nothing else in the pipeline moves.

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

Unchanged: the entire hook path fails open (any internal error logs and
allows the stop). Malformed lines are skipped by `countSummaryLines` and
`scanSummaries` exactly as today.

## Testing

Unit tests on `blockReason` (custom harness, test/run-tests.js):
- n = 0: instruction asks for outcome-phrased `did` (what-changed-in-the-
  project wording present; no file-list phrasing requested).
- n > 0: instruction asks for a whole-session-so-far line that supersedes
  earlier lines, and still forbids modifying existing lines.
- Existing gate/count/merge tests unchanged and stay green.

## Out of scope (YAGNI)

- Demoting or folding no-delta sessions in the feed (admission bite —
  parked).
- Making threads the feed unit sooner (unit bite — stays gated on the
  Stage 4 matcher proving out).
- A `covers` marker field or any backfill of historical delta lines
  (newest-wins makes it unnecessary).
- Daemon-side LLM summarization of sessions.
