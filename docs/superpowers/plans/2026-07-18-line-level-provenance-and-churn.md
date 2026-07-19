# Line-level provenance + churn diagnostic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 2 commit↔session map into two derived surfaces — line-level `membridge why <file>:<line>` (blame → SHA → map → the session/ask/summary behind that line) and a **diagnostic-only** churn instrument (what fraction of a session's written lines still exist in HEAD) — both as pure joins over the existing map plus a best-effort **injected** git runner. No new capture, no change to `commits.jsonl`.

**Architecture:** One new git helper (`blameLine`) beside the existing readers in `lib/commits.js`; a new pure `lineProvenance` in `lib/provenance.js` that reuses `fileProvenance`'s session→row construction; CLI parse + wire in `bin/membridge.js`; an optional `line` param on the MCP `why` tool in `lib/mcp.js`. Churn is a **separate module** `lib/churn.js` (own git reads through an injected runner) plus a `churn` CLI command — deliberately decoupled so it builds in parallel. Every git call degrades to the file-level / "unavailable" answer and never throws (AGENTS.md house rules).

**Tech Stack:** Node.js (CommonJS). No new dependencies — `git blame` via the same `defaultRunGit(projectPath)` (`execFileSync`) pattern as `lib/changes.js`/`lib/commits.js`. Test harness: `test/run-tests.js` (`check(name, fn)`, `npm test`), offline only — injected `runGit` returning fixture blame/numstat output; no real repo, no network, no wall clock.

**Locked decisions (from the approved spec, do not relitigate):**
- **Authorship gate is assumed** — the map holds only commits whose committer email == local `git config user.email`; pulled teammate commits are skipped locally, so line-level `why` and churn **trust the map**. The gate itself is a *separate, prerequisite* piece (Phase 2 follow-up) and is **NOT built here**; both features are semantically correct the moment it lands. See "Dependency on the authorship gate" below.
- Line-level is a join over the **existing** `commits.jsonl` — no schema change, no new capture.
- No line / bad line / unmapped SHA / merge / uncommitted line ⇒ **degrade to file-level**, annotated — never an error, never empty when file history exists.
- Blame runs through an **injected** `deps.runGit`; any git failure degrades. Never throws into a CLI/MCP/render path.
- **Churn is diagnostic-only:** never a target, never a teammate/author parameter, never cross-person. A fixed caveat line ships with every churn render.

---

## Dependency on the authorship gate

The gate (filter `readCommit`/`attributeCommit` — or `newCommitsSince` — to commits whose `%ce` == local `user.email`) is a **hard prerequisite for correctness** but **not a code dependency of these tasks**: the map's on-disk format is unchanged, so line-level `why` and churn compile and pass their fixture tests without it. What the gate changes is *which SHAs are in the map* at runtime. **Build order:** the gate task (tracked separately, Phase 2 follow-up) SHOULD land before this feature is user-facing; if it has not, ship line-level `why` with its "teammate/untracked commit" fallback doing the right thing anyway (an ungated pulled SHA simply shows file-level history with the annotation), and hold the churn CLI until the gate is in, since churn's denominator assumes local-only commits.

## Parallelization map (isolated worktrees)

- **Task 1** (`blameLine` helper) and **Task 5** (`lib/churn.js` compute) are **INDEPENDENT** of each other and of everything else — start both in parallel worktrees immediately.
- **Chain A (line-level):** Task 1 → **Task 2** (`lineProvenance`) → { **Task 3** (CLI), **Task 4** (MCP) } — 3 and 4 are **parallel siblings** once Task 2 is merged.
- **Chain B (churn):** Task 5 → **Task 6** (churn CLI) — serial, and independent of Chain A end to end.
- Cross-chain: none. Task 3 and Task 6 both touch `bin/membridge.js` (different command handlers) — merge order only, no logic coupling.

---

## Data contracts

