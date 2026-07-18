# MemBridge — Pre-Launch Checklist

_Single source of truth for what we're building toward. Supersedes the dated
`HANDOFF-*.md` notes and `servers.md`. Committed to the repo so both humans and
both AI sessions read the same thing. **This is human-owned — do not confuse it
with the auto-generated `CLAUDE.md` block, which MemBridge rewrites.**_

_Last updated: 2026-07-17 · Owners: Andrew, Marco_

## How to use this doc

1. At the **start** of a work session, read this file (and pull latest).
2. When you finish a chunk, update the item's **Status / Branch** and commit
   this file with your change.
3. The other person pulls before starting. Git is the sync layer — the two
   Claude sessions do not talk to each other; they coordinate only through
   this committed doc.
4. Settle architectural calls in the **Decisions log** so we stop
   relitigating them.

Status legend: `todo` · `in progress` · `blocked` · `done`

---

## Where we are today (verified 2026-07-14)

- The **team-collaboration MVP exists** on branch `marco-ui`: Supabase backend
  (migrations, invite links, roles), RLS as the authz layer, a Next.js web app
  under `web/`, team sync push/pull, and the team-hub dashboard.
- **Canonical source is top-level `lib/`.** `app/lib/` is a gitignored mirror
  refreshed by `scripts/prepare-app.js` (build scripts run it automatically).
  Review and edit `lib/`, not the mirror.
- Redaction (`lib/redact.js`) works and strips known secret patterns from
  asks/summaries before upload. **Redaction is not encryption.**

---

## P0 — Launch-blocking (cannot sell the Team tier without these)

### 1. End-to-end encryption of the sync payload
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Why:** `lib/teamsync.js` `pushProject` currently uploads `ask`, `summary`,
  and `files` to Supabase as **plaintext** (redacted + clipped only). The whole
  privacy wedge — "E2E encrypted, we never receive it readable, we retain
  nothing" — is false until this lands. A B2B security reviewer will find this
  immediately.
- **Definition of done:** summaries (and any opted-in prompts) are encrypted on
  the user's machine before upload; Supabase holds ciphertext only; the key is
  never uploaded. Web feed can no longer render summaries server-side — that
  change is expected and tracked under P1.

### 2. Prompt-privacy upload-gate (data layer)
- **Status:** code done (180/180, uncommitted) · **Owner:** Andrew · **Branch:**
  local, off `fix/checkpoint-sequence` — needs commit
- **Why:** teammates' verbatim prompts must not leave the machine unless the
  user opts in. Enforced at the **upload boundary**, not the UI.
- **Definition of done:** `config.team.sharePrompts` defaults false; when off,
  `pushProject` uploads `ask: null` (summary + files still go); offline tests
  prove non-shared prompts never reach Supabase and fail on reverted code. Also
  fixed: null-ask rendering in the injected block + both dashboards, and a
  settings/CLI bug that discarded the opt-in. CLI: `membridge team share-prompts
  <on|off>`.
- **✅ Deploy gate — VERIFIED 2026-07-17:** `memory_entries.ask` is nullable
  in the **live** DB (checked directly against production; Marco's Part A
  summary columns — summary/goal/decisions/gotchas/changes — are live too),
  so the default `ask: null` upload is safe to ship. The change is
  version-controlled as `supabase/migrations/007_memory_ask_nullable.sql`
  (this doc previously pointed at `005_ask_nullable.sql`; the migration lives
  at 007). Note the live DB has no migration history, so "applied" can only be
  confirmed by inspecting the schema — see #10.

### 3. Cryptographer review
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Definition of done:** one external cryptographer signs off on the crypto +
  key-management design **before** any security guarantee is written down
  publicly or in sales material. Don't roll our own crypto.

### 4. Key-management design
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Definition of done:** documented scheme — trust-on-first-use + out-of-band
  verification (Signal-style safety numbers) or keys derived from a
  team-controlled secret. Keys never uploaded to us. Study Syncthing's model.

### 9. Invite token weakness
- **Status:** in progress (migration written, awaiting review + apply) ·
  **Owner:** Andrew · **Branch:** local, uncommitted —
  `supabase/migrations/010_security_hardening.sql`
