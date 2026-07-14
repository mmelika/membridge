-- Fix: joining a team failed with `column reference "team_id" is ambiguous`.
-- Both join RPCs return `table (team_id ...)`, which makes team_id a PL/pgSQL
-- variable — so the unqualified team_id in `on conflict (team_id, user_id)`
-- could be either the variable or the team_members column, and Postgres
-- refuses to guess. The conflict target is dropped instead: the composite PK
-- (team_id, user_id) is the table's only constraint, so a bare
-- `on conflict do nothing` behaves identically (FOUND semantics included).
--
-- Run this in the Supabase SQL editor on backends created before this fix.

create or replace function public.join_team(p_code uuid, p_display_name text)
returns table (team_id uuid, team_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_team from public.teams where teams.invite_code = p_code;
  if v_team.id is null then
    raise exception 'invalid invite code';
  end if;
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  return query select v_team.id, v_team.name;
end;
$$;

create or replace function public.redeem_invite(p_token text, p_display_name text)
returns table (team_id uuid, team_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_invite from public.invites where invites.token = p_token;
  if v_invite.token is null then
    raise exception 'invalid invite link';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'this invite link has been revoked';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    raise exception 'this invite link has expired';
  end if;
  if v_invite.max_uses is not null and v_invite.use_count >= v_invite.max_uses then
    raise exception 'this invite link has already been used';
  end if;
  select * into v_team from public.teams where id = v_invite.team_id;
  -- Never grants more than member; joining twice is a no-op, not a burn.
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  if found then
    update public.invites set use_count = use_count + 1
      where invites.token = p_token;
  end if;
  return query select v_team.id, v_team.name;
end;
$$;
