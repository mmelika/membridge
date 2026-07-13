'use strict';
const os = require('os');
const path = require('path');
const { isRealPrompt } = require('./claude-code');

// Codex writes rollout JSONL files under ~/.codex/sessions/YYYY/MM/DD/.
// The project path arrives once (session_meta / turn_context payloads), then
// user messages follow — so the cwd is carried in fileState across
// incremental reads of the same file. The latest assistant text rides along
// in fileState too and becomes the session's summary event.

const MIN_SUMMARY_CHARS = 80; // same bar as claude-code: skip "Done." noise

// Final assistant text arrives as event_msg agent_message payloads; the exact
// shape has varied across Codex versions, so accept a plain string and both
// content-array placements.
function agentText(p) {
  if (typeof p.message === 'string') return p.message;
  const arr = Array.isArray(p.content) ? p.content
    : p.message && Array.isArray(p.message.content) ? p.message.content : null;
  if (!arr) return '';
  return arr
    .filter(c => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
    .map(c => c.text)
    .join(' ');
}

module.exports = {
  id: 'codex',
  displayName: 'Codex',

  sessionRoots(config) {
    const opts = (config.adapters || {}).codex || {};
    return [opts.dir || path.join(os.homedir(), '.codex', 'sessions')];
  },

  extractEvents(entries, fileState) {
    const events = [];
    for (const e of entries) {
      if (!e) continue;
      const p = e.payload || {};
      if (p.cwd) fileState.cwd = p.cwd;
      if (!e.timestamp || !fileState.cwd) continue;

      let text = null;
      if (e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        text = (p.content || [])
          .filter(c => c && (c.type === 'input_text' || c.type === 'text') && typeof c.text === 'string')
          .map(c => c.text)
          .join(' ');
      } else if (e.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        text = p.message;
      } else if (e.type === 'event_msg' && p.type === 'agent_message') {
        const t = agentText(p).trim();
        if (t) fileState.lastText = { ts: e.timestamp, project: fileState.cwd, text: t };
      } else if (e.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
        const t = agentText(p).trim();
        if (t) fileState.lastText = { ts: e.timestamp, project: fileState.cwd, text: t };
      }
      if (text !== null && isRealPrompt(text)) {
        events.push({ ts: e.timestamp, project: fileState.cwd, source: this.displayName, kind: 'prompt', text: text.trim() });
      }
    }
    // One summary per pass from the freshest text; renderers keep only the
    // latest summary per session, so re-emits and updates supersede cleanly.
    const last = fileState.lastText;
    if (last && last.text.length >= MIN_SUMMARY_CHARS) {
      events.push({ ts: last.ts, project: last.project, source: this.displayName, kind: 'summary', text: last.text });
    }
    return events;
  },
};
