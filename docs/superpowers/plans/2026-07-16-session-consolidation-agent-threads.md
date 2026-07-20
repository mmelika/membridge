# Session Consolidation: Work Units and Agent Threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the Activity feed so each widget is one *work unit* — one author's runs on one project within a time burst — with the individual agents (main session + subagents) shown as threads *inside* the widget, not as separate cards. Fold in the headline fix: only a distilled summary may occupy the brief spot; a harvested reasoning line never does.

**Architecture:** All grouping and rendering already happen at render time in the embedded dashboard script inside `lib/dashboard.js` (the Activity feed path: `buildThreads` → `threadHtml` → `feedDayGroupHtml`, plus the `#session=` page). This plan adds one grouping layer and one render function on top of the existing run grouping — no storage/schema change, no server.js/teamsync.js change. `lib/feed.js` normalizers already pass `session` through; nothing new is needed there.

**Tech Stack:** Node.js (CommonJS, zero deps). The embedded dashboard JS is a string and cannot execute under the suite, so pure functions (`buildThreads`, the new `buildUnits`, headline selection) are verified by a fixture harness: extract the functions from the emitted script and drive them with fixtures — the pattern the session-widget work established (`scratchpad/widget-check.js`). The standard `test/run-tests.js` harness (`check(name, fn)`, `npm test`) stays green (275 checks at plan time).

**Locked decisions (from the approved spec):**
- **Deterministic burst, not inference** — a work unit is `author + project + burst`; a burst is runs whose latest events are within `BURST_GAP` (default 30 min). No file-overlap guessing.
- **Run stays the inner unit** — one `(session, project)` group = one agent. Subagents are separate runs, rendered only as threads inside their unit, never as top-level cards.
- **Distilled-only headline** — the unit brief is the newest distilled summary among its runs; harvested last-text is never the brief (it may appear as secondary per-run detail). No distilled summary ⇒ `Working on: <latest ask>`.
- **Clutter guard** — a single-run, single-prompt unit renders as today's simple one-line card, no agent-thread chrome.
- **Sessionless entries** degrade to today's per-ask cards.

---

## Data contracts

**Feed entry** (from `lib/feed.js` normalizers): `{ ts, origin:'local'|'team', author, authorId, self, source, session, project, projectId, projectPath, ask, summary, distilled, files?, … }`. Unchanged.

**Run** = the current `buildThreads` output element: `{ key, entries:[…newest-first], ts, rep }`. `rep` currently picks distilled-then-harvested; Task 2 tightens this so a harvested pick is marked, not treated as a headline-worthy brief.

**Work unit** (new, from `buildUnits`):
```
{
  key,            // stable id for expand-persistence + nav: author|project|firstSession
  author, authorId, self, source, project, projectId, projectPath,
  runs: [ run, … ],   // newest-run-first; each run is a buildThreads element
  ts,             // newest event across all runs (anchors the day group + order)
  tsStart,        // oldest event across all runs (for the time span)
  rep,            // the headline run: newest run whose rep is DISTILLED, else null
  live,           // true if any run is in progress (no distilled summary + recent)
  promptCount, agentCount
}
```

**`BURST_GAP`**: a single named constant (ms), default `30 * 60 * 1000`.

---

## File structure

- **Modify** `lib/dashboard.js` (embedded script only):
  - `buildThreads` — keep; adjust `rep` selection so distilled vs harvested is explicit (Task 2).
  - **Add** `buildUnits(threads)` — group runs into work units (Task 1).
  - **Add** `unitHtml(u)` — render a work-unit widget with agent threads inside; reuse `threadHtml`'s per-run body as the thread body (Task 3).
  - `feedDayGroupHtml` — group by units, render `unitHtml` (Task 3).
  - `#session=` page — resolve a run within the current units; live/prompt fingerprint covers new prompts (Task 4).
- **Modify** `test/run-tests.js` — a `node --check` extraction guard already exists; add any assertions that can run without a browser.
- **Add** `scratchpad/widget-check.js` fixtures for the pure functions (not committed to the suite; referenced from the task, run manually).

Do **not** touch `server.js`, `teamsync.js`, `feed.js` (beyond reading), `project-resolve.js`, or the schema.

---

