# Catch-Up Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved v2 "Catch-Up" dashboard as MemBridge's front end — a faithful visual port of the template — backed by the new server capabilities it needs (per-user read-state + AI briefing, project soft-delete, team metadata), so a user opens the app and sees what their teammates did since they last looked.

**Architecture:** MemBridge is a zero-runtime-dependency Node.js + Electron app. A local daemon (`lib/server.js`) serves a self-contained HTML-string dashboard (`lib/dashboard.js`) and a JSON `/api`. Team data lives in Supabase (`lib/teamsync.js` + `supabase/*.sql`), reached through security-definer RPCs. Read-state is per-machine local state (`state.json`); AI briefings/roadmaps use the user's own Anthropic key (BYOK). This plan adds a read pointer + briefing generator, an archive-based soft-delete, a handful of read-path additions, and rebuilds the dashboard UI to match the template.

**Tech Stack:** Node.js (no deps), Electron, Supabase/Postgres (SQL RPCs + RLS), a zero-dependency test harness (`node test/run-tests.js` with `check()` cases + `test/mock-supabase.js`). The Anthropic Messages API is reachable in tests via the `MEMBRIDGE_API_BASE` override.

---

## Phase order & dependencies

Phases are independently shippable and are ordered so backend capability lands before the UI that consumes it:

