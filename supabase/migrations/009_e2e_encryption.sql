-- E2E encryption, schema half (plan Task 3): identity + sealed-team-key
-- tables and the nullable ciphertext columns on memory_entries. Additive
-- only — nothing is dropped, existing plaintext columns are untouched and
-- keep being written (dual-write until the coordinated cutover, which is out
-- of scope here). No function changes: team_feed intentionally does NOT
-- return the new columns yet — encrypt-on-push / decrypt-on-pull wiring is
-- Tasks 4–6.
--
-- ⚠ Deploy gate — same discipline as 007_memory_ask_nullable.sql: apply this
-- to the LIVE Supabase before shipping any client with config.team.encrypt
-- on. The offline tests use a mock backend that accepts these columns, so a
-- missing live migration will NOT be caught by CI — only by a failed push in
-- production. The live DB has no migration history (migrations are applied
-- by hand), so every statement here is re-runnable: `if not exists` /
-- guarded `create policy` throughout. Run in the Supabase SQL editor (one
-- transaction) or `supabase db push`; with psql, use `psql -1 -f`.
--
-- Numbering: 009 lands in the repo after 010_security_hardening.sql was
-- written. The two are order-independent — 009 creates only new objects and
-- 010 never references them — so either apply order is fine.

-- ---------------------------------------------------------------------------
-- 1. member_pubkeys: one libsodium box public key per user, uploaded by the
-- client at identity bootstrap (ensureIdentity, Task 4). The matching private
-- key lives in the OS keychain and is never uploaded. Upsertable: the insert
-- + update policies below both exist so `on conflict (user_id) do update`
-- works for the owner.
-- ---------------------------------------------------------------------------
create table if not exists public.member_pubkeys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  public_key text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. team_keys: the team key for one epoch, sealed (crypto_box_seal) once to
-- each member's public key. Any member of the team may write rows — the
-- member who mints an epoch seals it to every teammate (resolveTeamKey,
-- Task 5) — but each member can only ever READ the rows sealed to them.
-- Rows are immutable: no update/delete policies on purpose; key rotation
-- writes a new epoch, it never rewrites an old one.
-- ---------------------------------------------------------------------------
create table if not exists public.team_keys (
  team_id uuid not null references public.teams (id) on delete cascade,
  epoch integer not null,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  sealed_team_key text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, epoch, member_user_id)
);

-- The client's hot path is "my sealed rows" (member_user_id = auth.uid());
-- the primary key leads with team_id, so give that lookup its own index.
create index if not exists team_keys_member_idx
  on public.team_keys (member_user_id);

-- ---------------------------------------------------------------------------
-- 3. memory_entries: nullable ciphertext columns, one alter per column
-- (008's style). ciphertext/nonce are base64 text at this boundary (the
-- client's teamcrypto API is base64 across the wire); key_epoch says which
-- team_keys epoch decrypts the row. Plaintext columns stay as-is.
-- ---------------------------------------------------------------------------
alter table public.memory_entries add column if not exists ciphertext text;
alter table public.memory_entries add column if not exists nonce text;
alter table public.memory_entries add column if not exists key_epoch integer;

-- ---------------------------------------------------------------------------
-- 4. Row-level security, mirroring the schema.sql pattern: membership via
-- the same public.is_team_member(team_id) gate every existing policy uses,
-- default-role policies (anon evaluates the gate to false and sees nothing),
-- table grants left to Supabase's defaults exactly like the other tables.
--
-- `create policy` has no `if not exists`, and drop-and-recreate would break
-- this file's "drops nothing" rule — so policy creation is guarded through
-- pg_policies instead. (A policy's body is settled at first apply; edits
-- would be a new migration, so the guard never hides a change.)
-- ---------------------------------------------------------------------------
alter table public.member_pubkeys enable row level security;
alter table public.team_keys enable row level security;

do $$
begin
  -- member_pubkeys: you always see your own row (bootstrap needs it before
  -- any team exists); teammates' pubkeys are visible when you share a team —
  -- the EXISTS walks the target user's memberships and keeps those where the
  -- caller passes the standard is_team_member gate. Sealing an epoch to the
  -- whole team (Task 5) reads exactly this set.
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'member_pubkeys'
                   and policyname = 'member_pubkeys_select') then
    create policy member_pubkeys_select on public.member_pubkeys
      for select using (
        user_id = auth.uid()
        or exists (
          select 1 from public.team_members m
          where m.user_id = member_pubkeys.user_id
            and public.is_team_member(m.team_id)
        )
      );
  end if;

  -- Writes: only your own row, both halves of an upsert.
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'member_pubkeys'
                   and policyname = 'member_pubkeys_insert') then
    create policy member_pubkeys_insert on public.member_pubkeys
      for insert with check (user_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'member_pubkeys'
                   and policyname = 'member_pubkeys_update') then
    create policy member_pubkeys_update on public.member_pubkeys
      for update using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;

  -- team_keys: read only what is sealed TO YOU, and only while you are still
  -- a member — no member can fetch another member's sealed copy, and a
  -- removed member loses access to the table (what they already hold is a
  -- rotation concern, out of scope here).
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'team_keys'
                   and policyname = 'team_keys_select') then
    create policy team_keys_select on public.team_keys
      for select using (
        member_user_id = auth.uid()
        and public.is_team_member(team_id)
      );
  end if;

  -- Inserts: any member of the team may seal rows (including rows whose
  -- member_user_id is a teammate — that is the point of sealing an epoch to
  -- everyone). Non-members cannot write keys into a team.
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'team_keys'
                   and policyname = 'team_keys_insert') then
    create policy team_keys_insert on public.team_keys
      for insert with check (public.is_team_member(team_id));
  end if;
end $$;
