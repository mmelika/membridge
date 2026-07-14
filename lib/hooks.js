'use strict';
// Session distillation via Claude Code's Stop hook: as a session accumulates
// edits, the hook blocks the stop and asks the agent to append a checkpoint
// line to <project>/.membridge/summaries.jsonl. scan.js merges those lines
// back as high-quality kind:'summary' events (source 'Distilled').
//
// Staleness, not one-shot: the first checkpoint is asked at minEdits edits,
// and another every checkpointEvery edits after that — so a long session
// keeps its summary current instead of freezing on an early note. The hook
// only ever blocks once per stop cycle (the loop guard below).
//
// Contract (verified against docs.claude.com/en/docs/claude-code/hooks):
// the Stop hook receives a JSON payload on stdin — session_id, cwd,
// transcript_path and the top-level stop_hook_active loop guard — and blocks
// by printing {"decision":"block","reason":"..."} to stdout and exiting 0.
// A plain exit 0 with no output allows the stop.
//
// Everything in the hook path fails OPEN: a MemBridge bug must never trap a
// user's Claude Code session, so any internal error is logged and the stop
// is allowed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');
const memorydb = require('./memorydb');

const SUMMARIES_FILE = 'summaries.jsonl';
const summariesPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, SUMMARIES_FILE);

// Env override so tests never touch the real ~/.claude/settings.json.
function claudeSettingsPath() {
  return process.env.MEMBRIDGE_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

// How many usable checkpoint lines summaries.jsonl already holds for this
// session (session matches, did is a non-empty string). Malformed JSON lines
// count as absent — the agent is simply asked again.
function countSummaryLines(projectPath, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(summariesPath(projectPath), 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.session === sessionId && typeof e.did === 'string' && e.did.trim()) n++;
    } catch {
      // malformed line: ignore
    }
  }
  return n;
}

// Retained for callers that only care whether any checkpoint exists.
function hasSummaryLine(projectPath, sessionId) {
  return countSummaryLines(projectPath, sessionId) > 0;
}

// n is the count of checkpoints already written for this session. The first
// (n === 0) asks for a summary of the whole session; later ones ask for a
// fresh line covering only work since the previous checkpoint.
function blockReason(target, sessionId, n) {
  const scope = n > 0
    ? `cover ONLY the work done since your previous summary line for this session (${n} already written) — do not repeat or modify earlier lines`
    : 'summarize what you accomplished this session';
  return 'MemBridge session distillation: before stopping, append exactly ONE new line of JSON to ' +
    `${target} (create the .membridge directory if it does not exist; do not modify existing lines): ` +
    `{"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","did":"...","decisions":"...","gotchas":"..."} ` +
    `— did: 1-3 plain-text sentences that ${scope}; ` +
    'decisions: key choices a teammate would need to know, or "" if none; ' +
    'gotchas: surprises or pitfalls you hit, or "" if none. ' +
    'Only what a teammate needs — no markdown, no file lists. Then stop again.';
}

