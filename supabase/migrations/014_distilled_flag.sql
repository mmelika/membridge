-- Distilled-flag propagation (teammate-summary Activity fix):
--   The `distilled` bit — whether a session's summary is a real distilled brief
--   or a harvested mid-session line — is a local-only signal today, dropped at
--   every team-sync hop. The Activity day-card headline is distilled-only, so a
--   teammate's summary (never flagged distilled over sync) renders as "no
--   summaries shared" even though the text is present. This carries the bit:
--     1. memory_entries gains a `distilled` boolean (dual-written by push).
--     2. team_feed returns it so the desktop feed knows a teammate summary is a
--        real brief, not a harvested tail line.
--
-- distilled is routing metadata, not content: it is NOT encrypted (rides
-- alongside ciphertext exactly like source/session), so it stays readable after
-- the plaintext cutover. Pre-existing rows default to false — they render as
-- harvested (Option B's day-card fallback still surfaces their summary), and a
-- teammate's re-push backfills the true value.
--
-- ⚠ Deploy gate — same discipline as 009/013: apply to the LIVE Supabase before
-- shipping clients that expect it. Every statement is re-runnable. Run in the
-- Supabase SQL editor (one transaction) or `supabase db push`; with psql, use
-- `psql -1 -f`.

-- ---------------------------------------------------------------------------
-- 1. memory_entries.distilled — additive, defaulted, non-null.
-- ---------------------------------------------------------------------------
alter table public.memory_entries
  add column if not exists distilled boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. team_feed: drop + recreate to add `distilled` to the return row (Postgres
-- refuses to change a function's OUT row type in place — same dance as 013).
-- ---------------------------------------------------------------------------
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
  ts timestamptz, source text, ask text, summary text, files jsonb, created_at timestamptz,
  goal text, decisions text, gotchas text, changes jsonb,
  session text, ciphertext text, nonce text, key_epoch integer,
  distilled boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at,
         e.goal, e.decisions, e.gotchas, e.changes,
         e.session, e.ciphertext, e.nonce, e.key_epoch,
         e.distilled
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