## Task 1: `buildUnits` — group runs into work units

**Files:**
- Modify: `lib/dashboard.js` (add `buildUnits`, `BURST_GAP`)
- Test: `scratchpad/widget-check.js` (fixtures)

- [ ] **Step 1: Write the failing fixture checks**

Extract `buildThreads` + `buildUnits` from the emitted script (reuse the extraction helper in `scratchpad/widget-check.js`) and assert:

```js
// A main session + 2 subagent sessions on one project within BURST_GAP
// collapse into ONE unit with 3 agent threads, newest-run-first.
const now = Date.parse('2026-07-16T12:30:00Z');
const mk = (session, tsISO, ask, summary, distilled) =>
  ({ origin:'team', author:'marco', authorId:'m', session, project:'membridge',
     ts:tsISO, ask, summary, distilled, source:'Claude Code' });
const entries = [
  mk('main','2026-07-16T12:00:00Z','plan it', null, false),
  mk('sub-a','2026-07-16T12:10:00Z','do A', 'Did A', true),
  mk('sub-b','2026-07-16T12:20:00Z','do B', 'Did B', true),
];
const units = buildUnits(buildThreads(entries));
assert.strictEqual(units.length, 1);
assert.strictEqual(units[0].runs.length, 3);
assert.strictEqual(units[0].agentCount, 3);
assert.strictEqual(units[0].promptCount, 3);

// A 4th run 40 min after the last (> BURST_GAP) starts a SECOND unit.
const far = mk('later','2026-07-16T13:00:00Z','resume', null, false);
const units2 = buildUnits(buildThreads(entries.concat([far])));
assert.strictEqual(units2.length, 2);

// Different authors never merge; different projects never merge.
```

- [ ] **Step 2: Run to verify they fail** (`buildUnits` undefined).

- [ ] **Step 3: Implement `buildUnits` (`lib/dashboard.js`)**

Add near `buildThreads`:
```js
var BURST_GAP = 30 * 60 * 1000; // runs within 30 min are one work unit
function unitKeyOf(run) {
  var e = run.entries[0];
  return [normKeyPart(e.authorId || e.author), normKeyPart(e.projectId || e.projectPath || e.project)].join('|');
}
// Group runs (buildThreads output) into work units: same author+project,
// bursts split at BURST_GAP. Runs arrive newest-first from buildThreads;
// keep that order so the newest run leads each unit.
function buildUnits(threads) {
  var byAuthorProj = {};
  threads.forEach(function (r) {
    var k = unitKeyOf(r);
    (byAuthorProj[k] = byAuthorProj[k] || []).push(r);
  });
  var units = [];
  Object.keys(byAuthorProj).forEach(function (k) {
    var runs = byAuthorProj[k].slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
    var cur = null;
    runs.forEach(function (r) {
      var t = Date.parse(r.ts) || 0;
      if (cur && Math.abs((Date.parse(cur.ts) || 0) - t) <= BURST_GAP) {
        cur.runs.push(r);
        if (String(r.ts) < String(cur.tsStart)) cur.tsStart = r.ts;
      } else {
        cur = { key: k + '|' + (r.entries[0].session || r.key), runs: [r], ts: r.ts, tsStart: r.ts };
        units.push(cur);
      }
    });
  });
  units.forEach(finalizeUnit);
  units.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  return units;
}
// Headline = newest run whose rep is DISTILLED; harvested reps are NOT
// eligible (that is the "reasoning line in the summary spot" fix). Counts
// and the copy fields come from the newest run.
function finalizeUnit(u) {
  var newest = u.runs[0].entries[0];
  u.author = newest.author; u.authorId = newest.authorId; u.self = newest.self;
  u.source = newest.source; u.project = newest.project;
  u.projectId = newest.projectId; u.projectPath = newest.projectPath;
  u.agentCount = u.runs.length;
  u.promptCount = u.runs.reduce(function (n, r) { return n + r.entries.length; }, 0);
  u.rep = null;
  u.runs.forEach(function (r) { if (!u.rep && r.rep && r.rep.distilled) u.rep = r; });
  u.live = !u.rep; // no distilled summary anywhere ⇒ in progress
}
```
(`normKeyPart` already exists from the session-widget work.)