- **Phase 0 — Brand logo** (no deps). Vendor the brand assets and expose the mark for the header.
- **Phase 1 — Read-state + since-window** (no deps). Adds `state.catchup`, `/api/catchup*`, `feedPayload` `since`.
- **Phase 2 — AI briefing** (depends on Phase 1's `state.catchup` default + `feedPayload` export).
- **Phase 3 — Project soft-delete** (no deps; DB migration + `/api/team/archive-project`).
- **Phase 4 — Team metadata + sync timestamp** (no deps).
- **Phase 5 — Front-end visual port** (depends on Phases 0–4 endpoints; degrades gracefully if a call 404s).
- **Phase 6 — Project page enrichment** (no deps; feeds the Phase 5 project-page stats).

Recommended execution order: 0 → 1 → 2 → 3 → 4 → 6 → 5 (build every endpoint the UI reads before the UI).

### Reconciliations to apply during execution

These pin cross-phase interfaces that the drafts surfaced. Apply them exactly:

1. **`GET /api/catchup` must return the cached briefing text**, not just `hasBriefing`. When implementing `catchupPayload()` (Phase 1, Task 1.3), return `{ lastViewedTs, prevViewedTs, hasBriefing: !!(state.catchup && state.catchup.briefing), briefing: (state.catchup && state.catchup.briefing) || null }`. This lets the Catch-Up UI (Phase 5.3) render a previously-generated briefing on load without spending tokens to regenerate. Phase 2 writes `state.catchup.briefing = { text, generatedAt, since }`; this read surfaces it.
2. **`feedPayload` is exported** from `lib/server.js` in Phase 1 (Task 1.2) — Phase 2's `/api/briefing/generate` and the tests both import it.
3. **Role source for FE gates** is the `/api/team` payload (`teamState.teams[].role`, `'owner'|'admin'` = manager), mirroring `invitePanelHtml` (`lib/dashboard-team.js:173`). The FE gate is advisory; the backend RPC (`is_team_manager`) is the real enforcement (Phase 3).
4. **`memory_entries.ask` is now NULLABLE.** The operator has already run `alter table public.memory_entries alter column ask drop not null;` against the live Supabase (summary-only / "ask not captured" sessions can now be stored without a prompt). Version-control it: add migration `supabase/migrations/007_memory_ask_nullable.sql` containing exactly that `alter`, and change `supabase/schema.sql:43` from `ask text not null check (char_length(ask) <= 400),` to `ask text check (char_length(ask) <= 400),`. No live DB action is needed — the migration only records the applied change for teammates/fresh installs. Because a pulled team row can now carry `ask = null`, the AI prompt builders must coalesce: in Phase 2's briefing prompt builder and Phase 6's roadmap team-merge use `e.ask || ''` (mirror `advisor.js:159`, which currently interpolates `${e.ask}` unguarded — it has been safe only because local asks are never null), and skip any entry whose `ask` **and** `summary` are both empty. Feed/UI paths already coalesce (`feed.js:19,40`, `dashboard.js:891`) and need no change.

5. **Non-goals (do NOT build):** GitHub OAuth sign-in; reciprocal read receipts ("Andrew is caught up through your session"); syncing teammates' todos/checkpoints into the feed; a "Signed in via GitHub" provenance label; any hosted invite web page / `webUrl` (invites are plain codes).

---

## Phase 0: Brand logo integration

Vendor the approved brand logo files into the app bundle and make the dashboard render the real brand mark (favicon + a reusable header mark), replacing the hand-inlined ad-hoc data-URI. The Electron app icon (`app/assets/icon.png`) is already the brand `membridge-app-icon-512.png` and the tray glyph already matches the brand mark, so this phase is asset-vendoring + dashboard wiring only. Not unit-tested; verify by eye.

**Files**
- Create: `app/assets/brand/*` (copied brand SVGs + PNGs)
- Modify: `lib/dashboard.js:19` (favicon `<link>`), `lib/dashboard.js:409` (the reused mark background), and add mark-SVG constants near `dashboardPage()` (`lib/dashboard.js:12`)
- Modify: `scripts/gen-icons.js` header comment (point at the vendored copy)

---

### Task 0.1: Vendor the brand logo files into the app bundle

**Files**
- Create: `app/assets/brand/` from `docs/brand/`

- [ ] Copy the brand files into the app tree so they ship in the packaged app and can be referenced by build tooling:

```bash
mkdir -p app/assets/brand
cp docs/brand/svg/membridge-app-icon.svg app/assets/brand/
cp docs/brand/svg/membridge-mark-blue.svg app/assets/brand/
cp docs/brand/svg/membridge-mark-white.svg app/assets/brand/
cp docs/brand/svg/membridge-mark-dark.svg app/assets/brand/
cp docs/brand/png/favicon-16.png app/assets/brand/
cp docs/brand/png/favicon-32.png app/assets/brand/
cp docs/brand/png/favicon-48.png app/assets/brand/
cp docs/brand/png/membridge-app-icon-192.png app/assets/brand/
cp docs/brand/png/membridge-app-icon-512.png app/assets/brand/
cp docs/brand/png/membridge-mark-blue-512.png app/assets/brand/
cp docs/brand/png/membridge-mark-white-512.png app/assets/brand/
```

- [ ] Verify the Electron app icon is already the brand (it is — `app/assets/icon.png` is byte-identical to `docs/brand/png/membridge-app-icon-512.png`):

```bash
cmp app/assets/icon.png app/assets/brand/membridge-app-icon-512.png && echo "app icon == brand 512 (ok)"
```

- [ ] Commit:

```bash
git add app/assets/brand
git commit -m "chore(brand): vendor brand logo files into app/assets/brand"
```

---

### Task 0.2: Render the real brand mark in the dashboard (favicon + reusable header constants)

**Files**
- Modify: `lib/dashboard.js:12` (add mark constants at the top of `dashboardPage()`), `lib/dashboard.js:19` (favicon), `lib/dashboard.js:409` (mark background)

The current page inlines an ad-hoc M-bridge data-URI in two places (the favicon at `:19` and a CSS `background` at `:409`). Replace both with the exact brand mark, and expose blue/white mark constants for Phase 5.2's header (theme-aware).

- [ ] At the top of `dashboardPage()` (`lib/dashboard.js:12`, before the returned template string), add the brand mark as constants (content copied verbatim from `docs/brand/svg/membridge-mark-blue.svg` / `membridge-mark-white.svg` / `membridge-app-icon.svg`):

```javascript
// Brand mark, inlined so the page stays self-contained. Sources of truth:
// docs/brand/svg/membridge-mark-{blue,white}.svg and membridge-app-icon.svg.
var MARK_BLUE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/></svg>';
var MARK_WHITE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/></svg>';
// Rounded-square app icon (blue field, white mark) for the favicon.
var ICON_DATAURI = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4.5" fill="#3B82F6"/><g fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(12 12) scale(0.72) translate(-12 -12)"><path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/></g></svg>');
```

- [ ] Replace the favicon `<link>` at `lib/dashboard.js:19` with one that uses the constant (build the head string with `+ ICON_DATAURI +` so it interpolates; if the page is a single template literal, use `${ICON_DATAURI}`):

```html
<link rel="icon" href="${ICON_DATAURI}">
```

- [ ] Replace the ad-hoc data-URI `background` at `lib/dashboard.js:409` to reference the same icon (interpolate `ICON_DATAURI`), so there is one source of truth:

```css
background: url("${ICON_DATAURI}") center/contain no-repeat;
```

- [ ] Manual verify: `npm run app`; confirm the browser tab / window favicon shows the blue rounded-square MemBridge mark, and any place that used the small mark background still renders it. (The header wordmark + mark comes in Phase 5.2, which consumes `MARK_BLUE` / `MARK_WHITE`.)

- [ ] Commit:

```bash
git add lib/dashboard.js
git commit -m "feat(ui): render the brand mark from a single inlined source (favicon + header constants)"
```

---

## Phase 1: Catch-Up read-state store + feed since-window

Add the per-user Catch-Up read pointer (`state.catchup`) with GET/POST endpoints, and thread an `opts.since` ISO window through `feedPayload` (local `>= since` filter + team `p_since`) and the `GET /api/feed` query parser. All backend, full TDD against the zero-dependency harness.

Files:
- `lib/util.js` — `state.catchup` default in `loadState()`
- `lib/server.js` — `feedPayload` since threading, `catchupPayload`/`markCaughtUp`/`undoCaughtUp`, three `/api/catchup*` routes, `GET /api/feed ?since` parsing, `module.exports`
- `test/run-tests.js` — new `check()` cases (local block + hub block)

### Task 1.1: `state.catchup` default in loadState

Files:
- Modify `test/run-tests.js` (add a check near the base local-feed block, after the `before=` test at ~line 432)
- Modify `lib/util.js:138-156` (STATE_VERSION region + `loadState`) and `:221-225` (exports)

- [ ] Write the FAILING test. Insert this `check()` immediately after the `/api/feed before= filters local entries inclusively by ts` check (test/run-tests.js ~line 432), before `const projects = ...`:
```js
    check('loadState seeds a default catchup read-state', () => {
      const st = util.loadState();
      assert.deepStrictEqual(st.catchup, { lastViewedTs: null, prevViewedTs: null, briefing: null },
        `catchup default missing: ${JSON.stringify(st.catchup)}`);
    });
```
- [ ] Run `npm test` (expected FAIL — `st.catchup` is `undefined`).
- [ ] Implement. In `lib/util.js`, add the default constant right above `STATE_VERSION` (line 134):
```js
// Catch-Up read pointer: when the user last marked Home "caught up" (lastViewedTs),
// the prior pointer for one-step undo (prevViewedTs), and the cached AI briefing
// (Phase 2 writes { text, generatedAt, since } here; null until generated).
const DEFAULT_CATCHUP = { lastViewedTs: null, prevViewedTs: null, briefing: null };
```
- [ ] Replace the three fresh-state literals in `loadState` (lines 143, 149, 154) `{ version: STATE_VERSION, files: {}, projects: {} }` with a shared factory. Add above `loadState` (line 140):
```js
function freshState() {
  return { version: STATE_VERSION, files: {}, projects: {}, catchup: { ...DEFAULT_CATCHUP } };
}
```
Then change lines 143/149/154 to `return freshState();`, and change the success return (line 152) from `return state;` to:
```js
    return { ...state, catchup: { ...DEFAULT_CATCHUP, ...(state.catchup || {}) } };
```
- [ ] Add `DEFAULT_CATCHUP` to `module.exports` (lib/util.js:221-225): append `DEFAULT_CATCHUP,` to the export list.
- [ ] Run `npm test` (expected PASS).
- [ ] `git commit -am "feat: seed default catchup read-state in loadState"`

### Task 1.2: thread opts.since through feedPayload (local filter + team p_since)

Files:
- Modify `test/run-tests.js` (local since check after Task 1.1's check ~line 432; team since check in the hub block after test/run-tests.js:1222)
- Modify `lib/server.js:103` (`feedPayload`: team `teamFeed` opts 149-153, local filter 167-171), `:561-564` (`GET /api/feed` parse), `:807` (exports)

- [ ] Write the FAILING local test. Insert after the Task 1.1 check (test/run-tests.js ~line 432). The base daemon has local events at `2026-07-09T10:00…11:00` and `Implement the secret feature Zeta` at `2026-07-09T11:00:00.000Z`:
```js
    const sinceTs = '2026-07-09T11:00:00.000Z';
    const feedSince = await (await fetch(`${base}/api/feed?since=${encodeURIComponent(sinceTs)}&limit=50`)).json();
    check('/api/feed since= keeps only local entries at or after the window', () => {
      const localRows = feedSince.entries.filter(e => e.origin === 'local');
      assert.ok(localRows.length >= 1, 'expected at least one recent local entry');
      assert.ok(localRows.every(e => String(e.ts) >= sinceTs), 'a local entry older than since= leaked through');
      assert.ok(localRows.some(e => e.summary && /secret feature Zeta/.test(e.summary) || /Zeta/.test(e.ask || '')),
        'the 11:00 entry should survive the since window');
    });
    const feedSinceFuture = await (await fetch(`${base}/api/feed?since=2099-01-01T00:00:00.000Z&limit=50`)).json();
    check('/api/feed since= in the future drops all local entries', () => {
      assert.strictEqual(feedSinceFuture.entries.filter(e => e.origin === 'local').length, 0,
        'future since window must exclude every local row');
    });
```
- [ ] Write the FAILING team test. In the hub block, insert immediately after the `resolves a linked local path to the team uuid` check and before `await new Promise(r => hubSrv.close(r));` (test/run-tests.js:1222). The seeded receipt row is at ts `2026-07-13T10:00:00.000Z` (test/run-tests.js:1195):
```js
    const teamSinceHit = await (await fetch(
      `${hubBase}/api/feed?since=2026-07-13T09:00:00.000Z&limit=50`)).json();
    const teamSinceMiss = await (await fetch(
      `${hubBase}/api/feed?since=2099-01-01T00:00:00.000Z&limit=50`)).json();
    check('/api/feed since= forwards to team_feed p_since (both directions)', () => {
      assert.ok(teamSinceHit.entries.some(e => e.origin === 'team' && /receipt PDF/.test(e.summary || '')),
        'recent team row should pass the since window');
      assert.strictEqual(teamSinceMiss.entries.filter(e => e.origin === 'team').length, 0,
        'future since window must exclude every team row');
    });
```
- [ ] Run `npm test` (expected FAIL — `since` is ignored, so old local rows and all team rows survive).
- [ ] Implement the team forward. In `feedPayload`'s `teamFeed` opts (lib/server.js:150-153), add `since`:
```js
    const settled = await Promise.allSettled(teamList.map(t =>
      teamsync.teamFeed(config, t.team_id, {
        author: opts.author, project: teamProject, source: opts.source,
        beforeCreatedAt: opts.before || null, since: opts.since || null, limit,
      })));
```
- [ ] Implement the local filter. In the `const f = local.filter(...)` block (lib/server.js:167-171), add the since clause:
```js
  const f = local.filter(e =>
    (!opts.author || e.author === opts.author || e.authorId === opts.author) &&
    (!opts.project || e.projectPath === opts.project || e.projectId === opts.project) &&
    (!opts.source || e.source === opts.source) &&
    (!opts.since || String(e.ts) >= String(opts.since)) &&
    (!opts.before || String(e.ts) <= String(opts.before)));
```
- [ ] Parse the query param. In `GET /api/feed` (lib/server.js:561-564), add `since`:
```js
      json(res, 200, await feedPayload({
        author: q('author'), project: q('project'), source: q('source'),
        before: q('before'), since: q('since'), limit,
      }));
```
- [ ] Export `feedPayload` (it is currently absent from lib/server.js:807). Add `feedPayload,` to `module.exports`.
- [ ] Run `npm test` (expected PASS).
- [ ] `git commit -am "feat: thread since window through feedPayload local filter and team p_since"`

### Task 1.3: Catch-Up read-state endpoints (GET /api/catchup, POST mark, POST undo)

Files:
- Modify `test/run-tests.js` (checks in the base daemon block, after the since checks ~line 432 — these mutate `state.json` via the spawned daemon and read back over HTTP)
- Modify `lib/server.js` (new payload/mutator fns near `settingsPayload` ~line 354; three routes in the `handle` if/else chain; `module.exports:807`)

- [ ] Write the FAILING tests. Insert after the Task 1.2 since checks (test/run-tests.js ~line 432). Run these sequentially so the pointer transitions are deterministic (mark sets prev=old-last; undo restores):
```js
    const cu0 = await (await fetch(`${base}/api/catchup`)).json();
    check('GET /api/catchup returns the empty read pointer', () => {
      assert.strictEqual(cu0.lastViewedTs, null, 'lastViewedTs should start null');
      assert.strictEqual(cu0.prevViewedTs, null, 'prevViewedTs should start null');
      assert.strictEqual(cu0.hasBriefing, false, 'no briefing yet');
    });
    const markTs = '2026-07-10T00:00:00.000Z';
    const cu1 = await (await post(`${base}/api/catchup/mark`, { ts: markTs })).json();
    check('POST /api/catchup/mark with a ts sets lastViewedTs and clears prev from null', () => {
      assert.strictEqual(cu1.lastViewedTs, markTs, 'lastViewedTs not set to the given ts');
      assert.strictEqual(cu1.prevViewedTs, null, 'prevViewedTs should be the old (null) lastViewedTs');
    });
    const cu2 = await (await post(`${base}/api/catchup/mark`, {})).json();
    check('POST /api/catchup/mark without a ts stamps now() and shifts prev', () => {
      assert.strictEqual(cu2.prevViewedTs, markTs, 'prevViewedTs must capture the previous lastViewedTs');
      assert.ok(cu2.lastViewedTs && !isNaN(Date.parse(cu2.lastViewedTs)), 'lastViewedTs must be a valid ISO now()');
      assert.ok(cu2.lastViewedTs > markTs, 'now() must sort after the earlier marked ts');
    });
    const cuGet = await (await fetch(`${base}/api/catchup`)).json();
    check('GET /api/catchup reflects the latest mark', () => {
      assert.strictEqual(cuGet.lastViewedTs, cu2.lastViewedTs, 'read pointer did not persist');
    });
    const cu3 = await (await post(`${base}/api/catchup/undo`, {})).json();
    check('POST /api/catchup/undo restores the previous pointer', () => {
      assert.strictEqual(cu3.lastViewedTs, markTs, 'undo must restore lastViewedTs to prevViewedTs');
      assert.strictEqual(cu3.prevViewedTs, null, 'undo must clear prevViewedTs');
    });
```
- [ ] Run `npm test` (expected FAIL — all four routes 404).
- [ ] Implement the payload + mutators. Add in `lib/server.js` just above `settingsPayload` (line 354):
```js
// Catch-Up read pointer. GET is pure (never mutates); mark/undo rewrite the
// pointer immutably so a mis-tap is one-step reversible from Home.
function catchupPayload() {
  const c = loadState().catchup || {};
  return {
    lastViewedTs: c.lastViewedTs || null,
    prevViewedTs: c.prevViewedTs || null,
    hasBriefing: !!(c.briefing && c.briefing.text),
  };
}

function markCaughtUp(ts) {
  const state = loadState();
  const c = state.catchup || {};
  const next = {
    ...c,
    prevViewedTs: c.lastViewedTs || null,
    lastViewedTs: ts || new Date().toISOString(),
  };
  saveState({ ...state, catchup: next });
  return { lastViewedTs: next.lastViewedTs, prevViewedTs: next.prevViewedTs };
}

function undoCaughtUp() {
  const state = loadState();
  const c = state.catchup || {};
  const next = { ...c, lastViewedTs: c.prevViewedTs || null, prevViewedTs: null };
  saveState({ ...state, catchup: next });
  return { lastViewedTs: next.lastViewedTs, prevViewedTs: next.prevViewedTs };
}
```
- [ ] Add the GET route. In `handle`, immediately after the `GET /api/feed` branch closes (lib/server.js:565, before `GET /api/scan`):
```js
    } else if (req.method === 'GET' && url.pathname === '/api/catchup') {
      json(res, 200, catchupPayload());
```
- [ ] Add the two POST routes. Place them alongside the other POSTs, e.g. after the `POST /api/projects/delete` branch (lib/server.js:730):
```js
    } else if (req.method === 'POST' && url.pathname === '/api/catchup/mark') {
      const body = await readBody(req);
      const ts = String(body.ts || '').trim() || null;
      json(res, 200, markCaughtUp(ts));
    } else if (req.method === 'POST' && url.pathname === '/api/catchup/undo') {
      json(res, 200, undoCaughtUp());
```
- [ ] Add `catchupPayload, markCaughtUp, undoCaughtUp` to `module.exports` (lib/server.js:807).
- [ ] Run `npm test` (expected PASS).
- [ ] `git commit -am "feat: add catchup read-state endpoints (get/mark/undo)"`

## Phase 2: AI briefing generator

Add `advisor.generateBriefing()` and the `POST /api/briefing/generate` route, reusing every piece of the existing BYOK/roadmap plumbing (`postMessages`, the timeout+retry+401 envelope, the no-key degrade). The route turns `feedPayload` entries into per-teammate groups (self excluded), asks Claude for a catch-up briefing, caches it to `state.catchup.briefing`, and degrades cleanly when there is no key.

Files
- `lib/advisor.js` — new `BRIEFING_SYSTEM`, `BRIEFING_MAX_TOKENS`, `buildBriefingPrompt()`, `generateBriefing()`; export the last two.
- `lib/server.js` — new `POST /api/briefing/generate` branch in the route chain.
- `test/run-tests.js` — teach the existing Anthropic mock to answer plain-text (non-schema) `/v1/messages` and capture a `lastBriefingRequest`; add a unit check for `generateBriefing` and an end-to-end route check inside the signed-in team block.

### Task 2.1 — advisor.generateBriefing (unit-tested against the mock Anthropic)

Files
- Modify `test/run-tests.js:308` (add `lastBriefingRequest`), `test/run-tests.js:317-330` (branch the mock `/v1/messages` handler on `output_config`).
- Modify `lib/advisor.js:149` (after `PLAN_SYSTEM`), `lib/advisor.js:166` (after `buildPlanPrompt`), `lib/advisor.js:234` (after `generatePlan`), `lib/advisor.js:236` (exports).

- [ ] Write the FAILING test. First extend the mock so a briefing (no `output_config`) is captured separately and answered with plain text. Replace the `/v1/messages` handler at `test/run-tests.js:317-330` and add the capture var next to `lastPlanRequest` (`test/run-tests.js:308`):

```javascript
  let lastPlanRequest = null;
  let lastBriefingRequest = null;
```

```javascript
      } else if (req.method === 'POST' && req.url === '/v1/messages') {
        if (!authed) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(AUTH_FAIL);
          return;
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed.output_config) {
          // Roadmap request: structured JSON plan.
          lastPlanRequest = parsed;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: parsed.model,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(CANNED_PLAN) }],
            usage: { input_tokens: 4200, output_tokens: 900 },
          }));
        } else {
          // Briefing request: free-form prose.
          lastBriefingRequest = parsed;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: parsed.model,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Andrew wired the receipt PDF; Dana added refund guardrails.' }],
            usage: { input_tokens: 500, output_tokens: 60 },
          }));
        }
      } else {
```

- [ ] Add the unit check right after the roadmap tests and before `mockApi.close` (insert after `test/run-tests.js:711`, still inside the block where the mock on 17944 is alive). `advisorLib` is already imported (`test/run-tests.js:25`):

```javascript
    process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17944'; // in-process advisor -> the same mock
    const briefNoKey = await advisorLib.generateBriefing('', 'claude-sonnet-5', { since: null, teammates: [] });
    const briefOk = await advisorLib.generateBriefing(GOOD_KEY, 'claude-sonnet-5', {
      since: '2026-07-10T00:00:00.000Z', until: '2026-07-14T00:00:00.000Z',
      teammates: [
        { name: 'Andrew', entries: [{ ts: '2026-07-11T09:00:00.000Z', source: 'Claude Code', ask: 'Wire the receipt PDF', summary: 'Receipts now email a PDF', files: ['pay.js'], project: 'shop-app' }] },
        { name: 'Dana', entries: [{ ts: '2026-07-12T09:00:00.000Z', source: 'Codex', ask: 'Add refund guardrails', summary: null, files: [], project: 'shop-app' }] },
      ],
    });
    check('briefing: generateBriefing needs a key and turns teammate activity into prose', () => {
      assert.ok(briefNoKey.error && !briefNoKey.text, 'no-key path must return { error }, not text');
      assert.ok(briefOk.text && !briefOk.error, `expected { text }, got ${JSON.stringify(briefOk)}`);
      assert.ok(lastBriefingRequest, 'mock never saw a briefing request');
      assert.ok(!lastBriefingRequest.output_config, 'a briefing must be plain text, never json_schema');
      assert.strictEqual(lastBriefingRequest.max_tokens, 1200);
      assert.strictEqual(lastBriefingRequest.thinking.type, 'disabled', 'sonnet must run with thinking off');
      assert.ok(lastBriefingRequest.system.includes('catch-up'), 'briefing system prompt missing');
      const userMsg = lastBriefingRequest.messages[0].content;
      assert.ok(userMsg.includes('Andrew') && userMsg.includes('Dana'), 'teammate activity missing from the prompt');
      assert.ok(userMsg.includes('Wire the receipt PDF') || userMsg.includes('Receipts now email a PDF'), 'ask/summary missing');
    });
```

- [ ] Run `npm test` — expect FAIL (`advisorLib.generateBriefing is not a function`).
- [ ] Add the system prompt and token budget after `PLAN_SYSTEM` (`lib/advisor.js:149`):

```javascript
const BRIEFING_MAX_TOKENS = 1200;

const BRIEFING_SYSTEM = `You are MemBridge's catch-up briefer. You read a digest of what a developer's teammates did with AI coding tools since the developer last looked, and you write a short, skimmable briefing that gets them caught up fast.

Write 2-4 short paragraphs or tight bullets in plain language. Lead with what matters most. Name the teammate and the project they touched, and group related work. Ground every claim in the digest — never invent activity that is not there; if the digest is thin, say so in one line. No preamble and no sign-off — just the briefing.`;
```

- [ ] Add `buildBriefingPrompt` after `buildPlanPrompt` (`lib/advisor.js:166`):

```javascript
function buildBriefingPrompt(payload) {
  const lines = [];
  if (payload.since) {
    lines.push(`Window: since ${payload.since}${payload.until ? ` until ${payload.until}` : ''}.`);
  }
  if (!payload.teammates || !payload.teammates.length) {
    lines.push('No teammate activity was captured in this window.');
    return lines.join('\n');
  }
  lines.push('', 'Recent teammate activity (grouped by teammate, oldest first):', '');
  for (const t of payload.teammates) {
    lines.push(`## ${t.name}`);
    for (const e of t.entries || []) {
      const detail = e.summary || e.ask || '';
      const files = e.files && e.files.length ? ` [files: ${e.files.join(', ')}]` : '';
      lines.push(`- ${e.ts} · ${e.source}${e.project ? ` · ${e.project}` : ''}: ${detail}${files}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
```

- [ ] Add `generateBriefing` after `generatePlan` (`lib/advisor.js:234`) — same never-throw envelope, but a `{ text } | { error }` shape and no structured-output config:

```javascript
// Generate a catch-up briefing from teammate activity. Mirrors generatePlan's
// error discipline (never throws for expected failures) but returns free-form
// prose: { text } on success, { error } on any expected failure.
async function generateBriefing(apiKey, model, payload) {
  if (!apiKey) return { error: 'Add your Anthropic key in Settings first.' };
  const body = {
    model,
    max_tokens: BRIEFING_MAX_TOKENS,
    system: BRIEFING_SYSTEM,
    messages: [{ role: 'user', content: buildBriefingPrompt(payload) }],
  };
  if (model === 'claude-sonnet-5') body.thinking = { type: 'disabled' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    let res = await postMessages(apiKey, body, ctrl.signal);
    if (res.status === 429 || res.status >= 500) res = await postMessages(apiKey, body, ctrl.signal); // one retry
    if (res.status === 401) return { error: 'That key looks invalid — check Settings.' };
    if (!res.ok) {
      let msg = `The Anthropic API answered with an error (${res.status}) — try again in a minute.`;
      try {
        const b = await res.json();
        if (b && b.error && b.error.message) msg = b.error.message;
      } catch {}
      return { error: msg };
    }
    const data = await res.json();
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    if (!text.trim()) return { error: 'The model returned an empty briefing — try again.' };
    return { text: text.trim() };
  } catch (err) {
    return {
      error: err.name === 'AbortError'
        ? 'Timed out waiting for the Anthropic API — try again.'
        : 'Could not reach the Anthropic API — are you online?',
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] Export the new functions (`lib/advisor.js:236-240`):

```javascript
module.exports = {
  API_VERSION, PLANNER_MODELS, DEFAULT_MODEL, PRICES,
  apiBase, getAdvisorConfig, testKey,
  estimateCost, actualCost, buildPlanPrompt, generatePlan,
  buildBriefingPrompt, generateBriefing,
};
```

- [ ] Run `npm test` — expect PASS for the new `briefing: generateBriefing…` check and no regression in the roadmap checks (the mock branch keeps `lastPlanRequest` intact for the plan assertions, which run before this one).
- [ ] Commit: `feat: add advisor.generateBriefing for catch-up briefings`

### Task 2.2 — POST /api/briefing/generate (assembles teammate rows, caches, degrades)

Files
- Modify `lib/server.js:773` (insert a new `else if` branch immediately before the closing `} else { json(res, 404, …) }`).
- Modify `test/run-tests.js:1222` (insert an end-to-end check inside the signed-in team block, just before `await new Promise(r => hubSrv.close(r));`).

- [ ] Write the FAILING test. Insert before `test/run-tests.js:1223` (`await new Promise(r => hubSrv.close(r));`). At this point `MEMBRIDGE_HOME` is `HOME_A` (Marco, owner) and `team_feed` already returns rows authored by Marco, Andrew and Dana, so `feedPayload` yields teammate rows to group. `hubBase`, `post`, `util` and `http` are all in scope. The original Anthropic mock was closed at line 786, so stand up a fresh canned briefing mock:

```javascript
    // Catch-up briefing over the local API: teammate rows only, self excluded,
    // grouped by author, and a no-key degrade. A throwaway Anthropic mock
    // stands in for the (already-closed) roadmap mock; the in-process server
    // reads MEMBRIDGE_API_BASE per call, so setting it now is enough.
    let lastTeamBriefReq = null;
    const briefMock = http.createServer((rq, rs) => {
      const cs = [];
      rq.on('data', c => cs.push(c));
      rq.on('end', () => {
        lastTeamBriefReq = JSON.parse(Buffer.concat(cs).toString('utf8'));
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({
          model: lastTeamBriefReq.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Andrew wired the receipt PDF; Dana added refund guardrails.' }],
          usage: { input_tokens: 500, output_tokens: 60 },
        }));
      });
    });
    await new Promise(r => briefMock.listen(17948, '127.0.0.1', r));
    process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17948';

    await post(`${hubBase}/api/settings`, { apiKey: '' });
    const briefDegraded = await (await post(`${hubBase}/api/briefing/generate`, {})).json();
    await post(`${hubBase}/api/settings`, { apiKey: GOOD_KEY });
    const briefRes = await (await post(`${hubBase}/api/briefing/generate`, { since: '2026-07-01T00:00:00.000Z' })).json();
    check('briefing route: degrades without a key; briefs teammate activity with one', () => {
      assert.strictEqual(briefDegraded.degraded, true, 'no-key path must degrade');
      assert.ok(!briefDegraded.text, 'degraded path must not carry a briefing');
      assert.strictEqual(briefRes.degraded, false);
      assert.ok(briefRes.text && /receipt PDF/.test(briefRes.text), `briefing text missing: ${JSON.stringify(briefRes)}`);
      assert.ok(briefRes.generatedAt, 'generatedAt missing');
      assert.ok(lastTeamBriefReq, 'briefing mock never saw a request');
      const userMsg = lastTeamBriefReq.messages[0].content;
      assert.ok(userMsg.includes('Andrew'), 'teammate Andrew missing from the digest');
      assert.ok(!/^##\s*You\b/m.test(userMsg), 'self rows leaked into the teammate digest');
      const st = util.loadState();
      assert.ok(st.catchup && st.catchup.briefing && /receipt PDF/.test(st.catchup.briefing.text),
        'briefing not cached to state.catchup.briefing');
      assert.strictEqual(st.catchup.briefing.since, '2026-07-01T00:00:00.000Z', 'cached since window wrong');
    });
    await post(`${hubBase}/api/settings`, { apiKey: '' });
    await new Promise(r => briefMock.close(r));
```

- [ ] Run `npm test` — expect FAIL (route returns 404, `briefRes.degraded` undefined).
- [ ] Add the route branch immediately before `} else {` at `lib/server.js:773`. It reuses the in-module `feedPayload` (no export needed) and `advisor` (imported at `lib/server.js:6`); the `state.catchup` write is defensive so it works whether or not the catch-up read-state phase has landed yet:

```javascript
    } else if (req.method === 'POST' && url.pathname === '/api/briefing/generate') {
      const body = await readBody(req);
      const since = String(body.since || '').trim() || null;
      const config = getConfig();
      const adv = advisor.getAdvisorConfig(config);
      // No key -> degrade, exactly like the roadmap path does (the FE offers
      // "add an API key" instead of a briefing).
      if (!adv.apiKey) return json(res, 200, { degraded: true });
      // Only teammates' work belongs in a catch-up briefing: drop our own rows
      // (self), then group what's left by author. feedPayload already tags each
      // entry with { self, author, ... } and forwards `since` to the team feed.
      const feedRes = await feedPayload({ since, limit: 200 });
      const byAuthor = new Map();
      for (const e of feedRes.entries || []) {
        if (e.self) continue;
        const name = e.author || 'Teammate';
        if (!byAuthor.has(name)) byAuthor.set(name, []);
        byAuthor.get(name).push({ ts: e.ts, source: e.source, ask: e.ask, summary: e.summary, files: e.files, project: e.project });
      }
      const teammates = [...byAuthor.entries()].map(([name, entries]) => ({ name, entries }));
      const now = new Date().toISOString();
      const r = await advisor.generateBriefing(adv.apiKey, adv.model, { since, until: now, teammates });
      if (r.error) return json(res, 502, { error: r.error });
      // Cache the briefing (overwrite = "Regenerate", same as the roadmap). Merge
      // defensively so we never clobber the catch-up read pointers.
      const state = loadState();
      const catchup = state.catchup || { lastViewedTs: null, prevViewedTs: null, briefing: null };
      saveState({ ...state, catchup: { ...catchup, briefing: { text: r.text, generatedAt: now, since } } });
      json(res, 200, { text: r.text, generatedAt: now, degraded: false });
    } else {
```

- [ ] Run `npm test` — expect PASS for `briefing route: degrades without a key…`, no regressions.
- [ ] Commit: `feat: POST /api/briefing/generate — cached teammate catch-up briefing`

## Phase 3: Project soft-delete (owner/manager, reversible)

Goal: give shared projects a reversible, manager-only "delete for the whole team" that archives the project on the backend (hiding it from the feed and project lists) while cleaning up locally, and lets plain members only unlink their own machine. Archive/unarchive are manager-gated by the existing `is_team_manager` RPC.

Files:
- `supabase/migrations/005_project_archive.sql` (Create)
- `supabase/schema.sql` (Modify — projects table ~34)
- `lib/teamsync.js` (Modify — wrappers near `unlinkProject` ~369; exports ~575)
- `lib/server.js` (Modify — new `archiveSharedProject` near `deleteProject` ~339; new route in the if/else chain ~712)
- `test/mock-supabase.js` (Modify — RPCs in `handleRpc` ~176; `team_feed` filter ~159; `project_stats` handler ~250)
- `test/run-tests.js` (Modify — new `check()` cases inside the section-8 team `try`, ~1318)

### Task 3.1: Backend migration + schema columns

Files:
- Create `supabase/migrations/005_project_archive.sql`
- Modify `supabase/schema.sql:34` (after the `projects` create table, mirroring the `summary` alter at 55-56)

Not exercised by the Node harness (no Postgres); validate manually against a real Supabase before deploy. No commit gate on tests here — this task ships with 3.2.

- [ ] Create `supabase/migrations/005_project_archive.sql` with the columns, RPCs, and the two archived filters (recreate `team_feed` like 004 does; `create or replace` the `project_stats` view since its column set is unchanged):

```sql
-- Project soft-delete: owners/admins can archive a shared project for the whole
-- team (reversible), hiding it from the unified feed and the projects lists
-- without destroying its history. Mirrors 002_team_v2.sql's security-definer +
-- is_team_manager() gate style. Additive/idempotent; run in the Supabase SQL
-- editor or `supabase db push`. Depends on 002 (is_team_manager) and 004
-- (the summary-carrying team_feed signature dropped+recreated below).

alter table public.projects add column if not exists archived_at timestamptz;
alter table public.projects
  add column if not exists archived_by uuid references auth.users (id);

-- Archive: manager-gated soft delete. The RPC — not RLS — is the real
-- authorization boundary, so a plain member calling it directly is refused.
create or replace function public.archive_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.projects where id = p_project;
  if v_team is null then
    raise exception 'unknown project';
  end if;
  if not public.is_team_manager(v_team) then
    raise exception 'only a team owner or admin can delete a project for the team';
  end if;
  update public.projects
    set archived_at = now(), archived_by = auth.uid()
    where id = p_project;
end;
$$;

-- Unarchive: the same manager gate; restores the project everywhere.
create or replace function public.unarchive_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.projects where id = p_project;
  if v_team is null then
    raise exception 'unknown project';
  end if;
  if not public.is_team_manager(v_team) then
    raise exception 'only a team owner or admin can restore a project';
  end if;
  update public.projects
    set archived_at = null, archived_by = null
    where id = p_project;
end;
$$;

-- team_feed must skip archived projects. Postgres refuses to change a
-- function's RETURNS TABLE via create-or-replace, so DROP+recreate the
-- 9-arg signature (unchanged since 004), adding `and p.archived_at is null`.
drop function if exists public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz);

create or replace function public.team_feed(
  p_team uuid,
  p_before_created_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 50,
  p_author uuid default null,
  p_project uuid default null,
  p_source text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  id bigint, project_id uuid, project_name text,
  author_id uuid, author_name text,
  ts timestamptz, source text, ask text, summary text, files jsonb, created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and p.archived_at is null
    and public.is_team_member(p_team)
    and (p_before_created_at is null
         or (e.created_at, e.id) < (p_before_created_at, p_before_id))
    and (p_author is null or e.author_id = p_author)
    and (p_project is null or e.project_id = p_project)
    and (p_source is null or e.source = p_source)
    and (p_since is null or e.ts >= p_since)
    and (p_until is null or e.ts <= p_until)
  order by e.created_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- project_stats view (source for teamProjectsPayload): exclude archived. Column
-- set is identical to 002's, so create-or-replace is enough — no drop needed.
create or replace view public.project_stats
with (security_invoker = on) as
  select p.id as project_id, p.team_id, p.name, p.repo_url,
         max(e.ts) as last_activity,
         count(distinct e.author_id) as contributors,
         count(e.id) as entries
  from public.projects p
  left join public.memory_entries e on e.project_id = p.id
  where p.archived_at is null
  group by p.id;
```

- [ ] Modify `supabase/schema.sql`: immediately after the `projects` create table (closes at line 34), add the idempotent columns so a fresh install already has them:

```sql
-- Soft-delete for shared projects (see migrations/005_project_archive.sql).
-- Added via `alter ... add column if not exists` so it is backwards-compatible
-- with already-live backends and pre-existing clients.
alter table public.projects add column if not exists archived_at timestamptz;
alter table public.projects
  add column if not exists archived_by uuid references auth.users (id);
```

- [ ] Manual verification note (record in the commit body): apply 005 in the Supabase SQL editor, `select archive_project('<uuid>')` as a member (expect `only a team owner or admin` error) and as the owner (expect the row's `archived_at` set and the project gone from `team_feed`/`project_stats`), then `unarchive_project` to confirm it returns.

### Task 3.2: teamsync wrappers + mock RPCs (TDD)

Files:
- Modify `test/run-tests.js` (add `check()` cases inside the section-8 `try`, after the auto-link tests ~1317, before the `privacy: files outside the project` check)
- Modify `lib/teamsync.js:369` (add wrappers after `unlinkProject`) and `lib/teamsync.js:575` (exports)
- Modify `test/mock-supabase.js` (RPCs, `team_feed` filter, `project_stats` filter)

- [ ] Write the FAILING tests first. Insert this block at `test/run-tests.js` ~line 1318 (right after the `auto-link: config team.autoLink=true` check, still under `process.env.MEMBRIDGE_HOME = HOME_A`):

```js
    // ----- migration 005: project soft-delete (owner/manager, reversible) -----
    // A fresh linked project so archiving never disturbs the shop-app fixtures.
    process.env.MEMBRIDGE_HOME = HOME_A;
    const projArch = path.join(ROOT, 'projects', 'archive-app');
    fs.mkdirSync(projArch, { recursive: true });
    fs.writeFileSync(path.join(projArch, 'CLAUDE.md'), '# Archive app\n');
    const stArch = util.loadState();
    stArch.projects[projArch] = {
      events: [{ ts: '2026-07-13T09:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'Draft the archive feature', session: 'arch1' }],
    };
    util.saveState(stArch);
    const archLink = await teamsync.linkProject(util.getConfig(), projArch, team.team_id, 'Acme');
    await teamsync.syncTeams({ project: projArch }); // push the entry so it appears in the feed

    // A plain member (Dana, home-d) cannot archive: the RPC is manager-gated.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    let memberArchErr = null;
    try {
      await teamsync.archiveProject(util.getConfig(), archLink.projectId);
    } catch (err) {
      memberArchErr = err;
    }
    check('archive: a plain member cannot delete a shared project for the team', () => {
      assert.ok(memberArchErr && /owner or admin/i.test(memberArchErr.message), `said: ${memberArchErr && memberArchErr.message}`);
      assert.ok(!mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'project was archived by a non-manager');
    });

    // The owner archives it: gone from the projects payload and the feed.
    process.env.MEMBRIDGE_HOME = HOME_A;
    await teamsync.archiveProject(util.getConfig(), archLink.projectId);
    const projsAfterArchive = await teamProjectsPayload(team.team_id);
    const feedAfterArchive = await teamsync.teamFeed(util.getConfig(), team.team_id, { limit: 100 });
    check('archive: owner archive hides the project from the projects payload and the feed', () => {
      assert.ok(mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'archived_at not set');
      assert.ok(!projsAfterArchive.some(r => r.project_id === archLink.projectId), 'archived project still listed');
      assert.ok(!feedAfterArchive.some(e => e.project_id === archLink.projectId), 'archived project rows still in the feed');
    });

    // Reversible: unarchive brings it back.
    await teamsync.unarchiveProject(util.getConfig(), archLink.projectId);
    const projsAfterRestore = await teamProjectsPayload(team.team_id);
    check('archive: unarchive restores the project (reversible)', () => {
      assert.ok(!mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'archived_at not cleared');
      assert.ok(projsAfterRestore.some(r => r.project_id === archLink.projectId), 'restored project missing from payload');
    });
```

- [ ] Run `npm test` (expected FAIL: `teamsync.archiveProject is not a function`, and the mock has no `archive_project`/`unarchive_project` RPCs).

- [ ] Implement the mock RPCs. In `test/mock-supabase.js`, inside `handleRpc` add (just before the final `json(res, 404, ...)` at ~line 176):

```js
    if (fn === 'archive_project') {
      const teamId = projectTeam(body.p_project);
      if (!isManager(teamId, userId)) return json(res, 403, { message: 'only a team owner or admin can delete a project for the team' });
      const p = projects.find(x => x.id === body.p_project);
      if (p) p.archivedAt = new Date().toISOString();
      return json(res, 200, null);
    }
    if (fn === 'unarchive_project') {
      const teamId = projectTeam(body.p_project);
      if (!isManager(teamId, userId)) return json(res, 403, { message: 'only a team owner or admin can restore a project' });
      const p = projects.find(x => x.id === body.p_project);
      if (p) p.archivedAt = null;
      return json(res, 200, null);
    }
```

- [ ] Teach the mock's read paths to hide archived rows. In `team_feed` (~line 163) add an archived filter to the chain:

```js
        .filter(e => projectTeam(e.project_id) === body.p_team)
        .filter(e => !(projects.find(p => p.id === e.project_id) || {}).archivedAt)
```

  and in the `project_stats` GET handler (~line 257) exclude archived projects:

```js
        const rows = projects
          .filter(p => (!teamEq || p.teamId === teamEq) && isMember(p.teamId, userId) && !p.archivedAt)
```

  (Optional, same one-liner spirit: the auto-link `/rest/v1/projects` GET at ~line 274 may also add `&& !p.archivedAt` so an archived project is never re-suggested. State this if included.)

- [ ] Implement the teamsync wrappers. In `lib/teamsync.js`, after `unlinkProject` (ends line 376), add:

```js
// Soft-delete a shared project for the whole team (reversible). The backend
// archive_project / unarchive_project RPCs enforce the owner/admin gate — these
// are thin wrappers, exactly like removeMember/setRole above.
async function archiveProject(config, projectId) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'archive_project', { p_project: projectId });
}

async function unarchiveProject(config, projectId) {
  const creds = await hubCreds(config);
  await rpc(config, creds, 'unarchive_project', { p_project: projectId });
}
```

  and add both to `module.exports` (line 581, alongside `removeMember, setRole, ...`):

```js
  removeMember, setRole, renameTeam, rotateInvite, leaveTeam,
  archiveProject, unarchiveProject,
```

- [ ] Run `npm test` (expected PASS for the three new archive checks; no regressions).

- [ ] Commit: `feat: add reversible owner/manager project soft-delete (archive RPCs + teamsync wrappers)`.

### Task 3.3: `/api/team/archive-project` route + delete-branch logic (TDD)

Files:
- Modify `test/run-tests.js` (append route checks after the Task 3.2 block, still inside the section-8 `try`)
- Modify `lib/server.js:339` (add `archiveSharedProject` after `deleteProject`) and `lib/server.js:712` (new route after `/api/team/unlink`)

Route-shape decision (stated explicitly): add a new `POST /api/team/archive-project { path }` for the shared-project path and leave `/api/projects/delete` as the LOCAL-only path unchanged. The FE calls `archive-project` for shared projects and `projects/delete` for local-only ones. The new route still resolves the three branches server-side (local-only → local delete; shared+manager → archive+cleanup+unlink; shared+member → unlink only) so the backend is authoritative regardless of which button the FE wires.

Role source for the branch: `teamsync.listTeams()` (`my_teams`) returns each team's `role`; managers = `owner` or `admin`, matching `is_team_manager` (`002_team_v2.sql:35`). The backend `archive_project` RPC is the real authorization; the local role check only decides which branch to run.

- [ ] Write the FAILING tests first. Append to `test/run-tests.js` immediately after the Task 3.2 block:

```js
    // The dashboard route. A plain member (Dana) can only unlink their own
    // machine — never archive for the team.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    const danaClone = path.join(ROOT, 'projects-d', 'archive-app');
    fs.mkdirSync(danaClone, { recursive: true });
    const stDana = util.loadState();
    stDana.projects = { ...(stDana.projects || {}), [danaClone]: { events: [] } };
    util.saveState(stDana);
    await teamsync.linkProject(util.getConfig(), danaClone, team.team_id, 'Acme'); // same project row
    const MEMBER_PORT = 17948;
    const memberSrv = startServer(MEMBER_PORT, { retries: 0 });
    await waitForHttp(`http://127.0.0.1:${MEMBER_PORT}/api/status`);
    const memberDel = await (await fetch(`http://127.0.0.1:${MEMBER_PORT}/api/team/archive-project`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: danaClone }),
    })).json();
    await new Promise(r => memberSrv.close(r));
    check('archive route: a plain member only unlinks locally, never archives for the team', () => {
      assert.strictEqual(memberDel.scope, 'local');
      assert.strictEqual(memberDel.archived, false);
      assert.ok(memberDel.unlinked, 'member path did not unlink');
      assert.ok(!fs.existsSync(path.join(danaClone, '.membridge', 'team.json')), 'member team.json survived');
      assert.ok(!mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'member call archived for the whole team');
    });

    // The owner deletes the shared project over the route: archived for the
    // team AND fully cleaned up locally (team.json gone, project out of state).
    process.env.MEMBRIDGE_HOME = HOME_A;
    const OWNER_PORT = 17949;
    const ownerSrv = startServer(OWNER_PORT, { retries: 0 });
    await waitForHttp(`http://127.0.0.1:${OWNER_PORT}/api/status`);
    const ownerDel = await (await fetch(`http://127.0.0.1:${OWNER_PORT}/api/team/archive-project`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projArch }),
    })).json();
    await new Promise(r => ownerSrv.close(r));
    check('archive route: owner delete archives for the team and cleans up locally', () => {
      assert.strictEqual(ownerDel.scope, 'team');
      assert.strictEqual(ownerDel.archived, true);
      assert.ok(mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'backend project not archived via the route');
      assert.ok(!fs.existsSync(path.join(projArch, '.membridge', 'team.json')), 'team.json survived the archive');
      assert.ok(!util.loadState().projects[projArch], 'project still in local state after delete');
    });
