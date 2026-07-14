'use strict';
const fs = require('fs');
const path = require('path');
const digest = require('./digest');

// Per-project memory database, stored inside the project at .membridge/:
//   memory.json  — structured DB: memory entries + an index of the project's
//                  local files, so entries can reference the exact files each
//                  AI touched and any other LLM can be pointed at them
//   memory.md    — the same memory rendered as markdown for humans and agents
//
// Both are derived deterministically from the project's event history, so
// they can always be regenerated and never drift from the source of truth.

const DIR_NAME = '.membridge';
const DB_VERSION = 1;

const toPosix = p => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// File index
// ---------------------------------------------------------------------------
function buildFileIndex(projectPath, config) {
  const ignore = new Set(config.indexIgnore || []);
  const max = config.maxIndexFiles || 2000;
  const files = [];
  let truncated = false;

  (function walk(dir, rel) {
    if (files.length >= max) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, r);
      } else if (e.isFile()) {
        if (files.length >= max) {
          truncated = true;
          return;
        }
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        files.push({ path: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  })(projectPath, '');

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { updatedAt: new Date().toISOString(), truncated, count: files.length, files };
}

// ---------------------------------------------------------------------------
// Entries: one entry per prompt, with the files edited afterwards (up to the
// next prompt) attached — "what was asked, and which files it touched".
// ---------------------------------------------------------------------------
// Files outside the project are dropped entirely: entries can be pushed to
// team sync, a foreign absolute path would leak usernames and machine layout,
// and even the basename of a scratch file carries no signal for teammates.
// Returns null for such paths.
function relFile(projectPath, file) {
  try {
    const r = path.relative(projectPath, file);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return toPosix(r);
  } catch {}
  return null;
}

function buildEntries(projectPath, proj, config) {
  const regexes = digest.compileRedactions(config);
  const maxEntries = config.maxEntries || 100;
  const entries = [];
  let current = null;
  // Summaries and todo state belong to the ask they answer: the most recent
  // entry of the same session. Candidate summaries are collected per entry
  // and settled by digest.pickSummary at the end, so the Distilled-beats-
  // harvested rule is the same one every other surface uses.
  const lastInSession = new Map();
  const summariesFor = new Map(); // entry -> its candidate summary events

  for (const ev of proj.events) {
    if (ev.kind === 'prompt') {
      current = {
        ts: ev.ts,
        source: ev.source,
        // Redact before clipping: truncation must not break a pattern's anchor.
        ask: digest.clip(digest.redactText(ev.text || '', regexes), 300),
        files: [],
      };
      entries.push(current);
      lastInSession.set(ev.session || '', current);
    } else if (ev.kind === 'edit' && ev.file) {
      const rel = relFile(projectPath, ev.file);
      if (rel === null) continue;
      if (!current || current.source !== ev.source) {
        current = { ts: ev.ts, source: ev.source, ask: '(file edits)', files: [] };
        entries.push(current);
        lastInSession.set(ev.session || '', current);
      }
      if (!current.files.includes(rel)) current.files.push(rel);
    } else if (ev.kind === 'summary' && ev.text) {
      const entry = lastInSession.get(ev.session || '');
      if (entry) {
        if (!summariesFor.has(entry)) summariesFor.set(entry, []);
        summariesFor.get(entry).push(ev);
      }
    } else if (ev.kind === 'todos' && Array.isArray(ev.items)) {
      const entry = lastInSession.get(ev.session || '');
      if (entry) {
        entry.tasks = {
          ...digest.todoCounts(ev.items),
          items: ev.items.map(i => ({
            text: digest.clip(digest.redactText(digest.plainText(i.text || ''), regexes)),
            status: i.status,
          })),
        };
      }
    }
  }
  const clipSummary = (text, n) => digest.clip(digest.redactText(digest.plainText(text), regexes), n);
  for (const [entry, evs] of summariesFor) {
    const best = digest.pickSummary(evs);
    if (!best) continue;
    entry.summary = clipSummary(best.text, 300);
    if (best.source === 'Distilled') entry.distilled = true;
    // A long session leaves a trail of distilled checkpoints; keep the whole
    // ordered sequence for the "go deeper" view (context block + team push
    // still take only the latest). Single-summary sessions carry none.
    const seq = digest.sessionSummaries(evs);
    if (seq.length > 1 && seq[0].source === 'Distilled') {
      entry.checkpoints = seq.map(e => clipSummary(e.text, 240));
    }
  }
  return entries.slice(-maxEntries);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderMemoryMd(projectPath, db, config) {
  const name = path.basename(projectPath);
  const shown = db.entries.slice(-30);
  const lines = [];
  lines.push(`# Project memory — ${name}`);
  lines.push('');
  lines.push('_Cross-tool AI activity log, maintained by MemBridge. Any AI agent reading this: it records what other AI tools recently did in this project and which files they touched. Auto-generated — do not edit._');
  lines.push('');
  for (const e of shown) {
    lines.push(`## ${digest.shortDate(e.ts)} · ${e.source}`);
    lines.push('');
    lines.push(e.ask);
    if (e.checkpoints && e.checkpoints.length > 1) {
      lines.push('');
      lines.push('Checkpoints:');
      e.checkpoints.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    } else if (e.summary) {
      lines.push('');
      lines.push(`Result: ${e.summary}`);
    }
    if (e.tasks) {
      lines.push('');
      lines.push(`Tasks (${e.tasks.done}/${e.tasks.total} done):`);
      for (const t of e.tasks.items || []) {
        lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.text}`);
      }
    }
    if (e.files.length) {
      lines.push('');
      lines.push(`Files: ${e.files.map(f => `\`${f}\``).join(', ')}`);
    }
    lines.push('');
  }
  const idx = db.fileIndex;
  lines.push('---');
  lines.push('');
  lines.push(`File index: ${idx.count}${idx.truncated ? '+' : ''} files indexed at ${digest.shortDate(idx.updatedAt)} — full list with sizes and timestamps in \`${DIR_NAME}/memory.json\`.`);
  const topLevel = [...new Set(idx.files.map(f => f.path.split('/')[0]))].slice(0, 20);
  if (topLevel.length) lines.push(`Top level: ${topLevel.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

// A compact handoff for web AIs that cannot see this machine: the same
// redacted entries as memory.md, trimmed to fit a chat box. Served to the
// dashboard's per-project "Copy for AI" button.
function renderCopyText(projectPath, proj, config) {
  const name = path.basename(projectPath);
  const entries = buildEntries(projectPath, proj, config).slice(-12);
  const lines = [];
  lines.push(`Context on my local project "${name}" — recent AI coding work, digested by MemBridge ${digest.shortDate(new Date().toISOString())} UTC.`);
  lines.push('Treat this as background so you know what has already been done; no need to summarize it back.');
  lines.push('');
  if (entries.length) {
    lines.push('Recent asks (oldest first):');
    for (const e of entries) {
      const files = e.files.length ? ` — files: ${e.files.join(', ')}` : '';
      lines.push(`- ${digest.shortDate(e.ts)} · ${e.source}: ${e.ask}${files}`);
      if (e.summary) lines.push(`  Result: ${digest.clip(e.summary, 240)}`);
      if (e.tasks) lines.push(`  Tasks: ${e.tasks.done}/${e.tasks.total} done`);
    }
  } else {
    lines.push('No AI activity captured in this project yet.');
  }
  const top = topLevelNames(projectPath, config);
  if (top.length) {
    lines.push('');
    lines.push(`Project top level: ${top.join(', ')}`);
  }
  lines.push('');
  lines.push(`(Fuller log lives in ${DIR_NAME}/memory.md inside the project — ask me to paste it if you need more.)`);
  return lines.join('\n') + '\n';
}

// One-level directory listing, honoring the same ignore set as the file
// index. Names only — file contents never enter the digest.
function topLevelNames(projectPath, config) {
  const ignore = new Set(config.indexIgnore || []);
  let entries;
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => !ignore.has(e.name) && !e.name.startsWith('.'))
    .map(e => (e.isDirectory() ? e.name + '/' : e.name))
    .sort()
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const dbPath = projectPath => path.join(projectPath, DIR_NAME, 'memory.json');
const mdPath = projectPath => path.join(projectPath, DIR_NAME, 'memory.md');

function loadDb(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(dbPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Rebuild the project DB + markdown from the current event history.
// Returns the list of files written (empty when nothing changed).
function updateProject(projectPath, proj, config) {
  const db = {
    version: DB_VERSION,
    project: toPosix(projectPath),
    updatedAt: new Date().toISOString(),
    fileIndex: buildFileIndex(projectPath, config),
    entries: buildEntries(projectPath, proj, config),
  };

  const written = [];
  const dir = path.join(projectPath, DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });

  // Skip writes when nothing meaningful changed (ignore volatile timestamps).
  const prev = loadDb(projectPath);
  const fingerprint = d => JSON.stringify({ e: d.entries, f: d.fileIndex.files });
  if (!prev || fingerprint(prev) !== fingerprint(db)) {
    fs.writeFileSync(dbPath(projectPath), JSON.stringify(db, null, 2));
    fs.writeFileSync(mdPath(projectPath), renderMemoryMd(projectPath, db, config));
    written.push(dbPath(projectPath), mdPath(projectPath));
  }
  return written;
}

function removeProjectMemory(projectPath) {
  const dir = path.join(projectPath, DIR_NAME);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

module.exports = { DIR_NAME, buildFileIndex, buildEntries, renderMemoryMd, renderCopyText, topLevelNames, updateProject, loadDb, removeProjectMemory, dbPath, mdPath };
