'use strict';
const os = require('os');
const path = require('path');

// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<project-slug>/<session-id>.jsonl. Every entry carries
// the project path in `cwd`; fileState only tracks the most recent assistant
// text block, which becomes the session's summary event.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_TODO_ITEMS = 20; // todos events are stored verbatim — keep them bounded
const MIN_SUMMARY_CHARS = 80; // shorter final texts are "Done." noise, not summaries

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

  extractEvents(entries, fileState) {
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
          if (!c || c.type !== 'tool_use') continue;
          if (EDIT_TOOLS.has(c.name) && c.input && c.input.file_path) {
            events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'edit', file: c.input.file_path });
          } else if (c.name === 'TodoWrite' && c.input && Array.isArray(c.input.todos)) {
            const items = c.input.todos
              .filter(t => t && typeof t.content === 'string')
              .slice(0, MAX_TODO_ITEMS)
              .map(t => ({ text: t.content, status: String(t.status || 'pending') }));
            if (items.length) {
              events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'todos', items });
            }
          }
        }
        // The last assistant text seen so far is the agent's running
        // self-report; it survives incremental reads via fileState.
        const text = textFromContent(e.message.content).trim();
        if (text) fileState.lastText = { ts: e.timestamp, project: e.cwd, text };
      }
    }
    // One summary per pass from the freshest text: an updated last-text emits
    // a new event, and renderers keep only the latest summary per session.
    const last = fileState.lastText;
    if (last && last.text.length >= MIN_SUMMARY_CHARS) {
      events.push({ ts: last.ts, project: last.project, source: this.displayName, kind: 'summary', text: last.text });
    }
    return events;
  },

  isRealPrompt,
};