```

- [ ] Run `npm test` (expected FAIL: route returns 404 `not found`; `archiveSharedProject` does not exist).

- [ ] Implement the branch helper. In `lib/server.js`, after `deleteProject` (ends line 339), add:

```js
// Delete a SHARED project. Owners/admins archive it for the whole team
// (reversible soft-delete on the backend) and clean up locally; a plain member
// can only unlink their own machine. The backend archive_project RPC is the
// real authorization — the local role check just picks the branch. A path with
// no team link falls back to a plain local delete.
async function archiveSharedProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath) || path.resolve(projectPath);
  const link = teamsync.loadTeamLink(key);
  if (!link || !link.projectId) {
    return { ...deleteProject(key), scope: 'local' };
  }
  const teams = await teamsync.listTeams(config).catch(() => []);
  const team = (teams || []).find(t => t.team_id === link.teamId);
  const isManager = !!team && ['owner', 'admin'].includes(team.role);
  if (!isManager) {
    // Plain member: unlink this machine only; never archive for the team.
    const unlinked = teamsync.unlinkProject(key);
    return {
      path: key, scope: 'local', archived: false, unlinked,
      message: 'only owners or managers can delete a shared project for the team',
    };
  }
  await teamsync.archiveProject(config, link.projectId);
  teamsync.unlinkProject(key); // drop team.json first
  deleteProject(key);          // then strip injected blocks + wipe local memory/state
  return { path: key, scope: 'team', archived: true };
}
```

- [ ] Add the route. In `lib/server.js`, after the `/api/team/unlink` branch (ends line 712), insert:

```js
    } else if (req.method === 'POST' && url.pathname === '/api/team/archive-project') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      json(res, 200, await archiveSharedProject(p));
