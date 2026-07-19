'use strict';
// Commit↔session attribution (provenance Phase 2, Task 1). Pure: given the
// files a commit touched, the commit's timestamp, and the project's event
// stream, decide which session owns each file. The rule is simple on
// purpose — the session of the MOST RECENT edit at or before the commit
// time owns the file; an edit dated after the commit cannot have produced
// it. File granularity only, same as lib/provenance.js: no line-level
// blame, no churn. No git in this module either — reading commits is the
// next task; this is the attribution rule alone, so it stays testable with
// plain fixtures (changes.js draws the same line around deriveChanges).
const fs = require('fs');
const path = require('path');
const provenance = require('./provenance');
const memorydb = require('./memorydb');
const { parseNumstat, defaultRunGit } = require('./changes');

// The sessions that own `changedFiles` as of `commitTs`.
//   changedFiles  repo-relative paths as git reports them (absolute and
//                 ./-prefixed spellings are normalized too)
//   commitTs      ISO string or epoch ms
//   events        the project's event stream; only kind 'edit' rows with a
//                 file and a parseable ts participate
//   opts.projectPath  the root that absolute paths (event files are usually
//                 absolute) normalize against; without it an absolute path
//                 cannot be matched and falls through as unattributed
// Returns { sessions: [{ session, files }], unattributed: [] } — sessions
// newest-owning first (by their latest winning edit), files in input order,
// spelled repo-relative. A file whose winning edit carries no session id is
// unattributed too: with nobody to credit, that IS unattributed.
function attributeCommit(changedFiles, commitTs, events, opts = {}) {
  const projectPath = (opts && opts.projectPath) || null;
  const cutoff = typeof commitTs === 'number' ? commitTs : Date.parse(commitTs);
  const norm = f => {
    const s = String(f || '');
    if (!s) return null;
    if (path.isAbsolute(s) && !projectPath) return null;
    return provenance.normalizeRel(projectPath || '', s);
  };

  // Normalize the commit's files up front; anything unnormalizable (empty,
  // absolute with no root, escaping the project) can never match an edit,
  // so it is unattributed as given.
  const targets = [];
  const unattributed = [];
  for (const f of Array.isArray(changedFiles) ? changedFiles : []) {
    const rel = norm(f);
    if (rel) targets.push(rel);
    else unattributed.push(String(f));
  }

  // Latest qualifying edit per file, one pass over the stream. Equal
  // timestamps: the later event wins (streams are time-sorted, so that is
  // the later write).
  const winner = new Map(); // rel -> { session, t }
  if (Number.isFinite(cutoff) && Array.isArray(events)) {
    const relevant = new Set(targets);
    for (const ev of events) {
      if (!ev || ev.kind !== 'edit' || !ev.file) continue;
      const t = Date.parse(ev.ts);
      if (!Number.isFinite(t) || t > cutoff) continue;
      const rel = norm(ev.file);
      if (!rel || !relevant.has(rel)) continue;
      const prev = winner.get(rel);
      if (!prev || t >= prev.t) winner.set(rel, { session: ev.session || '', t });
    }
  }

  const bySession = new Map(); // session -> { session, files, lastT }
  for (const rel of targets) {
    const w = winner.get(rel);
    if (!w || !w.session) {
      unattributed.push(rel);
      continue;
    }
    let g = bySession.get(w.session);
    if (!g) bySession.set(w.session, (g = { session: w.session, files: [], lastT: 0 }));
    g.files.push(rel);
    if (w.t > g.lastT) g.lastT = w.t;
  }
  const sessions = [...bySession.values()]
    .sort((a, b) => b.lastT - a.lastT)
    .map(({ session, files }) => ({ session, files }));
  return { sessions, unattributed };
}

// ---------------------------------------------------------------------------
// Git readers (Phase 2, Task 2). Same conventions as lib/changes.js: an
// injectable runGit (deps.runGit) defaulting to execFileSync in the project
// root, and every call best-effort — any git failure degrades to an empty
// result, it NEVER throws into a caller. Reading only: nothing here writes a
// store or wires into scan (Task 3).
// ---------------------------------------------------------------------------

