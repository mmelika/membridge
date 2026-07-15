# Simplified dashboard — one feed, summary-first

**Date:** 2026-07-14
**Status:** Approved by Marco (brainstorming session)

## Problem

The app's job is: open it and immediately see what the team worked on. Today that
takes too many concepts and clicks. Five surfaces (Overview with a marketing hero,
Neural map, Team hub, project pages with four sub-tabs, Settings), two parallel
worlds (local projects vs. team workspace), a filter bar of three select boxes,
member drill-down pages, and admin chrome (invites, roles, share panels,
suggestions) sitting on the same screen as the activity feed. Worse, the feed
shows raw prompts ("asks"), not what actually got done — the `team_feed` RPC
never returns the `summary` column even though pushes store it.

## Decisions (from the brainstorm)

1. Home = **one unified feed**: you + teammates, all projects, newest first.
   The Overview/Team split dies.
2. **Neural map is removed entirely.**
3. **Project pages stay real pages**, with a single merged stream (no sub-tabs).
4. Home layout is a **pure feed**: single centered column, small filter chips,
   no side rails or cards.
5. Implementation approach: **new shell, same plumbing** — one new local
   `/api/feed` endpoint; plus one tiny Supabase migration (function-only) so
   teammates' summaries reach the feed.
6. Entries are **summary-first**: the accomplishment leads, the raw ask is a
   muted secondary line.

## Design

### App structure

Three surfaces, replacing five:

| Surface | Route | Content |
|---|---|---|
| Home | `#home` (default) | The unified feed |
| Project page | `#project=<path>` or `#project=<team-project-id>` | Merged per-project stream (values starting with `/` are local paths; anything else is a team project UUID) |
| Settings | `#settings` | App settings + team management + project management |

- Header: logo · running/sync pill (click = sync now) · **Invite** button
  (jumps to Settings → invite section) · settings gear. Nothing else.
- Sign-in gate (`#view-auth`) is unchanged; signing in lands on Home.
- Removed: tab bar, Overview hero/stats/grid, Neural map (view, canvas
  simulation, `/api/graph` route, `lib/graph.js` if unused elsewhere), member
  pages (`#team-member=` route), team project route (`#team-project=`, folded
  into `#project=`), Add-project/Scan header buttons (move to Settings),
  hub side cards and panels.
- Clicking a person anywhere filters the feed to them (replaces member pages).

### Home feed

**Data.** New route in the local daemon (`lib/server.js`):
`GET /api/feed?author=&project=&source=&before=…` returning one merged,
day-groupable list. Sources:

- Local: entries from every watched project (`.membridge` memory), which carry
  `ask`, `summary`, `distilled`, `files`, `tasks`.
- Team: existing `team_feed` RPC per team the user belongs to (Supabase
  otherwise untouched).

Merge logic lives in a new **`lib/feed.js`** (pure functions, unit-tested):
sort by `ts` descending, dedupe entries present in both sources (your own
pushed work) by `project + ts + ask`, preferring the local copy (it has the
richer summary/distilled data). Pagination: `limit 50`, "Load more" passes a
cursor; the seam between sources is approximate and that is accepted.

**Entry format (summary-first).** Applies to home feed and project page:

- Meta line: avatar (stable per-person color), name ("You" for self), tool
  badge, project pill (→ project page; omitted on the project page itself),
  relative time.
- Body: the **summary** — what got done — clamped to ~3 lines with a
  "more" expander for long ones.
- Muted secondary line: `Asked: <original prompt>`.
- Small mono files line: first file `+N more`.
- No summary yet (running session / non-distilling tool): italic
  `Working on: <ask>` with an "in progress" hint instead of a body. Unfinished
  work must look different from finished work.

**Filters.** Three quiet chips above the feed — person / project / tool —
replacing the select-box filter bar. Chips are populated from the merged data.

**Empty and degraded states.**

- Team backend unreachable → feed still renders local entries with a one-line
  notice ("Team activity unavailable — showing local work"); recovers on next
  poll. Never a dead error page when local data exists.
- Signed in but no team → local entries plus one slim "create or join a team"
  card.
- Nothing at all → the existing "use Claude Code or Codex and it appears here"
  empty state.

**Polling** follows the existing pattern: interval fetch, fingerprint
comparison so unchanged data never rebuilds the DOM, `data-ago` patching.

### Project page

- One merged stream (local + team entries interleaved), same summary-first
  entry format, day-grouped. No sub-tabs.
- Header: name · path · shared-with-team chip · **Copy for AI** · `⋯` menu.
- `⋯` menu absorbs the old Memory tab and admin actions: open memory log,
  context-file targets info, pause/resume, share with team / unlink,
  remove memory block, delete project. Destructive items keep the
  click-again-to-confirm arming pattern.
- **Roadmap** (the old Plan tab) survives as a collapsed section at the bottom;
  expanding reveals exactly today's generator UI. Gated on the API key as now.
- Team-only projects (not on this Mac) use the same template: team activity
  only, plus a "link local folder" action.

### Settings

Existing settings cards stay; two sections are added:

- **Team**: switch team, rename, members list (roles, remove — owner/admin
  gated as today), invite links (create/copy/revoke, legacy code rotate),
  create/join another team, leave team, account row with log out.
- **Projects**: add a project (moves from header), detected-tools scan
  (moves from header modal), and the watched-projects list with pause/delete —
  the way to reach a project that has no recent feed activity.

### Backend change (the one Supabase touch)

Migration `004_feed_summary.sql`: `create or replace function public.team_feed`
with `summary text` added to the return table and `e.summary` to the select.
Function-only — no table, index, or data changes; old clients ignore the extra
column. Also update `supabase/schema.sql` to match.

### What gets deleted

- `#view-neural`, the canvas simulation block in `lib/dashboard.js`,
  `/api/graph`, and `lib/graph.js` (verify no other consumer first).
- Overview hero, stats row, project card grid, marketing copy.
- `lib/dashboard-team.js` hub layout: side cards, panels, and the
  member/team-project sub-routes. (The suggested-links panel is not deleted —
  it moves to a slim card atop the feed.)
- Project sub-tabs (`ptabs`) and per-tab panels.
- Header Add project / Scan buttons and their modals (functionality moves to
  Settings, modals may be reused there).

## Error handling

- `/api/feed` returns `{ entries, teamUnavailable? }` — a team fetch failure
  degrades to local-only with the flag set; a local read failure is a real 500.
- All existing armed-confirm flows and notice patterns are kept.
- Client keeps the stale-response sequence guard when navigating.

## Testing

- TDD for `lib/feed.js` (merge, dedupe, cursor, degradation flags) in
  `test/run-tests.js` — tests written first.
- Existing tests must stay green (hooks, teamsync, dashboard route tests).
- Manual verification: rebuild MemBridge.app, install to /Applications,
  relaunch, verify feed against the live backend with both accounts
  (Marco + Andrew) before calling it done.

## Out of scope

- Web workspace (`web/`) parity — desktop dashboard only for now.
- True unified cursor across sources (Supabase-side feed) — revisit only if
  the seam pagination annoys in practice.
- Auth screen redesign.