```

- [ ] Run `npm test` (expected PASS for both route checks; full suite green).

- [ ] Commit: `feat: add POST /api/team/archive-project with owner-archive / member-unlink branching`.

## Phase 4: Team metadata + real sync timestamp + offline teammate names

Surface member count + team creation date on each team, record a real wall-clock team-sync timestamp separate from the local injection time, and let the offline (degraded) feed still name teammates from locally-cached entries.

Files:
- Modify `supabase/migrations/006_team_meta.sql` (Create)
- Modify `supabase/schema.sql:188-199` (my_teams function)
- Modify `test/mock-supabase.js:79-87` (my_teams handler), `test/mock-supabase.js:54-56` (team creation)
- Modify `lib/server.js:461-514` (teamPayload), `lib/server.js:45-65` (statusPayload)
- Modify `lib/teamsync.js:531-573` (syncTeams)
- Modify `test/run-tests.js` (new check cases)

### Task 4.1: `my_teams` returns member_count + created_at; teamPayload surfaces memberCount/createdAt

Files:
- Modify `test/run-tests.js` (new check after the existing team-payload check at line 875)
- Modify `test/mock-supabase.js:79-87`, `test/mock-supabase.js:54`
- Create `supabase/migrations/006_team_meta.sql`
- Modify `supabase/schema.sql:188-199`
- Modify `lib/server.js:493-513` (teamPayload return)

- [ ] Write the FAILING test. Insert a new `check()` immediately after the existing `dashboard: team payload exposes identity, teams and linked projects without tokens` check (test/run-tests.js:882). Marco is the only member of the just-created `Acme` team here, so member_count must be 1:
```js
    check('dashboard: team payload surfaces member count and creation date', () => {
      const t = dashboardTeam.teams.find(x => x.team_id === team.team_id);
      assert.ok(t, 'team missing from payload');
      assert.strictEqual(t.memberCount, 1, `expected 1 member, got ${t.memberCount}`);
      assert.ok(t.createdAt && !Number.isNaN(Date.parse(t.createdAt)), 'createdAt missing or unparseable');
      // raw RPC columns are preserved for older consumers
      assert.ok('member_count' in t && 'created_at' in t, 'raw RPC columns dropped');
    });
```
- [ ] Run `npm test` — expect FAIL (`t.memberCount` is `undefined`; the mock `my_teams` returns no such column and teamPayload passes rows through untouched).
- [ ] Teach the mock to stamp a creation time on new teams. In `test/mock-supabase.js:54`, add `createdAt`:
```js
      const team = { id: uuid(), name: body.p_name, inviteCode: uuid(), createdAt: new Date().toISOString() };
```
- [ ] Teach the mock `my_teams` handler (test/mock-supabase.js:79-87) to return the two new columns, counting members per team:
```js
    if (fn === 'my_teams') {
      const rows = members.filter(m => m.userId === userId).map(m => {
        const t = teams.get(m.teamId);
        return {
          team_id: m.teamId,
          team_name: t.name,
          role: m.role,
          invite_code: t.inviteCode,
          member_count: members.filter(x => x.teamId === m.teamId).length,
          created_at: t.createdAt || null,
        };
      });
      return json(res, 200, rows);
    }
```
- [ ] Surface the new columns in `teamPayload` (lib/server.js). The current return spreads nothing onto `teams` (it is passed raw at line 502). Replace `teams,` in the return object (line 502) with a mapped version that keeps the raw rows and adds camelCase aliases:
```js
    teams: (teams || []).map(t => ({
      ...t,
      memberCount: typeof t.member_count === 'number' ? t.member_count : null,
      createdAt: t.created_at || null,
    })),
```
- [ ] Run `npm test` — expect PASS.
- [ ] Write the real SQL so a fresh/hosted install matches the mock. Create `supabase/migrations/006_team_meta.sql`:
```sql
-- Add member_count + created_at to my_teams so the dashboard can show team
-- size and age without a second round-trip. Postgres refuses to change a
-- function's RETURNS TABLE via create-or-replace, so DROP then recreate
-- (same pattern as 004_feed_summary.sql). Idempotent/re-runnable. Old clients
-- ignore the extra columns. Run in the Supabase SQL editor or `supabase db push`.

drop function if exists public.my_teams();

