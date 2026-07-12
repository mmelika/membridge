'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { getConfig, loadState, saveState, loadUserConfig, saveUserConfig, ensureConfig, isProjectOff, log } = require('./util');
const advisor = require('./advisor');
const digest = require('./digest');
const memorydb = require('./memorydb');
const { buildGraph } = require('./graph');
const { syncOnce, getAdapters, findProjectKey } = require('./scan');
const { dashboardPage } = require('./dashboard');

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function statusPayload() {
  const config = getConfig();
  const state = loadState();
  const projects = Object.entries(state.projects || {});
  let lastSync = null;
  const tools = new Set();
  for (const [, proj] of projects) {
    if (proj.lastSync && (!lastSync || proj.lastSync > lastSync)) lastSync = proj.lastSync;
    for (const e of proj.events || []) tools.add(e.source);
  }
  return {
    running: true,
    pid: process.pid,
    version: require('../package.json').version,
    intervalSec: config.intervalSec,
    projectCount: projects.length,
    tools: [...tools],
    adapters: getAdapters(config).map(a => a.displayName),
    lastSync,
  };
}

function projectsPayload() {
  const config = getConfig();
  const state = loadState();
  const regexes = digest.compileRedactions(config);
  const out = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (!Array.isArray(proj.events)) proj.events = []; // added-but-empty project
    let exists = false;
    try {
      exists = fs.statSync(key).isDirectory();
    } catch {}
    out.push({
      path: key,
      name: path.basename(key),
      exists,
      paused: isProjectOff(key, config),
      lastSync: proj.lastSync || null,
      lastActivity: proj.events.length ? proj.events[proj.events.length - 1].ts : null,
      tools: [...new Set(proj.events.map(e => e.source))],
      prompts: digest.recentPrompts(proj, config, regexes).reverse(),
      files: digest.recentFiles(key, proj, config),
      targets: config.targets.map(t => ({
        file: t,
        exists: exists && fs.existsSync(path.join(key, t)),
      })),
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

const planPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'plan.json');

function loadPlan(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Exactly what a roadmap request sends to Anthropic — and nothing else:
// project name, the goal, already-redacted recent asks, file paths, and
// top-level names. Never file contents, never other projects. The Plan tab
// lists this verbatim next to the Generate button.
function planPayload(key, proj, config, goal) {
  const regexes = digest.compileRedactions(config);
  return {
    projectName: path.basename(key),
    goal: digest.redactText(String(goal || ''), regexes).slice(0, 2000),
    recentAsks: memorydb.buildEntries(key, proj, config).slice(-20),
    topLevel: memorydb.topLevelNames(key, config),
  };
}

// Everything the project page needs in one payload: fuller history than the
// grid cards — entries carry which files each ask touched — plus injection
// targets and whether a memory.md exists to link to.
function projectDetail(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return null;
  if (!Array.isArray(proj.events)) proj.events = [];
  let exists = false;
  try {
    exists = fs.statSync(key).isDirectory();
  } catch {}
  const adv = advisor.getAdvisorConfig(config);
  return {
    hasKey: !!adv.apiKey,
    plan: loadPlan(key),
    estimate: {
      model: adv.model,
      costUsd: advisor.estimateCost(adv.model, advisor.buildPlanPrompt(planPayload(key, proj, config, '')).length),
    },
    path: key,
    name: path.basename(key),
    exists,
    paused: isProjectOff(key, config),
    lastSync: proj.lastSync || null,
    lastActivity: proj.events.length ? proj.events[proj.events.length - 1].ts : null,
    tools: [...new Set(proj.events.map(e => e.source))],
    entries: memorydb.buildEntries(key, proj, config).slice(-50),
    files: digest.recentFiles(key, proj, { ...config, maxFiles: 20 }),
    targets: config.targets.map(t => ({
      file: t,
      exists: exists && fs.existsSync(path.join(key, t)),
    })),
    memory: {
      relPath: `${memorydb.DIR_NAME}/memory.md`,
      exists: fs.existsSync(memorydb.mdPath(key)),
    },
  };
}

// Read-only view of the project's own memory log. The served path is derived
// from a tracked project key — never from the raw query — so this cannot be
// pointed at arbitrary files.
function memoryMdPayload(projectPath) {
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  if (!key) return null;
  try {
    return fs.readFileSync(memorydb.mdPath(key), 'utf8');
  } catch {
    return null;
  }
}

// Toggle pause by adding/removing the exact project path in config exclude.
function toggleProject(projectPath) {
  ensureConfig();
  const raw = loadUserConfig();
  raw.exclude = raw.exclude || [];
  const idx = raw.exclude.indexOf(projectPath);
  if (idx === -1) raw.exclude.push(projectPath);
  else raw.exclude.splice(idx, 1);
  saveUserConfig(raw);
  return { path: projectPath, paused: idx === -1 };
}

// Register a directory so it shows on the dashboard before any AI activity.
function addProject(projectPath) {
  const resolved = path.resolve(projectPath);
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {}
  if (!isDir) return { error: 'not a directory' };
  const state = loadState();
  const existing = findProjectKey(state, resolved);
  if (existing) return { path: existing, added: false };
  state.projects = state.projects || {};
  state.projects[resolved] = { events: [] };
  saveState(state);
  return { path: resolved, added: true };
}

// Forget a project: strip injected blocks, drop its .membridge dir and state.
// Transcript offsets stay consumed, so only future activity revives it.
function deleteProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath) || path.resolve(projectPath);
  for (const target of config.targets) digest.removeBlock(path.join(key, target));
  memorydb.removeProjectMemory(key);
  if (state.projects && state.projects[key]) {
    delete state.projects[key];
    saveState(state);
  }
  return { path: key, deleted: true };
}

// Settings for the dashboard. The API key itself is never sent to the page —
// only whether one exists, where it came from, and its last 4 characters.
function settingsPayload() {
  const config = getConfig();
  const adv = advisor.getAdvisorConfig(config);
  return {
    hasKey: !!adv.apiKey,
    keySource: adv.source, // 'config' | 'env' | null
    keyHint: adv.source === 'config' ? `…${adv.apiKey.slice(-4)}` : '',
    model: adv.model,
    models: advisor.PLANNER_MODELS,
    intervalSec: config.intervalSec,
    targets: config.targets,
  };
}

function saveSettings(body) {
  ensureConfig();
  const raw = loadUserConfig();
  if (body.apiKey !== undefined) {
    raw.advisor = raw.advisor || {};
    raw.advisor.apiKey = String(body.apiKey || '').trim();
  }
  if (body.model !== undefined && advisor.PLANNER_MODELS.some(m => m.id === body.model)) {
    raw.advisor = raw.advisor || {};
    raw.advisor.model = body.model;
  }
  if (body.intervalSec !== undefined) {
    const n = parseInt(body.intervalSec, 10);
    if (Number.isFinite(n)) raw.intervalSec = Math.max(15, n);
  }
  if (Array.isArray(body.targets)) {
    const t = body.targets.map(s => String(s).trim()).filter(Boolean);
    if (t.length) raw.targets = t;
  }
  saveUserConfig(raw);
  return settingsPayload();
}

// "Copy for AI" digest: a trimmed, already-redacted handoff the dashboard
// puts on the clipboard for pasting into web AIs (ChatGPT, claude.ai, ...)
// that cannot see this disk. The manual bridge until importers/MCP (M5).
function copyPayload(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return { error: 'unknown project' };
  if (!Array.isArray(proj.events)) proj.events = [];
  return { path: key, text: memorydb.renderCopyText(key, proj, config) };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardPage());
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, statusPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/projects') {
      json(res, 200, projectsPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/project') {
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const d = projectDetail(p);
      if (!d) return json(res, 404, { error: 'unknown project' });
      json(res, 200, d);
    } else if (req.method === 'GET' && url.pathname === '/api/project/memory') {
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const text = memoryMdPayload(p);
      res.writeHead(text === null ? 404 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text === null ? 'No memory log for this project yet.' : text);
    } else if (req.method === 'GET' && url.pathname === '/api/graph') {
      json(res, 200, buildGraph(loadState(), getConfig()));
    } else if (req.method === 'GET' && url.pathname === '/api/settings') {
      json(res, 200, settingsPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      json(res, 200, saveSettings(body));
    } else if (req.method === 'POST' && url.pathname === '/api/settings/test') {
      // Tests the pasted key if one is provided, else the stored/env key.
      const body = await readBody(req);
      const adv = advisor.getAdvisorConfig(getConfig());
      const key = String(body.apiKey || '').trim() || adv.apiKey;
      json(res, 200, await advisor.testKey(key, adv.model));
    } else if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readBody(req);
      json(res, 200, syncOnce(body.project ? { project: body.project } : {}));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/toggle') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: 'path required' });
      json(res, 200, toggleProject(body.path));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/add') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const r = addProject(p);
      json(res, r.error ? 400 : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/projects/delete') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      json(res, 200, deleteProject(p));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/copy') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const r = copyPayload(p);
      json(res, r.error ? 404 : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/plan/generate') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      const goal = String(body.goal || '').trim();
      if (!p || !goal) return json(res, 400, { error: 'path and goal required' });
      const config = getConfig();
      const state = loadState();
      const key = findProjectKey(state, p);
      const proj = key ? state.projects[key] : null;
      if (!proj) return json(res, 404, { error: 'unknown project' });
      if (!Array.isArray(proj.events)) proj.events = [];
      const adv = advisor.getAdvisorConfig(config);
      if (!adv.apiKey) return json(res, 400, { error: 'Add your Anthropic key in Settings first.' });
      const payload = planPayload(key, proj, config, goal);
      const r = await advisor.generatePlan(adv.apiKey, adv.model, payload);
      if (!r.ok) return json(res, r.status || 502, { error: r.error });
      const saved = {
        goal: payload.goal,
        generatedAt: new Date().toISOString(),
        model: r.model,
        costUsd: r.costUsd,
        usage: r.usage,
        plan: r.plan,
      };
      fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
      fs.writeFileSync(planPath(key), JSON.stringify(saved, null, 2));
      // Re-render this project's memory block right away so the roadmap line
      // reaches CLAUDE.md/AGENTS.md now, not on the next activity. syncOnce
      // skips paused/missing projects on its own.
      syncOnce({ project: key });
      json(res, 200, { ok: true, plan: saved });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    log(`dashboard error ${req.method} ${url.pathname}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

// Local-only by design: binds 127.0.0.1, never an external interface.
// A fast stop→start can find the port still held by the dying daemon; without
// a retry the new daemon would keep syncing forever with a dead dashboard.
function startServer(port, opts = {}) {
  const retries = opts.retries === undefined ? 20 : opts.retries;
  const retryDelayMs = opts.retryDelayMs === undefined ? 500 : opts.retryDelayMs;
  const server = http.createServer(handle);
  let attempt = 0;
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      if (attempt < retries) {
        attempt++;
        log(`dashboard port ${port} in use, retrying (${attempt}/${retries})`);
        setTimeout(() => server.listen(port, '127.0.0.1'), retryDelayMs).unref();
      } else {
        log(`dashboard port ${port} still in use after ${retries} retries; giving up (is another MemBridge running?). Sync continues without the dashboard.`);
      }
      return;
    }
    log(`dashboard server error: ${err.message}`);
  });
  server.listen(port, '127.0.0.1', () => log(`dashboard on http://127.0.0.1:${port}`));
  return server;
}

module.exports = { startServer, statusPayload, projectsPayload, projectDetail, toggleProject, addProject, deleteProject, copyPayload, settingsPayload, saveSettings };
