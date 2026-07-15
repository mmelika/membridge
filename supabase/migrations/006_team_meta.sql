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