create or replace function public.my_teams()
returns table (
  team_id uuid,
  team_name text,
  role text,
  invite_code uuid,
  member_count bigint,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id,
    t.name,
    m.role,
    t.invite_code,
    (select count(*) from public.team_members mc where mc.team_id = t.id),
    t.created_at
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by m.joined_at;
$$;
```
- [ ] Mirror the change in `supabase/schema.sql:188-199` so a fresh install has it (replace the whole `create or replace function public.my_teams()` block with the recreated body above, minus the `drop function` line — schema.sql is the from-scratch definition). Keep the surrounding comment `-- Teams the calling user belongs to (RLS-safe convenience for the CLI).`
- [ ] `git commit -m "feat: my_teams returns member_count + created_at; teamPayload surfaces them"`

### Task 4.2: real team-sync timestamp (`teamLastSync`) recorded on sync and exposed in statusPayload

Files:
- Modify `test/run-tests.js` (new check after the successful `teamsync.syncTeams()` at line 927)
- Modify `lib/teamsync.js:571`
- Modify `lib/server.js:45-64` (statusPayload)

- [ ] Write the FAILING test. The `syncTeams()` at run-tests.js:927 already pushes proj1 successfully (`rA.synced` includes proj1). Add a check right after the existing `team: push uploads only redacted digest entries` check (test/run-tests.js:935):
```js
    check('status: teamLastSync records a real wall-clock time after a successful sync', () => {
      const before = statusPayload();
      assert.ok(before.teamLastSync, 'teamLastSync missing after a successful team sync');
      assert.ok(!Number.isNaN(Date.parse(before.teamLastSync)), 'teamLastSync is not an ISO timestamp');
      // distinct field from the local injection time
      assert.ok('lastSync' in before, 'lastSync field disappeared');
    });
```
Add `statusPayload` to the destructured import at test/run-tests.js:22:
```js
const { startServer, teamPayload, teamProjectsPayload, statusPayload } = require('../lib/server');
```
- [ ] Run `npm test` — expect FAIL (`statusPayload()` has no `teamLastSync`).
- [ ] Record the timestamp in `syncTeams` (lib/teamsync.js). Replace the persist line at teamsync.js:571:
```js
  if (synced.length || suggested.length) {
    if (synced.length) state.teamLastSync = new Date().toISOString();
    util.saveState(state);
  }
```
- [ ] Expose it in `statusPayload` (lib/server.js:55-64). Add `teamLastSync` to the returned object, reading the state already loaded at line 47:
```js
  return {
    running: true,
    pid: process.pid,
    version: require('../package.json').version,
    intervalSec: config.intervalSec,
    projectCount: projects.length,
    tools: [...tools],
    adapters: getAdapters(config).map(a => a.displayName),
    lastSync,
    teamLastSync: state.teamLastSync || null,
  };
```
- [ ] Run `npm test` — expect PASS.
- [ ] `git commit -m "feat: track and expose real teamLastSync separate from local injection time"`

### Task 4.3: offline teammate names in feedPayload's degraded branch

Files:
- Modify `test/run-tests.js` (new check inside the team-sync block, after a teammate has pushed — reuse the joined-member push at ~line 976+)
- Modify `lib/server.js:181-185` (feedPayload return)

- [ ] Write the FAILING test. After the second machine (home-b) joins and pushes teammate entries and machine A pulls them into `proj1.teamEntries`, force the team backend offline and assert the feed still names the teammate. Add this check after machine A has pulled the teammate's rows (locate the check that asserts machine A sees the joined member's activity, in the `home-b`/join block around test/run-tests.js:976-997; add immediately after that block restores `MEMBRIDGE_HOME = HOME_A` at line 997):
```js
    check('feed: offline (degraded) branch still names teammates from cached teamEntries', async () => {
      const savedUrl = process.env.MEMBRIDGE_TEAM_URL;
      process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:1'; // unreachable -> teamUnavailable
      try {
        const res = await feedPayload({ limit: 50 });
        assert.strictEqual(res.teamUnavailable, true, 'expected degraded feed');
        assert.ok(Array.isArray(res.offlineTeammates), 'offlineTeammates should be an array');
        assert.ok(res.offlineTeammates.length >= 1, 'no teammate names derived from cached teamEntries');
        assert.ok(!res.offlineTeammates.includes('You'), 'self should not appear as a teammate');
      } finally {
        process.env.MEMBRIDGE_TEAM_URL = savedUrl;
      }
    });
```
Add `feedPayload` to the import at test/run-tests.js:22:
```js
const { startServer, teamPayload, teamProjectsPayload, statusPayload, feedPayload } = require('../lib/server');
```
Note this check is `async`; register it with the harness's async form (`checkAsync`) if `check` is sync-only — mirror whichever the surrounding async team checks use (the team block already `await`s `teamPayload()` inside `try`, so if `check` does not accept a promise, wrap the body and `await` it, or use `checkAsync` exactly as other awaited assertions in this block do).
- [ ] Run `npm test` — expect FAIL (`res.offlineTeammates` is `undefined`).
- [ ] Derive the names in `feedPayload` (lib/server.js). The `proj.teamEntries` rows carry `.author` (set in teamsync.js pullProject at line 441). Compute distinct authors from every project's cache, only when degraded, and add to the return. Replace the return block at lib/server.js:183-184:
```js
  // Home reads these lightweight flags to pick its empty / no-team state and
  // its suggested-links card without a second round-trip to /api/team.
  const out = feed.buildFeed({ local: f, team, teamUnavailable, limit });
  // When a team is unreachable, the live team_feed rows are gone, but each
  // project cached its last-pulled teammate entries. Derive distinct author
  // names from that cache so the offline headline can still say who was active
  // instead of "unavailable". Empty when the feed is healthy.
  let offlineTeammates = [];
  if (teamUnavailable) {
    const names = new Set();
    for (const proj of Object.values(state.projects || {})) {
      for (const e of proj.teamEntries || []) {
        if (e && e.author && e.author !== 'You') names.add(e.author);
      }
    }
    offlineTeammates = [...names];
  }
  return { ...out, signedIn: !!creds, hasTeam: teamList.length > 0, suggestions, offlineTeammates };
```
- [ ] Run `npm test` — expect PASS.
- [ ] `git commit -m "feat: name teammates from cached teamEntries in the degraded feed"`

## Phase 5: Front-end visual port — v2 dashboard

Rebuild the self-contained page in `lib/dashboard.js` so every surface — app shell, Catch-Up `#home`, the Everything feed, the Project page, Settings, and the auth/onboarding screen — faithfully matches the approved v2 mockup (`docs/design/membridge-dashboard-v2.reference.html`): the warm off-white palette, the exact token system (light + dark via `body[data-theme]`), and the card / chip / section-label / session-card components. In the same pass, wire the new Catch-Up backend (`/api/catchup*`, `/api/feed?since`, `/api/briefing/generate`, `/api/team/archive-project`) and re-express every behavior from the prior behavior-only draft (`docs/design/_drafts/phase5.md`) — local-first unblock, first-run Welcome, plain invite codes, Cursor row, Account/Log-out, role-gated delete — inside the visual rebuild rather than as bolt-ons. The data layer stays: keep `esc()`, `ago()`, `setPill()`, `badgeHtml()`, `dayGroupHtml()`, the fetch loaders, hash routing, and 5 s polling — Phase 5 restyles their **output** and markup, not the plumbing. This FE work has no DOM test harness, so every task verifies manually against the mockup and ends in a conventional commit.

**Files**
- `lib/dashboard.js` — the ~1877-line page: `<style>` (:21–524), surface markup (`#view-auth` :528, header :544, `#view-home` :605, `#view-project` :613, `#view-settings` :617), and the render JS (`applyTheme` :835, `startHome`/`loadHome`/`renderHome` :869–907, `dayGroupHtml` :939, `renderChips` :952, `emptyHomeHtml` :990, the `#view-home` click delegate :1001–1038, modals :1040–1156, `renderScan` :1131, settings renderers :1214–1420, `pjMenuHtml` :1781, `renderProject` :1812).
- `lib/dashboard-team.js` — `teamCss` (:11–48), and inside `teamJs`: `renderTeam` (:129), `invitePanelHtml` (:172), `settingsPanelHtml` (:202), `createJoinPanelHtml` (:222), `handleTeamClick` (:258), `handleTeamSubmit` (:366).
- Read-only references: `docs/design/design-tokens.css`, `docs/design/membridge-dashboard-v2.reference.html`, `docs/brand/svg/membridge-mark-{blue,white,dark}.svg`.

> **Offline invariant (applies to every task):** the page ships with no build step, no CDN, no network. Do **not** add the mockup's Google-Fonts `<link>`. Port the font *families* as graceful stacks that degrade offline: `--display: Calistoga, Georgia, "Times New Roman", serif`, body `Inter, system-ui, -apple-system, "Segoe UI", sans-serif`, `--mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. The mockup itself falls back to `Calistoga,Georgia,serif` inline, so a system stack is design-faithful.

---

### Task 5.1 — Design system: port the v2 tokens (verbatim) + rebuild component CSS

**Files:** `lib/dashboard.js` — replace the `:root` token block (:368–394) and the `body` background rule (:395–401); update the boot theme script (:20), `body:not(.session-ready)` gate stays (:29–30) but delete the signed-out display gate (:31–32); rewire `applyTheme` (:835–842) and the boot inline script (:20) to `body[data-theme]`.

**5.1a — Port the token set verbatim.** Replace the entire `:root { color-scheme: light dark; --bg: light-dark(...); … }` block (:368–394) and the gradient `body` rule (:395–401) with the token system from `docs/design/design-tokens.css`, placed on `body` / `body[data-theme="dark"]` exactly as the template defines it (tokens live on `body`, not `:root`, because the dark theme is an attribute toggle, not `light-dark()`):

```css
html, body { margin: 0; padding: 0; }
body {
  --bg:#FAFAFA; --card:#FFFFFF; --surface2:#F1F5F9; --surface3:#E2E8F0;
  --text:#0F172A; --text2:#64748B; --text3:#94A3B8;
  --border:#E2E8F0; --border2:#CBD5E1;
  --accent:#0052FF; --accent2:#4D7CFF;
  --accent-soft:rgba(0,82,255,.06); --accent-brd:rgba(0,82,255,.3);
  --grad:linear-gradient(135deg,#0052FF,#4D7CFF);
  --inv:#0F172A; --inv-text:#F8FAFC; --inv-text2:rgba(248,250,252,.68);
  --marco:#0052FF; --andrew:#0D9673;
  --amber:#C77414; --amber-soft:rgba(199,116,20,.09);
  --green:#0D9673;
  --shadow-md:0 4px 6px rgba(0,0,0,.07);
  --shadow-xl:0 20px 25px rgba(0,0,0,.1);
  --shadow-accent:0 4px 14px rgba(0,82,255,.25);
  --shadow-accent-lg:0 8px 24px rgba(0,82,255,.35);

  /* --- compatibility aliases: existing component CSS + teamCss reference the
     legacy Minimalist tokens; map them onto the v2 system so nothing we keep
     (feed rows, team panels, modals) breaks. New v2 component CSS below uses
     the v2 names directly. --- */
  --muted: var(--text2);
  --danger:#DC2626;
  --ok: var(--green); --ok-dot: var(--green);
  --bg2: var(--card);
  --surface-subtle: var(--surface2); --surface-raised: var(--surface2);
  --glass: color-mix(in srgb, var(--bg) 84%, transparent);
  --glass-border: var(--border);
  --btn-bg: var(--card);
  --warn: var(--amber);
  --radius:16px;
  --shadow-sm: var(--shadow-md); --shadow-lg: var(--shadow-xl);
  --display: Calistoga, Georgia, "Times New Roman", serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  background: var(--bg); color: var(--text);
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased;
  min-height:100%; display:flex; flex-direction:column; overflow:hidden;
}
body[data-theme="dark"] {
  --bg:#0B1120; --card:#111A2E; --surface2:#16213A; --surface3:#1E293B;
  --text:#F1F5F9; --text2:#94A3B8; --text3:#5B6B84;
  --border:#1E293B; --border2:#334155;
  --accent:#4D7CFF; --accent2:#7A9DFF;
  --accent-soft:rgba(77,124,255,.1); --accent-brd:rgba(77,124,255,.35);
  --grad:linear-gradient(135deg,#2E63FF,#6E93FF);
  --inv:#111A2E; --inv-text:#F8FAFC; --inv-text2:rgba(248,250,252,.6);
  --marco:#4D7CFF; --andrew:#22C08F;
  --amber:#E79A3C; --amber-soft:rgba(231,154,60,.12);
  --green:#22C08F;
  --shadow-md:0 4px 10px rgba(0,0,0,.35);
  --shadow-xl:0 20px 30px rgba(0,0,0,.45);
  --shadow-accent:0 4px 14px rgba(46,99,255,.35);
  --shadow-accent-lg:0 8px 24px rgba(46,99,255,.45);
  --danger:#F87171;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent2); text-decoration: underline; }
@keyframes mbPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:.7}}
@keyframes mbSpin{to{transform:rotate(360deg)}}
@keyframes mbFade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
::selection { background: rgba(0,82,255,.18); }
```

Keep the existing `@keyframes pulse` (:503) so the legacy `.pill::before` / `.section-label::before` references still animate; new components use `mbPulse`. Keep `* { box-sizing: border-box }` (:22) and the `body:not(.session-ready) > * { visibility: hidden }` FOUC gate (:29–30). **Delete** the signed-out display gate at :31–32 (folds in `phase5.md` Task 5.1 — see 5.7).

**5.1b — Rebuild the core component CSS on the v2 tokens.** Rewrite the button, card, chip, section-label, and avatar rules (currently split across :55–71 and :416–453) so they match the mockup. Concretely:

```css
button.btn {
  font: inherit; font-size:13px; font-weight:600; min-height:34px; padding:0 15px;
  border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text);
  cursor:pointer; display:inline-flex; align-items:center; gap:6px;
  transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
}
button.btn:hover { border-color: var(--accent-brd); box-shadow: var(--shadow-md); }
button.btn:active { transform: scale(.98); }
button.btn.primary { border:none; color:#fff; background:var(--grad); box-shadow:var(--shadow-accent); }
button.btn.primary:hover { transform: translateY(-1px); box-shadow: var(--shadow-accent-lg); }
button.btn.ghost { background:transparent; border-color:transparent; box-shadow:none; color:var(--text2); }
button.btn.del, button.btn.danger { color:var(--text2); background:var(--card); border-color:var(--border); }
button.btn.del:hover, button.btn.danger:hover { color:var(--danger); border-color:color-mix(in srgb,var(--danger) 45%,transparent); }
button.btn:disabled { opacity:.5; cursor:default; box-shadow:none; }
button.btn:focus-visible, input:focus-visible, select:focus-visible {
  outline:3px solid var(--accent-soft); outline-offset:2px;
}
.card { background:var(--card); border:1px solid var(--border); border-radius:20px;
  padding:20px 24px; margin-bottom:16px; box-shadow:var(--shadow-md); }
.section-label { display:inline-flex; align-items:center; gap:10px; padding:6px 16px;
  border-radius:99px; border:1px solid var(--accent-brd); background:var(--accent-soft); color:var(--accent);
  font:600 11px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; }
.section-label::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--accent);
  animation:mbPulse 2s ease infinite; }
/* Local-only red pill (kept semantic) + Shared team pill (accent). */
.chip { display:inline-block; font:600 9.5px/1.5 var(--mono); letter-spacing:.08em; text-transform:uppercase;
  padding:1px 8px; border-radius:99px; border:1px dashed var(--border2); color:var(--text3); background:none; }
.team-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 11px; border-radius:99px;
  color:var(--accent); background:var(--accent-soft); border:1px solid var(--accent-brd);
  font:600 9.5px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
.team-chip::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--accent); }
/* Author avatar tile: --marco / --andrew wins for known authors, avColor() otherwise. */
.favatar, .avatar { flex:none; display:inline-flex; align-items:center; justify-content:center; color:#fff;
  font:600 11px/1 var(--mono); border-radius:10px; box-shadow:var(--shadow-md); }
.favatar { width:28px; height:28px; }
```

Retune the header, modal, `.section-head`, `.page-title`/`.gradient-text`, `.pcard`, `#view-project .pj-menu*`, and auth CSS (currently :402–521) so their radii/shadows/type read against the new tokens — e.g. `.page-title { font:400 clamp(38px,5vw,60px)/1.02 var(--display); letter-spacing:-.04em; }`, `.gradient-text { background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }`. Leave `${teamCss}` (:523) untouched — the aliases carry it.

**5.1c — Rewire theme to `body[data-theme]`.** Replace the boot inline script (:20) and `applyTheme` (:835–842) so the theme is an explicit attribute, not `color-scheme`:

```html
<script>try{var t=localStorage.getItem('mb-theme');
  var d=(t==='light'||t==='dark')?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  document.documentElement.dataset.theme=d; }catch(e){}</script>
```

```javascript
function resolveTheme(pref){
  if (pref==='light'||pref==='dark') return pref;
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch(e){ return 'light'; }
}
function applyTheme(pref){
  document.body.dataset.theme = resolveTheme(pref);
  try { if (pref==='light'||pref==='dark') localStorage.setItem('mb-theme',pref); else localStorage.removeItem('mb-theme'); }
  catch(e){}
}
```

Call `applyTheme(themePref())` once at boot (next to `loadTeam()` :1871) so `<body data-theme>` is set before first paint (the early `documentElement` script prevents the flash). The Settings `#stTheme` radios (:641–645, wired :850–854) already call `applyTheme(this.value)` — no change. The header glyph toggle is added in Task 5.2.

**Verify:** `npm run app`; open `#home`, `#settings`, `#project=…`. Toggle System/Light/Dark in Settings and confirm the whole page flips (bg `#FAFAFA`↔`#0B1120`, cards, text, borders) with no unstyled flash on reload. Screenshot each surface in both themes and compare palette against `docs/design/membridge-dashboard-v2.reference.html` rendered light/dark. Confirm no element shows a raw/black default (i.e. every alias resolves).
**Commit:** `git commit -m "refactor(ui): port v2 design tokens and rebuild core component CSS"`

---

### Task 5.2 — App shell + header: wordmark + brand mark, sync label, invite, theme glyph, degraded banner

**Files:** `lib/dashboard.js` — header markup (:544–550); header action wiring (`goHome` :819, `openInvite` :821, `openSettings` :826); `setPill` (:758–761); add a degraded banner element + updater.

**5.2a — Header markup.** Replace :544–550 with the mockup's header: a clickable brand chip (M-bridge mark on a gradient tile + Calistoga wordmark), a flexible spacer, the sync label (mono uppercase pill bound to `/api/status`), Invite, a theme glyph button, and the settings gear. The brand mark is the real MemBridge glyph from `docs/brand/svg/membridge-mark-white.svg` (`M5 20V4l7 9 7-9v16` + `M1 14h22`), inlined white on the blue tile so it is theme-agnostic:

```html
<header>
  <div class="brand" id="goHome" title="Catch-Up">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/>
      </svg>
    </span>
    <span class="brand-word">MemBridge</span>
  </div>
  <span class="grow"></span>
  <button class="pill" id="pill" title="Click to sync now">Synced</button>
  <button class="btn" id="openSignin" title="Sign in to sync with your team">Sign in</button>
  <button class="btn primary" id="openInvite" title="Invite teammates">Invite</button>
  <button class="btn ghost" id="themeToggle" title="Toggle theme" aria-label="Toggle theme">&#9790;</button>
  <button class="btn ghost" id="openSettings" title="Settings" aria-label="Settings">&#9881;</button>
</header>
```

Header/brand CSS (replace :402–411):

```css
header { flex:none; position:sticky; top:0; z-index:40; height:56px; padding:0 28px; gap:10px;
  display:flex; align-items:center; background:var(--bg); border-bottom:1px solid var(--border); }
.brand { display:flex; align-items:center; gap:9px; cursor:pointer; padding:6px 9px; margin-left:-9px;
  border-radius:10px; transition:background .2s; }
.brand:hover { background:var(--surface2); }
.brand-mark { width:26px; height:26px; border-radius:8px; background:var(--grad); box-shadow:var(--shadow-accent);
  display:inline-flex; align-items:center; justify-content:center; }
.brand-mark svg { width:15px; height:15px; }
.brand-word { font-family:var(--display); font-size:16px; letter-spacing:0; }
.pill { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--accent-brd); background:var(--accent-soft);
  color:var(--accent); padding:6px 13px; border-radius:99px; cursor:pointer;
  font:600 10.5px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
.pill::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--green); animation:mbPulse 3s ease infinite; }
.pill.off { border-color:color-mix(in srgb,var(--amber) 45%,transparent); background:var(--amber-soft); color:var(--amber); }
.pill.off::before { background:var(--amber); }
#openSignin { display:none; } body.signed-out #openSignin { display:inline-flex; } body.signed-out #openInvite { display:none; }
```

**5.2b — Sync label from `/api/status`.** `setPill(ok)` (:758) currently prints "Running"/"Unreachable". Repoint it to the mockup's "Synced"/"Offline" copy and, when signed-in, append the real last team-sync time from the Phase-4 `/api/status.teamLastSync`:

```javascript
var setPill = function (ok, teamLastSync) {
  if (!ok) { pillEl.textContent = 'Offline'; pillEl.className = 'pill off'; return; }
  pillEl.textContent = teamLastSync ? 'Synced · ' + ago(teamLastSync) : 'Synced';
  pillEl.className = 'pill';
};
```

Add one lightweight `/api/status` poll inside the existing sync path (reuse `syncNow` :809 and the boot) to pass `teamLastSync`; when the field is absent (older backend) it degrades to plain "Synced". Keep `#pill` as the click-to-sync control (:820).

**5.2c — Theme glyph.** Wire `#themeToggle` next to `openSettings` (:826): it flips between light/dark and updates its glyph:

```javascript
document.getElementById('themeToggle').onclick = function () {
  var next = (document.body.dataset.theme === 'dark') ? 'light' : 'dark';
  applyTheme(next);
  this.innerHTML = next === 'dark' ? '&#9728;' /* ☀ */ : '&#9790;' /* ☾ */;
};
```

Initialise the glyph at boot from `resolveTheme(themePref())`.

**5.2d — Degraded "Team sync unreachable … Retry" banner.** Add a `<div id="syncBanner"></div>` directly under `</header>`. The Home/Project loaders already surface `teamUnavailable`; render the mockup's amber banner into it (pulsing dot + Retry) from a shared helper, cleared when a sync succeeds:

```javascript
function renderSyncBanner(unreachable) {
  var el = document.getElementById('syncBanner');
  el.innerHTML = unreachable
    ? '<div class="sync-banner"><span class="sb-dot"></span>Team sync unreachable — showing your local sessions only. '
      + 'Teammate activity will appear when the connection returns.'
      + '<button class="sb-retry" id="sbRetry">Retry</button></div>' : '';
}
```

```css
.sync-banner { display:flex; align-items:center; gap:9px; max-width:1080px; margin:0 auto; padding:9px 28px;
  background:var(--amber-soft); border-bottom:1px solid var(--border); font-size:12.5px; color:var(--text2); }
.sb-dot { width:7px; height:7px; border-radius:50%; background:var(--amber); flex:none; animation:mbPulse 2s ease infinite; }
.sb-retry { margin-left:auto; background:none; border:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; }
```

Wire `#sbRetry` (delegated) to `syncNow()`.

**Verify:** open `#home`. Confirm the header shows the M-bridge mark on a blue gradient tile + "MemBridge" in the serif display face, the pill reads "Synced · Nm ago", Invite is the gradient primary, and the moon/sun glyph toggles the theme. Kill the backend (or force `teamUnavailable`) and confirm the amber banner appears with a working Retry. Screenshot-compare the header strip to the mockup (`membridge-dashboard-v2.reference.html` lines 80–122).
**Commit:** `git commit -m "feat(ui): v2 app shell — brand mark header, sync label, theme glyph, degraded banner"`

---

### Task 5.3 — Catch-Up `#home` band: split title, AI briefing, since-you-looked, headlines, projects-changed, empty states

**Files:** `lib/dashboard.js` — add a `#homeCatchup` mount atop `#view-home` (:605–611); add `loadCatchup` / `renderCatchup` / `renderWelcome` / `loadBriefing` next to the home JS (~:1038); extend `startHome` (:869) and the `#view-home` click delegate (:1001–1038).

This band is the top of `#home`; the existing grouped feed (Task 5.4) scrolls below it under a "See everything" divider — a single-scroll SPA reconciliation of the mockup's separate Catch-Up / Everything screens (no routing change).

**5.3a — Mount.** Insert above `#homeSuggest` (:606): `<div id="homeCatchup"></div>`.

**5.3b — Load once per Home entry** (not on the 5 s poll — a since-count churning each tick is noise). Change `startHome` (:869):
```javascript
function startHome(){ homeFp=''; loadHome(); loadCatchup(); homeTimer=setInterval(loadHome,5000); }
```

**5.3c — First-run Welcome** (folds in `phase5.md` Task 5.3). Composes `/api/status` + `/api/scan`; reuses the Add-project (`openAdd`) and Detected-tools (`openScan`) modals. Renders the mockup's "Welcome to MemBridge" card (daemon-running ✓ / N tools detected ✓ / dashed "Add your first project" row):
```javascript
function renderWelcome(host) {
  Promise.all([
    fetch('/api/status').then(function(r){return r.json();}).catch(function(){return {};}),
    fetch('/api/scan').then(function(r){return r.json();}).catch(function(){return {adapters:[]};})
  ]).then(function(res){
    var status=res[0]||{}, scan=res[1]||{};
    var found={}; (scan.adapters||[]).filter(function(a){return a.exists;}).forEach(function(a){found[a.displayName]=1;});
    var names=Object.keys(found), n=names.length;
    host.innerHTML =
      '<div class="card"><span class="section-label">Welcome to MemBridge</span>'+
      '<h2 class="cu-title" style="margin:14px 0 6px">One memory. <span class="gradient-text">Every agent.</span></h2>'+
      '<p class="m-help">The daemon is running'+(status.pid?' (pid '+esc(String(status.pid))+')':'')+
        ' and watching for AI activity on this Mac. Your first briefing appears after a work session in a watched project.</p>'+
      '<div class="cu-steps">'+
        '<div class="cu-step"><span class="cu-ok">&#10003;</span><div><strong>Daemon running</strong><span class="cu-dim"> — watching for sessions</span></div></div>'+
        '<div class="cu-step"><span class="cu-ok">&#10003;</span><div><strong>'+(n?n+' tool'+(n===1?'':'s')+' detected':'No tools detected yet')+'</strong>'+
          '<span class="cu-dim"> — '+(n?names.map(esc).join(', '):'MemBridge will pick them up automatically')+'</span></div></div>'+
        '<div class="cu-step"><span class="cu-box"></span><div class="grow"><strong>Add your first project</strong><span class="cu-dim"> — point MemBridge at a folder you code in</span></div>'+
          '<button class="btn" data-catchup="add-project">Add project</button></div>'+
      '</div></div>';
  });
}
```

**5.3d — Loader + renderer** (folds in `phase5.md` Task 5.7). `renderCatchup` selects first-run → not-on-a-team → all-caught-up → active. Reuse `ago()`; `teamState` is the boot `/api/team` payload.
```javascript
var catchupSince = null;
function loadCatchup() {
  var host = document.getElementById('homeCatchup'); if (!host) return;
  fetch('/api/projects').then(function(r){return r.json();}).then(function(projects){
    projects = projects || [];
    if (!projects.length) { renderWelcome(host); return; }
    fetch('/api/catchup').then(function(r){return r.ok?r.json():{};}).then(function(cu){
      cu = cu || {}; catchupSince = cu.lastViewedTs || null;
      var feedP = catchupSince
        ? fetch('/api/feed?since='+encodeURIComponent(catchupSince)+'&limit=50').then(function(r){return r.json();}).catch(function(){return {entries:[]};})
        : Promise.resolve({entries:[]});
      feedP.then(function(f){ renderCatchup(host, cu, (f&&f.entries)||[], projects); });
    }).catch(function(){ host.innerHTML=''; });
  }).catch(function(){ host.innerHTML=''; });
}
```
`renderCatchup` emits the mockup structure: the section-label pill, the split-accent title (`catchupTitlePre` + gradient `catchupTitleAccent`), the "Since you last looked · Nm ago" subline, the Mark/Undo controls, the inverted AI-briefing card (`#cuBriefing`, generate/regenerate relabelled off `cu.hasBriefing`), the Headlines list (reusing `feedEntryHtml` session cards from Task 5.4 for each `since` entry, `.self===false`), and the "Projects — what changed" card list (Shared/Local badges, click → `#project=`). Its title splits like the mockup (`While you were out` / `You're all caught up` / `You're not on a team yet`):
```javascript
function renderCatchup(host, cu, sinceEntries, projects) {
  var onTeam = !!(teamState && (teamState.teams||[]).length);
  var others = sinceEntries.filter(function(e){ return e.self === false; });
  var people = {}; others.forEach(function(e){ if(e.author) people[e.authorId||e.author]=e.author; });
  var names = Object.keys(people).map(function(k){return people[k];});
  var changed = projects.filter(function(p){ return cu.lastViewedTs && p.lastActivity && String(p.lastActivity) > String(cu.lastViewedTs); });

  var titlePre, titleAccent;
  if (!onTeam) { titlePre='You\\u2019re not on'; titleAccent='a team yet'; }
  else if (!others.length) { titlePre='You\\u2019re all'; titleAccent='caught up'; }
  else { titlePre='While you'; titleAccent='were out'; }

  var head = '<span class="section-label">The Catch-Up</span>'+
    '<div class="cu-head"><h1 class="cu-title">'+esc(titlePre)+' <span class="cu-accent">'+esc(titleAccent)+'</span></h1>'+
    (others.length ? '<button class="btn" data-catchup="mark">Mark as caught up</button>' : '')+'</div>';
  var since = cu.lastViewedTs
    ? '<div class="cu-since">Since you last looked — '+esc(ago(cu.lastViewedTs))+'</div>' : '';

  // ---- empty branches ----
  if (!onTeam) { host.innerHTML = head + noTeamCatchupHtml(); return; }
  if (!others.length) { host.innerHTML = head + allCaughtUpHtml(cu); return; }

  // ---- active ----
  var headlineCards = others.map(function(e){ return feedEntryHtml(e, { headline:true }); }).join('');
  var briefing = '<div id="cuBriefing"></div>'+
    '<div class="cu-brief-actions"><button class="btn" data-catchup="brief">'+
      (cu.hasBriefing ? 'Regenerate briefing' : 'Catch me up with AI')+'</button></div>';
  var projRows = (changed.length ? changed : projects.slice(0,5)).map(function(p){
    var badge = p.team ? '<span class="team-chip">Shared</span>' : '<span class="chip">Local only</span>';
    var when = p.lastActivity ? '<span class="fago" data-ago="'+esc(p.lastActivity)+'">'+esc(ago(p.lastActivity))+'</span>' : '';
    return '<div class="mem-row click" data-catchup-open="'+esc(p.path)+'"><div class="grow"><strong>'+esc(p.name)+'</strong> '+badge+'</div>'+when+'</div>';
  }).join('');
  host.innerHTML = head + since + briefing +
    '<section class="cu-section"><div class="cu-section-head"><span class="section-label">Headlines</span>'+
      '<button class="cu-see" data-catchup="see-everything">See everything &darr;</button></div>'+ headlineCards +'</section>'+
    '<section class="cu-section"><span class="section-label">Projects — what changed</span>'+
      '<div class="cu-projs">'+projRows+'</div></section>';
  if (cu.hasBriefing) renderCachedBriefing(cu);   // reconciliation: show prior briefing without regenerating
}
```
`renderCachedBriefing(cu)` populates `#cuBriefing` from the cached `{text, generatedAt}` that `GET /api/catchup` returns when present (per the Phase-1 contract) — so a returning user sees the last briefing immediately. `loadBriefing(btn)` (the explicit generate, avoiding auto-spend) posts `{since:catchupSince}` to `/api/briefing/generate`, renders `d.text` in the inverted card, and shows the degraded "add an API key" hint when `d.degraded`:
```javascript
function briefCardHtml(text, when) {
  return '<section class="brief-card"><div class="brief-grid"></div>'+
    '<div class="brief-head"><span class="brief-spark">&#10022;</span>'+
      '<span class="brief-kicker">Briefing · AI-generated</span>'+
      '<button class="brief-regen" data-catchup="brief">&#8635; Regenerate</button></div>'+
    '<p class="brief-body">'+esc(text||'')+'</p>'+
    (when ? '<div class="brief-when">Generated '+esc(ago(when))+'</div>' : '')+'</section>';
}
function renderCachedBriefing(cu){ var box=document.getElementById('cuBriefing'); if(box&&cu.briefing) box.innerHTML=briefCardHtml(cu.briefing.text, cu.briefing.generatedAt); }
function loadBriefing(btn){
  if (btn.disabled) return; btn.disabled = true;
  var box = document.getElementById('cuBriefing'); if (box) box.innerHTML = '<p class="m-help">Thinking&hellip;</p>';
  fetch('/api/briefing/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({since:catchupSince})})
    .then(function(r){return r.json();}).then(function(d){
      btn.disabled=false; if(!box) return;
      if (d.degraded) { box.innerHTML='<div class="brief-nokey">AI briefing off — <button class="linklike" data-catchup="open-settings">add an API key</button> in Settings for a written summary. The headlines below tell the same story.</div>'; return; }
      box.innerHTML = briefCardHtml(d.text, d.generatedAt);
    }).catch(function(){ btn.disabled=false; if(box) box.innerHTML='<p class="m-help">Briefing unavailable right now.</p>'; });
}
```

**5.3e — Empty-state builders** matching the mockup: `allCaughtUpHtml(cu)` = centered gradient ✓ tile + "You're all caught up" + "Nothing new since …" + an Undo link when `cu.prevViewedTs`; `noTeamCatchupHtml()` = the bordered card with the solid/dashed circle pair, the invite CTA (`data-catchup="go-team"`), and "join an existing team". Both use `.card`, `.section-label`, and the token palette.

**5.3f — Extend the `#view-home` click delegate** (:1001) with the catch-up actions and project-open (folds in `phase5.md` Tasks 5.3 + 5.7). Add near the top of the handler:
```javascript
var cu = e.target.closest('[data-catchup]');
if (cu) { var act = cu.getAttribute('data-catchup');
  if (act==='add-project'){ openAdd(); return; }
  if (act==='detected-tools'){ openScan(); return; }
  if (act==='open-settings'){ location.hash='#settings'; return; }
  if (act==='go-team'){ location.hash='#settings'; setTimeout(scrollToInvite,0); return; }
  if (act==='see-everything'){ var f=document.getElementById('homeFeed'); if(f) f.scrollIntoView({behavior:'smooth'}); return; }
  if (act==='brief'){ loadBriefing(cu); return; }
  if (act==='mark'){ cu.disabled=true;
    fetch('/api/catchup/mark',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(){ loadCatchup(); }).catch(function(){ cu.disabled=false; setPill(false); }); return; }
  if (act==='undo'){ cu.disabled=true;
    fetch('/api/catchup/undo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(){ loadCatchup(); }).catch(function(){ cu.disabled=false; setPill(false); }); return; }
}
var cuOpen = e.target.closest('[data-catchup-open]');
if (cuOpen) { location.hash = '#project=' + encodeURIComponent(cuOpen.getAttribute('data-catchup-open')); return; }
```

Key CSS (novel to this surface):
```css
.cu-head { display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; margin:18px 0 0; }
.cu-title { margin:0; flex:1; font:400 42px/1.05 var(--display); letter-spacing:-.02em; }
.cu-accent { position:relative; background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
.cu-since { color:var(--text3); font-size:12.5px; margin:14px 0 32px; }
.cu-section { margin:40px 0; } .cu-section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.cu-see { background:none; border:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; }
.cu-projs { display:grid; gap:2px; }
/* Inverted AI-briefing spotlight card */
.brief-card { position:relative; overflow:hidden; border-radius:20px; background:var(--inv); color:var(--inv-text);
  padding:28px 30px 26px; margin:8px 0 40px; box-shadow:var(--shadow-xl); }
.brief-grid { position:absolute; inset:0; opacity:.04; pointer-events:none;
  background-image:radial-gradient(circle,#fff 1px,transparent 1px); background-size:32px 32px; }
.brief-head { position:relative; display:flex; align-items:center; gap:9px; margin-bottom:15px; }
.brief-spark { background:linear-gradient(135deg,#6E93FF,#9DB7FF); -webkit-background-clip:text; background-clip:text; color:transparent; }
.brief-kicker { font:600 10.5px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; color:var(--inv-text2); }
.brief-regen { margin-left:auto; background:none; border:none; color:var(--inv-text2); font:inherit; font-size:12px; cursor:pointer; }
.brief-body { position:relative; margin:0; font-size:16.5px; line-height:1.7; color:var(--inv-text); }
.brief-when { margin-top:10px; font:600 9.5px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--inv-text2); }
.brief-nokey { padding:12px 16px; border:1px dashed var(--border2); border-radius:12px; color:var(--text3); font-size:12.5px; margin-bottom:40px; }
.linklike { background:none; border:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; padding:0; }
```

**Verify:** signed in on a team with a teammate's recent activity, open `#home`. Confirm the section-label pill, the split-accent serif title, "Since you last looked — Nm ago", the inverted dark briefing card, expandable Headline session cards, and the Projects-changed list with Shared/Local badges. Click "Mark as caught up" → band flips to the ✓ all-caught-up state with Undo → Undo restores it. Click "Catch me up with AI": with a key a briefing renders in the inverted card; with no key the degraded "add an API key" hint shows. On a machine with zero tracked projects, confirm the Welcome card. Screenshot-compare to mockup lines 124–333.
**Commit:** `git commit -m "feat(ui): Catch-Up home — split title, AI briefing card, mark/undo, headlines, projects-changed, empty states"`

---

### Task 5.4 — Everything feed: session-card anatomy

**Files:** `lib/dashboard.js` — `feedEntryHtml` (:1635–1656) and its expand listener (:1659–1662); the feed-entry / feed-day CSS (:225–275); `renderChips` output CSS (:279–293). This one component is reused by Home headlines (5.3), the Everything feed, and the Project stream (5.5).

Rebuild `feedEntryHtml(e, opts)` to the mockup's session card: an author-colored avatar **tile** (initial), a summary line with an optional amber "Working on: " prefix for WIP (`!e.summary`), a meta row (author `text2`/500, tool badge pill, project mono, optional "in progress · N of M todos" amber-pulse when WIP, time pushed right, chevron), and a click-expandable detail panel (`The ask` italic quote, `Checkpoints` numbered gradient, `Todos` with a progress bar + items, `Files touched` chips). Checkpoints/todos render **only when present** on the entry (Phase 6 backfills them; today's payload has `summary`/`ask`/`files`, which still renders correctly). Author color: `--marco` / `--andrew` for those names, else the existing `avColor()` hash.

