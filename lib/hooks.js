'use strict';
// Session distillation via Claude Code's Stop hook: when a session that
// actually edited files is about to end without a self-written summary, the
// hook blocks the stop ONCE and asks the agent to append one JSON line to
// <project>/.membridge/summaries.jsonl. scan.js merges those lines back as
// high-quality kind:'summary' events (source 'Distilled').
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

// True when summaries.jsonl already holds a usable line for this session.
// Malformed JSON lines count as absent — the agent will simply be asked once.
function hasSummaryLine(projectPath, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(summariesPath(projectPath), 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.session === sessionId && typeof e.did === 'string' && e.did.trim()) return true;
    } catch {
      // malformed line: ignore
    }
  }
  return false;
}

function blockReason(target, sessionId) {
  return 'MemBridge session distillation: before stopping, append exactly ONE line of JSON to ' +
    `${target} (create the .membridge directory if it does not exist; do not modify existing lines): ` +
    `{"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","did":"...","decisions":"...","gotchas":"..."} ` +
    '— did: 1-3 plain-text sentences on what you actually accomplished this session; ' +
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

    if (hasSummaryLine(key, sessionId)) return;
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(summariesPath(key), sessionId) }) + '\n');
  } catch (err) {
    // fail open — log and allow the stop
    try {
      util.log(`hook stop error: ${err && err.stack ? err.stack : err}`);
    } catch {}
  }
}

module.exports = { runStop, hasSummaryLine, summariesPath, claudeSettingsPath, SUMMARIES_FILE };
