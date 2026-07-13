'use strict';
const fs = require('fs');
const path = require('path');
const { normPath } = require('./util');

const BEGIN = '<!-- membridge:begin -->';
const END = '<!-- membridge:end -->';

const eventKey = e => [e.ts, e.source, e.kind, e.session || '', e.text || '', e.file || ''].join('|');

// Fold newly scanned events into each project's rolling history (deduped,
// time-sorted, capped). Returns the set of project keys that changed.
function mergeEvents(state, events, config) {
  state.projects = state.projects || {};
  const touched = new Set();
  const seen = new Map(); // project key -> Set of event keys
  // Case-insensitive filesystems (win32): map the case-folded path to the
  // stored key so tools reporting different casings share one history.
  const canon = new Map();
  for (const k of Object.keys(state.projects)) canon.set(normPath(k), k);

  for (const ev of events) {
    if (!ev || !ev.project || !ev.ts) continue;
    const resolved = path.resolve(String(ev.project));
    const norm = normPath(resolved);
    let key = canon.get(norm);
    if (!key) canon.set(norm, (key = resolved));
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
    if (ev.session) stored.session = ev.session;
    if (Array.isArray(ev.items)) stored.items = ev.items;
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

// Agent self-reports arrive as chat markdown; a one-line digest wants prose.
// Prompts are left alone — the user's own formatting is part of the ask.
function plainText(text) {
  return String(text)
    .replace(/```[a-z]*\n?/gi, ' ') // code fences
    .replace(/`([^`]*)`/g, '$1')    // inline code
    .replace(/\*\*|__/g, '')        // bold
    .replace(/^#{1,6}\s+/gm, ' ')   // headings
    .replace(/\|/g, ' ')            // table pipes
    .replace(/\s+/g, ' ')
    .trim();
}

const shortDate = ts => String(ts).slice(0, 16).replace('T', ' ');

function recentPrompts(proj, config, regexes) {
  const max = (config && config.maxPrompts) || 8;
  return proj.events
    .filter(e => e.kind === 'prompt')
    .slice(-max)
    // Redact before clipping: truncation must not break a pattern's anchor.
    .map(e => ({ ts: e.ts, source: e.source, text: clip(redactText(e.text || '', regexes)) }));
}

// Files outside the project root are dropped, not shown: an absolute
// scratchpad path leaks usernames and machine layout into synced (and
// potentially committed) files, and carries no signal for teammates.
function dedupeFiles(projectPath, edits, max) {
  const seen = new Set();
  const files = [];
  let outside = 0;
  for (let i = edits.length - 1; i >= 0 && files.length < max; i--) {
    const f = edits[i].file;
    if (!f || seen.has(f)) continue;
    seen.add(f);
    let rel = null;
    try {
      const r = path.relative(projectPath, f);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r;
    } catch {}
    if (rel === null) {
      outside++;
      continue;
    }
    files.push({ file: rel, source: edits[i].source });
  }
  return { files, outside };
}

function recentFiles(projectPath, proj, config) {
  const max = (config && config.maxFiles) || 10;
  return dedupeFiles(projectPath, proj.events.filter(e => e.kind === 'edit'), max).files;
}

// Per-chat view of the event history: the last maxSessions sessions, each with
// its first ask, the latest agent self-report and todo state, and the files it
// touched. The latest summary/todos win — earlier ones in the same session are
// stale by definition (the last write reflects current task state).
function sessionGroups(projectPath, proj, config) {
  const maxSessions = (config && config.maxSessions) || 5;
  const maxFiles = (config && config.maxFiles) || 10;
  const bySession = new Map();
  for (const e of proj.events) {
    const s = e.session || '';
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s).push(e);
  }
  // proj.events is time-sorted, so each group is too; order sessions by their
  // latest activity and keep the most recent maxSessions, oldest first.
  return [...bySession.values()]
    .sort((a, b) => String(a[a.length - 1].ts).localeCompare(String(b[b.length - 1].ts)))
    .slice(-maxSessions)
    .map(events => {
      const prompts = events.filter(e => e.kind === 'prompt' && e.text);
      const summaries = events.filter(e => e.kind === 'summary' && e.text);
      const todoWrites = events.filter(e => e.kind === 'todos' && Array.isArray(e.items));
      const edits = dedupeFiles(projectPath, events.filter(e => e.kind === 'edit'), maxFiles);
      return {
        ts: events[0].ts,
        source: events[0].source,
        prompts,
        ask: prompts.length ? prompts[0].text : '',
        summary: summaries.length ? summaries[summaries.length - 1].text : '',
        todos: todoWrites.length ? todoWrites[todoWrites.length - 1].items : null,
        files: edits.files,
        outsideOnly: !edits.files.length && edits.outside > 0,
      };
    });
}

const todoCounts = items => ({
  done: items.filter(i => i && i.status === 'completed').length,
  total: items.length,
});

// The brief memory block each AI tool will read from its context file.
function renderBlock(projectPath, proj, config) {
  const regexes = compileRedactions(config);
  const maxPrompts = (config && config.maxPrompts) || 8;
  const sessions = sessionGroups(projectPath, proj, config);
  const files = recentFiles(projectPath, proj, config);

  const lines = [BEGIN];
  lines.push('## Shared AI memory (MemBridge)');
  lines.push('');
  lines.push('_Recent work done in this project by AI coding tools, auto-synced so each tool knows what the others did. Treat as background context. Do not edit this block — MemBridge rewrites it._');
  lines.push('');
  if (sessions.some(s => s.prompts.length || s.summary || s.todos)) {
    lines.push('Recent asks across tools:');
    for (const s of sessions) {
      // Redact before clipping: truncation must not break a pattern's anchor.
      if (!s.summary && !s.todos) {
        // Nothing richer than the asks — keep the original one-line format.
        for (const p of s.prompts.slice(-maxPrompts)) {
          lines.push(`- ${shortDate(p.ts)} · ${p.source}: ${clip(redactText(p.text, regexes))}`);
        }
        continue;
      }
      lines.push(`- ${shortDate(s.ts)} · ${s.source}`);
      lines.push(`  Ask: ${s.ask ? clip(redactText(s.ask, regexes)) : '(not captured)'}`);
      if (s.summary) lines.push(`  Result: ${clip(redactText(plainText(s.summary), regexes), 240)}`);
      if (s.todos) {
        const t = todoCounts(s.todos);
        lines.push(`  Tasks: ${t.done}/${t.total} done`);
      }
      if (s.files.length) lines.push(`  Files: ${s.files.map(f => f.file).join(', ')}`);
      else if (s.outsideOnly) lines.push('  Files: (outside project)');
    }
    lines.push('');
  }
  if (files.length) {
    lines.push(`Files recently modified by AI tools: ${files.map(f => f.file).join(', ')}`);
    lines.push('');
  }
  // Entries pulled from teammates via team sync. Redacted again on render as
  // defense in depth — the server should only ever hold redacted text anyway.
  const team = (proj.teamEntries || []).slice(-((config && config.maxPrompts) || 8));
  if (team.length) {
    lines.push("Teammates' AI activity (MemBridge team sync):");
    for (const e of team) {
      const f = e.files && e.files.length ? ` — files: ${e.files.slice(0, 5).join(', ')}` : '';
      lines.push(`- ${shortDate(e.ts)} · ${e.author} · ${e.source}: ${clip(redactText(e.ask || '', regexes))}${f}`);
    }
    lines.push('');
  }
  // The current roadmap (PLAN M3) is cross-tool memory too: one line so every
  // AI tool reading this file knows the plan and where the details live.
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(projectPath, '.membridge', 'plan.json'), 'utf8'));
    const tasks = (saved.plan.phases || []).reduce((n, p) => n + p.tasks.length, 0);
    lines.push(`Current roadmap: ${clip(redactText(saved.goal, regexes), 120)} — ${tasks} tasks · \`.membridge/plan.json\``);
    lines.push('');
  } catch {}
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
  compileRedactions, redactText, clip, plainText, shortDate, recentPrompts, recentFiles,
  sessionGroups, todoCounts,
};