```javascript
function feedEntryHtml(e, opts) {
  opts = opts || {};
  var who = e.self ? 'You' : (e.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(e.authorId||'you');
  var wip = !e.summary;
  var avatar = '<span class="favatar" style="background:'+color+'">'+esc((who[0]||'?').toUpperCase())+'</span>';
  var todos = e.todos || [];
  var done = todos.filter(function(t){ return t[1]; }).length;
  var todoLabel = todos.length ? (done+' of '+todos.length+' todos done') : '';
  var summaryLine = '<div class="fsummary">'+(wip?'<span class="fworking-lbl">Working on:&nbsp;</span>':'')+esc(e.summary||e.ask||'')+'</div>';
  var meta = '<div class="fmeta">'+
    '<button class="fperson" data-author="'+esc(e.authorId||who)+'">'+esc(who)+'</button>'+ badgeHtml(e.source)+
    ((opts.hideProject||!e.project)?'':'<button class="fproj" data-project="'+esc(e.projectId||e.projectPath||'')+'" data-path="'+esc(e.projectPath||'')+'" data-id="'+esc(e.projectId||'')+'">'+esc(e.project)+'</button>')+
    (wip&&todoLabel?'<span class="fwip"><span class="fwip-dot"></span>in progress · '+esc(todoLabel)+'</span>':'')+
    '<span class="fago" data-ago="'+esc(e.ts)+'">'+esc(ago(e.ts))+'</span>'+
    '<span class="fchev">&#9662;</span></div>';
  // detail (revealed by .fentry.open)
  var detail = '<div class="fdetail">';
  if (e.ask) detail += '<div class="fd-label">The ask</div><p class="fd-ask">&ldquo;'+esc(e.ask)+'&rdquo;</p>';
  if (e.checkpoints && e.checkpoints.length) detail += '<div class="fd-label">Checkpoints</div><div class="fd-checks">'+
    e.checkpoints.map(function(c,i){ return '<div class="fd-check"><span class="fd-n">'+String(i+1).padStart(2,'0')+'</span><span>'+esc(c)+'</span></div>'; }).join('')+'</div>';
  if (todos.length) detail += '<div class="fd-label">Todos · '+esc(todoLabel)+'</div>'+
    '<div class="fd-bar"><span style="width:'+Math.round(100*done/todos.length)+'%;background:'+(wip?'var(--amber)':'var(--grad)')+'"></span></div>'+
    '<div class="fd-todos">'+todos.map(function(t){ return '<div class="fd-todo'+(t[1]?' done':'')+'"><span>'+(t[1]?'&#10003;':'&#9675;')+'</span><span>'+esc(t[0])+'</span></div>'; }).join('')+'</div>';
  if (e.files && e.files.length) detail += '<div class="fd-label">Files touched</div><div class="fd-files">'+
    e.files.map(function(f){ return '<span class="fd-file">'+esc(f)+'</span>'; }).join('')+'</div>';
  detail += '</div>';
  return '<article class="fentry'+(wip?' pending':'')+(opts.headline?' headline':'')+'">'+
    '<div class="fentry-head">'+avatar+'<div class="grow">'+summaryLine+meta+'</div></div>'+ detail +'</article>';
}
```

Change the expand listener (:1659–1662) to toggle the whole entry, not the clamp:
```javascript
document.addEventListener('click', function (e) {
  var head = e.target.closest ? e.target.closest('.fentry-head') : null;
  if (head && !e.target.closest('.fperson') && !e.target.closest('.fproj')) head.parentNode.classList.toggle('open');
});
```
(Class-based toggle preserves the existing rationale: unchanged polls keep whatever the reader opened.)

Session-card + day-header CSS (replace the `#view-home .fentry…` / `.feed-day` block at :225–275):
```css
.fentry { border-bottom:1px solid var(--border); }
.fentry-head { display:flex; gap:14px; align-items:flex-start; padding:16px 12px 16px 4px; margin:0 -12px 0 -4px;
  cursor:pointer; border-radius:14px; transition:background .2s; }
.fentry-head:hover { background:var(--surface2); }
.favatar { margin-top:1px; }
.fsummary { font-size:15px; font-weight:600; letter-spacing:-.01em; line-height:1.45; color:var(--text); }
.fentry.pending .fsummary { }  .fworking-lbl { color:var(--amber); }
.fmeta { display:flex; align-items:center; gap:9px; margin-top:7px; font-size:12px; color:var(--text3); flex-wrap:wrap; }
.fperson { background:none; border:none; padding:0; font:inherit; font-size:12.5px; font-weight:500; color:var(--text2); cursor:pointer; }
.fperson:hover { color:var(--accent); }
.badge { padding:2px 9px; border-radius:99px; border:1px solid var(--border); font:500 10px/1.4 var(--mono); letter-spacing:.04em; color:var(--text2); background:none; }
.fproj { background:none; border:none; padding:0; font:inherit; font-family:var(--mono); font-size:10.5px; color:var(--text3); cursor:pointer; }
.fproj:hover { color:var(--accent); }
.fwip { display:flex; align-items:center; gap:5px; color:var(--amber); font-weight:600; font-size:11.5px; }
.fwip-dot { width:6px; height:6px; border-radius:50%; background:var(--amber); animation:mbPulse 2s ease infinite; }
.fago { margin-left:auto; white-space:nowrap; } .fchev { color:var(--text3); font-size:10px; transition:transform .2s; }
.fentry.open .fchev { transform:rotate(180deg); }
.fdetail { display:none; margin:2px 0 20px 42px; padding:20px 22px; border-radius:16px; background:var(--card);
  border:1px solid var(--border); box-shadow:var(--shadow-md); animation:mbFade .25s ease; }
.fentry.open .fdetail { display:block; }
.fd-label { font:600 10px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; color:var(--text3); margin:0 0 9px; }
.fd-ask { margin:0 0 18px; font-size:13.5px; font-style:italic; color:var(--text2); line-height:1.65; max-width:58ch; }
.fd-checks { display:grid; gap:8px; margin-bottom:18px; }
.fd-check { display:flex; gap:11px; font-size:13px; color:var(--text2); }
.fd-n { font:500 10.5px/1 var(--mono); background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; margin-top:2px; }
.fd-bar { height:4px; border-radius:2px; background:var(--surface3); max-width:220px; margin-bottom:11px; }
.fd-bar span { display:block; height:4px; border-radius:2px; transition:width .4s; }
.fd-todos { display:grid; gap:6px; margin-bottom:18px; }
.fd-todo { display:flex; gap:9px; font-size:13px; align-items:baseline; color:var(--text); }
.fd-todo.done { color:var(--text3); } .fd-todo.done span:last-child { text-decoration:line-through; }
.fd-files { display:flex; flex-wrap:wrap; gap:6px; }
.fd-file { font-family:var(--mono); font-size:10.5px; padding:4px 9px; border-radius:8px; background:var(--surface2); color:var(--text2); }
.feed-day { margin:28px 0 4px; font:600 10px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; color:var(--text3); }
.feed-day:first-child { margin-top:0; }
```
Restyle the filter chips (`renderChips`/`chipRow` output, CSS :279–293) to the mockup's pill chips: inactive = `1px solid var(--border)` on transparent `var(--text2)`; active (`.on`) = `var(--grad)` fill, white, `box-shadow:var(--shadow-accent)`. `dayGroupHtml` (:939) and `renderChips` (:952) JS are unchanged — only their CSS/`feedEntryHtml` output change.

