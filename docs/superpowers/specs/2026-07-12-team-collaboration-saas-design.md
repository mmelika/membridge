# MemBridge Team Collaboration SaaS — Design

**Date:** 2026-07-12
**Status:** Draft — pending Marco's approval
**Decisions made:** Hosted web app + local daemon · free beta (no billing this phase) · priorities: onboarding/invites, activity visibility, team management · stack: Next.js + Supabase on Vercel

## Goal

Make team collaboration the core of MemBridge as a SaaS: seamless (near-zero setup for a new teammate), easy to view (a team can see who did what without installing anything), simple (few screens, few concepts).

## 1. Architecture overview

What exists stays: the local daemon pushes redacted memory entries to Supabase and pulls teammates' entries down; row-level security already restricts everything to team members. We add one new surface and upgrade the schema around it:

```
local daemon (unchanged sync) ──┐
                                ├──> Supabase (auth + Postgres + RLS)
web app (NEW, Next.js/Vercel) ──┘         │
   • invite landing /join/<token>          └─ schema v2: invite links,
   • team activity feed                        roles, feed views,
   • team management                           management RPCs
```

The web app is a new `web/` folder in this repo — Next.js App Router + `supabase-js` + Tailwind, nothing else. No custom API server: the browser talks straight to Supabase and RLS is the authorization layer, same as the CLI.

## 2. Schema v2 (Supabase)

- **Invite links** — new `invites` table (short URL-safe token, team, creator, optional expiry, use count) plus a `redeem_invite(token, display_name)` security-definer RPC. Invite UX becomes `https://<app>/join/a8x3kq` instead of pasting a UUID. The legacy `invite_code` keeps working during the transition.
- **Roles & management RPCs** — add `admin` role alongside `owner`/`member`; RPCs for `remove_member`, `set_role`, `rotate_invite`, `rename_team`, `leave_team`, with matching RLS policies (owner/admin only for destructive actions).
- **Feed read model** — a `team_feed` RPC with keyset pagination and filters (member, project, tool, date range) plus a lightweight `project_stats` view (last activity, contributor count) so the web feed is one query, not N.

## 3. Hosted web app — "easy to view"

Four screens, deliberately minimal:

- **`/join/<token>`** — the invite landing. Shows "You've been invited to *Team X*", inline signup/login, auto-joins on success, then a short "install MemBridge to start contributing" step. A teammate goes from invite link → seeing the team feed in under a minute, without installing anything.
- **Team feed** — a single timeline grouped by day: avatar-colored author, tool badge, the ask, project chip, touched files expandable. Filter bar: person / project / tool. This is the core "who did what" view.
- **Projects** — cards per team project: last activity, contributors, mini activity sparkline; click opens the feed pre-filtered to that project.
- **Team settings** — members list (remove, change role), invite links (create/rotate/revoke), rename team.

Plus login/signup and a thin marketing landing page. Auth is the same Supabase email/password the CLI uses — one account everywhere.

## 4. Local seamlessness — "seamless"

- **`membridge join <link>`** — one command that handles login-or-signup then joins the team. Accepts the same token as the web link.
- **Auto-link projects** — when a local project's normalized git remote matches a project a teammate already linked to a team, MemBridge links it automatically (dashboard notification + config opt-out). Today every member manually runs `team link` per project; this removes that step entirely.
- **Local dashboard** — the team tab gains "Copy invite link" and a deep link to the hosted feed; management lives primarily on the web.

## 5. Error handling & privacy

Unchanged model: team sync stays best-effort (an unreachable backend never blocks local sync); only already-redacted digest entries leave the machine, and only for explicitly linked projects. The web app adds friendly empty/error states. Invite tokens are single-purpose, revocable, and never grant more than the member role.

## 6. Testing

- The existing offline mock-Supabase suite extends to cover `redeem_invite`, auto-link, and `membridge join` (preserving the zero-dependency, offline test property).
- Web app: Playwright E2E for the two critical flows (invite → join → see feed; filter the feed), component tests for feed rendering. 80% coverage target.

## 7. Phases

1. **Schema v2 + CLI** — invites, roles, RPCs, feed views; `membridge join`; auto-link. Ships value even before the web app exists.
2. **Web app core** — Next.js scaffold, auth, `/join/<token>`, team feed.
3. **Management + polish** — team settings UI, projects view, local dashboard integration.
4. **Beta launch** — deploy to Vercel, README/docs, invite first teams.

## Out of scope (this phase)

Billing/Stripe, real-time updates (Supabase Realtime), SSO/organizations, per-entry comments or reactions.