- [ ] **Step 4: Run to verify they pass.** Then `npm test` — no regressions (this task adds a function; nothing calls it yet).

- [ ] **Step 5: Commit**
```bash
git add lib/dashboard.js
git commit -m "feat(ui): buildUnits — group runs into author/project work-unit bursts"
```

---

## Task 2: Distilled-only headline (fix reasoning line in the brief)

**Files:**
- Modify: `lib/dashboard.js` (`buildThreads` `rep` selection)
- Test: `scratchpad/widget-check.js`

- [ ] **Step 1: Write the failing fixture check**

```js
// A run whose ONLY summary is harvested must not surface as a distilled rep,
// so its unit shows "Working on:", never the harvested reasoning line.
const harvestedOnly = [{ origin:'team', author:'marco', authorId:'m', session:'s',
  project:'membridge', ts:'2026-07-16T12:00:00Z', ask:'go',
  summary:'Now let me look at the digest pipeline', distilled:false, source:'Claude Code' }];
const u = buildUnits(buildThreads(harvestedOnly))[0];
assert.strictEqual(u.rep, null);
assert.strictEqual(u.live, true);
// And a distilled summary IS chosen.
```

- [ ] **Step 2: Run to verify it fails** (current `buildThreads` sets `rep` to the harvested entry via the fallback).

- [ ] **Step 3: Tighten `rep` in `buildThreads`**

Today:
```js
var rep = null;
t.entries.forEach(function (e) { if (!rep && e.summary && e.distilled) rep = e; });
if (!rep) t.entries.forEach(function (e) { if (!rep && e.summary) rep = e; });
t.rep = rep;
```
Change so the harvested fallback is remembered separately, not as the headline brief:
```js
var distilled = null, harvested = null;
t.entries.forEach(function (e) {
  if (!distilled && e.summary && e.distilled) distilled = e;
  if (!harvested && e.summary && !e.distilled) harvested = e;
});
t.rep = distilled;                 // headline brief: distilled only
t.repHarvested = harvested;        // secondary per-run detail, never the unit headline
```
Then in `threadHtml` (per-run body, used inside a unit), a run with no `rep`
but a `repHarvested` may show that harvested line as muted secondary text under
its `Working on:` header — but it must never be promoted to the unit headline
(Task 3 reads `unit.rep` only).

- [ ] **Step 4: Run to verify it passes.** Then `npm test`.

- [ ] **Step 5: Commit**
```bash
git add lib/dashboard.js
git commit -m "fix(ui): distilled-only headline; harvested lines demoted to detail"
```

---

## Task 3: Render work units with agent threads

**Files:**
- Modify: `lib/dashboard.js` (`unitHtml`, `feedDayGroupHtml`)
- Test: `scratchpad/widget-check.js`

- [ ] **Step 1: Write the failing fixture checks**

Drive `unitHtml` (string builder) and assert the rendered markup:
```js
// Multi-agent unit: headline = the distilled summary; a meta line with
// "N agents · M prompts"; one thread per run, each thread capped at 3 prompts
// with "show more"/"See all" reusing the existing dropdown affordances.
// Single-run single-prompt unit: renders the simple one-line card, NO
// "agents" chrome (clutter guard).
// In-progress unit: accent border + pulsing "working now".
// XSS: hostile ask/summary/project/author fully escaped.
```

- [ ] **Step 2: Run to verify they fail** (`unitHtml` undefined).

- [ ] **Step 3: Implement `unitHtml` + switch the feed to units**