**Verify:** open `#home`, scroll past the Catch-Up band to the Everything feed. Confirm day headers, session cards with avatar tiles, tool badges, and right-aligned times; click a card to expand The ask / Todos (progress bar) / Files touched; confirm a WIP row shows the amber "Working on:" + "in progress" pulse. Toggle a filter chip and confirm the active pill is the gradient fill. Screenshot-compare to mockup lines 237–294 and 339–366.
**Commit:** `git commit -m "refactor(ui): v2 session-card feed entries with expandable detail"`

---

### Task 5.5 — Project page: header avatars, stats row, roadmap, role-gated ⋯ menu

**Files:** `lib/dashboard.js` — `renderProject` (:1812–1868), `pjMenuHtml` (:1781–1811), the `pjRoot` click handler (:1543–1591); project-page CSS (:152–224, :434).

**5.5a — Header + stats + roadmap.** Restyle `renderProject`'s `head` to the mockup: a "← Catch-Up" back link, the Calistoga project name + `shared · <teamName>` badge (or `local only` chip), the mono `path`, and a member-avatar cluster with "Marco & Andrew · <lastTouched>" (read `detail.members` + `detail.stats` from Phase 6; degrade to just the path when absent). Add the stats strip (`sessions this week` / `files touched` / `open todos`, the last gradient-numbered) from `detail.stats` (`{sessions, files, todos}`), and an active-now pill when `detail.activeNow`. Keep the existing collapsed **Roadmap** `<details>` + `planPanelHtml` (:1849–1851) — it is the app's real roadmap generator; restyle its `> summary` to the mockup's row ("Roadmap · generated from this project's memory · ✦ uses your API key") and keep the Now/Next/Later prose styling for the generated body via `.gradient-text` on the "Now/Next/Later" leads. Stream rows already use the Task-5.4 session card via `dayGroupHtml(entries,{hideProject:true})` (:1834).

```css
#view-project .inner { max-width:780px; padding:48px 28px 110px; }
.pj-back { color:var(--text3); font-size:12.5px; cursor:pointer; margin-bottom:16px; display:inline-block; }
.pj-back:hover { color:var(--text2); }
.pj-head { display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; }
.pj-head h2 { margin:0; font:400 34px/1.1 var(--display); letter-spacing:-.02em; }
.pj-members { display:flex; align-items:center; gap:10px; margin-top:14px; font-size:12.5px; color:var(--text2); }
.pj-avs { display:flex; } .pj-avs .avatar { width:22px; height:22px; border-radius:50%; font-size:10px; border:2px solid var(--bg); box-shadow:none; }
.pj-avs .avatar + .avatar { margin-left:-7px; }
.pj-stats { display:flex; margin:28px 0 10px; border:1px solid var(--border); border-radius:16px; background:var(--card); box-shadow:var(--shadow-md); overflow:hidden; flex-wrap:wrap; }
.pj-stat { flex:1; min-width:120px; padding:16px 20px; border-right:1px solid var(--border); }
.pj-stat:last-child { border-right:none; }
.pj-stat b { font:400 24px/1 var(--display); } .pj-stat.grad b { background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
.pj-stat span { display:block; margin-top:2px; font:600 9.5px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--text3); }
```

**5.5b — Role-gated ⋯ menu** (folds in `phase5.md` Task 5.8). Add a `teamRoleFor` helper above `pjMenuHtml` (:1781) and replace the fixed "Unlink"/"Delete project" tail (:1795–1803) with role gating: a **local-only** project keeps "Delete project…" (existing `openDel` → `/api/projects/delete`); a **shared** project gates the destructive item by the caller's role in that team — a manager (owner/admin, mirroring `invitePanelHtml`'s test at `dashboard-team.js:173`) gets "Delete for the whole team" → `POST /api/team/archive-project { projectId }`; a plain member gets "Remove from my machine" → the existing `/api/team/unlink`.
```javascript
function teamRoleFor(teamId){
  var teams=(teamState&&teamState.teams)||[];
  for (var i=0;i<teams.length;i++) if (teams[i].team_id===teamId) return teams[i].role;
  return null;
}
```
In `pjMenuHtml` (:1795–1803), the destructive tail becomes:
```javascript
if (detail.team) {
  var manager = (function(r){ return r==='owner'||r==='admin'; })(teamRoleFor(detail.team.teamId));
  items += '<button class="pj-mi" data-act="unlink" data-path="'+esc(p)+'">Stop sharing with '+esc(detail.team.teamName||'team')+'</button>';
  items += '<button class="pj-mi" data-act="remove-block" data-path="'+esc(p)+'" data-name="'+esc(detail.name)+'">Remove memory block</button>';
  items += '<div class="pj-mi-sep"></div>';
  items += manager
    ? '<button class="pj-mi danger" data-act="archive" data-project-id="'+esc(detail.team.projectId||'')+'" data-path="'+esc(p)+'" data-name="'+esc(detail.name)+'">Delete for the whole team</button>'
    : '<button class="pj-mi danger" data-act="unlink" data-path="'+esc(p)+'" data-name="'+esc(detail.name)+'">Remove from my machine</button>';
} else {
  items += '<button class="pj-mi" data-act="team-page">Share with a team</button>';
  items += '<button class="pj-mi" data-act="remove-block" data-path="'+esc(p)+'" data-name="'+esc(detail.name)+'">Remove memory block</button>';
  items += '<div class="pj-mi-sep"></div>';
  items += '<button class="pj-mi danger" data-act="del" data-path="'+esc(p)+'" data-name="'+esc(detail.name)+'">Delete project</button>';
}
```
Add the `archive` branch to the `pjRoot` handler beside the `unlink` branch (:1572); the backend does the soft-archive **and** local cleanup + unlink, so on success go `#home`:
```javascript
if (btn.dataset.act === 'archive') {
  if (!armed(btn)) return;
  if (!btn.dataset.projectId) { setPill(false); return; }
  btn.disabled = true;
  fetch('/api/team/archive-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:btn.dataset.projectId})})
    .then(function(r){ return r.json().catch(function(){return {};}).then(function(d){ if(!r.ok) throw new Error(d.error||'archive failed'); }); })
    .then(function(){ location.hash='#home'; })
    .catch(function(){ btn.disabled=false; setPill(false); });
  return;
}
```
Restyle the `.pj-menu` / `.pj-mi` block (:166–196) onto v2 tokens (rounded 16px card, `var(--shadow-xl)`, `.danger` = `var(--danger)`).

**Verify:** open a **shared** project as its **owner** — the header shows member avatars + `shared · <team>` badge + path + stats strip, and the ⋯ menu shows "Delete for the whole team"; arm+confirm archives it and returns to `#home` (project drops from the feed). As a **plain member**, the menu shows "Remove from my machine" (unlink only). A **local-only** project shows the `local only` chip and "Delete project…" → the existing confirm modal. Confirm Roadmap still generates. Screenshot-compare to mockup lines 369–476.
**Commit:** `git commit -m "feat(ui): v2 project page — member avatars, stats strip, role-gated archive/unlink/delete menu"`

---

### Task 5.6 — Settings: team card, members, watched projects, Cursor row, API key, Account + Log out

**Files:** `lib/dashboard.js` — `teamSettingsHtml` (:1268–1291), `accountRowHtml` (:1324–1330), `renderScan` (:1131–1146), `projectsSettingsHtml` (:1348–1362), settings markup (:617–720); `lib/dashboard-team.js` — `settingsPanelHtml` (:202–221), `createJoinPanelHtml` (:222–230), `invitePanelHtml` (:172–201), `handleTeamSubmit` invite-create (:398–408).

**5.6a — Team card + "N members · created <month year>".** In `teamSettingsHtml` (:1281), replace the stat line so it reads the Phase-4 `memberCount` + `createdAt` from `/api/team`: `<role-badge> · N members · created <Mon YYYY>` (format `createdAt` via `new Date(...).toLocaleDateString(undefined,{month:'long',year:'numeric'})`, guarded for absence). Keep the existing switcher/rename/switch controls; restyle the members list (`membersSettingsHtml`, :1294) rows to the mockup's avatar-tile + name + "you · email" + role badge (owner = accent badge, member = neutral) — the row markup already carries avatars and role badges, so this is CSS + the "(you) · email" text.

**5.6b — Account + Log out consistency** (folds in `phase5.md` Task 5.4). Append `accountRowHtml(d)` as the last card of `teamSettingsHtml` (:1284–1290 return) so a signed-in member always gets a standalone Account/Log-out card (matching `noTeamSettingsHtml` at :1322). Remove the now-duplicate profile/logout block from `settingsPanelHtml` (`dashboard-team.js:215–219`) so there is exactly one Log-out; the function ends after the rename/leave rows.

**5.6c — Invite = plain code only** (folds in `phase5.md` Task 5.5). In `invitePanelHtml` (`dashboard-team.js:186–192`) render/copy `inv.token` (not `inv.url`); in `handleTeamSubmit`'s invite-create after-hook (:401–407) `copyText(inv.token)` with the message "Invite code copied — share it and they run \"membridge join <code>\" or paste it in Join a team."; relabel the join field in `createJoinPanelHtml` (:228) to "Invite code" / placeholder "Paste an invite code" (keep the `inviteCode` field name). Delete every `d.webUrl` "Open web workspace" affordance — in `accountRowHtml` (`dashboard.js:1328`) and the removed `settingsPanelHtml` profile block.

**5.6d — Cursor "—" known-tools row** (folds in `phase5.md` Task 5.6). In `renderScan` (:1132–1136) merge a FE display registry so known-but-unconfigured tools still show a greyed "—" row (display-only; ingestion unchanged):
```javascript
var KNOWN_TOOLS = ['Claude Code','Codex','Cursor'];
var seen = {};
var adapterRows = d.adapters.map(function(a){ seen[a.displayName]=true;
  return '<div class="scan-row"><span class="tool">'+esc(a.displayName)+'</span><span class="root">'+esc(a.root)+'</span>'+(a.exists?'':'<span class="missing">(not found)</span>')+'</div>'; }).join('');
adapterRows += KNOWN_TOOLS.filter(function(t){ return !seen[t]; }).map(function(t){
  return '<div class="scan-row"><span class="tool">'+esc(t)+'</span><span class="root" style="color:var(--text3)">&mdash;</span><span class="missing" style="color:var(--text3)">(not configured)</span></div>'; }).join('');
if (!adapterRows) adapterRows = '<div class="scan-row"><span class="root">No adapters configured.</span></div>';
```
Also update the Settings watched-projects footer (mockup line 523) to a "Tools detected: Claude Code ✓ · Codex ✓ · Cursor —" summary line.

**5.6e — Restyle** the Settings markup (:617–720) — section-label kickers ("Team" / "Watched projects" / "AI briefings & roadmaps" / "Account"), rounded `.card`s, the API-key BYOK card with its active/no-key status pill (`renderSettings` :1387 status already computed) — onto v2 tokens. `#stProjectList`, `#stKey`, and all existing IDs/handlers stay wired.

**Verify:** sign in and open `#settings`. Confirm the Team card shows "N members · created <Month Year>", a members list with avatar tiles + role badges, watched projects with pause/remove, "Detected tools" listing a greyed Cursor "—" row, the BYOK key card with an active/no-key status, and exactly one Account card with a working Log out (logging out returns to the local-first Home). Create an invite → confirm it is a plain code (no `http…`), "Copy code" copies just the token, the Join field says "Invite code", and no "Open web workspace" button exists anywhere. Screenshot-compare to mockup lines 478–543.
**Commit:** `git commit -m "feat(ui): v2 settings — team card, members, Cursor row, plain invite codes, Account + Log out"`

---

### Task 5.7 — Auth / onboarding + local-first unblock

**Files:** `lib/dashboard.js` — header gate CSS already added in 5.2 (`#openSignin` / `body.signed-out`), `currentTab` (:766–771), `openSignin` wiring; `lib/dashboard-team.js` — `renderTeam` (:129–164) and the auth-copy line (:154), `handleTeamClick` (:258).

**5.7a — Remove the signed-out takeover** (folds in `phase5.md` Task 5.1). The display gate at `dashboard.js:31–32` was deleted in 5.1; the header `#openSignin`/`#openInvite` toggle was added in 5.2. Rewrite `currentTab` (:766–771) so the auth view is reachable only at `#signin` (signed-out no longer forces it):
```javascript
var currentTab = function () {
  if (location.hash === '#signin') return 'auth';
  if (location.hash === '#settings') return 'settings';
  if (location.hash.indexOf('#project=') === 0) return 'project';
  return 'home';
};
```
Wire `#openSignin` next to `openSettings` (:826): `document.getElementById('openSignin').onclick = function(){ location.hash='#signin'; };`. In `renderTeam` (`dashboard-team.js:133/141/158`), keep setting `document.body.className` to `session-ready signed-out` / `signed-in` but let the hash decide the view — the trailing `applyTab()` calls are now harmless (they show Home unless the hash is `#signin`), so the app chrome (header, Home, Project, Settings) stays usable with no account.

**5.7b — Fixed local-first copy + escape hatch** (folds in `phase5.md` Tasks 5.1–5.2). Replace the stale "neural map" line (`dashboard-team.js:154`) with the local-first promise:
```javascript
'<div class="auth-security">Your account syncs this Mac\\'s redacted project memory with your team. Everything works locally first — signing in only adds shared team memory. Credentials stay in MemBridge\\'s protected local store.</div>';
```
In the not-authenticated form (:153), append a non-blocking escape hatch after the submit button:
```javascript
'<button class="btn ghost" type="button" data-team-action="stay-local" style="margin-top:12px">Continue without an account &rarr;</button></form>' +
```
And in `handleTeamClick` (:262, near the top), add: `if (action === 'stay-local') { location.hash = '#home'; return; }`. The existing email/password forms already provide "Continue with email".

