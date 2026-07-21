# Activity Display: Outcome Headlines

**Date:** 2026-07-20
**Status:** Approved design
**Builds on:** [2026-07-17-outcome-led-cumulative-summaries-design.md](2026-07-17-outcome-led-cumulative-summaries-design.md) (distilled summaries) and the merged session-consolidation card model (`unitHtml`/`threadHtml`).

## Principle

Every card answers "what changed in our shared project reality?" in one glance,
with detail one click away — never a wall of harvested AI monologue, a raw error
prompt, or a mid-sentence truncation.

## Current state (merged code)

The merged dashboard already made the **primary** headline distilled-only: a
harvested last-message can't override a distilled summary
([dashboard.js ~2358](../../lib/dashboard.js) `t.rep = distilled; t.repHarvested = harvested`).
Four gaps remain, all visible in the current feed:

1. **Finished, no-distill runs still headline with harvested prose.**
   `threadHtml`/`unitHtml` fall back to `t.repHarvested.summary` (the agent's last
   chat line) before "session ended · no summary shared". This is the
   "The merged trial build is running…" card.
2. **Live runs headline with the raw ask** — a noisy error paste ("Working on:
   Install failed: Guru Meditation…") sits in the headline unfiltered.
3. **Distilled summaries are too long to headline** — a full `did` ("Git identity
   now uses marco@melika.com everywhere (global config…)") has no tight lead, so it
   clamps into mush.
4. **No clamp / uneven rhythm** — headlines run 1–4 lines, breaking the scan.

## Design — four deltas

### Delta 1 — `headline` field on distilled summaries

Add an optional `headline` (≤ ~10 words, the outcome in a glance) alongside
`goal`/`did`/`decisions`/`gotchas`:

- **`blockReason`** (lib/hooks.js) asks for it: "headline: ≤10 words, the single
  outcome a teammate would read at a glance (e.g. 'Auto-approve rule added for
  summary appends')". Added to the JSON template.
- **`runAppend`** (lib/hooks.js) treats it as **optional**: if present it must be a
  string; absence still validates (older lines and any that omit it are fine).
- **`scanSummaries`** (lib/scan.js) carries `ev.headline` when present, exactly like
  `goal`/`decisions`/`gotchas`.
- **`feed.js`** carries `headline` in both `normalizeLocal` and `normalizeTeam`
  (redacted like the other free-text fields).
- **No DB migration.** Team rows pushed without a `headline` column simply arrive
  without it and fall back (below). Cross-teammate tight headlines can come later
  behind a migration; out of scope here.

### Delta 2 — the headline picker (one helper, used everywhere)

A single `runHeadline(rep, opts)` helper decides the card's main line, replacing the
inline three-way in `threadHtml` and `unitHtml`:

```
distilled rep present → rep.headline || firstSentence(rep.summary)
else live             → askHeadline(newest.ask)          // Delta 3
else                  → firstSentence(newest.ask) if a real ask, else
                        "session ended · no summary shared"
```

- **Harvested prose (`repHarvested`) is never the headline.** `repHarvested` may
  still exist as data and may render inside the expander, but it is removed from the
  headline fallback chain.
- `firstSentence(text)` = the text up to the first sentence break (`.`/`!`/`?`
  followed by space or end), trimmed, hard-capped at ~90 chars — so even a rambling
  `did` or ask contributes only its lead clause.

### Delta 3 — live-ask guard (`askHeadline`)

Live runs currently dump the raw ask. `askHeadline(ask)`:

- Collapse whitespace/newlines to single spaces.
- If the ask is empty → `Working…`.
- If the ask is a noisy dump (length > ~120 chars after collapse, or contains
  newline-heavy / stack-trace-like markers such as multiple `\n`, `at `, `Error`,
  `failed:` patterns) → `Working…` (not the raw text).
- Otherwise → `Working on: <ask, firstSentence-capped>`.

Keep the pulsing amber "Working now" label unchanged; only the headline text is
guarded.

### Delta 4 — clamp and rhythm (display)

- The headline `<div>` gets a 2-line CSS clamp
  (`display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden`).
  No trailing "…" hack; the clamp handles overflow cleanly.
- The compact triad stays under the headline but each subline clamps to 1 line:
  `Intent` (from `goal`) and the `decisions · gotchas` subline.
- **The full outcome moves into the expander:** the complete `did`/`summary` (via
  `summaryFull` when present) renders at the top of the expanded body, above the
  per-run agent threads, alongside the existing `changes` block. So the headline is
  the glance; the expander is the full story.
- Consistent card padding/height already come from `unitHtml`'s card chrome; the
  clamp is what removes the height variance.

## What does NOT change

- The distilled-only primary-rep logic (already correct).
- The work-unit grouping, agent-thread expansion, live/STALE_GAP rule, and card
  chrome from the merge.
- Storage/merge of summaries beyond adding the one `headline` field.
- Team push schema (no migration).

## Error handling

- Every helper is pure and total: missing/empty inputs yield the safe placeholder
  ("Working…" or "session ended · no summary shared"), never `undefined`/throw.
- `runHeadline` returns already-escaped HTML or plain text that the caller escapes,
  consistent with current `esc()` usage — no double-escaping.

## Testing

Custom harness (test/run-tests.js):
- `firstSentence`: multi-sentence → first only; no punctuation → whole, capped;
  empty → "".
- `askHeadline`: empty → "Working…"; short ask → "Working on: <ask>"; long/noisy
  (newlines, "Error", "failed:") → "Working…".
- `runHeadline` precedence: distilled headline field wins; distilled without
  headline → first sentence of summary; no distilled + live → askHeadline; no
  distilled + finished + real ask → first sentence of ask; nothing → "session ended
  · no summary shared"; **harvested-only run never yields harvested text as the
  headline**.
- `blockReason` names the `headline` field; `runAppend` accepts a line with
  `headline` and one without (both valid), rejects a non-string `headline`.
- `scanSummaries`/`feed` carry `headline` through (present and absent cases).

## Out of scope (YAGNI)

- A `headline` DB column + migration for cross-teammate tight headlines (fallback to
  first-sentence covers it for now).
- Consecutive-duplicate collapse in the feed (separate concern; the design-tool
  prompt covers it as pure display).
- Any restyle beyond the clamp + expander move (the calm/technical look stays).