**`lib/commits.js` — `blameLine(projectPath, file, line, deps = {})`** → `sha | null`.
Runs `git blame -L <line>,<line> --porcelain --no-color -- <file>` through `deps.runGit || defaultRunGit(projectPath)`; returns the leading 40-hex SHA, or `null` on the all-zero "not committed yet" SHA, malformed output, or any git failure (caught). Reading only — never writes.

**`lib/provenance.js` — `lineProvenance(projectPath, proj, config, file, line, now, deps = {})`** →
`{ line, sha, session, fallback }` where `session` is one row shaped exactly like `fileProvenance`'s rows (`who, tool, session, ts, ask, summary, decisions, gotchas, live`) plus nothing extra, or `null`; `fallback` is `null` or a reason string (`'no-line' | 'uncommitted' | 'unmapped' | 'merge' | 'git-unavailable'`). When `fallback` is set the caller shows the file-level list. Reuses the existing `digest.pickSummary` + `buildEntries` machinery; does not re-implement redaction (boundary layers do that, as today).

**Commit-map lookup:** `loadCommitMap(projectPath)` → find record with `r.sha === sha` → its `sessions[]` → the entry whose `files` includes `normalizeRel(projectPath, file)` → that `.session`. Merge records (`files: []`) and absent SHAs ⇒ `fallback`.

**`lib/churn.js` — `churn(projectPath, { session, sinceDays, now }, deps = {})`** →
`{ commits, written, landed, fraction, status }` where `status ∈ 'ok' | 'too-recent' | 'insufficient' | 'unavailable'`, `written`/`landed` are line counts, `fraction = landed/written` (or `null`). Pure over: `loadCommitMap` (the commit set), per-commit additions via injected numstat reads, and `git blame HEAD` survival counts via the injected runner. No author/teammate input exists in the signature — by design.

---

## File structure

- **Modify** `lib/commits.js` — add `blameLine` (~15 lines) beside `readCommit`; export it.
- **Modify** `lib/provenance.js` — add `lineProvenance` (~45 lines) reusing the existing row builder; export it.
- **Modify** `bin/membridge.js` — parse `<file>:<line>` in `cmdWhy`; render the single line-level row (or annotated file-level fallback); add `cmdChurn` + `churn` command + help/usage lines.
- **Modify** `lib/mcp.js` — optional `line` param on the `why` tool; call `lineProvenance` when present; update the tool description.
- **Create** `lib/churn.js` — the churn compute (~70 lines).
- **Modify** `test/run-tests.js` — new `check(...)` blocks per task.

---

## Task 1: `blameLine` git helper — one line → SHA (INDEPENDENT)

**Files:** Modify `lib/commits.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — inject a `runGit` returning fixture porcelain blame; assert the 40-hex SHA is extracted; an all-zero SHA (`0000000000000000000000000000000000000000`) ⇒ `null`; empty/garbage output ⇒ `null`; a throwing runner ⇒ `null` (never throws).
- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep blameLine` → FAIL (function missing).
- [ ] **Step 3: Implement** `blameLine(projectPath, file, line, deps = {})`: guard `line` is a positive integer (else `null`); `runGit(['blame', '-L', `${line},${line}`, '--porcelain', '--no-color', '--', file])`; take the first token of the first line, validate `/^[0-9a-f]{40}$/`, reject all-zero; whole body in try/catch → `null`. Mirror `readCommit`'s injected-runner + degrade conventions exactly. Export it.
- [ ] **Step 4: Run to verify it passes; full `npm test`** — report count.
- [ ] **Step 5: Commit** — `git commit -m "feat(provenance): blameLine — line → commit SHA (injected, degrades)"` *(only if Andrew asks; house rule: never commit unsolicited)*.

---

## Task 2: `lineProvenance` — SHA → map → session row (depends on Task 1)

