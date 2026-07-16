'use strict';
// Pure change-model derivation. Given a project root and the relative file
// paths a session edited, ask git for status + line counts (best-effort) and
// return an ordered, grouped model the renderers share. Any git failure
// degrades to a filename-only list — never throws into a render path.
const { execFileSync } = require('child_process');

const DEP_RE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile(\.lock)?|poetry\.lock|Cargo\.lock|go\.(sum|mod)|requirements\.txt|composer\.(json|lock))$/;
const STATUS_RANK = { new: 0, edited: 1, deleted: 2 };

function defaultRunGit(projectPath) {
  return args => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseStatus(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    if (!file) continue;
    map.set(file, code.includes('D') ? 'deleted' : (code === '??' || code.includes('A')) ? 'new' : 'edited');
  }
  return map;
}

function parseNumstat(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    const m = line.split('\t');
    if (m.length < 3) continue;
    const add = m[0] === '-' ? null : parseInt(m[0], 10);
    const del = m[1] === '-' ? null : parseInt(m[1], 10);
    map.set(m[2].trim(), { add: Number.isFinite(add) ? add : null, del: Number.isFinite(del) ? del : null });
  }
  return map;
}

// files: relative path strings. highlights: [{file, note}] (relative paths).
function deriveChanges(projectPath, files, highlights = [], opts = {}) {
  const rels = [...new Set(files.filter(Boolean))];
  const noteFor = new Map((highlights || []).filter(h => h && h.file).map(h => [h.file, String(h.note || '').trim() || null]));
  let status = new Map(), stat = new Map();
  try {
    const runGit = opts.runGit || defaultRunGit(projectPath);
    status = parseStatus(runGit(['status', '--porcelain', '--untracked-files=all', '--', ...rels]));
    stat = parseNumstat(runGit(['diff', 'HEAD', '--numstat', '--', ...rels]));
  } catch { /* not a repo / git missing → filename-only */ }

  const model = rels.map(file => {
    const dep = DEP_RE.test(file);
    const s = stat.get(file) || {};
    return {
      file,
      status: status.get(file) || 'edited',
      add: dep ? null : (s.add != null ? s.add : null),
      del: dep ? null : (s.del != null ? s.del : null),
      note: noteFor.get(file) || null,
      dep,
    };
  });
  return model.sort((a, b) =>
    (a.dep - b.dep) ||
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    a.file.localeCompare(b.file));
}

module.exports = { deriveChanges, DEP_RE };
