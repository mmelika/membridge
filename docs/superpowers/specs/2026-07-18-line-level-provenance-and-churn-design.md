# Line-level provenance (`why <file>:<line>`) + a churn diagnostic

**Date:** 2026-07-18
**Status:** Approved design (Andrew) — Phase 3 of provenance
**Builds on:** Phase 0 `lib/provenance.js` (`fileProvenance`, `normalizeRel`), Phase 2 `lib/commits.js` (the commit↔session map: `readCommit`, `newCommitsSince`, `attributeCommit`, `loadCommitMap`), `lib/changes.js` (git plumbing: `defaultRunGit`, `unquote`, degrade-to-empty)

## Problem

Phase 0 answers *"who touched this file, when, and what were they trying to
do"* — **file granularity only**. Phase 2 built the missing half: a durable,
append-only **commit↔session map** (`.membridge/commits.jsonl`) that records,
per commit, which session owns each changed file. That map is currently written
and read only by the backfill loop and the file-level surfaces — its per-line
potential is untapped.

Two questions the map can now answer but nothing surfaces:

1. **"Which session wrote *this line*?"** A teammate reading a diff points at
   line 42, not at a filename. `git blame` already knows the commit; the map
   already knows the session behind the commit. Joining them turns
   `membridge why <file>` into `membridge why <file>:<line>` — the ask, the
   result summary, the decisions/gotchas behind one specific line.

2. **"Did the work land?"** An agent wrote 300 lines in a session; how many
   still exist in HEAD a week later? That is a **diagnostic** — a smell that a
   session thrashed, was reverted, or churned — never a score. We frame it as
   diagnostic-only, on purpose and loudly (see below), because a
   "lines-retained" number is exactly the kind of metric that becomes a
   perverse target the moment it is comparable across people.

Both features are pure joins over the **existing** map plus a **best-effort,
injected** git runner. No new capture, no schema change to `commits.jsonl`.

## The model

Two nouns, both derived — nothing new is stored.

- **Line attribution** — for `<file>:<line>`, `git blame -L <line>,<line>`
  yields the commit SHA that last wrote that line; `loadCommitMap` yields the
  record for that SHA; the record's `sessions[]` yields the owning session for
  that file. From the session we reconstruct the same row `fileProvenance`
  produces (`who`, `tool`, `ts`, `ask`, `summary`, `decisions`, `gotchas`,
  `live`), plus the `sha` and the blamed `line`. A **single row**, not a list —
  a line has exactly one last-writer.

