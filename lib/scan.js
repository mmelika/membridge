'use strict';
const fs = require('fs');
const path = require('path');
const { getConfig, loadState, saveState, walkFiles, isProjectOff, log } = require('./util');
const digest = require('./digest');
const claudeCode = require('./adapters/claude-code');
const codex = require('./adapters/codex');
const custom = require('./adapters/custom');

// ---------------------------------------------------------------------------
// Incremental JSONL reading: only bytes appended since the last sync are read,
// and only complete lines are consumed, so a session file being actively
// written by a tool is never half-parsed.
// ---------------------------------------------------------------------------
function readNewLines(file, offset) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { entries: [], offset: offset || 0 };
  }
  let start = offset || 0;
  if (stat.size < start) start = 0; // file was truncated/rewritten
  if (stat.size === start) return { entries: [], offset: start };

  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a); // '\n' is single-byte ASCII, safe on raw bytes
  if (lastNl === -1) return { entries: [], offset: start };

  const entries = [];
  for (const line of buf.slice(0, lastNl).toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      // skip corrupt/partial line
    }
  }
  return { entries, offset: start + lastNl + 1 };
}

function getAdapters(config) {
  const a = config.adapters || {};
  const list = [];
  if (!a['claude-code'] || a['claude-code'].enabled !== false) list.push(claudeCode);
  if (!a.codex || a.codex.enabled !== false) list.push(codex);
  for (const def of a.custom || []) {
    if (!def || def.enabled === false) continue;
    try {
      list.push(custom.create(def));
    } catch (err) {
      log(`bad custom adapter ${def && def.id}: ${err.message}`);
    }
  }
  return list;
}

// One pass over every adapter's session stores. Mutates state.files (offsets
// and per-file carry data such as the Codex cwd).
function scanAll(state, config) {
  state.files = state.files || {};
  const events = [];
  for (const adapter of getAdapters(config)) {
    for (const root of adapter.sessionRoots(config)) {
      for (const file of walkFiles(root, '.jsonl')) {
        const rec = state.files[file] || (state.files[file] = { offset: 0, adapter: adapter.id, data: {} });
        rec.data = rec.data || {};
        const r = readNewLines(file, rec.offset);
        rec.offset = r.offset;
        if (r.entries.length) events.push(...adapter.extractEvents(r.entries, rec.data));
      }
    }
  }
  return events;
}

function findProjectKey(state, projectPath) {
  const want = path.resolve(projectPath);
  return Object.keys(state.projects || {}).find(k => path.resolve(k) === want) || null;
}

// One full sync pass: scan session stores → merge events → inject the memory
// block into each touched, non-excluded, still-existing project.
function syncOnce(opts = {}) {
  const config = getConfig();
  const state = loadState();
  const events = scanAll(state, config);
  const touched = digest.mergeEvents(state, events, config);

  let projectKeys;
  if (opts.project) {
    const key = findProjectKey(state, opts.project);
    projectKeys = key ? [key] : [];
  } else {
    projectKeys = [...touched];
  }

  const changes = [];
  const skipped = [];
  for (const key of projectKeys) {
    const proj = state.projects[key];
    if (!proj || !proj.events.length) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(key).isDirectory();
    } catch {}
    if (!isDir) {
      skipped.push({ project: key, reason: 'path no longer exists' });
      continue;
    }
    if (isProjectOff(key, config)) {
      skipped.push({ project: key, reason: 'paused/excluded' });
      continue;
    }
    const block = digest.renderBlock(key, proj, config);
    for (const target of config.targets) {
      const file = path.join(key, target);
      if (opts.dryRun) {
        changes.push({ file, action: 'would update' });
      } else if (digest.inject(file, block)) {
        changes.push({ file, action: 'updated' });
      }
    }
    if (!opts.dryRun) proj.lastSync = new Date().toISOString();
  }

  if (!opts.dryRun) saveState(state);
  return { newEvents: events.length, projects: projectKeys, changes, skipped };
}

module.exports = { readNewLines, getAdapters, scanAll, syncOnce, findProjectKey };