// `membridge hook stop` — reads the Stop-hook payload from stdin and either
// allows the stop (exit 0, no output) or blocks it once with instructions.
function runStop() {
  try {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      return; // no/garbled payload: not a real hook invocation, allow
    }
    if (!payload || typeof payload !== 'object') return;
    // NEVER block twice: a prior block already asked for the summary.
    if (payload.stop_hook_active === true) return;

    const config = util.getConfig();
    const distill = config.distill || {};
    if (distill.enabled === false) return;

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    if (!cwd || !sessionId) return;

    const state = util.loadState();
    const { findProjectKey } = require('./scan'); // lazy: scan.js requires this module back
    const key = findProjectKey(state, cwd);
    if (!key || util.isProjectOff(key, config)) return; // untracked or paused: never nag

    // Worthiness gate: only sessions that actually changed files are worth a
    // summary. The daemon may not have scanned the tail of this session yet;
    // undercounting fails open (no block), never traps.
    const minEdits = Number.isFinite(distill.minEdits) ? distill.minEdits : 1;
    const edits = (state.projects[key].events || [])
      .filter(e => e && e.kind === 'edit' && e.session === sessionId).length;
    if (edits < minEdits) return;

    // Staleness checkpoint: re-block once every checkpointEvery edits have
    // accumulated past the first. n = checkpoints already on disk; the next
    // is due at minEdits + n * checkpointEvery. Pure read — the daemon owns
    // state.json, so the hook writes nothing.
    const every = Number.isFinite(distill.checkpointEvery) && distill.checkpointEvery >= 1
      ? distill.checkpointEvery : 4;
    const n = countSummaryLines(key, sessionId);
    if (edits < minEdits + n * every) return;
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(summariesPath(key), sessionId, n) }) + '\n');
  } catch (err) {
    // fail open — log and allow the stop
    try {
      util.log(`hook stop error: ${err && err.stack ? err.stack : err}`);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// setup-hooks / remove-hooks: register the Stop hook in ~/.claude/settings.json.
// This file belongs to the user and may carry hooks MemBridge knows nothing
// about, so the rules are strict: never overwrite or reorder existing
// entries, preserve every unknown key, refuse to touch a file that does not
// parse, and only ever add/remove entries containing 'membridge'. Explicit
// opt-in command only — the daemon never installs this by itself.
// ---------------------------------------------------------------------------

const HOOK_COMMAND = 'membridge hook stop';
const mentionsMembridge = v => JSON.stringify(v).toLowerCase().includes('membridge');

// Parse the settings file. Missing file -> empty settings; unparseable or
// unexpectedly-shaped file -> throw, so callers refuse to write over it.
function readSettings(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { settings: {}, existed: false };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to touch ${file}: it is not valid JSON — fix or remove it first`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`refusing to touch ${file}: expected a JSON object at the top level`);
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error(`refusing to touch ${file}: "hooks" is not an object`);
  }
  if (settings.hooks && settings.hooks.Stop !== undefined && !Array.isArray(settings.hooks.Stop)) {
    throw new Error(`refusing to touch ${file}: "hooks.Stop" is not an array`);
  }
  return { settings, existed: true };
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function isHookInstalled() {
  try {
    const { settings } = readSettings(claudeSettingsPath());
    return ((settings.hooks || {}).Stop || []).some(mentionsMembridge);
  } catch {
    return false;
  }
}

function setupHooks() {
  const file = claudeSettingsPath();
  const { settings } = readSettings(file);
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];
  if (settings.hooks.Stop.some(mentionsMembridge)) {
    return `Claude Code Stop hook already installed in ${file} — nothing changed.`;
  }
  // Stop hooks take no matcher; 10s is generous for a local state read.
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] });
  writeSettings(file, settings);
  return `Installed the MemBridge Stop hook in ${file} (appended after your existing hooks).
On every Claude Code session stop, \`${HOOK_COMMAND}\` asks the agent for a 2-3 line
summary of sessions that edited files, written to <project>/.membridge/summaries.jsonl.
Undo anytime with: membridge remove-hooks`;
}

function removeHooks() {
  const file = claudeSettingsPath();
  const { settings, existed } = readSettings(file);
  if (!existed) return `No Claude Code settings file at ${file} — nothing to remove.`;
  const stop = (settings.hooks || {}).Stop || [];
  let removed = 0;
  const kept = [];
  for (const entry of stop) {
    // Surgical: only membridge command(s) are dropped. A user entry that
    // mixes its own hooks with ours keeps everything else; an entry left
    // with no hooks is removed whole.
    if (entry && Array.isArray(entry.hooks)) {
      const inner = entry.hooks.filter(h => !mentionsMembridge(h));
      if (inner.length === entry.hooks.length) {
        kept.push(entry); // nothing of ours inside — untouched
      } else {
        removed += entry.hooks.length - inner.length;
        if (inner.length) kept.push({ ...entry, hooks: inner });
      }
    } else if (mentionsMembridge(entry)) {
      removed++;
    } else {
      kept.push(entry);
    }
  }
  if (!removed) return `No MemBridge hook found in ${file} — nothing changed.`;
  settings.hooks.Stop = kept;
  if (!kept.length) delete settings.hooks.Stop;
  writeSettings(file, settings);
  return `Removed the MemBridge Stop hook from ${file} (${removed} entr${removed === 1 ? 'y' : 'ies'}); your other hooks are untouched.
Re-enable anytime with: membridge setup-hooks`;
}

module.exports = {
  runStop, countSummaryLines, hasSummaryLine, blockReason, summariesPath, claudeSettingsPath, SUMMARIES_FILE,
  setupHooks, removeHooks, isHookInstalled, HOOK_COMMAND,
};
