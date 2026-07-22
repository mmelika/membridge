-- E2E feed migration (E2E completion, feed rewrite):
--   1. team_feed returns ciphertext/nonce/key_epoch (and session) so clients
--      decrypt content locally. The readable columns stay in the return set
--      for the dual-write window; after cutover they are simply null.
--   2. team_keys SELECT widens from sealed-to-me-only to every member of the
--      team: epoch membership is how any member detects a removed teammate
--      (rotation) or an unsealed joiner (join-seal). Sealed blobs are only
--      openable by their target's private key, so visibility of the rows is
--      not a confidentiality leak.
--
-- ⚠ Deploy gate — same discipline as 009: apply to the LIVE Supabase before
-- shipping clients that expect it (the E2E-completion release). The live DB
-- has no migration history; every statement here is re-runnable. Run in the
-- Supabase SQL editor (one transaction) or `supabase db push`; with psql,
-- use `psql -1 -f`.

-- ---------------------------------------------------------------------------
-- 1. team_feed: drop + recreate (Postgres refuses to change a function's OUT
-- row type in place — same dance as 004/005/008, same signature dropped).
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
  session text, ciphertext text, nonce text, key_epoch integer
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at,
         e.goal, e.decisions, e.gotchas, e.changes,
         e.session, e.ciphertext, e.nonce, e.key_epoch
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

-- ---------------------------------------------------------------------------
-- 2. team_keys: member-wide SELECT. The 009 policy (rows sealed TO you only)
-- is replaced; membership still gates everything, and a removed member loses
-- the whole table exactly as before.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'team_keys'
               and policyname = 'team_keys_select') then
    drop policy team_keys_select on public.team_keys;
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'team_keys'
                   and policyname = 'team_keys_select_members') then
    create policy team_keys_select_members on public.team_keys
      for select using (public.is_team_member(team_id));
  end if;
end $$;
