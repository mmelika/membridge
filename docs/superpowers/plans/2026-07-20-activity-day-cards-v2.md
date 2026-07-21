# Activity Day Cards v2 — Implementation Plan (light workflow)

> **For agentic workers:** Implement this with a **single implementer per task + ONE final whole-branch review** — NOT per-task adversarial review rounds. This is UI; match rigor to risk. Use `superpowers:executing-plans` (single-agent, TDD), not the full subagent-driven-development review loop. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Activity's top level is one day card per author per project per day — a one-sentence day headline + a checklist of changes (live-first, first 4 + a bottom-right expander) — and clicking a card opens a two-level session view (summaries + an inline bottom-left prompt dropdown, no deeper level), per [the spec](../specs/2026-07-20-activity-day-cards-v2-design.md).

**Architecture:** Reuse `buildDayCards` (grouping) from branch `feat/activity-day-drilldown`. Re-author `dayCardHtml` (v2 visual) and a new Level-2 session view; wire both into `feedDayGroupHtml`. Everything below (unit grouping, `runHeadline`, session data, project page) is consumed unchanged.

**Tech stack:** Client fns in the embedded `<script>` of `lib/dashboard.js` (~3984 lines post-merge), tested via `extractFn` + eval like the existing `buildUnits`/`runHeadline` checks. Custom harness `test/run-tests.js`, run `node test/run-tests.js`. **First: run the suite on this fresh branch to get the real baseline number — do not assume 447 or 462; Marco's merge changed it.**

**Conventions:** commit `<type>: <description>`, no footer. TDD: failing test first. Client fns use `var`, `esc()`, CSS vars, and the `catchupExpanded`/`data-card-toggle` contracts.

**Locked (do not relitigate):** two levels only (no prompt-detail page); grouping key = author×project×`homeDayLabel(ts)`; day headline = highest-prompt distilled unit (tie→newer); checklist live-first, first 4 + bottom-right expander; Level 2 prompts inline behind a bottom-left toggle, display-only; project page stays per-unit via `opts.unitCards`.

## Task 0: branch baseline + lift `buildDayCards`
**Files:** `lib/dashboard.js`, `test/run-tests.js`.
- [ ] Run `node test/run-tests.js`, record the real baseline count.
- [ ] Lift `buildDayCards` and its 7 grouping checks from `git show feat/activity-day-drilldown:lib/dashboard.js` (and the test file) into this branch **unchanged**. Confirm those 7 checks pass. Commit: `feat(dashboard): port buildDayCards grouping from the v1 branch`.

## Task 1: day headline + checklist data on each day card
**Files:** `lib/dashboard.js` (extend the `buildDayCards` result), `test/run-tests.js`.
- [ ] **Failing tests:** day headline picks the highest-prompt distilled unit (tie→newer); no-distilled → live "Working…" vs finished "N sessions · no summaries shared"; checklist array is one entry per unit, live-first, each `{glyph, text, live}` where text is the unit's `runHeadline` and glyph ∈ `◐/✓/○` by state.
- [ ] Run → expect FAIL.
- [ ] Implement: extend each day-card object with `headline`, `checklist[]`, `sessions/prompts/files` counts, `live`. Reuse `runHeadline(u.rep&&u.rep.rep, u.runs[0].entries[0], u.live)` per unit, mirroring `unitHtml`'s call shape.
- [ ] Run → green + full suite. Commit: `feat(dashboard): day headline + live-first checklist data`.

## Task 2: `dayCardHtml` v2 + wire into `feedDayGroupHtml`
**Files:** `lib/dashboard.js`, `test/run-tests.js`.
- [ ] **Failing tests (markup on the returned string):** contains the sentence headline; renders first 4 checklist rows with glyphs and a "working now" tag on live rows; a bottom-right `data-day-expand` "Show all N changes ▾" control when >4; stat row; the header is a `data-day-open` target; body NOT auto-expanded. And: `feedDayGroupHtml` top level emits day cards (a `data-day-open` per author-day), `homeDayLabel` separators intact, no per-unit `unitHtml` at the top level.
- [ ] Run → expect FAIL.
- [ ] Implement `dayCardHtml(c, opts)` to the mock v2 layout (match the delivered `day-drilldown-mock-v2.html`: avatar/who/chip/proj/when, sentence headline, checklist with live-first + first-4 + bottom-right expander, stat row). Rewire `feedDayGroupHtml`'s per-day loop to `buildDayCards(units)` → `dayCardHtml`. Add the `data-day-expand` handler (in-place checklist reveal) and the `data-day-open` handler (→ Task 3 view) to the existing delegated feed listener; keep `catchupExpanded` for expand-state, keyed by day-card key.
- [ ] Run → green + full suite. Commit: `feat(dashboard): v2 day card — sentence headline + checklist dropdown`.

## Task 3: Level-2 session view (summaries + inline prompt dropdown)
**Files:** `lib/dashboard.js`, `test/run-tests.js`.
- [ ] **Failing tests:** the day-detail render produces one session card per unit for the author-day, live-first; each has a 2–3 sentence summary (unit `summary`/`did`, not just the headline); prompt rows are hidden until a bottom-left `data-prompts-toggle`; **prompt rows carry NO deeper-open attribute** (assert the absence — this is the "no level 3" guarantee); a breadcrumb back to the feed exists.
- [ ] Run → expect FAIL.
- [ ] Implement `dayDetailHtml(card, opts)` + a `data-day-open` route that swaps the feed view for it (reuse the view-swap the existing session page uses; breadcrumb via the same pattern). Session card = summary + a bottom-left prompt toggle revealing 3–4 entry rows (`(prompt not shared)` when unshared), display-only. Back link restores the feed with `catchupExpanded` intact.
- [ ] Run → green + full suite. Commit: `feat(dashboard): day → session view, inline prompts, no prompt-detail level`.

## Final review (one pass)
- [ ] One whole-branch review: spec conformance (two levels, live-first, expander sides, no level-3 handler), no modified pre-existing checks, `dayCardHtml` matches the mock. Then a human `npm run app` pass: expand a checklist (bottom-right), click a card → session view, toggle prompts (bottom-left), confirm prompts don't navigate, filters + back behave, an open card survives a poll tick.

## Self-review
- Spec "sentence + checklist, first 4 + bottom-right expander" → Tasks 1–2. "two-level, inline prompts, no level 3" → Task 3 (with an explicit absence assertion). Grouping reuse → Task 0. Project page unchanged → inherited `opts.unitCards`, untouched.
- Delegated (flagged): the exact view-swap/breadcrumb mechanics — align with the existing session-page route rather than inventing one; assertions above stay as written.
