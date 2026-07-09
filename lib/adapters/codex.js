'use strict';
const os = require('os');
const path = require('path');
const { isRealPrompt } = require('./claude-code');

// Codex writes rollout JSONL files under ~/.codex/sessions/YYYY/MM/DD/.
// The project path arrives once (session_meta / turn_context payloads), then
// user messages follow — so the cwd is carried in fileState across
// incremental reads of the same file.

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
      }
      if (text !== null && isRealPrompt(text)) {
        events.push({ ts: e.timestamp, project: fileState.cwd, source: this.displayName, kind: 'prompt', text: text.trim() });
      }
    }
    return events;
  },
};
