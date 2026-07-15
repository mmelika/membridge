-- Add teammates' `summary` to the team feed. The pushes table already stores
-- summary (schema.sql), but team_feed never returned it, so the unified feed
-- could only show raw asks. Function-only (no table/index/data changes), but it
-- DROPs and recreates team_feed because Postgres refuses to change a function's
-- RETURNS TABLE via create-or-replace. Idempotent/re-runnable. Old clients
-- ignore the extra column. Run in the Supabase SQL editor or `supabase db push`.

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
