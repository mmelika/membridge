# Session Consolidation: Work Units and Agent Threads

**Date:** 2026-07-16
**Status:** Approved design (Andrew) — supersedes the grouping half of Stage 3 for the Activity feed
**Builds on:** [2026-07-16-session-runs-and-threads-design.md](2026-07-16-session-runs-and-threads-design.md) (Runs and Threads)

## Problem

Two things make the Activity feed hard to read.

1. **Fragmentation across sessions.** The feed groups by `(author, project,
   session)` — one card per session. A single burst of one person's work
   fragments into many cards, worst of all under **subagent-driven
   execution**, where one piece of work spawns a main session plus several
   subagent sessions, each with its own session id, each landing as its own
   "1 prompt" card. The reader sees ten cards for one thing.

2. **Reasoning lines in the summary spot.** A session with no *distilled*
   summary falls back to a harvested last-message, and that harvested text —
   often a mid-session reasoning line like "Now let me look at the
   digest/memorydb pipeline…" — is rendered as if it were the AI brief. It
   reads like noise sitting in the headline.

The Runs-and-Threads spec addresses fragmentation *within* a sitting (Stage 3
groups asks into a run) and links related runs only as a **caption** (Stage 4,
deliberately not feed grouping, because its file-overlap matcher is
unreliable). Andrew wants stronger, deterministic consolidation for the feed:
one widget per person's burst of work, with the individual agents readable
*inside* it — not one card per agent.

## The model

Keep the run as the inner unit; add a deterministic outer unit for the feed.

- **Run** — one `(session, project)` group of a person's events. Unchanged
  from the Runs-and-Threads spec. This is a single agent's work (a main
  session, or one subagent).
- **Work unit** — one **author's runs on one project within a time gap
  (a burst)**. The feed shows exactly one widget per work unit. This is what
  the reader thinks of as "the thing marco was doing this morning."
- **Agent thread** — inside a work unit, each run renders as its own labeled
  thread of prompts. Multiple agents (main + subagents) live as threads
  *within* one widget, never as separate feed cards.

Deterministic, not inferred: a work unit is `author + project + burst`, where
a burst is runs whose events are within `BURST_GAP` (default **30 min**) of
each other. No file-overlap guessing — this is the reliability Stage 4 lacked,
which is why it can safely drive feed structure.

### Widget (collapsed)

One widget per work unit:
- **Headline** = the newest **distilled** summary among the unit's runs. A
  harvested last-message is *never* eligible for the headline (fix for problem
  #2). If no run has a distilled summary, the unit is in-progress: show
  `Working on: <latest ask>`.
- **Meta row** — author · tool · project · time span · a count of agents and
  prompts (e.g. "3 agents · 11 prompts"), and a pulsing "working now" when any
  run in the unit is still active.
- **Accent left border** while in progress, as today.

### Widget (expanded)

Prompts group into **agent threads**, one per run:
- Each thread is headed by that run's own summary (distilled preferred; a
  harvested line may appear here as secondary detail, just not as the unit
  headline) or `Working on:` if the run is unsummarized.
- Under each thread, that run's prompts, capped (reuse the existing 3-most-
  recent + "show more" cap, applied per thread), oldest→newest.
- A "See all" affordance opens the session page for that run.

### Clutter guard

The whole point is to *not* flood the feed with agents. So:
- Subagent runs never appear as top-level feed cards — only as threads inside
  their work unit.
- A work unit with a single run and a single prompt collapses to today's
  simple one-line card (no empty "1 agent" chrome).
- The agent-thread breakdown only renders when a unit actually has more than
  one run *or* more than a few prompts; otherwise the widget is just the brief.

### Attribution to a work unit

A run joins the newest existing work unit for its `(author, project)` when its
latest event is within `BURST_GAP` of that unit's latest event; otherwise it
starts a new unit. Runs with no session id degrade to today's per-ask cards
(same fallback as the Runs spec).

## Overlap with the Runs-and-Threads spec

This is intentionally an override of that spec's Stage 3/4 boundary for the
Activity feed, chosen by Andrew ("mine wins"):
- It keeps the **run** as defined there.
- It replaces "one card per run" with "one card per **work unit**," and moves
  the agent breakdown *inside* the card.
- It uses a **deterministic burst** rather than Stage 4's file-overlap
  inference to decide what belongs together — so it is safe to use as feed
  structure, which Stage 4 explicitly was not.

Marco's Stage 1 (attribution by edits) is upstream of this and unchanged: a run
is filed under the project its edits resolve to before any grouping happens.

## Error handling

- Grouping never throws the render: a malformed entry falls back to a
  single-run unit (today's per-ask behavior is always the floor).
- A run with no session id is its own unit (never false-merged).
- The burst gap is a single named constant, tuned later against real data; a
  wrong value costs readability, never correctness.
- Headline selection failing to find a distilled summary always degrades to
  `Working on:` — it never renders a harvested reasoning line as the brief.

## Testing

Grouping and headline selection are pure functions, driven by fixtures
(the embedded dashboard JS can't run under the suite, so functions are
extracted and exercised directly, as the session-widget work established):

- Subagent burst: a main session + N subagent sessions on one project within
  `BURST_GAP` collapse into one work unit with N+1 agent threads.
- Gap boundary: two runs of the same author/project separated by more than
  `BURST_GAP` form two units.
- Headline: a unit with a distilled summary shows it; a unit whose only
  summaries are harvested shows `Working on:`, never the harvested text.
- Clutter guard: a single-run single-prompt unit renders as today's simple
  card with no agent-thread chrome.
- Live: a unit with any active run shows "working now"; the count reflects
  deduped runs/prompts.
- Sessionless entries degrade to per-ask cards.
- XSS: brief/ask/project/author markup is escaped in the unit widget and each
  agent thread.
