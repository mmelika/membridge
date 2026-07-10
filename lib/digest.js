'use strict';
const fs = require('fs');
const path = require('path');

const BEGIN = '<!-- membridge:begin -->';
const END = '<!-- membridge:end -->';

const eventKey = e => [e.ts, e.source, e.kind, e.text || '', e.file || ''].join('|');

// Fold newly scanned events into each project's rolling history (deduped,
// time-sorted, capped). Returns the set of project keys that changed.
function mergeEvents(state, events, config) {
  state.projects = state.projects || {};
  const touched = new Set();
  const seen = new Map(); // project key -> Set of event keys

  for (const ev of events) {
    if (!ev || !ev.project || !ev.ts) continue;
    const key = path.resolve(String(ev.project));
    const proj = state.projects[key] || (state.projects[key] = { events: [] });
    let keys = seen.get(key);
    if (!keys) {
      keys = new Set(proj.events.map(eventKey));
      seen.set(key, keys);
    }
    const k = eventKey(ev);
    if (keys.has(k)) continue;
    keys.add(k);
    const stored = { ts: ev.ts, source: ev.source, kind: ev.kind };
    if (ev.text) stored.text = ev.text;
    if (ev.file) stored.file = ev.file;
    proj.events.push(stored);
    touched.add(key);
  }

  for (const key of touched) {
    const proj = state.projects[key];
    proj.events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const cap = (config && config.maxStoredEvents) || 200;
    if (proj.events.length > cap) proj.events = proj.events.slice(-cap);
  }
  return touched;
}

function compileRedactions(config) {
  const out = [];
  for (const pattern of (config && config.redact) || []) {
    try {
      out.push(new RegExp(pattern, 'gi'));
    } catch {
      // ignore invalid user pattern
    }
  }
  return out;
}

function redactText(text, regexes) {
  let t = String(text);
  for (const rx of regexes) t = t.replace(rx, '[redacted]');
  return t;
}

function clip(text, n = 140) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const shortDate = ts => String(ts).slice(0, 16).replace('T', ' ');

function recentPrompts(proj, config, regexes) {
  const max = (config && config.maxPrompts) || 8;
  return proj.events
    .filter(e => e.kind === 'prompt')
    .slice(-max)
    .map(e => ({ ts: e.ts, source: e.source, text: redactText(clip(e.text || ''), regexes) }));
}

function recentFiles(projectPath, proj, config) {
  const max = (config && config.maxFiles) || 10;
  const edits = proj.events.filter(e => e.kind === 'edit');
  const seen = new Set();
  const out = [];
  for (let i = edits.length - 1; i >= 0 && out.length < max; i--) {
    const f = edits[i].file;
    if (!f || seen.has(f)) continue;
    seen.add(f);
    let rel = f;
    try {
      const r = path.relative(projectPath, f);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r;
    } catch {}
    out.push({ file: rel, source: edits[i].source });
  }
  return out;
}

// The brief memory block each AI tool will read from its context file.
function renderBlock(projectPath, proj, config) {
  const regexes = compileRedactions(config);
  const prompts = recentPrompts(proj, config, regexes);
  const files = recentFiles(projectPath, proj, config);

  const lines = [BEGIN];
  lines.push('## Shared AI memory (MemBridge)');
  lines.push('');
  lines.push('_Recent work done in this project by AI coding tools, auto-synced so each tool knows what the others did. Treat as background context. Do not edit this block — MemBridge rewrites it._');
  lines.push('');
  if (prompts.length) {
    lines.push('Recent asks across tools:');
    for (const p of prompts) lines.push(`- ${shortDate(p.ts)} · ${p.source}: ${p.text}`);
    lines.push('');
  }
  if (files.length) {
    lines.push(`Files recently modified by AI tools: ${files.map(f => f.file).join(', ')}`);
    lines.push('');
  }
  if (config && config.writeProjectMemory !== false) {
    lines.push('Full activity log and project file index: `.membridge/memory.md` (structured data in `.membridge/memory.json`).');
    lines.push('');
  }
  lines.push(`_Last update: ${shortDate(new Date().toISOString())} UTC · synced by MemBridge_`);
  lines.push(END);
  return lines.join('\n');
}

// Idempotently place the block: replace in place if present, append to an
// existing file, or create the file. Returns true if the file changed.
function inject(filePath, block) {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {}
  let updated;
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b !== -1 && e !== -1 && e > b) {
    updated = existing.slice(0, b) + block + existing.slice(e + END.length);
  } else if (existing.trim()) {
    updated = existing.replace(/\s*$/, '\n\n') + block + '\n';
  } else {
    updated = block + '\n';
  }
  if (updated === existing) return false;
  fs.writeFileSync(filePath, updated);
  return true;
}

// Strip the managed block. Deletes the file if nothing else was in it.
// Returns 'removed', 'deleted' or null (no block found).
function removeBlock(filePath) {
  let existing;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b === -1 || e === -1 || e <= b) return null;
  const before = existing.slice(0, b).replace(/\n+$/, '\n');
  const after = existing.slice(e + END.length).replace(/^\n+/, '');
  const rest = before + after;
  if (!rest.trim()) {
    fs.unlinkSync(filePath);
    return 'deleted';
  }
  fs.writeFileSync(filePath, rest);
  return 'removed';
}

module.exports = {
  BEGIN, END,
  mergeEvents, renderBlock, inject, removeBlock,
  compileRedactions, redactText, clip, shortDate, recentPrompts, recentFiles,
};
