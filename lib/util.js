'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// MemBridge home holds config.json, state.json, pid + log files.
// Env vars exist so tests/CI can fully isolate; end users use config.json.
function homeDir() {
  return process.env.MEMBRIDGE_HOME || path.join(os.homedir(), '.membridge');
}
const configPath = () => path.join(homeDir(), 'config.json');
const statePath = () => path.join(homeDir(), 'state.json');
const pidPath = () => path.join(homeDir(), 'membridge.pid');
const logPath = () => path.join(homeDir(), 'membridge.log');

const DEFAULT_CONFIG = {
  $docs: 'MemBridge config. targets: context files injected per project. exclude: project paths/globs to skip. redact: regexes scrubbed before injection. adapters.custom: point MemBridge at any JSONL session store (see README).',
  intervalSec: 60,
  dashboardPort: 7437,
  targets: ['CLAUDE.md', 'AGENTS.md'],
  exclude: [],
  redact: [
    'sk-[A-Za-z0-9_-]{8,}',
    'AKIA[0-9A-Z]{16,}',
    'ghp_[A-Za-z0-9]{20,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    "(api[_-]?key|secret|token|password)\\s*[=:]\\s*[^\\s\"']+",
  ],
  maxPrompts: 8,
  maxFiles: 10,
  maxStoredEvents: 200,
  writeProjectMemory: true,
  maxEntries: 100,
  maxIndexFiles: 2000,
  indexIgnore: [
    '.git', 'node_modules', '.membridge', 'dist', 'build', 'out', '.next',
    '.nuxt', '.venv', 'venv', '__pycache__', 'target', 'coverage',
    '.idea', '.vscode', '.DS_Store',
  ],
  adapters: {
    'claude-code': { enabled: true },
    codex: { enabled: true },
    custom: [],
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra !== undefined ? extra : base;
  if (base && extra && typeof base === 'object' && typeof extra === 'object') {
    const out = { ...base };
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
    return out;
  }
  return extra !== undefined ? extra : base;
}

// Write a starter config on first run so users have something to edit.
function ensureConfig() {
  fs.mkdirSync(homeDir(), { recursive: true });
  if (!fs.existsSync(configPath())) {
    fs.writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

function loadUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveUserConfig(raw) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(raw, null, 2));
}

// Effective config: defaults < config.json < env vars. Read fresh each call so
// dashboard edits take effect without restarting the daemon.
function getConfig() {
  const cfg = deepMerge(DEFAULT_CONFIG, loadUserConfig());
  if (process.env.MEMBRIDGE_TARGETS) {
    cfg.targets = process.env.MEMBRIDGE_TARGETS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.MEMBRIDGE_INTERVAL) {
    cfg.intervalSec = parseInt(process.env.MEMBRIDGE_INTERVAL, 10) || cfg.intervalSec;
  }
  if (process.env.MEMBRIDGE_PORT) {
    cfg.dashboardPort = parseInt(process.env.MEMBRIDGE_PORT, 10) || cfg.dashboardPort;
  }
  cfg.adapters = cfg.adapters || {};
  cfg.adapters['claude-code'] = cfg.adapters['claude-code'] || {};
  cfg.adapters.codex = cfg.adapters.codex || {};
  if (process.env.MEMBRIDGE_CLAUDE_DIR) cfg.adapters['claude-code'].dir = process.env.MEMBRIDGE_CLAUDE_DIR;
  if (process.env.MEMBRIDGE_CODEX_DIR) cfg.adapters.codex.dir = process.env.MEMBRIDGE_CODEX_DIR;
  cfg.intervalSec = Math.max(15, cfg.intervalSec);
  return cfg;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { files: {}, projects: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function log(msg) {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // logging must never crash the daemon
  }
}

function walkFiles(dir, ext, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, ext, out);
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const IS_WIN = process.platform === 'win32';
function normPath(p) {
  const r = path.resolve(String(p));
  return IS_WIN ? r.toLowerCase() : r;
}
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// exclude entries: exact path, parent path, or glob with '*'
function isExcluded(projectPath, config) {
  const p = normPath(projectPath);
  for (const raw of config.exclude || []) {
    if (!raw) continue;
    const pat = IS_WIN ? String(raw).toLowerCase() : String(raw);
    if (pat.includes('*')) {
      const rx = new RegExp('^' + pat.split('*').map(escapeRx).join('.*') + '$');
      if (rx.test(p) || rx.test(projectPath)) return true;
    } else {
      const n = normPath(pat);
      if (p === n || p.startsWith(n + path.sep)) return true;
    }
  }
  return false;
}

// Per-project kill switch: drop a `.membridge-off` file in the project root.
function isProjectOff(projectPath, config) {
  if (isExcluded(projectPath, config)) return true;
  try {
    return fs.existsSync(path.join(projectPath, '.membridge-off'));
  } catch {
    return true;
  }
}

module.exports = {
  homeDir, configPath, statePath, pidPath, logPath,
  DEFAULT_CONFIG, ensureConfig, loadUserConfig, saveUserConfig, getConfig,
  loadState, saveState, log, walkFiles, isExcluded, isProjectOff, normPath,
};
