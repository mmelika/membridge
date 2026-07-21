# Activity Day Cards v2: sentence headline + checklist, two-level drill

**Date:** 2026-07-20
**Status:** Approved design (Andrew, from mock v2) — supersedes the rendering of `2026-07-21-activity-day-drilldown-design.md`
**Builds on:** the merged Activity code (`feedDayGroupHtml`/`buildUnits`/`unitHtml`/`runHeadline` in `lib/dashboard.js` after Marco's master merge) and the **`buildDayCards` grouping already written and tested on branch `feat/activity-day-drilldown`** (reuse it; the grouping is unchanged).

## Problem

The first day-card build was correct in logic but wrong in presentation: cards showed bare fallbacks ("Working…", "N sessions · no summaries shared") stacked into a wall, with no sentence headline and no checklist. It also added a third drill level (a per-prompt page) nobody wanted. The approved mock v2 fixes both: a **one-sentence day headline + a checklist of what changed**, and **exactly two levels** — day card → session view. No prompt-detail page.

## The model

Two levels, one new grouping (reused), no new persistence.

**Level 1 — Day card** (one per author × project × local day; grouping = the existing `buildDayCards` from the old branch, key parts normalized exactly as `unitKeyOf` does). A day card carries:
- **Day headline** — one general sentence of what the day did. Deterministic pick: the `runHeadline` of the day's unit with the highest prompt count whose rep is distilled; tie → newer. No distilled rep anywhere → live day → "Working…"; finished → "N sessions · no summaries shared" (fallbacks only; the card shines when summaries flow).
- **Checklist** — one row per unit, **live/most-recent first**. Each row = that unit's `runHeadline`, prefixed by a state glyph: `◐` amber + a "working now" tag for a live unit, `✓` green for a distilled/finished unit, `○` grey for finished-no-summary. **First 4 shown; a bottom-right "Show all N changes ▾" expander** reveals the rest in place.
- **Stat row** — `N sessions · N prompts · N files` (sum over units). Bottom-left.
- The **card header is the drill target** → clicking it opens Level 2 for that author-day.

**Level 2 — Session view** (the existing per-unit activity, scoped to one author's day). A breadcrumb (`Activity › marco — Mon Jul 20`) + the day headline, then one **session card per unit**, live/most-recent first:
- A **2–3 sentence summary** (the unit's distilled `summary`/`did`, not just the headline).
- **Prompts inline, behind a bottom-left "▾ show N prompts" toggle** — reveals 3–4 prompt rows (the unit's entries; `(prompt not shared)` when not shared). **Prompts are display-only — not clickable to a deeper level.**
- Live units keep the amber "working now" marker.

## What does NOT change / is explicitly dropped

- **No Level 3.** The prompt-detail page from v1 is removed; prompt rows render inline and do nothing on click.
- The work-unit grouping (`buildUnits`), `runHeadline`, live/`STALE_GAP` rule, `homeDayLabel` day separators, and the `catchupExpanded` + `data-card-toggle` persistence contract are reused unchanged.
- **Project page stays per-unit** (the `opts.unitCards` opt-out decided on the old branch carries over): day cards are Activity-only.
- No change to summaries storage, team push, feed data, or the DB.

## Overlap with prior work

This replaces the *rendering* half of `2026-07-21-activity-day-drilldown-design.md`; the grouping half (`buildDayCards`) is reused verbatim from `feat/activity-day-drilldown`. The old branch is the source to lift `buildDayCards` (+ its 7 grouping tests) from; everything downstream of it is re-authored to this spec.

## Error handling

- `buildDayCards` is pure/total (already proven on the old branch): empty units → empty; bad `ts` groups under `homeDayLabel`'s output, never throws.
- Missing summaries degrade to the fallback strings above; a checklist with no distilled reps still renders `○` rows.
- Level 2 with a single unit still renders as the session view (no special case).
- Privacy inherited: Level 2 reads only post-redaction fields; `(prompt not shared)` rows render as-is.

## Testing (custom harness `test/run-tests.js`, client fns via `extractFn`)

- `buildDayCards` grouping/order/counts — **reuse the old branch's 7 checks unchanged.**
- Day headline pick: highest-prompt distilled unit wins, tie→newer; no-distilled → live vs finished fallback strings.
- Checklist: glyph per unit state (`◐`/`✓`/`○`); live rows first; first 4 shown, expander reveals the rest; live row carries the "working now" tag.
- `dayCardHtml`: sentence header present; checklist body; bottom-right expander; stat row; header is the day-open target; collapsed by default.
- Level 2 render: session cards scoped to the author-day, 2–3 sentence summary present, prompts hidden until the bottom-left toggle, **prompt rows have no deeper-open handler**.
- Feed e2e: Activity top level renders day cards (not per-unit), day separators intact, an open day card survives the poll (`catchupExpanded` keyed by day-card key).