- **Why:** `gen_invite_token()` (002) draws `floor(random() * 58)` positions
  over a **54**-char alphabet, so ~7% of draws append `''` — measured on live
  data: ~50% of tokens are shorter than 10 chars, shortest observed 6. And
  `random()` is a seeded PRNG, not a CSPRNG. Compounding it, `peek_invite` is
  an anon-callable, previously unthrottled "is this token valid" oracle. An
  invite token **is** team membership — a guessed token hands over the team's
  whole memory feed. P0 by this doc's own bar: it's exactly the class of
  finding a B2B security reviewer leads with (same story as #1), and it's
  cheap to fix now — rotating tokens today breaks two people's links; after
  launch it breaks customers'.
- **Definition of done:** migration 010 reviewed and applied to the live DB.
  It (a) rewrites the generator on pgcrypto's CSPRNG with bias-free rejection
  sampling at a fixed 16 chars (54^16 ≈ 6e27), self-checked in-migration
  (500 generations: length, alphabet, uniqueness); (b) **rotates every live
  invite token — outstanding invite links die; re-send them after applying**;
  (c) throttles `peek_invite`/`redeem_invite` at 10 attempts/min per caller
  IP (SQL can't count failed `redeem` calls — raises roll their attempt rows
  back; Auth rate limits in #11 are the backstop there); (d) revokes anon
  EXECUTE across the RPC surface except `peek_invite` + `is_team_member`
  (~20 linter warnings — verified non-exploitable, so defense-in-depth).

---

## P1 — Should-have (needed for a credible launch, not strictly blocking)

### 5. Summary-first teammate UI
- **Status:** todo · **Owner:** Marco (web) · **Branch:** —
- **Definition of done:** `web/feed` and `dashboard-team.js` default to the
  session **summary** ("what was done"), collapse per-prompt asks, and expand to
  show a teammate's prompts only when that teammate opted in (else "not
  shared"). Depends on #2. Interacts with #1 (encryption changes how the feed
  reads summaries).

### 6. Retroactivity decision
- **Status:** todo · **Owner:** Andrew + Marco · **Branch:** —
- **Definition of done:** decide whether to scrub/backfill `ask` rows already
  uploaded before the gate (#2) existed. Record the decision here; ship a
  migration if we scrub.

### 7. Resolve `lib/` vs `app/lib` drift
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Why:** the mirror has drifted (`teamsync.js`, `digest.js`, `util.js` were
  stale). Risk: shipping an Electron build with old behavior.
- **Definition of done:** decide whether the mirror should exist at all or be a
  build-time-only artifact; ensure no stale drift can ship.

### 8. Merge the checkpoint-sequence fix
- **Status:** done (pushed `fix/checkpoint-sequence`, 176/176) · **Owner:**
  Andrew · **Branch:** `fix/checkpoint-sequence`
- **Definition of done:** PR reviewed and merged into `marco-ui`.

### 10. Migration tracking
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Why:** the live DB has **no migration history** (`supabase_migrations` is
  empty — checked 2026-07-17): every file in `supabase/migrations/` was
  applied by hand, so nothing can verify that repo and prod agree, and the
  E2E cutover (#1) would be flying blind against an unverifiable schema.
- **Definition of done:** adopt tracked migrations (supabase CLI `db push`
  with recorded history), or at minimum record the applied state and diff it
  once against the live schema — so "what is actually on prod" is answerable
  from the repo.

### 11. Supabase dashboard hardening (manual steps, not code)
- **Status:** todo · **Owner:** Andrew or Marco · **Branch:** — (dashboard
  settings only; nothing to commit)
- **Definition of done — two checkboxes in the Supabase dashboard:**
  1. Enable leaked-password protection (Auth settings), so sign-ups can't use
     known-breached passwords.
  2. Review the Auth rate limits for sign-in/OTP (Supabase-managed). Also the
     real backstop for invite brute-force via `redeem_invite`: the SQL
     throttle can't count calls that raise and roll back (see 010's
     comments), but every redeem needs an authenticated session, which these
     limits gate.

---

## P2 — Post-launch / nice-to-have

- Gemini CLI adapter.
- Local MCP server (expose MemBridge memory to MCP clients).
- Git-remote auto-linking polish.
- Cosmetic: in `memory.md`, the checkpoint block attaches to the session's
  latest summary-bearing entry, so its `Checkpoints:` list can sit under a
  trivial ask. Consider attaching to the session's first substantive entry.

---

## Decisions log

- **Prompt sharing: upload-gate, not display-gate.** Privacy is enforced by not
  uploading non-shared prompts, so they can't be read by the backend, Supabase,
  or a teammate hitting the API directly. Default off. (2026-07-14)
- **The shared unit is the summary; full chats stay local.** Summaries can
  contain sensitive IP, so they still require E2E encryption. (from `servers.md`)
- **Supabase is transport, not trust.** Use it as a dumb encrypted mailbox —
  encrypt client-side before upload. Resolved in principle, **not yet
  implemented** (that's P0 #1). (from `servers.md`)
- **Privacy is the differentiator; E2E is non-negotiable.** Shipping plaintext
  collapses the story to "as private as a private GitHub repo." (from
  `servers.md`)
- **Tiered model:** Free = LAN P2P (co-located, demo tier) · Team = hosted
  matchmaker, E2E, ~$10/seat/mo (guess) · Enterprise = customer self-hosts the
  matchmaker/relay. Keep BYOK; never resell AI tokens. (from `servers.md`)
- **Crypto:** don't roll our own — libsodium/NaCl or the Noise framework
  (WireGuard/Syncthing model). (from `servers.md`)

---

## Open questions to resolve together

- Encryption primitive: libsodium/NaCl vs Noise? (blocks P0 #1 scoping)
- Does E2E break enough of Marco's server-rendered web feed that the feed needs
  a client-side-decrypt rewrite, or a thin server-side "titles only" view?
- Pricing/seat model — is $10/seat/mo the real number?