// One commit's committer time and changed files.
//   The format line is `%cI|%P` — committer date plus the parent list — and
//   parseNumstat ignores it (no tabs), so one parser serves both modules.
//   Merge detection is EXPLICIT: modern git (>= 2.31) prints first-parent
//   numstat rows for merges (verified against this very repo), so "no rows"
//   cannot be relied on — two or more parents force files: [] per the
//   contract, no matter what git printed. --no-show-signature keeps a user's
//   log.showSignature=true from prepending signature text to stdout (which
//   would become a garbage ts). On git failure ts is null — unknowable, not
//   fabricated.
function readCommit(projectPath, sha, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    // Format `%cI|%ce|%P` — committer date, committer EMAIL, parent list. The
    // email drives the authorship gate (isLocalCommitter); parseNumstat still
    // ignores this line (no tabs). Emails contain no '|', so a plain split is
    // unambiguous even when the parent list is present.
    const out = String(runGit(['show', '--numstat', '--format=%cI|%ce|%P', '--no-color', '--no-show-signature', sha, '--']));
    const head = (out.split('\n').find(l => l.trim()) || '').trim();
    const parts = head.split('|');
    const ts = (parts[0] || '').trim() || null;
    const email = (parts[1] || '').trim() || null;
    const parents = (parts.slice(2).join('|')).trim().split(/\s+/).filter(Boolean);
    if (parents.length >= 2) return { sha, ts, email, files: [] };
    return { sha, ts, email, files: [...parseNumstat(out).keys()] };
  } catch {
    return { sha, ts: null, email: null, files: [] };
  }
}

// The local git identity for `projectPath` — `git config user.email`, trimmed,
// or null (unset config, git failure). The authorship gate compares a commit's
// committer email against this: a null here means "no local identity", which
// fails the gate closed (nothing is attributed) rather than crediting blindly.
function gitUserEmail(projectPath, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    return String(runGit(['config', 'user.email'])).trim() || null;
  } catch {
    return null;
  }
}

// Authorship gate: is a commit with `committerEmail` locally authored, given
// this machine's `localEmail`? Fail closed — a missing local identity, a
// missing committer email, or any mismatch is NOT local, so a pulled teammate
// commit is never falsely credited to a local session.
function isLocalCommitter(committerEmail, localEmail) {
  const a = String(committerEmail || '').trim();
  const b = String(localEmail || '').trim();
  if (!a || !b) return false;
  return a === b;
}

// Commit shas on HEAD after `sinceSha`, oldest-first, merges excluded.
// A missing, unknown, or non-ancestor cursor (checked with merge-base
// --is-ancestor, which exits non-zero and throws) falls back to a BOUNDED
// first run: the newest 50 commits, never the whole history. git log prints
// newest-first; the reversal happens here in JS rather than via --reverse,
// whose interaction with -n limiting is easy to misread. Total git failure
// returns [].
function newCommitsSince(projectPath, sinceSha, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  const shas = out => String(out).split('\n').map(l => l.trim()).filter(Boolean);
  if (sinceSha) {
    try {
      runGit(['merge-base', '--is-ancestor', sinceSha, 'HEAD']);
      return shas(runGit(['log', '--no-merges', '--format=%H', `${sinceSha}..HEAD`])).reverse();
    } catch { /* unknown / non-ancestor cursor or git failure: bounded first run below */ }
  }
  try {
    return shas(runGit(['log', '--no-merges', '-n', '50', '--format=%H'])).reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The commit->session map (Phase 2, Task 3): <project>/.membridge/
// commits.jsonl, one JSON line per commit, append-only. MemBridge owns this
// file — it both writes (sync backfill, post-commit hook) and reads it (the
// provenance surfaces). Append-only means the newest record is the last
// line, which is what lastRecordedSha leans on.
// ---------------------------------------------------------------------------
const COMMITS_FILE = 'commits.jsonl';
const commitMapPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, COMMITS_FILE);

// record = { sha, ts, project, sessions: [{ session, files }], unattributed }.
// mkdir+append; callers wrap (sync and the hook both run best-effort). A
// torn tail (crash or ENOSPC mid-append leaves a partial line with no
// trailing newline) must not glue with this record into one unparseable
// line — that would lose BOTH records and, worse, let the sync cursor
// advance past a commit that was never durably recorded. Land on a fresh
// line whenever the file's last byte is not \n.
function recordCommit(projectPath, record) {
  const file = commitMapPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let sep = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) sep = '\n';
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* no file yet: plain append below creates it */ }
  fs.appendFileSync(file, sep + JSON.stringify(record) + '\n');
}

// All recorded commits, oldest-first. Missing file -> []; a garbage line
// (interrupted write, hand edit) is skipped, never thrown on.
function loadCommitMap(projectPath) {
  let raw;
  try {
    raw = fs.readFileSync(commitMapPath(projectPath), 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object' && r.sha) records.push(r);
    } catch { /* garbage line: skip */ }
  }
  return records;
}

function lastRecordedSha(projectPath) {
  const records = loadCommitMap(projectPath);
  return records.length ? records[records.length - 1].sha : null;
}

// The repo's current HEAD sha, or null (empty repo, not a repo, no git).
// The post-commit hook needs the real sha — recording the literal string
// 'HEAD' would break the already-recorded idempotency check.
function headSha(projectPath, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectPath);
  try {
    return String(runGit(['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

module.exports = {
  attributeCommit, readCommit, newCommitsSince, headSha,
  gitUserEmail, isLocalCommitter,
  recordCommit, loadCommitMap, lastRecordedSha, commitMapPath,
};
