#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const util = require('../lib/util');
const { scanAll, syncOnce, getAdapters, findProjectKey } = require('../lib/scan');
const digest = require('../lib/digest');
const { startServer } = require('../lib/server');
const autostart = require('../lib/autostart');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = name => args.includes(name);
const opt = name => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

function readPid() {
  try {
    return parseInt(fs.readFileSync(util.pidPath(), 'utf8'), 10) || null;
  } catch {
    return null;
  }
}
function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printChanges(result) {
  for (const c of result.changes) console.log(`  ${c.action}: ${c.file}`);
  for (const s of result.skipped || []) console.log(`  skipped ${s.project} (${s.reason})`);
  if (!result.changes.length) console.log('  nothing to update');
}

function cmdSync() {
  util.ensureConfig();
  const dryRun = flag('--dry-run');
  const result = syncOnce({ dryRun, project: opt('--project') });
  console.log(`${dryRun ? '[dry run] ' : ''}${result.newEvents} new event(s), ${result.projects.length} project(s) affected`);
  printChanges(result);
}

function cmdScan() {
  util.ensureConfig();
  const config = util.getConfig();
  console.log('Read-only scan (nothing is written).\n');
  console.log('Adapters:');
  for (const a of getAdapters(config)) {
    for (const root of a.sessionRoots(config)) {
      const exists = fs.existsSync(root);
      console.log(`  ${a.displayName.padEnd(14)} ${root} ${exists ? '' : '(not found)'}`);
    }
  }
  const state = { files: {}, projects: {} }; // fresh: scan everything from byte 0
  const events = scanAll(state, config);
  digest.mergeEvents(state, events, config);
  const projects = Object.entries(state.projects);
  console.log(`\nProjects with AI activity: ${projects.length}`);
  for (const [key, proj] of projects) {
    const bySource = {};
    for (const e of proj.events) bySource[e.source] = (bySource[e.source] || 0) + 1;
    const parts = Object.entries(bySource).map(([s, n]) => `${s}: ${n}`).join(', ');
    const off = util.isProjectOff(key, config) ? '  [paused]' : '';
    console.log(`  ${key}${off}\n    ${parts}`);
  }
}

function cmdDaemon() {
  util.ensureConfig();
  const config = util.getConfig();
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(util.pidPath(), String(process.pid));
  util.log(`daemon started (pid ${process.pid}, interval ${config.intervalSec}s, v${pkg.version})`);

  const cleanup = () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(util.pidPath());
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const tick = () => {
    try {
      const r = syncOnce();
      if (r.changes.length) {
        util.log(`sync: ${r.newEvents} new event(s) -> ${r.changes.map(c => c.file).join('; ')}`);
      }
    } catch (err) {
      util.log(`sync error: ${err.stack || err}`);
    }
  };
  tick();
  setInterval(tick, util.getConfig().intervalSec * 1000);
  startServer(config.dashboardPort);
}

function cmdStart() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`MemBridge is already running (pid ${pid}).`);
    return;
  }
  util.ensureConfig();
  const out = fs.openSync(util.logPath(), 'a');
  const child = spawn(process.execPath, [__filename, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  const config = util.getConfig();
  console.log(`MemBridge daemon started in the background (pid ${child.pid}).`);
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);
}

function cmdStop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    console.log('MemBridge is not running.');
    return;
  }
  process.kill(pid);
  try {
    fs.unlinkSync(util.pidPath());
  } catch {}
  console.log(`Stopped MemBridge (pid ${pid}).`);
}

function cmdStatus() {
  const config = util.getConfig();
  const state = util.loadState();
  const pid = readPid();
  const running = isRunning(pid);
  console.log(`MemBridge v${pkg.version}`);
  console.log(`Daemon:    ${running ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}${running ? '' : ' (offline)'}`);
  console.log(`Home:      ${util.homeDir()}`);
  console.log(`Interval:  ${config.intervalSec}s   Targets: ${config.targets.join(', ')}`);
  console.log(`Autostart: ${autostart.isEnabled() ? 'enabled' : 'disabled'}`);
  const projects = Object.entries(state.projects || {});
  console.log(`Projects:  ${projects.length}`);
  for (const [key, proj] of projects) {
    const paused = util.isProjectOff(key, config) ? ' [paused]' : '';
    console.log(`  ${key}${paused} — ${proj.events.length} event(s), last sync ${proj.lastSync || 'never'}`);
  }
}

function cmdRemove() {
  const state = util.loadState();
  const config = util.getConfig();
  const only = opt('--project');
  let keys = Object.keys(state.projects || {});
  if (only) {
    const k = findProjectKey(state, only);
    keys = k ? [k] : [path.resolve(only)];
  }
  let n = 0;
  for (const key of keys) {
    for (const target of config.targets) {
      const file = path.join(key, target);
      const res = digest.removeBlock(file);
      if (res) {
        console.log(`  ${res === 'deleted' ? 'deleted (was only the memory block)' : 'block removed'}: ${file}`);
        n++;
      }
    }
  }
  console.log(n ? `Done — ${n} file(s) cleaned.` : 'No MemBridge blocks found.');
}

function openBrowser(url) {
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else if (process.platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}

function cmdDashboard() {
  const config = util.getConfig();
  const url = `http://127.0.0.1:${config.dashboardPort}`;
  if (!isRunning(readPid())) {
    cmdStart();
    // give the detached daemon a moment to bind the port
    setTimeout(() => openBrowser(url), 1500);
  } else {
    openBrowser(url);
  }
  console.log(`Dashboard: ${url}`);
}

function cmdHelp() {
  console.log(`MemBridge v${pkg.version} — shared memory across your AI coding tools

Your AI tools each keep their own session history. MemBridge watches them all,
distills a brief per-project memory, and writes it into the context files every
tool reads (CLAUDE.md, AGENTS.md, ...) — so Codex knows what Claude Code did,
and vice versa. Everything stays on your machine.

Usage: membridge <command>

  start               run the background daemon (sync + dashboard)
  stop                stop the background daemon
  status              daemon state, watched projects, config summary
  dashboard           open the local web dashboard (starts daemon if needed)
  sync [--dry-run] [--project <path>]   one sync pass right now
  scan                read-only: show which tools/projects were discovered
  remove [--project <path>]             strip injected memory blocks
  enable-autostart    launch MemBridge automatically at login
  disable-autostart   remove the login launcher
  daemon              run in the foreground (used internally / by services)
  help                this text

Config: ${util.configPath()}
Docs:   https://github.com/membridge/membridge#readme`);
}

const commands = {
  sync: cmdSync,
  scan: cmdScan,
  daemon: cmdDaemon,
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  remove: cmdRemove,
  dashboard: cmdDashboard,
  'enable-autostart': () => console.log(autostart.enable()),
  'disable-autostart': () => console.log(autostart.disable()),
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
  '--version': () => console.log(pkg.version),
  version: () => console.log(pkg.version),
};

const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\n`);
  cmdHelp();
  process.exit(1);
}
fn();