**5.7c — Restyle** the two-column `#view-auth` (markup :528–542, CSS :459–513) onto v2 tokens — the dark story column keeps its radial-dot texture and blurred accent glow, the panel keeps the section-label kicker, the Calistoga "One memory. / Every agent." headline, and the auth-security footer with its gradient ✓. (The mockup's centered single-card auth, lines 58–76, is a simplification of this richer two-column layout; keep the two-column, restyled to the same palette — same fonts, `--grad`, `--accent`, `--text2`.)

**Verify:** `npm run app` with **no** account/creds in the local store. Confirm the header, Home feed, a project page (`#project=`), and Settings all render and are usable; the "Sign in" button shows and Invite is hidden; clicking Sign in opens the two-column auth panel (no "neural map" text, reads as the local-first promise), "Continue with email" shows the email form, and "Continue without an account →" returns to Home. Screenshot-compare the auth panel palette to mockup lines 58–76.
**Commit:** `git commit -m "feat(ui): local-first unblock, non-blocking sign-in, fixed auth copy"`

---

**Cross-surface consistency (hold across all tasks):** one class vocabulary — `.card`, `.section-label`, `.chip`/`.team-chip`, `.favatar`/`.avatar`, `.fentry`/`.fmeta`/`.fdetail`, `.brief-card`, `.mem-row`, `.pj-stat`, `.pj-menu`/`.pj-mi` — every color/shadow/radius via a v2 token (never a raw hex except the brand-mark stroke `#fff` on its gradient tile and the semantic `--danger`); both `body` (light) and `body[data-theme="dark"]` must read correctly; buttons stay `<button>` with `aria-label`/`title`; the data layer (`esc`, `ago`, `setPill`, `dayGroupHtml`, `renderChips`, fetch loaders, hash routing, 5 s polling) is preserved — only the render **output** and markup change. Render functions whose produced HTML changes: `feedEntryHtml`, `renderHome`/`renderChips` (via new mount + CSS), `renderScan`, `teamSettingsHtml`, `accountRowHtml`, `renderProject`, `pjMenuHtml`, plus the new `loadCatchup`/`renderCatchup`/`renderWelcome`/`loadBriefing`; in `dashboard-team.js`: `renderTeam`, `invitePanelHtml`, `settingsPanelHtml`, `createJoinPanelHtml`, `handleTeamSubmit`.

## Phase 6: Project page enrichment (stats, delta, team-aware roadmap)

Add backend read-path enrichments to the project detail payload and the roadmap prompt: a stat row (sessions-this-week, distinct files touched, deduped open todos), a team-aware `lastTouched` + human `activeLabel`, and a roadmap `recentAsks` that folds in teammates' cached entries. All three are pure aggregation over already-available data; teammate todos/checkpoints stay out of scope.

Files
- `lib/memorydb.js` — new `projectStats()` helper (module exports at `lib/memorydb.js:293`).
- `lib/digest.js` — new `relativeLabel()` formatter (exports at `lib/digest.js:335-338`).
- `lib/server.js` — `projectDetail()` (`lib/server.js:242-281`), new `mergeRecentAsks()` above `planPayload()` (`lib/server.js:229-237`), exports at `lib/server.js:807`.
- `test/run-tests.js` — new `check()` cases; server import destructure at `test/run-tests.js:22`.

### Task 6.1: projectStats aggregation helper

Files
- Modify `test/run-tests.js` (add a `check()` in the pure-unit region, after the "project memory DB is created" check at `test/run-tests.js:170`).
- Modify `lib/memorydb.js` (add `projectStats` near `buildEntries`; extend exports at `lib/memorydb.js:293`).

- [ ] Write the FAILING test. Insert after `test/run-tests.js:180` (end of the memory-DB check). `relFile` inside memorydb drops out-of-project paths, so a scratch edit must not count toward `filesTouched`; open todos take the latest snapshot per session:
```js
  check('projectStats: week-windowed sessions, distinct files, deduped open todos', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const iso = d => new Date(now - d * 86400000).toISOString();
    const proj = { events: [
      { kind: 'prompt', source: 'Claude Code', session: 's1', ts: iso(1), text: 'a' },
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(proj1, 'src/login.js') },
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(proj1, 'src/login.js') }, // dup file
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(proj1, 'src/api.js') },
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(ROOT, 'scratch.js') }, // outside project -> dropped
      { kind: 'todos', session: 's1', ts: iso(1), items: [ { text: 'x', status: 'completed' }, { text: 'y', status: 'pending' } ] },
      { kind: 'todos', session: 's1', ts: iso(0.5), items: [ { text: 'x', status: 'completed' }, { text: 'y', status: 'in_progress' }, { text: 'z', status: 'pending' } ] }, // later snapshot -> 2 open
      { kind: 'prompt', source: 'Codex', session: 's2', ts: iso(2), text: 'b' },
      { kind: 'todos', session: 's2', ts: iso(2), items: [ { text: 'q', status: 'pending' } ] }, // 1 open
      { kind: 'prompt', source: 'Claude Code', session: 's3', ts: iso(10), text: 'old' }, // outside 7d window
      { kind: 'edit', source: 'Claude Code', session: 's3', ts: iso(10), file: path.join(proj1, 'src/old.js') }, // still counts (files are all-time)
    ] };
    const stats = memorydb.projectStats(proj1, proj, now);
    assert.strictEqual(stats.sessionsThisWeek, 2, `sessions ${stats.sessionsThisWeek}`); // s1, s2 in window; s3 excluded
    assert.strictEqual(stats.filesTouched, 3, `files ${stats.filesTouched}`); // login, api, old (scratch dropped)
    assert.strictEqual(stats.openTodos, 3, `open ${stats.openTodos}`); // s1 latest snapshot = 2 open, s2 = 1 open
  });
```
- [ ] Run `npm test` — expect this new check to FAIL (`memorydb.projectStats is not a function`).
- [ ] Add the implementation to `lib/memorydb.js` immediately after `buildEntries` (after line 148). It reuses the module-private `relFile` (defined at `lib/memorydb.js:74`) for the project-scoped file filter:
```js
// Aggregate counts for the project page's stat row, all from local events:
// distinct sessions active in the last 7 days, distinct project files ever
// touched, and still-open todos counting only the latest snapshot per session
// (so a session that keeps re-emitting its todo list is not double-counted).
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function projectStats(projectPath, proj, now = Date.now()) {
  const events = Array.isArray(proj && proj.events) ? proj.events : [];
  const weekAgo = now - WEEK_MS;
  const sessions = new Set();
  const files = new Set();
  const latestTodos = new Map(); // session -> { ts, items }
  for (const ev of events) {
    const t = Date.parse(ev.ts);
    if (Number.isFinite(t) && t >= weekAgo) sessions.add(ev.session || '');
    if (ev.kind === 'edit' && ev.file) {
      const rel = relFile(projectPath, ev.file);
      if (rel !== null) files.add(rel);
    } else if (ev.kind === 'todos' && Array.isArray(ev.items)) {
      const s = ev.session || '';
      const prev = latestTodos.get(s);
      if (!prev || String(ev.ts) >= String(prev.ts)) latestTodos.set(s, { ts: ev.ts, items: ev.items });
    }
  }
  let openTodos = 0;
  for (const snap of latestTodos.values()) {
    openTodos += snap.items.filter(i => i && i.status !== 'completed').length;
  }
  return { sessionsThisWeek: sessions.size, filesTouched: files.size, openTodos };
}
```
- [ ] Extend the exports at `lib/memorydb.js:293` to include `projectStats`:
```js
module.exports = { DIR_NAME, buildFileIndex, buildEntries, projectStats, renderMemoryMd, renderCopyText, topLevelNames, updateProject, loadDb, removeProjectMemory, dbPath, mdPath };
```
- [ ] Run `npm test` — expect the new check to PASS (all others unchanged).
- [ ] `git commit -am "feat: add projectStats aggregation (sessions/files/open-todos) to memorydb"`

### Task 6.2: team-aware lastTouched + activeLabel + stats on /api/project

Files
- Modify `test/run-tests.js` (add the server import + two `check()` cases).
- Modify `lib/digest.js` (add `relativeLabel`; extend exports at `lib/digest.js:335-338`).
- Modify `lib/server.js` (`projectDetail` at `lib/server.js:242-281`; exports at `lib/server.js:807`).

- [ ] Extend the server import destructure at `test/run-tests.js:22` so the sync check can call `projectDetail` directly:
```js
const { startServer, teamPayload, teamProjectsPayload, projectDetail } = require('../lib/server');
```
- [ ] Write the FAILING tests. Insert both after the projectStats check from Task 6.1. The first pins `relativeLabel`; the second injects a teammate `teamEntry` with a far-future ts into the already-synced proj1 state, asserts `lastTouched` follows the teammate, then restores state so later tests are unaffected:
```js
  check('relativeLabel: coarse buckets with injectable now', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const iso = d => new Date(now - d * 86400000).toISOString();
    assert.strictEqual(digest.relativeLabel(iso(0), now), 'today');
    assert.strictEqual(digest.relativeLabel(iso(1), now), 'yesterday');
    assert.strictEqual(digest.relativeLabel(iso(3), now), '3 days ago');
    assert.strictEqual(digest.relativeLabel(null, now), 'no activity yet');
  });

  check('projectDetail: a teammate touch drives team-aware lastTouched + activeLabel + stats', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => path.basename(k) === 'shop-app');
    const proj = state.projects[key];
    const localLast = proj.events[proj.events.length - 1].ts;
    const saved = proj.teamEntries;
    const future = '2999-01-01T00:00:00.000Z';
    proj.teamEntries = [{ author: 'Andrew', ts: future, source: 'Codex', ask: 'teammate touch', files: [] }];
    util.saveState(state);
    const det = projectDetail(proj1);
    assert.strictEqual(det.lastTouched, future, `lastTouched ${det.lastTouched} (localLast ${localLast})`);
    assert.strictEqual(det.lastActivity, localLast, 'lastActivity should stay local-only');
    assert.ok(det.stats && typeof det.stats.filesTouched === 'number', 'stats row missing');
    assert.strictEqual(typeof det.activeLabel, 'string', 'activeLabel missing');
    assert.ok(det.activeLabel.length > 0, 'activeLabel empty');
    // restore original state for downstream tests
    const st2 = util.loadState();
    st2.projects[key].teamEntries = saved;
    util.saveState(st2);
  });
```
- [ ] Run `npm test` — expect both new checks to FAIL (`digest.relativeLabel is not a function`; `det.lastTouched` undefined).
- [ ] Add `relativeLabel` to `lib/digest.js` immediately after `shortDate` (after line 102), and add it to the exports at `lib/digest.js:337`:
```js
// Human "delta" label for a project's last-touched timestamp, shown as the
// project page's activity badge. Coarse buckets only — the exact ts is shown
// elsewhere. now is injectable so tests need no wall clock.
function relativeLabel(ts, now = Date.now()) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 'no activity yet';
  const day = 86400000;
  const diff = now - t;
  if (diff < day) return 'today';
  if (diff < 2 * day) return 'yesterday';
  const days = Math.floor(diff / day);
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  return shortDate(ts);
}
```
```js
  compileRedactions, redactText, clip, plainText, shortDate, relativeLabel, recentPrompts, recentFiles,
```
- [ ] In `lib/server.js` `projectDetail`, compute the team-aware values just before the `return` (after `lib/server.js:253`). `digest` and `memorydb` are already required at the top of the file (`lib/server.js:7,9`):
```js
  const teamEntries = proj.teamEntries || [];
  const localLast = proj.events.length ? proj.events[proj.events.length - 1].ts : null;
  const teamLast = teamEntries.reduce((m, e) => (!m || String(e.ts) > String(m) ? e.ts : m), null);
  const lastTouched = [localLast, teamLast].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
```
- [ ] Replace the `lastActivity` line (`lib/server.js:266`) and the `teamEntries` line (`lib/server.js:269`) in the returned object so the payload carries the new fields (keep `lastActivity` local-only as the FE already reads it):
```js
    lastActivity: localLast,
    lastTouched,
    activeLabel: digest.relativeLabel(lastTouched),
    stats: memorydb.projectStats(key, proj),
```
```js
    teamEntries: teamEntries.slice(-50),
```
- [ ] Run `npm test` — expect both new checks to PASS and the existing "/api/project returns the full project-page detail" check (`test/run-tests.js:531`) to stay green.
- [ ] `git commit -am "feat: team-aware lastTouched + activeLabel + stat row on /api/project"`

### Task 6.3: roadmap recentAsks folds in teammate entries

Files
- Modify `test/run-tests.js` (server import destructure at `test/run-tests.js:22`; one `check()` case).
- Modify `lib/server.js` (new `mergeRecentAsks` above `planPayload` at `lib/server.js:229`; `planPayload` body at `lib/server.js:234`; exports at `lib/server.js:807`).

- [ ] Extend the server import destructure at `test/run-tests.js:22` to expose `planPayload`:
```js
const { startServer, teamPayload, teamProjectsPayload, projectDetail, planPayload } = require('../lib/server');
```
- [ ] Write the FAILING test. Insert alongside the other pure-unit checks (after Task 6.2's). It builds a synthetic proj with one local ask and a duplicated teammate `teamEntry`, then asserts the merge dedupes, folds in the teammate, sorts oldest-first, and caps at 20. `buildEntries`/`topLevelNames` read `proj1` from disk, which exists as a fixture:
```js
  check('planPayload: recentAsks merges + dedupes teammate teamEntries, sorted, capped at 20', () => {
    const config = util.getConfig();
    const proj = {
      events: [{ kind: 'prompt', source: 'Claude Code', session: 's1', ts: '2026-07-10T09:00:00.000Z', text: 'Local ask one' }],
      teamEntries: [
        { author: 'Andrew', ts: '2026-07-11T09:00:00.000Z', source: 'Codex', ask: 'Teammate refactor', files: ['src/api.js'] },
        { author: 'Andrew', ts: '2026-07-11T09:00:00.000Z', source: 'Codex', ask: 'Teammate refactor', files: ['src/api.js'] }, // exact dup
      ],
    };
    const payload = planPayload(proj1, proj, config, 'ship it');
    const asks = payload.recentAsks.map(e => e.ask);
    assert.ok(asks.includes('Local ask one'), 'local ask dropped');
    assert.ok(asks.includes('Teammate refactor'), 'teammate ask not folded in');
    assert.strictEqual(asks.filter(a => a === 'Teammate refactor').length, 1, 'teammate ask not deduped');
    assert.ok(payload.recentAsks.length <= 20, 'not capped at 20');
    const iLocal = payload.recentAsks.findIndex(e => e.ask === 'Local ask one');
    const iTeam = payload.recentAsks.findIndex(e => e.ask === 'Teammate refactor');
    assert.ok(iLocal !== -1 && iTeam !== -1 && iLocal < iTeam, 'recentAsks not sorted oldest-first by ts');
  });
```
- [ ] Run `npm test` — expect FAIL: current `planPayload` (`lib/server.js:234`) returns only `buildEntries(...).slice(-20)`, so `Teammate refactor` is absent.
- [ ] Add `mergeRecentAsks` immediately above `planPayload` (before `lib/server.js:229`):
```js
// Fold a shared project's cached teammate entries into the roadmap's recent
// asks so the plan reflects the whole team's recent work, not just this
// machine's. Deduped on source|ts|ask, sorted oldest-first, capped like the
// local-only path was. teamEntries carry no tasks/checkpoints (out of scope) —
// only ts/source/ask/files/summary survive into the prompt.
function mergeRecentAsks(key, proj, config) {
  const local = memorydb.buildEntries(key, proj, config);
  const team = (proj.teamEntries || []).map(e => ({
    ts: e.ts,
    source: e.source,
    ask: e.ask,
    files: Array.isArray(e.files) ? e.files : [],
    summary: e.summary || undefined,
    author: e.author,
  }));
  const seen = new Set();
  const merged = [];
  for (const e of [...local, ...team]) {
    const k = `${e.source}|${e.ts}|${e.ask}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(e);
  }
  merged.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return merged.slice(-20);
}
```
- [ ] Change the `recentAsks` line in `planPayload` (`lib/server.js:234`) to use the merge:
```js
    recentAsks: mergeRecentAsks(key, proj, config),
```
- [ ] Add `planPayload` to the module exports at `lib/server.js:807` (so the unit test can import it):
```js
module.exports = { startServer, statusPayload, projectsPayload, projectDetail, planPayload, toggleProject, addProject, deleteProject, removeBlockFromProject, copyPayload, settingsPayload, saveSettings, teamPayload, teamProjectsPayload, runTeamSync, scanPayload };
```
- [ ] Run `npm test` — expect PASS. Verify the existing plan checks stay green: "plan: /api/project carries the plan, key state and estimate" (`test/run-tests.js:701`) and the roadmap-line-in-context-files check (`test/run-tests.js:693`) both still rely on the local ask "Build the login page with OAuth", which the merge preserves.
- [ ] `git commit -am "feat: fold teammate teamEntries into roadmap recentAsks (deduped, capped)"`

---

## Testing & verification

- **Backend (Phases 1–4, 6):** strict TDD against the zero-dependency harness — `npm test` (`node test/run-tests.js`). Every backend task writes a failing `check()` first, then the minimal implementation. New Supabase RPCs are taught to `test/mock-supabase.js`. The Anthropic call in Phase 2 is exercised via the `MEMBRIDGE_API_BASE` mock server the existing advisor tests use. The full suite must stay green (baseline: 181/181) after every task.
- **Front-end (Phases 0, 5):** no DOM harness — each task verifies manually with `npm run app`, comparing the surface against `docs/design/membridge-dashboard-v2.reference.html` in both light and dark themes, and confirming the wired behavior. Backend endpoints the UI depends on must already be green before the matching FE task.

## Definition of done

- `npm test` green (no regressions; new backend behavior covered).
- Every surface visually matches the v2 mockup in light **and** dark, with no unstyled flash and no raw/default-colored elements.
- The new SQL migrations (`005`, `006`, `007`) are committed and idempotent; `supabase/schema.sql` reflects the same end state so a fresh install matches the live DB.
- All the non-goals stayed unbuilt.
- Final full-implementation code review passes (subagent-driven-development's closing review).
