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
function relFile(projectPath, file) {
  try {
    const r = path.relative(projectPath, file);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return toPosix(r);
  } catch {}
  return toPosix(String(file));
}

function buildEntries(projectPath, proj, config) {
  const regexes = digest.compileRedactions(config);
  const maxEntries = config.maxEntries || 100;
  const entries = [];
  let current = null;

  for (const ev of proj.events) {
    if (ev.kind === 'prompt') {
      current = {
        ts: ev.ts,
        source: ev.source,
        ask: digest.redactText(digest.clip(ev.text || '', 300), regexes),
        files: [],
      };
      entries.push(current);
    } else if (ev.kind === 'edit' && ev.file) {
      const rel = relFile(projectPath, ev.file);
      if (!current || current.source !== ev.source) {
        current = { ts: ev.ts, source: ev.source, ask: '(file edits)', files: [] };
        entries.push(current);
      }
      if (!current.files.includes(rel)) current.files.push(rel);
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

module.exports = { DIR_NAME, buildFileIndex, buildEntries, renderMemoryMd, updateProject, loadDb, removeProjectMemory, dbPath, mdPath };
