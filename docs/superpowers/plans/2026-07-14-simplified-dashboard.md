# Simplified Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MemBridge's five-surface desktop dashboard with three surfaces — one unified summary-first activity feed (Home), real project pages with a single merged stream, and a Settings surface that absorbs all team/project admin.

**Architecture:** New shell, same plumbing. Add one pure read-model module (`lib/feed.js`, TDD) that merges local `.membridge` memory with the `team_feed` RPC; expose it through one new local route `GET /api/feed`; rebuild the client template (`lib/dashboard.js` + `lib/dashboard-team.js`) into a three-route SPA; and add one function-only Supabase migration so teammates' `summary` reaches the feed. Delete the Neural map, Overview hero, member pages, and team-project sub-route.

**Tech Stack:** Node.js (zero-dependency local daemon over `http`), a self-contained HTML/CSS/ES5 template string served at `/`, Supabase/PostgREST backend, custom zero-dependency test harness in `test/run-tests.js`.

---

## Deviations from the spec (read first)

These were confirmed by reading the code and adjust the spec's assumptions. They do not change the design, only where edits land:

1. **`supabase/schema.sql` needs no `team_feed` change.** The spec says "update `supabase/schema.sql` to match," but `team_feed` is defined in `supabase/migrations/002_team_v2.sql:285-321`, not in `schema.sql`. `schema.sql` is the v1 base (tables only); all team RPCs live in migrations. `memory_entries.summary` already exists in `schema.sql:50-56`. → Migration `004_feed_summary.sql` is the only SQL touch. (Task 9.)
2. **The "three select boxes" filter bar is the Team hub's `filterBarHtml`** (`lib/dashboard-team.js:428-445`), not a bar in `dashboard.js`. `dashboard.js` has no `<select>` filter bar. The new quiet filter *chips* replace `filterBarHtml`. (Tasks 12, 16.)
3. **There is no separate "sync pill" distinct from the status pill.** `#pill` (`lib/dashboard.js:593`) is the running/unreachable indicator; the spec's "running/sync pill (click = sync now)" is implemented by making `#pill` clickable and merging the `#syncNow` action into it. (Task 11.)
4. **`#view-auth` markup is in `dashboard.js:570-584`, but its show/hide logic is in `dashboard-team.js` `loadTeam()`** (`:159-207`, toggles `body.signed-out/signed-in`). Auth stays unchanged; do not touch either. (Respected throughout.)

---

## File structure

**Create:**
- `lib/feed.js` — pure feed read-model: normalize local + team entries, merge, dedupe, paginate, degradation flag. No I/O. (~180 lines)
- `supabase/migrations/004_feed_summary.sql` — `create or replace function public.team_feed` adding `summary`.

**Modify:**
- `lib/server.js` — add `GET /api/feed` branch; delete `GET /api/graph` branch and the now-dead `require('./graph')` import.
- `lib/teamsync.js` — add `summary` to the teammate-activity pull-select (`:431`) so `proj.teamEntries` also carries it.
- `lib/dashboard.js` — rewrite the shell: three-route hash router, new header, Home feed view, summary-first entry template, filter chips; delete Neural map, Overview hero/stats/grid, tab bar, project sub-tabs; rebuild project page; move admin to Settings.
- `lib/dashboard-team.js` — delete hub layout, member page, team-project sub-route, `filterBarHtml`; keep and re-home auth (`loadTeam`), team-management renderers (into Settings), and `suggestionsHtml` (into a slim feed card). Keep `feedListHtml`/helpers reusable.
- `test/run-tests.js` — add section `// --- 13. feed read-model (lib/feed.js) ---` before `--- summary ---` (`:2276`); add an `/api/feed` route assertion in the daemon section.

**Delete:**
- `lib/graph.js` — Neural map graph builder (verify no other consumer first — Task 18).

---

## Phase 1 — Feed read-model (`lib/feed.js`), TDD

The pure core. No file/network access — it transforms already-fetched arrays. This is the only unit-tested module; write tests first, mirroring the `lib/redact.js` table-driven style (`test/run-tests.js:2023-2082`).

### Normalized entry shape (the contract every later task depends on)

```js
// A single feed row after normalization. Local and team rows converge to this.
{
  origin: 'local' | 'team',
  ts: string,                 // ISO8601, the sort key
  self: boolean,              // true when authored by the current user
  author: string,             // display name; 'You' for self
  authorId: string | null,    // team user id (null for local-only entries)
  source: string,             // tool badge, e.g. 'Claude Code', 'Codex'
  project: string,            // display name for the project pill
  projectPath: string | null, // local absolute path -> #project=<path>
  projectId: string | null,   // team project uuid -> #project=<uuid>
  ask: string,                // original prompt (secondary line)
  summary: string | null,     // what got done (primary line); null => in-progress
  distilled: boolean,
  files: string[],
  tasks: object | null,       // { done, total, items } or null
  cursor: { createdAt: string, id: number } | null, // team pagination cursor
}
```

### Task 1: `normalizeLocal` — local `.membridge` entry → normalized

**Files:**
- Create: `lib/feed.js`
- Test: `test/run-tests.js` (new section 13)

- [ ] **Step 1: Write the failing test.** Add near the top-of-file requires (`test/run-tests.js:31`): `const feed = require('../lib/feed');`. Then add a new section before `--- summary ---` (`test/run-tests.js:2276`):

```js
// --- 13. feed read-model (lib/feed.js) ---
check('feed.normalizeLocal maps a buildEntries entry to the normalized shape', () => {
  const e = { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'fix the bug',
    summary: 'Fixed the null deref', distilled: true, files: ['a.js', 'b.js'],
    tasks: { done: 1, total: 2, items: [] } };
  const n = feed.normalizeLocal(e, { projectPath: '/Users/x/proj', projectName: 'proj', projectId: 'uuid-1' });
  assert.strictEqual(n.origin, 'local');
  assert.strictEqual(n.self, true);
  assert.strictEqual(n.author, 'You');
  assert.strictEqual(n.summary, 'Fixed the null deref');
  assert.strictEqual(n.ask, 'fix the bug');
  assert.strictEqual(n.distilled, true);
  assert.strictEqual(n.project, 'proj');
  assert.strictEqual(n.projectPath, '/Users/x/proj');
  assert.strictEqual(n.projectId, 'uuid-1');
  assert.deepStrictEqual(n.files, ['a.js', 'b.js']);
  assert.strictEqual(n.cursor, null);
});
check('feed.normalizeLocal treats a missing summary as in-progress (summary=null)', () => {
  const n = feed.normalizeLocal({ ts: '2026-07-14T06:00:00Z', source: 'Codex', ask: 'do a thing', files: [] },
    { projectPath: '/p', projectName: 'p', projectId: null });
  assert.strictEqual(n.summary, null);
  assert.strictEqual(n.distilled, false);
  assert.strictEqual(n.projectId, null);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `node test/run-tests.js 2>&1 | grep -E "normalizeLocal|Cannot find module"`. Expected: FAIL — `Cannot find module '../lib/feed'`.

- [ ] **Step 3: Create `lib/feed.js` with `normalizeLocal`.**

```js
'use strict';

