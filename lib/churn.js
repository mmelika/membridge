'use strict';
// Churn — a DIAGNOSTIC-ONLY landed-vs-reverted signal. For one session (or a
// window of the project's own recent local commits), of the lines that
// session's commits INTRODUCED, what fraction still survives verbatim in HEAD?
// A low number is a health signal (heavy rework / reverted work), never a
// target and NEVER compared across people — by construction there is no
// author/teammate parameter here, so cross-person comparison is impossible.
//
// Pure over: the commit map (which SHAs a session owns, and their files), the
// per-commit additions (`git show --numstat`), and per-file HEAD survival
// (`git blame HEAD`). Every git call goes through an injected runner and the
// whole body degrades to status:'unavailable' — it never throws into a CLI.
//
// Trust boundary: the commit map is already authorship-gated (only local-
// committer commits carry sessions), so "a session's commits" are genuinely
// this machine's work. Line survival is VERBATIM (no `-w`) and pre-gate this
// is an APPROXIMATE instrument — a moved line reads as churned.
const { parseNumstat, defaultRunGit } = require('./changes');

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA_LINE = /^([0-9a-f]{40}) \d+ \d+/; // a porcelain blame header line

// churn(projectPath, { session, sinceDays, now }, deps) ->
//   { commits, written, landed, fraction, status }
// status: 'ok' | 'too-recent' | 'insufficient' | 'unavailable'.
// NB: the options object carries NO author/teammate/who field — that omission
// is the whole point. sinceDays is a SETTLING threshold: only commits at least
// that old are judged, because a just-landed line hasn't had time to be
// reverted. `session` scopes to one session; omitted = every locally-attributed
// commit (the project's own recent work).
function churn(projectPath, opts = {}, deps = {}) {
  const session = opts.session || null;
  const sinceDays = Number.isFinite(opts.sinceDays) ? opts.sinceDays : 7;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cutoff = now - sinceDays * DAY_MS;
  const none = frac => ({ commits: 0, written: 0, landed: 0, fraction: null, status: frac });
  try {
    const records = deps.loadCommitMap ? deps.loadCommitMap(projectPath) : require('./commits').loadCommitMap(projectPath);
    const runGit = deps.runGit || defaultRunGit(projectPath);

    const ownsFor = rec => (rec.sessions || []).some(s => s && s.session === session);
    const isLocal = rec => Array.isArray(rec.sessions) && rec.sessions.length > 0;
    const candidates = (Array.isArray(records) ? records : [])
      .filter(rec => rec && rec.sha && (session ? ownsFor(rec) : isLocal(rec)));
    if (!candidates.length) return none('insufficient');

    // Only settled commits (older than the window) can be judged for survival.
    const settled = candidates.filter(rec => {
      const t = Date.parse(rec.ts);
      return Number.isFinite(t) && t <= cutoff;
    });
    if (!settled.length) return none('too-recent');

    const shaSet = new Set(settled.map(r => r.sha));
    // The files this session (or window) introduced, and how many lines each
    // commit added to them.
    const files = new Set();
    let written = 0;
    for (const rec of settled) {
      const owned = session
        ? ((rec.sessions.find(s => s && s.session === session) || {}).files || [])
        : rec.sessions.flatMap(s => (s && s.files) || []);
      const stat = parseNumstat(runGit(['show', '--numstat', '--format=', '--no-color', '--no-show-signature', rec.sha, '--']));
      for (const f of owned) {
        files.add(f);
        const s = stat.get(f);
        if (s && Number.isFinite(s.add)) written += s.add;
      }
    }
    if (written <= 0) return { commits: settled.length, written: 0, landed: 0, fraction: null, status: 'insufficient' };

    // Survival: blame HEAD once per file, count lines still originating from
    // one of the session's commits.
    let landed = 0;
    for (const f of files) {
      const out = String(runGit(['blame', 'HEAD', '--porcelain', '--', f]));
      for (const line of out.split('\n')) {
        const m = line.match(SHA_LINE);
        if (m && shaSet.has(m[1])) landed++;
      }
    }
    return { commits: settled.length, written, landed, fraction: landed / written, status: 'ok' };
  } catch {
    return none('unavailable');
  }
}

// `--since 7d` (or a bare `7`) → day count. Unparseable / missing → 7.
function parseSince(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d+)\s*d?$/i);
  return m ? parseInt(m[1], 10) : 7;
}

// The FIXED caveat — it ships with every churn render, ok or not. Churn is a
// health signal about rework, never a target, and (by construction, no author
// dimension exists) never comparable across teammates.
const CAVEAT = 'Churn is a diagnostic, not a target — a health signal about your own rework, never a goal to optimize and never compared across people.';
const APPROX = 'Note: this survival count is approximate — lines are matched verbatim, so a moved or reformatted line still reads as churned.';

function pct(f) {
  return `${Math.round(f * 100)}%`;
}

// Pure presenter over a churn(...) result. Returns a multi-line string; the
// caller just prints it. Always ends with the caveat (+ the approximate note).
function renderChurn(result, opts = {}) {
  const r = result || {};
  const scope = opts.session ? `session ${opts.session}` : 'this project\'s recent local commits';
  const days = Number.isFinite(opts.sinceDays) ? opts.sinceDays : 7;
  const lines = [];
  if (r.status === 'ok') {
    lines.push(`Churn for ${scope} — ${r.landed} of ${r.written} introduced line(s) still survive in HEAD (${pct(r.fraction)}), across ${r.commits} settled commit(s).`);
    const f = r.fraction;
    lines.push(f >= 0.8
      ? '  Read: most of what landed is still in place — low rework.'
      : f >= 0.5
        ? '  Read: a meaningful share has since been rewritten or reverted — moderate rework.'
        : '  Read: much of it has since been rewritten or reverted — heavy rework (worth a look, not a verdict).');
  } else if (r.status === 'too-recent') {
    lines.push(`Too recent to judge: ${scope}'s commits are all newer than the ${days}-day settling window, so survival isn't meaningful yet.`);
  } else if (r.status === 'insufficient') {
    lines.push(`Not enough committed, locally-attributed work to measure churn for ${scope} yet.`);
  } else {
    lines.push('Churn is unavailable here — git or the commit map could not be read.');
  }
  lines.push('');
  lines.push(CAVEAT);
  lines.push(APPROX);
  return lines.join('\n');
}

// The most recent session id in a project's event stream, or null.
function mostRecentSession(proj) {
  let best = null, bestTs = '';
  for (const ev of (proj && proj.events) || []) {
    if (!ev || !ev.session) continue;
    if (String(ev.ts) >= bestTs) { bestTs = String(ev.ts); best = ev.session; }
  }
  return best;
}

module.exports = { churn, parseSince, renderChurn, mostRecentSession, CAVEAT };
