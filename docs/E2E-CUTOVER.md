# E2E Encryption — Cutover Runbook

The E2E-completion release encrypts by default but still **dual-writes**
plaintext so nothing breaks while machines update. This runbook is the
deliberate flip to **ciphertext-only** storage. After step 5, the backend
never receives readable content again.

The one coordination rule (from the spec): **do not flip until every member
runs the E2E-completion release.** The moment plaintext stops, older clients
render nothing readable for new rows.

## 1. Apply the migrations to the live Supabase

In the Supabase SQL editor (each file is one re-runnable transaction; the
live DB has no migration history, so re-running is safe):

1. `supabase/migrations/009_e2e_encryption.sql` — identity + sealed-key
   tables, ciphertext columns (skip if already applied).
2. `supabase/migrations/013_e2e_feed.sql` — `team_feed` returns ciphertext;
   member-wide `team_keys` visibility (rotation/join detection).

Order matters: migrations first. A client running the new release against a
009-less backend pauses pushes (fail-closed) rather than degrading.

## 2. Every member updates MemBridge

Install the E2E-completion release on every machine. On its first team sync
each machine generates a keypair (private half in the macOS Keychain),
publishes the public half, and the first member to sync mints the epoch‑1
team key sealed to everyone.

Check `membridge status` on each machine: the `Encrypt:` line must read
`on (E2E, fail-closed)` with no `PAUSED`.

## 3. Verify fingerprints out-of-band

On each machine run:

    membridge team fingerprint

Compare the fingerprints over a call or in person — **not** through the
backend you are verifying. They must match pairwise. If a teammate's key
ever changes later, sync stops sealing to them and `membridge status` shows
a KEY ALERT; after re-verifying out-of-band, accept the new key with:

    membridge team trust <name or user-id>

## 4. Flip plaintext off (every member)

In `~/.membridge/config.json`, under `team`:

```json
{ "team": { "plaintextOff": true } }
```

From then on pushed rows carry ciphertext + routing metadata only; every
content column is null. If the backend is missing the 009/013 columns the
push refuses to degrade and holds entries instead (fail-closed).

## 5. (Optional) scrub historical plaintext

Rows pushed during the dual-write window still hold readable copies. To
remove them (Supabase SQL editor):

```sql
update public.memory_entries
set ask = null, goal = null, decisions = null, gotchas = null,
    summary = null, files = null, changes = null
where ciphertext is not null;
```

Rows with no ciphertext (pre-encryption history) would go blank for
everyone if scrubbed — leave them, or delete them outright if the content
should not exist server-side at all.

## Rollback

`team.plaintextOff` removed → dual-write resumes. `team.encrypt: false` →
full plaintext legacy sync (the explicit hatch; both members must flip it
to read each other again). Neither undoes step 5.

## What the server can still see after cutover

Ciphertext, nonces, epochs, who is sealed into which epoch, authorship,
timestamps, project/session ids, team membership. It cannot see content,
private keys, or the team key. Key authenticity rests on the TOFU pins +
out-of-band fingerprint checks above.
