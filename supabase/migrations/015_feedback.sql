-- 015_feedback.sql — post-install feedback inbox.
--
-- Mirrors the waitlist pattern (anon may INSERT only; reads are fully denied),
-- with tighter CHECK constraints per the 7/21 backend-readiness note. The
-- static form at membridge.me/feedback POSTs here with the publishable anon key;
-- there is no SELECT/UPDATE/DELETE policy, so anon can write a row and nothing
-- else. Additive and re-runnable (create-if-not-exists + drop-then-create
-- policy), matching the house migration style.

create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  setup text[] not null default '{}',                 -- ['Claude Code','Codex',...]
  message text not null check (char_length(message) between 1 and 4000),
  email text check (email is null or char_length(email) <= 200),
  quote_ok boolean not null default false,
  ref text check (ref is null or char_length(ref) <= 40),
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- Anon may INSERT only; no SELECT/UPDATE/DELETE policy => reads are fully denied.
-- `create policy` has no `if not exists`, so drop-then-create is the idempotent
-- guard (matches 011/012's policy handling).
drop policy if exists feedback_anon_insert on public.feedback;
create policy feedback_anon_insert on public.feedback
  for insert to anon with check (
    char_length(message) between 1 and 4000
    and (email is null or char_length(email) <= 200)
  );

grant insert on public.feedback to anon;