- **Churn** — for a session (or a time window resolved to the set of commits in
  the map), *lines written* = the additions those commits introduced;
  *lines landed* = how many of those exact lines survive verbatim in HEAD
  (`git blame HEAD` still attributes them to one of the session's commits).
  `landed / written` is the **landed fraction**; `1 − landed` is churn. A
  session with no commits older than the window returns "insufficient data",
  never `0`.

## Locked decision — the authorship gate (Andrew's call)

**The commit map attributes a commit locally only if its committer email ==
the local `git config user.email`.** Pulled teammate commits are *skipped*
locally — a teammate's session already reaches us through team sync, and
double-attributing their commit from our clone would credit the wrong session.

Line-level `why` and churn therefore **trust the map**: every SHA in
`commits.jsonl` is one this machine authored, so blaming a line to a mapped SHA
is safe. **This gate is a hard dependency and may not be built yet** (Phase 2
review flagged "upstream-commit false attribution needing an author gate" as an
open follow-up; `readCommit` today reads `%cI|%P` only — no `%ce`/`%ae`
filter). Until the gate lands, a line blamed to a *pulled* teammate commit that
happens to be in the local map could surface the wrong session. Both features
are correct **the moment the gate is in place**; neither feature builds the
gate. See the plan's dependency notes.

## Behavior

### Line-level `why`

- **Parse.** `membridge why <file>:<line>` splits on the last `:` whose tail is
  an integer (Windows drive letters and `:line:col` paste artifacts tolerated —
  a trailing `:col` is dropped, a non-integer tail means "no line given").
- **No line / bad line ⇒ file-level.** `membridge why <file>` is unchanged; a
  line of `0`, negative, or non-numeric falls back to the full file-level list.
  This is a *degrade*, not an error.
- **Blame ⇒ SHA ⇒ map ⇒ session ⇒ row.** Run blame for the one line; look the
  SHA up in `loadCommitMap`; find the session that owns this file in that
  record; build the provenance row for that session. Return
  `{ project, file, line, sha, session }` where `session` is the single row (or
  `null`).
- **SHA not in the map ⇒ file-level fallback, annotated.** A line last written
  by an uncommitted edit (blame SHA all-zeros), a pre-tracking commit, a
  merge commit (the map stores merges as `files: []`), or a
  gated-out teammate commit has no mapped session. We fall back to the
  file-level list and say why ("line 42 was last written by an untracked /
  teammate commit — showing file-level history instead"). Never an error, never
  empty when file-level history exists.
- **MCP `why` tool.** Gains an optional `line` integer param. With it, returns
  the single line-level row (same redaction pass as today, every text field
  through `redactedOrNull`); without it, byte-identical to today's file-level
  response. The tool description is updated to stop saying "no line-level
  blame."
- **Offline-testable.** Blame runs through an **injected git runner**
  (`deps.runGit`, defaulting to `defaultRunGit(projectPath)` exactly like
  `commits.js`), so tests feed fixture blame output with no real repo. Any git
  failure degrades to the file-level answer — blame never throws into `why`.

### Churn diagnostic

- `membridge churn [--session <id> | --since <Nd>] [--project <path>]` prints,
  for the resolved commit set: lines written, lines still in HEAD, landed
  fraction, and a one-line plain-English read ("most of this session's lines
  are still in HEAD" / "much of this was later rewritten"). No leaderboard, no
  teammate column, no target.
- **Window semantics.** `--since 7d` selects the session's (or the project's
  *own* — locally-authored) commits committed **at least** N days ago, so
  survival has had time to happen; a session all of whose commits are newer
  than the window returns "too recent to measure."
- **Diagnostic-only, framed explicitly.** The output carries a fixed caveat
  line: *"Churn is a diagnostic, not a target — a low number can mean healthy
  iteration. It is never compared across people."* The command **refuses** a
  teammate/author argument (there is none) and operates only on the local map,
  which — post-gate — contains only this machine's own commits. There is no
  cross-author API and none is planned.

## Error handling

- **git missing / not a repo / blame fails** ⇒ line-level degrades to
  file-level; churn returns "unavailable". Never throws (AGENTS.md: degrade,
  never throw into a render/CLI path).
- **Uncommitted line** (blame reports the all-zero "not committed yet" SHA) ⇒
  file-level fallback with the "uncommitted local edit" note.
- **SHA absent from map / merge / teammate (pre-gate)** ⇒ file-level fallback,
  annotated.
- **File outside the project / unknown project** ⇒ same handling as
  `fileProvenance` today: empty/`not tracked`, not an error.
- **Redaction** ⇒ every text field crossing the CLI stdout and the MCP boundary
  re-runs the redaction pipeline, identical to `whyFile`/`fileProvenance`.
- **Deleted file** ⇒ line-level requires a line that exists at HEAD; a deleted
  file has no HEAD line, so it degrades to the file-level history (which is a
  legitimate answer for deleted files, as today).

## Testing

Pure functions and injected-git fixtures, offline, matching
`test/run-tests.js`:

- **blame line → SHA:** injected runner returns porcelain blame for one line;
  helper extracts the 40-hex SHA; malformed/empty output ⇒ `null`.
- **line → session join:** fixture `commits.jsonl` + fixture events; blamed SHA
  resolves to the owning session's row (ask/summary/decisions/gotchas populated
  from the same pipeline as `fileProvenance`).
- **fallbacks:** no line given, non-integer line, all-zero SHA, SHA-not-in-map,
  and merge SHA (`files: []`) each fall back to the file-level list with the
  right annotation — never throw, never empty when file history exists.
- **git failure degrades:** a throwing runner yields the file-level answer.
- **MCP `line` param:** present ⇒ single row, redacted; absent ⇒ response
  byte-identical to today.
- **churn compute:** fixture commits (numstat additions) + fixture HEAD blame ⇒
  correct written/landed/fraction; a session with only within-window commits ⇒
  "too recent"; empty commit set ⇒ "insufficient data".
- **churn is local-only:** the command exposes no author/teammate parameter;
  the caveat line is always present in the rendered output.
