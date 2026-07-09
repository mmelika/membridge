'use strict';
const os = require('os');
const path = require('path');

// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<project-slug>/<session-id>.jsonl. Every entry carries
// the project path in `cwd`, so no per-file state is needed.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join(' ');
  }
  return '';
}

// Keep human asks; drop tool results, injected command wrappers, interruptions.
function isRealPrompt(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return false;
  return true;
}

module.exports = {
  id: 'claude-code',
  displayName: 'Claude Code',

  sessionRoots(config) {
    const opts = (config.adapters || {})['claude-code'] || {};
    return [opts.dir || path.join(os.homedir(), '.claude', 'projects')];
  },

  extractEvents(entries) {
    const events = [];
    for (const e of entries) {
      if (!e || !e.cwd || !e.timestamp || e.isSidechain) continue;
      if (e.type === 'user' && !e.isMeta && e.message) {
        const text = textFromContent(e.message.content);
        if (isRealPrompt(text)) {
          events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'prompt', text: text.trim() });
        }
      } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        for (const c of e.message.content) {
          if (c && c.type === 'tool_use' && EDIT_TOOLS.has(c.name) && c.input && c.input.file_path) {
            events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'edit', file: c.input.file_path });
          }
        }
      }
    }
    return events;
  },

  isRealPrompt,
};