**Files:** Modify `lib/provenance.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — fixture `proj.events` + a fixture commit map (inject `loadCommitMap` via `deps`, or point at a temp `.membridge/commits.jsonl`); inject `blameLine` via `deps` returning a known SHA. Assert: mapped SHA ⇒ single row with `ask`/`summary`/`decisions`/`gotchas` from the same pipeline as `fileProvenance`, `sha` set, `fallback: null`. Assert each fallback path sets the right reason and `session: null`: no/`0`/non-integer line (`'no-line'`), all-zero blame (`'uncommitted'`), SHA-not-in-map (`'unmapped'`), merge record `files: []` (`'merge'`), throwing git (`'git-unavailable'`).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `lineProvenance(...)`: validate the line (bad ⇒ `{fallback:'no-line'}`); `sha = deps.blameLine ? ... : commits.blameLine(...)`; `null` sha ⇒ `'uncommitted'`; load the map, find the record, then the owning session for `normalizeRel(projectPath, file)` (no session / merge `files:[]` / no record ⇒ `'unmapped'`/`'merge'`); build the one row by **reusing the exact row shape** `fileProvenance` produces for a local session (`digest.pickSummary` + the newest `buildEntries` entry that lists the file for the ask/ts/tool/live). Do NOT duplicate redaction — the CLI/MCP boundary redacts, as today. Export `lineProvenance`.
- [ ] **Step 4: Run to verify it passes; full `npm test`** — report count.
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(provenance): lineProvenance — line-level why over the commit map"`.

---

## Task 3: CLI `membridge why <file>:<line>` (depends on Task 2) — parallel with Task 4

**Files:** Modify `bin/membridge.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — a pure `parseFileLineArg(arg)` helper: `'src/a.js:42'` → `{file:'src/a.js', line:42}`; `'src/a.js'` → `{file:'src/a.js', line:null}`; `'C:\\x.js:10'` (drive colon) → line `10`, file intact; `'a.js:42:7'` (col paste) → line `42`; `'a.js:foo'` → `{line:null}`. Then a render test: with a stubbed `lineProvenance` returning a row ⇒ output shows the line, SHA short-hash, session ask/summary; with a `fallback` reason ⇒ output shows the annotation *and* the file-level list.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add `parseFileLineArg` and call it in `cmdWhy`; when a line is present, resolve the tracked key/rel exactly as today, call `lineProvenance`, and render the single row (reuse the existing file-level row renderer for the body, prefixed with the line + short SHA); on `fallback`, print the one-line reason then fall through to today's `fileProvenance` render. Keep `membridge why <file>` byte-identical when no line is given. Update the `why <file>` usage/help line to `why <file>[:<line>]`.
- [ ] **Step 4: Run to verify it passes; full `npm test`** — report count.
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(cli): membridge why <file>:<line> with file-level fallback"`.

---

## Task 4: MCP `why` tool `line` param (depends on Task 2) — parallel with Task 3

**Files:** Modify `lib/mcp.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — extend `whyFile` (or a new `whyLine`) exported for tests: with `line` set ⇒ returns `{project, file, line, sha, session}` where every text field passed through `redactedOrNull`; without `line` ⇒ response byte-identical to today's `whyFile`. Assert the fallback reason is carried through when the SHA is unmapped.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add optional `line: z.number().int().positive().optional()` to the `why` tool `inputSchema`; when present, call `lineProvenance` and redact every text field with `redactedOrNull` (same boundary discipline as `whyFile`); when absent, unchanged. Update the tool `description` to describe line-level blame and drop "no line-level blame."
- [ ] **Step 4: Run to verify it passes; full `npm test`** — report count.
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(mcp): why tool gains optional line param (redacted)"`.

---

## Task 5: `lib/churn.js` — landed-vs-reverted compute (INDEPENDENT)