- `unitHtml(u)`:
  - Header: avatar + headline. Headline = `esc(u.rep.rep.summary)` when
    `u.rep`, else the amber `Working on: <newest ask>` fallback (reuse
    `threadHtml`'s existing headline branch). The headline stays a
    `data-sess-open` link, routing to the **newest run's** session page.
  - Meta row: author · tool pill · project · time span (`ago(u.tsStart)`→`ago(u.ts)` or just `ago(u.ts)`), a pulsing "working now" when `u.live`, and a count: `u.agentCount > 1 ? u.agentCount + ' agents · ' + u.promptCount + ' prompts' : u.promptCount + ' prompt(s)'` with the expand chevron (must stay the LAST span, per the `data-card-toggle` handler).
  - **Clutter guard:** if `u.runs.length === 1 && u.promptCount === 1`, return the existing single-line card (delegate to `threadHtml(u.runs[0])`) — no unit chrome.
  - Expanded body (reuse `catchupExpanded[u.key]`): for each run in `u.runs`, render an **agent thread** — a small label ("agent 1 / subagent" or the run's own summary/`Working on:`) followed by that run's capped prompts (reuse the existing 3-recent + `-webkit-line-clamp:2` + `data-clamp-more` block from `threadHtml`, factored into a shared `promptRowsHtml(run)` helper so the two paths can't drift). Each thread ends with "See all N prompts →" (`data-sess-open` to that run's session) when the run has >3 prompts.
  - Keep the `data-card-toggle` + `markClamped(det)` contract exactly, so expand-persistence and clamp measurement work unchanged.
- `feedDayGroupHtml(entries)`:
  ```js
  var units = buildUnits(buildThreads(entries));
  // day header off units[i].ts; render unitHtml(units[i]) instead of threadHtml.
  ```

Factor the per-run prompt list out of `threadHtml` into `promptRowsHtml(run)` and call it from both `threadHtml` (single-run card) and each agent thread in `unitHtml`, so there is one clamp/show-more implementation.

- [ ] **Step 4: Run fixture checks + `npm test`.** Manually load the app and confirm marco's subagent burst is one widget with agent threads inside, and no reasoning line sits in a headline.

- [ ] **Step 5: Commit**
```bash
git add lib/dashboard.js
git commit -m "feat(ui): render work-unit widgets with per-agent threads"
```

---

## Task 4: Session page + live updates + whole-feature verify

**Files:**
- Modify: `lib/dashboard.js` (`loadSession` / `sessionPageHtml` if needed)
- Test: `scratchpad/widget-check.js`, `test/run-tests.js`

- [ ] **Step 1: Confirm the session page still resolves a run**

The `#session=<key>` page reconstructs by run key from `buildThreads` — units do not change run keys, so headline/"See all" links (which target a run's session) still resolve. Add a fixture check that a `data-sess-open` key emitted by `unitHtml` matches a `buildThreads(...).key` for the same entries.

- [ ] **Step 2: Live update fingerprint**

The feed fingerprint already serializes every entry, so a new prompt in an
existing run re-renders and lands inside the same unit (stable `unitKeyOf`),
and `catchupExpanded[u.key]` keeps an open unit open across the 5s poll. Add a
check that appending a prompt to a run keeps the unit count == 1 and bumps
`promptCount`. Confirm a unit flips `live:false` once any run gets a distilled
summary.

- [ ] **Step 3: `npm test` green (275 + additions) and manual pass**

- [ ] Subagent burst → one widget, N agent threads.
- [ ] Gap > 30 min → two widgets.
- [ ] Harvested-only session → `Working on:`, never the reasoning line in the headline.
- [ ] Single-run single-prompt → today's simple card (no agent chrome).
- [ ] New prompt on the 5s poll lands inside the existing widget; open widgets stay open.
- [ ] XSS escaped in the unit widget and agent threads.

- [ ] **Step 4: Commit**
```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "test(ui): session-page + live-update coverage for work units"
```

---

## Self-review (to complete during implementation)

- **Spec coverage:** fragmentation → Task 1 `buildUnits` (burst grouping) + Task 3 (agent threads inside one widget); reasoning-line-in-headline → Task 2 (distilled-only `rep`) enforced by Task 3 reading `unit.rep` only; clutter guard → Task 3; live/counts → Task 1 `finalizeUnit` + Task 4.
- **Contract stability:** run keys unchanged, so the `#session=` page and `data-sess-open` links keep working; `data-card-toggle` + `catchupExpanded` + `markClamped` reused verbatim; the chevron stays the last header span.
- **No drift:** the clamp/show-more prompt list lives in one `promptRowsHtml(run)` used by both the single-run card and agent threads.

## Verification (whole feature)

- `npm test` green (existing + new checks); fixtures in `scratchpad/widget-check.js` all pass.
- marco's subagent-driven run shows as one widget with agent threads, not a wall of cards.
- No harvested reasoning line ever appears in a headline.
- Live sessions grow inside their widget on the 5s poll; open widgets stay open.