// Pure feed read-model. Transforms already-fetched arrays (no fs/network):
// local .membridge entries (memorydb.buildEntries) and team_feed RPC rows are
// normalized to one shape, merged newest-first, deduped where the same pushed
// work appears in both, and paginated with an approximate cross-source cursor.

function normalizeLocal(e, meta) {
  return {
    origin: 'local',
    ts: e.ts || '',
    self: true,
    author: 'You',
    authorId: null,
    source: e.source || '',
    project: meta.projectName || '',
    projectPath: meta.projectPath || null,
    projectId: meta.projectId || null,
    ask: e.ask || '',
    summary: e.summary || null,
    distilled: !!e.distilled,
    files: Array.isArray(e.files) ? e.files : [],
    tasks: e.tasks || null,
    cursor: null,
  };
}

module.exports = { normalizeLocal };
```

- [ ] **Step 4: Run to verify it passes.** Run: `node test/run-tests.js 2>&1 | grep normalizeLocal`. Expected: two `ok` lines.

- [ ] **Step 5: Commit.**

```bash
git add lib/feed.js test/run-tests.js
git commit -m "feat: add feed.normalizeLocal read-model helper"
```

### Task 2: `normalizeTeam` — `team_feed` RPC row → normalized

**Files:**
- Modify: `lib/feed.js`
- Test: `test/run-tests.js` (section 13)

- [ ] **Step 1: Write the failing test** (append to section 13):

```js
check('feed.normalizeTeam maps a team_feed row and detects self by author id', () => {
  const row = { id: 42, project_id: 'uuid-9', project_name: 'shared', author_id: 'me',
    author_name: 'Marco', ts: '2026-07-14T05:00:00Z', source: 'Claude Code',
    ask: 'ship it', summary: 'Shipped', files: ['x.js'], created_at: '2026-07-14T05:00:01Z' };
  const mine = feed.normalizeTeam(row, { selfUserId: 'me' });
  assert.strictEqual(mine.origin, 'team');
  assert.strictEqual(mine.self, true);
  assert.strictEqual(mine.author, 'You');
  assert.strictEqual(mine.summary, 'Shipped');
  assert.strictEqual(mine.projectId, 'uuid-9');
  assert.strictEqual(mine.projectPath, null);
  assert.deepStrictEqual(mine.cursor, { createdAt: '2026-07-14T05:00:01Z', id: 42 });
  const theirs = feed.normalizeTeam(row, { selfUserId: 'someone-else' });
  assert.strictEqual(theirs.self, false);
  assert.strictEqual(theirs.author, 'Marco');
});
check('feed.normalizeTeam tolerates a summary-less row (pre-migration backend)', () => {
  const n = feed.normalizeTeam({ id: 1, project_id: 'p', project_name: 'p', author_id: 'a',
    author_name: 'A', ts: '2026-07-14T05:00:00Z', source: 'Codex', ask: 'q', files: [],
    created_at: '2026-07-14T05:00:00Z' }, { selfUserId: 'me' });
  assert.strictEqual(n.summary, null);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `node test/run-tests.js 2>&1 | grep normalizeTeam`. Expected: FAIL — `feed.normalizeTeam is not a function`.

- [ ] **Step 3: Add `normalizeTeam` to `lib/feed.js`** (above `module.exports`, and add it to the exports):

```js
function normalizeTeam(row, opts) {
  const self = !!(opts && opts.selfUserId && row.author_id === opts.selfUserId);
  return {
    origin: 'team',
    ts: row.ts || '',
    self,
    author: self ? 'You' : (row.author_name || ''),
    authorId: row.author_id || null,
    source: row.source || '',
    project: row.project_name || '',
    projectPath: null,
    projectId: row.project_id || null,
    ask: row.ask || '',
    summary: row.summary || null,
    distilled: false,
    files: Array.isArray(row.files) ? row.files : [],
    tasks: null,
    cursor: (row.created_at != null && row.id != null)
      ? { createdAt: row.created_at, id: row.id } : null,
  };
}
```

Update exports: `module.exports = { normalizeLocal, normalizeTeam };`

- [ ] **Step 4: Run to verify it passes.** Run: `node test/run-tests.js 2>&1 | grep normalizeTeam`. Expected: two `ok` lines.

- [ ] **Step 5: Commit.**

```bash
git add lib/feed.js test/run-tests.js
git commit -m "feat: add feed.normalizeTeam read-model helper"
```

### Task 3: `buildFeed` — merge, dedupe, sort, paginate, degradation flag

**Files:**
- Modify: `lib/feed.js`
- Test: `test/run-tests.js` (section 13)

Dedupe rule (from spec): entries present in both sources — your own pushed work — collapse by `project + ts + ask`, preferring the **local** copy (richer summary/distilled). Local project identity aligns to team identity via `projectId` when the local project is linked; otherwise the local key uses its path and no team row can collide with it.

- [ ] **Step 1: Write the failing test** (append to section 13):

```js
check('feed.buildFeed merges newest-first and drops the team dup of local self work', () => {
  const local = [feed.normalizeLocal(
    { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'same ask', summary: 'local rich', files: [] },
    { projectPath: '/p', projectName: 'p', projectId: 'uuid-1' })];
  const team = [
    feed.normalizeTeam({ id: 5, project_id: 'uuid-1', project_name: 'p', author_id: 'me', author_name: 'Marco',
      ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'same ask', summary: 'team copy',
      files: [], created_at: '2026-07-14T06:00:02Z' }, { selfUserId: 'me' }),
    feed.normalizeTeam({ id: 6, project_id: 'uuid-2', project_name: 'other', author_id: 'you', author_name: 'Andrew',
      ts: '2026-07-14T07:00:00Z', source: 'Codex', ask: 'their ask', summary: 'their work',
      files: [], created_at: '2026-07-14T07:00:01Z' }, { selfUserId: 'me' }),
  ];
  const res = feed.buildFeed({ local, team, teamUnavailable: false, limit: 50 });
  assert.strictEqual(res.entries.length, 2, 'the duplicated self team row is dropped');
  assert.strictEqual(res.entries[0].ask, 'their ask', 'newest first');
  assert.strictEqual(res.entries[1].summary, 'local rich', 'local copy kept over team dup');
  assert.strictEqual(res.teamUnavailable, false);
});
check('feed.buildFeed honors limit and returns a nextBefore cursor', () => {
  const team = [1, 2, 3].map(i => feed.normalizeTeam(
    { id: i, project_id: 'p', project_name: 'p', author_id: 'x', author_name: 'X',
      ts: '2026-07-14T0' + i + ':00:00Z', source: 'Codex', ask: 'a' + i, summary: 's' + i,
      files: [], created_at: '2026-07-14T0' + i + ':00:00Z' }, { selfUserId: 'me' }));
  const res = feed.buildFeed({ local: [], team, teamUnavailable: false, limit: 2 });
  assert.strictEqual(res.entries.length, 2);
  assert.strictEqual(res.entries[0].ask, 'a3');
  assert.strictEqual(res.nextBefore, res.entries[1].ts, 'cursor is the ts of the last returned entry');
});
check('feed.buildFeed passes through the teamUnavailable degradation flag', () => {
  const res = feed.buildFeed({ local: [], team: [], teamUnavailable: true, limit: 50 });
  assert.strictEqual(res.teamUnavailable, true);
  assert.deepStrictEqual(res.entries, []);
  assert.strictEqual(res.nextBefore, null);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `node test/run-tests.js 2>&1 | grep buildFeed`. Expected: FAIL — `feed.buildFeed is not a function`.

- [ ] **Step 3: Add `buildFeed` (and a private `dedupeKey`) to `lib/feed.js`:**

```js
// Collision key for "the same pushed work in both sources". A linked local
// project shares projectId with its team rows; unlinked locals fall back to
// path, which no team row carries, so they never collide.
function dedupeKey(e) {
  const proj = e.projectId || e.projectPath || e.project || '';
  return proj + ' ' + (e.ts || '') + ' ' + (e.ask || '');
}

function buildFeed(input) {
  const local = Array.isArray(input.local) ? input.local : [];
  const team = Array.isArray(input.team) ? input.team : [];
  const limit = input.limit > 0 ? input.limit : 50;

  const seen = new Set(local.map(dedupeKey));
  const merged = local.concat(team.filter(t => !seen.has(dedupeKey(t))));
  merged.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const page = merged.slice(0, limit);
  const nextBefore = merged.length > limit && page.length ? page[page.length - 1].ts : null;
  return { entries: page, teamUnavailable: !!input.teamUnavailable, nextBefore };
}
```

Update exports: `module.exports = { normalizeLocal, normalizeTeam, buildFeed };`

- [ ] **Step 4: Run to verify it passes.** Run: `node test/run-tests.js 2>&1 | grep buildFeed`. Expected: three `ok` lines.

- [ ] **Step 5: Run the full suite to confirm no regression.** Run: `npm test`. Expected: final line `N/N checks passed` (all green).

- [ ] **Step 6: Commit.**

```bash
git add lib/feed.js test/run-tests.js
git commit -m "feat: add feed.buildFeed merge/dedupe/paginate helper"
```

---

## Phase 2 — Local `GET /api/feed` route

### Task 4: Wire `/api/feed` into the daemon

**Files:**
- Modify: `lib/server.js` (add branch near the deleted `/api/graph` at `:470`; add `require('./feed')` at top with the other requires `:2-13`)
- Test: `test/run-tests.js` (daemon section 5, near the `/api/team/feed` assertion pattern)

Behavior: merge local entries across **all** watched projects with team activity from **every** team the user belongs to. A team-fetch failure degrades to local-only with `teamUnavailable: true` (never a 500); a local read failure is a real 500. Shape: `{ entries, teamUnavailable, nextBefore }`. Query params: `author`, `project`, `source`, `before` (ISO ts), `limit` (default 50).

- [ ] **Step 1: Write the failing test.** In the daemon section (mirror `test/run-tests.js:1200-1216`, which already spins up `startServer`), add after an existing `/api/*` assertion:

```js
const feedRes = await (await fetch(`${base}/api/feed?limit=50`)).json();
check('/api/feed returns a merged entries array with a degradation flag', () => {
  assert.ok(Array.isArray(feedRes.entries), 'entries is an array');
  assert.ok('teamUnavailable' in feedRes, 'response carries the teamUnavailable flag');
  assert.ok(feedRes.entries.every(e => 'summary' in e && 'origin' in e),
    'every entry is normalized (has origin + summary)');
});
```

(Use the same `base`/`startServer` handle already established earlier in section 5; if none is in scope at your insertion point, follow the `hubSrv`/`hubBase` setup at `:1200-1204`.)

- [ ] **Step 2: Run to verify it fails.** Run: `node test/run-tests.js 2>&1 | grep "/api/feed"`. Expected: FAIL — entries undefined (route returns 404 `{error:'not found'}`).

- [ ] **Step 3: Add the require.** In `lib/server.js`, after `const memorydb = require('./memorydb');` (`:9`) add:

```js
const feed = require('./feed');
```

- [ ] **Step 4: Add a `feedPayload` builder** near `projectsPayload` (`lib/server.js:67-98`). It normalizes local across all projects, fetches team feeds per team, and delegates merge to `lib/feed.js`:

```js
// Unified cross-project, cross-team feed. Local memory is always available;
// each team is fetched independently so one unreachable team degrades to a
// flag instead of failing the whole feed.
async function feedPayload(opts) {
  const config = getConfig();
  const state = loadState();
  const creds = teamsync.loadCredentials();
  const selfUserId = creds ? creds.userId : null;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;

  // Local: every watched project's entries, tagged with project identity.
  const local = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (!Array.isArray(proj.events)) proj.events = [];
    const link = teamsync.loadTeamLink(key);
    const meta = { projectPath: key, projectName: path.basename(key), projectId: link ? link.projectId : null };
    for (const e of memorydb.buildEntries(key, proj, config)) local.push(feed.normalizeLocal(e, meta));
  }

  // Team: team_feed RPC per membership. Any failure -> degrade, don't throw.
  let team = [];
  let teamUnavailable = false;
  if (creds) {
    let teams = [];
    try {
      teams = await teamsync.listTeams(config);
    } catch { teamUnavailable = true; }
    for (const t of teams) {
      try {
        const rows = await teamsync.teamFeed(config, t.team_id, {
          author: opts.author, project: opts.project, source: opts.source,
          beforeCreatedAt: opts.before || null, limit,
        });
        for (const r of rows || []) team.push(feed.normalizeTeam(r, { selfUserId }));
      } catch { teamUnavailable = true; }
    }
  }

  // Client-side filters also apply to local rows (team rows already filtered by the RPC).
  const f = local.filter(e =>
    (!opts.author || e.author === opts.author || e.authorId === opts.author) &&
    (!opts.project || e.projectPath === opts.project || e.projectId === opts.project) &&
    (!opts.source || e.source === opts.source) &&
    (!opts.before || String(e.ts) < String(opts.before)));

  return feed.buildFeed({ local: f, team, teamUnavailable, limit });
}
```

- [ ] **Step 5: Add the route branch.** In `handle` (`lib/server.js`), replace the `/api/graph` branch at `:470-471` with the `/api/feed` branch (mirrors the `/api/team/feed` param parsing at `:535-550`):

```js
} else if (req.method === 'GET' && url.pathname === '/api/feed') {
  const q = k => String(url.searchParams.get(k) || '').trim() || null;
  const limit = parseInt(url.searchParams.get('limit'), 10);
  json(res, 200, await feedPayload({
    author: q('author'), project: q('project'), source: q('source'),
    before: q('before'), limit: Number.isFinite(limit) ? limit : 50,
  }));
```

(This both adds `/api/feed` and removes `/api/graph` — see Task 18 for the import cleanup.)

- [ ] **Step 6: Run to verify it passes.** Run: `node test/run-tests.js 2>&1 | grep "/api/feed"`. Expected: `ok`.

- [ ] **Step 7: Run the full suite.** Run: `npm test`. Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: add local /api/feed unified merged-feed route"
```

---

## Phase 3 — Supabase: surface teammate summaries

### Task 5: Migration `004_feed_summary.sql`

**Files:**
- Create: `supabase/migrations/004_feed_summary.sql`

- [ ] **Step 1: Write the migration** (re-declares `team_feed` from `002_team_v2.sql:285-321` verbatim, adding `summary text` to the RETURNS TABLE and `e.summary` to the SELECT; identical `language sql / security definer / set search_path = public / stable` footer; header style matches `003`):

```sql
-- Add teammates' `summary` to the team feed. The pushes table already stores
-- summary (schema.sql), but team_feed never returned it, so the unified feed
-- could only show raw asks. Function-only change: no table/index/data touched.
-- Old clients ignore the extra column. Run in the Supabase SQL editor, or
-- `supabase db push`, on backends created before this fix.

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
```

- [ ] **Step 2: Verify it applies against the mock backend.** The mock's `team_feed` (`test/mock-supabase.js:159-175`) must return `summary`. Confirm/adjust the mock so its `team_feed` handler includes `summary` on each returned row (it stores summary already per `test/run-tests.js:979-988`). Run: `node test/run-tests.js 2>&1 | grep -iE "team.?feed|summary"`. Expected: existing team-feed tests stay green.

- [ ] **Step 3: Add a mock/route assertion that team summaries reach `/api/feed`.** In the team section (section 8, after members/feed are seeded with a summary-bearing entry), assert a team entry surfaces `summary` through `/api/feed`. Run: `npm test`. Expected: all green.

- [ ] **Step 4: Commit.**

```bash
git add supabase/migrations/004_feed_summary.sql test/mock-supabase.js test/run-tests.js
git commit -m "feat: team_feed returns summary (migration 004) so the feed is summary-first"
```

> **Manual step (not code):** apply `004_feed_summary.sql` to the live Supabase backend before the app can show teammates' summaries. Flag this to Marco at handoff — it is required for the feed to be summary-first for team entries.

### Task 6: Carry `summary` into the teammate-activity pull-select

**Files:**
- Modify: `lib/teamsync.js:431` (the `select` that populates `proj.teamEntries` during background sync)

- [ ] **Step 1:** Read `lib/teamsync.js` around `:425-435` to confirm the select string. It currently selects `author_name,ts,source,ask,files,created_at`.

- [ ] **Step 2:** Add `summary` to that select list so `proj.teamEntries` rows carry it (keeps project-page team entries summary-first even off the RPC path). Change `...ask,files,...` → `...ask,summary,files,...`.

- [ ] **Step 3:** Run: `npm test`. Expected: all green (the mock returns rows with a `summary` column; the pull path already tolerates its absence per the fallback at `lib/teamsync.js:409-416`).

- [ ] **Step 4: Commit.**

```bash
git add lib/teamsync.js
git commit -m "feat: pull teammate summary into local teamEntries"
```

---

## Phase 4 — Client shell: three-route SPA

From here the client template is rebuilt. There are no unit tests for the template string; verification is `npm test` (route/daemon tests must stay green) plus the manual app rebuild in Phase 8. Commit after each task so a regression is bisectable. Keep the existing self-contained ES5 style — no build step, no new deps.

Reusable helpers that MUST survive (do not delete): `esc`, `ago`, `toolHex`, `badgeHtml`, `setPill` (`dashboard.js:795-830`); `refreshAgo` (`:939-942`); the fingerprint-gate pattern (`:966-968`, `:1300-1302`); and in the team module `feedListHtml` + its avatar/day-group helpers (`dashboard-team.js:294-325`) and `loadTeam`/auth logic (`:159-207`).

### Task 7: Collapse the router to three routes

**Files:**
- Modify: `lib/dashboard.js` — `currentTab()` (`:835-843`), `applyTab()` (`:847-860`), `applyRun()` (`:862-874`), hashchange wiring (`:875-879`).

- [ ] **Step 1: Replace `currentTab()`** (`:835-843`) so only `home` / `project` / `settings` / `auth` exist (default `home`):

```js
function currentTab() {
  if (document.body.className.indexOf('signed-out') !== -1) return 'auth';
  if (location.hash === '#settings') return 'settings';
  if (location.hash.indexOf('#project=') === 0) return 'project';
  return 'home';
}
```

- [ ] **Step 2: Replace `applyTab()`** (`:847-860`) to toggle `.active` only on `#view-home`, `#view-project`, `#view-settings`, `#view-auth` (drop `#view-overview`, `#view-neural`, `#view-team` and all `#tab-*` lit-state):

```js
function applyTab() {
  var t = currentTab();
  document.getElementById('view-home').classList.toggle('active', t === 'home');
  document.getElementById('view-project').classList.toggle('active', t === 'project');
  document.getElementById('view-settings').classList.toggle('active', t === 'settings');
  applyRun();
}
```

- [ ] **Step 3: Replace `applyRun()`** (`:862-874`) to start/stop only the surviving pollers:

```js
function applyRun() {
  stopHome(); stopProject();
  var t = currentTab();
  if (t === 'home') startHome();
  else if (t === 'project') startProject();
  else if (t === 'settings') loadSettings();
  else if (t === 'auth') loadTeam();
}
```

- [ ] **Step 4:** Keep `window.addEventListener('hashchange', applyTab)` and the `visibilitychange` handler (`:875-876`); delete the three `#tab-*` onclick wirings (`:877-879`).

- [ ] **Step 5:** `npm test` — route tests must stay green (the `/` page still serves). Commit:

```bash
git add lib/dashboard.js
git commit -m "refactor: collapse dashboard router to home/project/settings"
```

### Task 8: New header (logo · status/sync pill · Invite · gear)

**Files:**
- Modify: `lib/dashboard.js` header markup (`:586-598`) and its wiring.

- [ ] **Step 1: Replace the `<header>` block** (`:586-598`) with:

```html
<header>
  <div class="brand" id="goHome"><span class="dot"></span>MemBridge</div>
  <span class="grow"></span>
  <span class="pill" id="pill" title="Click to sync now">Running</span>
  <button class="btn" id="openInvite" title="Invite teammates">Invite</button>
  <button class="btn" id="openSettings" title="Settings">&#9881;</button>
</header>
```

- [ ] **Step 2: Wire the header** (replace the deleted tab/add/scan wiring). `#goHome` → `location.hash = '#home'`; `#pill` click → the existing sync action (reuse the body of `syncNow` at `:881-893`, minus its neural/overview branches — after sync, refresh Home if active); `#openInvite` → `location.hash = '#settings'` then focus the invite section (Task 15 anchors `#settings-invite`); `#openSettings` → `location.hash = '#settings'`.

```js
document.getElementById('goHome').onclick = function () { location.hash = '#home'; };
document.getElementById('pill').onclick = syncNow;
document.getElementById('openInvite').onclick = function () { location.hash = '#settings'; setTimeout(scrollToInvite, 0); };
document.getElementById('openSettings').onclick = function () { location.hash = '#settings'; };
```

- [ ] **Step 3:** Trim `syncNow` (`:881-893`) to sync then `if (currentTab()==='home') { homeFp=''; loadHome(); }`. Delete `#addProject`/`#openScan` handlers (`:1021`, `:1104`) and the Add/Scan modals (`#addOverlay` `:604-640` region, `#scanOverlay` `:641-651`) — their function moves to Settings (Task 16), where the modal markup may be reused.

- [ ] **Step 4:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "feat: simplified header — logo, sync pill, invite, settings"
```

### Task 9: Summary-first entry template (shared by Home + Project)

**Files:**
- Modify: `lib/dashboard.js` — replace `entryHtml` (`:1345-1351`) and `teamEntryHtml` (`:1352-1357`) with one `feedEntryHtml(e)` over the normalized shape.

- [ ] **Step 1: Add `feedEntryHtml(e)`** near the old `entryHtml`. It reads the normalized fields (Task 1 shape). Summary leads; in-progress (no summary) looks different; ask is the muted secondary line; person and project are clickable filters/links:

```js
function personColor(id) {           // stable per-person avatar color
  var s = String(id || 'you'); var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ',55%,55%)';
}
function feedEntryHtml(e, opts) {
  opts = opts || {};
  var who = e.self ? 'You' : (e.author || 'Someone');
  var avatar = '<span class="favatar" style="background:' + personColor(e.authorId || 'you') + '">'
    + esc((who[0] || '?').toUpperCase()) + '</span>';
  var person = '<button class="fperson" data-author="' + esc(e.authorId || who) + '">' + esc(who) + '</button>';
  var proj = (opts.hideProject || !e.project) ? '' :
    '<button class="fproj" data-project="' + esc(e.projectId || e.projectPath || '') + '"'
    + ' data-path="' + esc(e.projectPath || '') + '" data-id="' + esc(e.projectId || '') + '">' + esc(e.project) + '</button>';
  var meta = '<div class="fmeta">' + avatar + person + badgeHtml(e.source) + proj
    + '<span class="fago" data-ago="' + esc(e.ts) + '">' + esc(ago(e.ts)) + '</span></div>';
  var body;
  if (e.summary) {
    body = '<div class="fsummary' + (e.distilled ? ' distilled' : '') + '">' + esc(e.summary) + '</div>'
      + '<div class="fask">Asked: ' + esc(e.ask) + '</div>';
  } else {
    body = '<div class="fworking">Working on: ' + esc(e.ask) + ' <span class="fhint">in progress</span></div>';
  }
  var files = (e.files && e.files.length)
    ? '<div class="afiles">' + esc(e.files[0]) + (e.files.length > 1 ? ' +' + (e.files.length - 1) + ' more' : '') + '</div>' : '';
  return '<div class="fentry' + (e.summary ? '' : ' pending') + '">' + meta + body + files + '</div>';
}
```

- [ ] **Step 2: Add matching CSS** in the `<style>` block (near the old `.aentry`/`.aresult` rules `:195-287`, which can be removed once no longer referenced): `.fentry`, `.fentry.pending` (visually distinct — e.g. dashed left border / muted), `.fmeta`, `.favatar`, `.fperson`, `.fproj`, `.fago`, `.fsummary` (clamp to ~3 lines with `-webkit-line-clamp`), `.fsummary.distilled`, `.fask` (muted), `.fworking` (italic), `.fhint`, `.afiles` (small mono). Use existing theme CSS variables (match the dark-mode spec palette already in the file).

- [ ] **Step 3:** Add a "more" expander for clamped summaries — a delegated click handler that toggles a `.expanded` class removing the line-clamp. (Keep it CSS-class based so polling rebuilds don't lose state unless content changed.)

- [ ] **Step 4:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "feat: summary-first feed entry template"
```

### Task 10: Home feed view

**Files:**
- Modify: `lib/dashboard.js` — add `#view-home` container (replacing `#view-overview` at `:653-674`); add `startHome`/`stopHome`/`loadHome`/`renderHome`.

- [ ] **Step 1: Replace the `#view-overview` container** (`:653-674`) with a pure single-column feed shell:

```html
<div id="view-home"><div class="inner">
  <div id="homeSuggest"></div>
  <div id="homeChips" class="chips"></div>
  <div id="homeNotice"></div>
  <div id="homeFeed"></div>
  <div id="homeMore"></div>
</div></div>
```

- [ ] **Step 2: Add the poller + loader** (mirror `startOverview`/`loadOverview` `:927-989` and the fingerprint gate `:966-968`). `loadHome` fetches `/api/feed` with current chip filters, gates on a fingerprint, then `renderHome(d)`; on unchanged data it only calls `refreshAgo('view-home')`:

```js
var homeTimer = null, homeFp = '', homeFilters = { author: null, project: null, source: null }, homeBefore = null;
function startHome() { homeFp = ''; homeBefore = null; loadHome(); homeTimer = setInterval(loadHome, 5000); }
function stopHome() { if (homeTimer) clearInterval(homeTimer); homeTimer = null; }
function feedUrl() {
  var q = ['limit=50'];
  if (homeFilters.author) q.push('author=' + encodeURIComponent(homeFilters.author));
  if (homeFilters.project) q.push('project=' + encodeURIComponent(homeFilters.project));
  if (homeFilters.source) q.push('source=' + encodeURIComponent(homeFilters.source));
  return '/api/feed?' + q.join('&');
}
function loadHome() {
  fetch(feedUrl()).then(function (r) { return r.json(); }).then(function (d) {
    setPill(true);
    var fp = JSON.stringify(d);
    if (fp === homeFp) { refreshAgo('view-home'); return; }
    homeFp = fp; renderHome(d);
  }).catch(function () { setPill(false); });
}
```

- [ ] **Step 3: Add `renderHome(d)`** — day-grouped entries via `feedEntryHtml`, the filter chips (Task 12), the degraded/empty states (Task 13), the suggested-links slim card (Task 14), and a "Load more" button when `d.nextBefore`:

```js
function renderHome(d) {
  renderChips(d.entries);
  document.getElementById('homeSuggest').innerHTML = suggestCardHtml(d);
  document.getElementById('homeNotice').innerHTML = d.teamUnavailable
    ? '<div class="notice">Team activity unavailable — showing local work.</div>' : '';
  var feed = document.getElementById('homeFeed');
  if (!d.entries.length) { feed.innerHTML = emptyHomeHtml(d); document.getElementById('homeMore').innerHTML = ''; return; }
  feed.innerHTML = dayGroupHtml(d.entries, {});     // reuse the team module's day-group helper
  document.getElementById('homeMore').innerHTML = d.nextBefore
    ? '<button class="btn" id="homeMoreBtn" data-before="' + esc(d.nextBefore) + '">Load more</button>' : '';
}
```

- [ ] **Step 4:** Add a delegated click handler on `#view-home` for: `.fperson` → set `homeFilters.author` and reload; `.fproj` → `location.hash = '#project=' + (data-path || data-id)`; `#homeMoreBtn` → append the next page (fetch `feedUrl() + '&before=' + before`, concatenate entries). Reuse the team module's day-grouping helper (extract `dayGroupHtml` from `feedListHtml` `dashboard-team.js:294-325`, or call `feedListHtml` adapted to `feedEntryHtml`).

- [ ] **Step 5:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "feat: home unified feed view"
```

### Task 11: Filter chips

**Files:**
- Modify: `lib/dashboard.js` — `renderChips`, chip CSS.

- [ ] **Step 1: Add `renderChips(entries)`** — derive distinct persons / projects / tools from the merged entries and render three quiet chip rows into `#homeChips`. Active chip reflects `homeFilters`; clicking a chip toggles that filter and calls `homeFp=''; loadHome()`. A chip set is omitted when it has ≤1 distinct value.

```js
function renderChips(entries) {
  var people = {}, projects = {}, tools = {};
  entries.forEach(function (e) {
    people[e.authorId || e.author] = e.author;
    if (e.project) projects[e.projectId || e.projectPath] = e.project;
    if (e.source) tools[e.source] = e.source;
  });
  var el = document.getElementById('homeChips');
  el.innerHTML =
    chipRow('author', people, homeFilters.author) +
    chipRow('project', projects, homeFilters.project) +
    chipRow('source', tools, homeFilters.source);
}
function chipRow(kind, map, active) {
  var keys = Object.keys(map); if (keys.length <= 1) return '';
  return '<div class="chiprow">' + keys.map(function (k) {
    return '<button class="chip' + (active === k ? ' on' : '') + '" data-chip="' + kind + '" data-val="' + esc(k) + '">'
      + esc(map[k]) + '</button>';
  }).join('') + '</div>';
}
```

- [ ] **Step 2:** Add the `.chips`/`.chiprow`/`.chip`/`.chip.on` CSS (quiet, pill-shaped, themed). Add a `[data-chip]` click handler in the `#view-home` delegate that sets `homeFilters[kind] = (already active ? null : val)` and reloads.

- [ ] **Step 3:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "feat: quiet filter chips on the home feed"
```

### Task 12: Empty, degraded & no-team states

**Files:**
- Modify: `lib/dashboard.js` — `emptyHomeHtml`, `suggestCardHtml`.

- [ ] **Step 1: Add `emptyHomeHtml(d)`** covering the two nothing-states: signed-in-no-team → local entries plus a slim "create or join a team" card; truly nothing → the existing "use Claude Code or Codex and it appears here" copy (reuse the current overview empty-state string). Read team presence from a lightweight field — extend `/api/feed` payload with `hasTeam`/`signedIn` booleans (add to `feedPayload` return in Task 4: `signedIn: !!creds, hasTeam: teams.length > 0`), or fetch `/api/team` once. Prefer extending `/api/feed` to avoid an extra request.

- [ ] **Step 2:** Ensure the degraded notice (already wired in `renderHome`) never replaces local entries — it renders above the feed only.

- [ ] **Step 3:** `npm test`; commit:

```bash
git add lib/dashboard.js lib/server.js
git commit -m "feat: home empty/degraded/no-team states"
```

### Task 13: Suggested-links slim card

**Files:**
- Modify: `lib/dashboard.js` — `suggestCardHtml`; source the data from `/api/team` `suggestions` (`lib/server.js:392-396`) or fold `suggestions` into the `/api/feed` payload.

- [ ] **Step 1:** Port `suggestionsHtml` (`dashboard-team.js:419-427`) to a slim single-card `suggestCardHtml(d)` rendered into `#homeSuggest` (top of feed). Keep the two actions `suggest-accept` / `suggest-dismiss` and their POST to `/api/team/suggestion` (handlers currently at `dashboard-team.js:741-742` — re-home them into the Home delegate or a shared handler).

- [ ] **Step 2:** Add `suggestions` to the `/api/feed` payload (cheap: reuse the block at `lib/server.js:392-396`) so Home needs no extra fetch.

- [ ] **Step 3:** `npm test`; commit:

```bash
git add lib/dashboard.js lib/server.js
git commit -m "feat: suggested-links slim card atop the feed"
```

---

## Phase 5 — Project page

### Task 14: Merged project stream (no sub-tabs)

**Files:**
- Modify: `lib/dashboard.js` — `renderProject` (`:1468-1547`), `loadProject` (`:1291-1308`), delete `ptabs` scaffold (`:1475-1479`), panels (`:1483-1534`), `applyPjTab` (`:1549-1559`).

- [ ] **Step 1:** Point the project page at the unified feed: `loadProject` fetches `/api/feed?project=<pathOrId>` for the stream **and** `/api/project?path=<path>` for header/roadmap/memory metadata (or extend `/api/feed` with a project-detail block; simplest is two fetches merged before the fingerprint gate). The `#project=` value may be a local path (starts with `/`) or a team UUID — pass it straight through as the `project` filter; the server matches both (`feedPayload` filter in Task 4).

- [ ] **Step 2:** Rewrite `renderProject(d)` to emit: header (name · path · shared-with-team chip · **Copy for AI** button · `⋯` menu) then one day-grouped merged stream via `feedEntryHtml(e, { hideProject: true })`. Remove the four-panel `ptabs` structure entirely.

- [ ] **Step 3:** Delete `applyPjTab` (`:1549-1559`) and the `.ptab` click branch in the `pjRoot` delegate (`:1314-1315`); keep the `pjRoot` delegate for the new `⋯` menu and Copy button.

- [ ] **Step 4:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "feat: project page single merged stream"
```

### Task 15: Project `⋯` menu + collapsed Roadmap

**Files:**
- Modify: `lib/dashboard.js` — new `⋯` menu; keep Roadmap generator (`:1362-1467`) as a collapsed section.

- [ ] **Step 1:** Build a `⋯` menu that absorbs the old Memory tab + admin actions: open memory log (`/api/project/memory?path=`), context-file targets info, pause/resume (`POST /api/projects/toggle`), share-with-team / unlink, remove memory block, delete project. Preserve the **click-again-to-confirm arming** pattern used by the existing destructive `button[data-act]` handlers (`:1319-1338`).

- [ ] **Step 2:** Keep the Roadmap generator (`planPanelHtml`/`planResultHtml`/`generateRoadmap` `:1384-1467`) intact but render it inside a collapsed `<details class="roadmap">` at the bottom of the project page; expanding reveals today's generator UI. Gate on `d.hasKey` exactly as now (locked card links to `#settings`). Preserve the `#pjGoal` draft-preservation logic (`:1537-1545`) and the `pjBusy` guard.

- [ ] **Step 3:** Team-only project (no local folder): same template, team activity only, plus a "link local folder" action (port `open-local`/`link-selected` from `dashboard-team.js:576-587`).

- [ ] **Step 4:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "feat: project ⋯ menu and collapsed roadmap section"
```

---

## Phase 6 — Settings absorbs admin

### Task 16: Team + Projects sections in Settings

**Files:**
- Modify: `lib/dashboard.js` Settings view (`:682-772`, `renderSettings` `:1172-1205`); reuse team-management renderers from `lib/dashboard-team.js` (`settingsPanelHtml` `:390-409`, `invitePanelHtml` `:360-389`, `membersCardHtml` `:446-462`, `createJoinPanelHtml` `:410-418`, and their handlers `:765-834`).

- [ ] **Step 1: Add a Team section** to Settings with an `id="settings-invite"` anchor (Invite button target from Task 8, via `scrollToInvite`): switch team, rename, members list (roles/remove, owner/admin gated), invite links (create/copy/revoke, legacy code rotate), create/join another team, leave team, account row with log out. Reuse the existing team-management HTML builders and their `handleTeamClick`/`handleTeamChange`/`handleTeamSubmit` handlers — these stay in the team module; mount their output into the Settings DOM and keep the existing `authRoot`/`teamRoot` event delegation working by pointing it at the Settings container.

- [ ] **Step 2: Add a Projects section** to Settings: add-a-project (port `openAdd`/`submitAdd` `:996-1029` and reuse the `#addOverlay` markup moved here), detected-tools scan (port `openScan`/`renderScan` `:1081-1102` and the `#scanOverlay` markup), and the watched-projects list with pause/delete — the way to reach a project with no recent feed activity (each row links to `#project=<path>`).

- [ ] **Step 3:** Add `scrollToInvite()` → `document.getElementById('settings-invite').scrollIntoView()`.

- [ ] **Step 4:** `npm test`; commit:

```bash
git add lib/dashboard.js lib/dashboard-team.js
git commit -m "feat: settings absorbs team and project management"
```

---

## Phase 7 — Delete the removed surfaces

### Task 17: Delete Neural map, Overview, tab bar (client)

**Files:**
- Modify: `lib/dashboard.js`; **Delete:** `lib/graph.js` (Task 18 verifies first).

- [ ] **Step 1:** Delete Neural: HTML `#view-neural` (`:774-789`); CSS blocks (`:283-287`, `:527-528`); all JS `:1561-1972` (`startNeural`/`stopNeural`/`fetchGraph`/`buildGraph`/`stepSim`/`resizeCanvas`/`frame`/`project`/`draw`/`pickNode`/`renderPanel` etc.); the `#tab-neural` button and neural branches in `applyTab`/`applyRun`/`syncNow` (already handled in Tasks 7–8).

- [ ] **Step 2:** Delete Overview leftovers: any residual `#view-overview` markup and `startOverview`/`stopOverview`/`projectCard`/`loadOverview`/`stat` (`:927-989`) — superseded by Home (Task 10). Delete `.hero`/`.stats`/`.grid`/`.orb`/`.float-card` CSS.

- [ ] **Step 3:** Confirm no dangling references: `grep -nE "view-neural|startNeural|fetchGraph|loadOverview|projectCard|ptabs|#tab-|/api/graph" lib/dashboard.js`. Expected: no matches.

- [ ] **Step 4:** `npm test`; commit:

```bash
git add lib/dashboard.js
git commit -m "refactor: delete neural map, overview hero, tab bar"
```

### Task 18: Delete `/api/graph`, `lib/graph.js`, and the graph test

**Files:**
- Modify: `lib/server.js` (import at `:10`); **Delete:** `lib/graph.js`; Modify `test/run-tests.js` (graph test in section 4, `:241-321`).

- [ ] **Step 1: Verify no other consumer.** Run: `grep -rnE "require\\(['\\\"]\\./graph['\\\"]\\)|buildGraph|/api/graph" lib app test`. Expected: only `lib/server.js:10` (import), the section-4 graph test in `test/run-tests.js`, and `test/run-tests.js:22` (`const { buildGraph } = require('../lib/graph')`). If anything else appears, stop and reassess.

- [ ] **Step 2:** Remove `const { buildGraph } = require('./graph');` (`lib/server.js:10`). (The `/api/graph` branch was already replaced in Task 4.)

- [ ] **Step 3:** Remove the graph pieces from `test/run-tests.js`: the `require('../lib/graph')` at `:22` and the neural-graph assertions in section 4 (`:241-321` — keep the session-id/state-migration tests in that section, remove only the graph ones). Rename the section banner from `neural graph` accordingly.

- [ ] **Step 4:** `git rm lib/graph.js`.

- [ ] **Step 5:** Run: `npm test`. Expected: all green, no `Cannot find module './graph'`.

- [ ] **Step 6: Commit.**

```bash
git add lib/server.js test/run-tests.js
git rm lib/graph.js
git commit -m "refactor: remove /api/graph route and lib/graph.js"
```

### Task 19: Delete hub layout, member page, team-project sub-route (team module)

**Files:**
- Modify: `lib/dashboard-team.js` — delete unused renderers; keep auth (`loadTeam` `:159-207`), `feedListHtml` + helpers (`:294-325`), `badgeHtml`/avatar helpers, and the team-management builders now consumed by Settings (Task 16).

- [ ] **Step 1:** Delete `renderHub` (`:487-496`), `hubHeaderHtml` (`:336-352`), `membersCardHtml`/`projectsCardHtml`/`shareCardHtml` as a hub side-rail (retain member-list rendering if Settings reuses it — keep `membersCardHtml`, delete the hub grid assembly), `filterBarHtml` (`:428-445`, superseded by chips), `renderMemberPage` (`:512-564`), `renderProjectPage` (`:567-620`), and the `#team-member=`/`#team-project=` route parsing in `teamSubView` (`:138-144`) plus `renderCurrent` member/project branches (`:261-266`).

- [ ] **Step 2:** Repoint `open-member` triggers (feed authors `:313`, member rows `:451`, contributors `:599`) to set a **feed author filter** instead of navigating (or delete now-unused trigger sites). Repoint `open-project`/`open-local` to `#project=`.

- [ ] **Step 3:** The `#view-team` mount (`teamHtml` `:78-83`) and the `#view-team` container in `dashboard.js` (`:676` inject point) are no longer routed — remove the container; keep `teamCss`/`teamJs` injection points (`:565`, `:1163`) since Settings still uses team-module code.

- [ ] **Step 4:** `grep -nE "renderHub|team-member=|team-project=|filterBarHtml|renderMemberPage|renderProjectPage" lib/dashboard-team.js lib/dashboard.js`. Expected: no matches (except intentional Settings reuse).

- [ ] **Step 5:** `npm test`; commit:

```bash
git add lib/dashboard.js lib/dashboard-team.js
git commit -m "refactor: delete team hub layout, member pages, team-project route"
```

---

## Phase 8 — Verification

### Task 20: Full suite + app rebuild + live check

**Files:** none (verification only).

- [ ] **Step 1: Full test suite green.** Run: `npm test`. Expected: `N/N checks passed`, exit 0. All pre-existing tests (hooks, teamsync, dashboard routes, distillation, redaction, consent) plus the new feed tests pass.

- [ ] **Step 2: Dead-reference sweep.** Run: `grep -rnE "view-neural|/api/graph|ptabs|filterBarHtml|team-member=|team-project=|loadOverview" lib app`. Expected: no matches.

- [ ] **Step 3: Rebuild MemBridge.app and reinstall** (per the project memory: rebuild + reinstall after large changes). Follow the repo's build script (`scripts/`), install to `/Applications`, relaunch.

- [ ] **Step 4: Manual verification against the live backend** — before calling it done, sign in with **both** accounts (Marco + Andrew), apply migration `004_feed_summary.sql` to the live backend first, and confirm:
  - Home shows a unified, summary-first feed (newest first) across both accounts and all projects.
  - Clicking a person filters the feed; clicking a project pill opens its page.
  - A running/undistilled session shows the "Working on:" in-progress style.
  - Killing team connectivity degrades to local-only with the notice, and recovers on the next poll.
  - Project page shows one merged stream, `⋯` menu actions work (with armed-confirm on destructive ones), and the collapsed Roadmap still generates.
  - Settings holds all team + project management; Invite jumps to the invite section.
  - Neural map, Overview hero, member pages, and team-project route are gone.

- [ ] **Step 5:** Update `README.md` / `CHANGELOG.md` if they describe the old five-surface UI (out of the core change but keep docs honest).

- [ ] **Step 6: Final commit** (if any doc updates):

```bash
git add README.md CHANGELOG.md
git commit -m "docs: update for simplified three-surface dashboard"
```

---

## Self-review notes (author checklist, resolved)

- **Spec coverage:** Home unified feed (Tasks 10–13), summary-first entries (Task 9), neural removed (Tasks 17–18), project pages single stream + ⋯ + collapsed roadmap (Tasks 14–15), pure feed shell (Tasks 7–8), `/api/feed` (Task 4), `lib/feed.js` merge/dedupe/cursor/degradation TDD (Tasks 1–3), migration 004 (Task 5), Settings team+projects (Task 16), empty/degraded/no-team states (Task 12), suggested-links moved (Task 13), polling/fingerprint/data-ago reused (Tasks 10, 14). All spec sections map to a task.
- **Type/name consistency:** the normalized entry shape (Task 1) is the single contract used by `normalizeLocal`/`normalizeTeam`/`buildFeed` (Tasks 1–3), `feedPayload` (Task 4), and `feedEntryHtml`/`renderHome`/`renderChips` (Tasks 9–11). `homeFilters`/`homeFp`/`homeBefore`/`feedUrl`/`loadHome`/`renderHome`/`startHome`/`stopHome` are used consistently across Tasks 7, 10, 11, 12.
- **Deviations** from the spec are listed at the top (schema.sql, filter-bar location, single status pill, auth ownership) and reflected in the tasks.