**Files:** Create `lib/churn.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — inject the commit map (fixture records with `sessions[].files`), a `runGit` that returns fixture numstat (additions per commit) and fixture `git blame HEAD` porcelain (which lines still map to the session's SHAs), and a fixed `now`. Assert: `written`/`landed`/`fraction` computed correctly for a session whose commits are older than the window; a session with only within-window commits ⇒ `status:'too-recent'`; empty commit set ⇒ `status:'insufficient'`; a throwing runner ⇒ `status:'unavailable'` (never throws). Assert the signature has **no** author/teammate parameter.
- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep churn` → FAIL (module missing).
- [ ] **Step 3: Implement** `churn(projectPath, {session, sinceDays, now}, deps)`: from `loadCommitMap` pick the SHAs owned by `session` (or, for `--since`, all local commits committed ≤ `now - Nd`); `written` = sum of additions across those commits (numstat via injected runner); for each touched file, `git blame HEAD --porcelain` and count lines whose SHA ∈ the set = `landed`; `fraction = landed/written`. Guard every git call; degrade to `status:'unavailable'`. Pure, injected deps, no wall clock.
- [ ] **Step 4: Run to verify it passes; full `npm test`** — report count.
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(provenance): churn — landed-vs-reverted diagnostic (local-only)"`.

---

## Task 6: `membridge churn` CLI (depends on Task 5)

**Files:** Modify `bin/membridge.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — a pure renderer over a `churn(...)` result: `status:'ok'` ⇒ output shows written/landed/fraction, a plain-English read, and **always** the fixed caveat line ("Churn is a diagnostic, not a target … never compared across people."); `too-recent`/`insufficient`/`unavailable` ⇒ their honest messages, still with the caveat. Assert the command rejects an unknown/author-like flag rather than accepting a teammate.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `cmdChurn`: parse `--session <id>` / `--since <Nd>` / `--project <path>` (default: current session or the project's own recent local commits); resolve the tracked key like `cmdWhy`; call `churn`; render with the caveat line unconditionally. Add `churn` to the `commands` map and a help/usage line under a "Provenance" heading. No author/teammate flag exists.
- [ ] **Step 4: Run to verify it passes; full `npm test`** — report count.
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(cli): membridge churn — diagnostic landed-vs-reverted view"`.

---

## Self-review

- **Spec coverage:** blame→SHA → Task 1; SHA→map→session row → Task 2; CLI `<file>:<line>` + fallback → Task 3; MCP `line` param → Task 4; churn compute → Task 5; churn CLI + caveat → Task 6. Every fallback path (no-line, uncommitted, unmapped, merge, git-unavailable) is asserted in Tasks 2/3.
- **House rules baked in:** every task is TDD-first (write failing test, run, then implement); every git touch goes through an **injected** runner and **degrades, never throws**; both boundaries (CLI stdout, MCP) **redact** every text field; helpers are pure/injected for offline tests; each task ends on a **full green suite with a reported count**; commits only if Andrew asks.
- **Scope discipline:** no change to `commits.jsonl`, no new capture, no edit to `dashboard.js`/`teamsync.js`/the crypto modules. `lib/churn.js` is a new module so churn never entangles line-level `why`.
- **Parallelism:** Tasks 1 and 5 are independent worktree starts; Chain A (1→2→{3,4}) and Chain B (5→6) share no logic; Tasks 3 and 6 touch different handlers in `bin/membridge.js` (merge-order only).
- **Explicitly NOT done here (prerequisite, tracked separately):** the **authorship gate** (`%ce` == local `user.email` filter in the map writer). Both features *assume* it; correctness of an ungated pulled SHA is protected by the "teammate/untracked commit" fallback, but the churn CLI should wait for the gate before going user-facing.

## Verification (whole feature)

- `npm test` green (existing + new); every new test is offline with an injected `runGit` — no real repo, no clock.
- `membridge why <file>` unchanged; `membridge why <file>:<line>` shows the session/ask/summary behind the line, or an annotated file-level fallback for uncommitted/unmapped/merge lines.
- MCP `why` with `line` returns a redacted single row; without `line`, byte-identical to today.
- `membridge churn --session <id>` prints written/landed/fraction with the diagnostic caveat and exposes no cross-person comparison.
- Sanity on a real repo once the authorship gate is merged: a line you wrote resolves to your session; a pulled teammate line falls back to file-level.
