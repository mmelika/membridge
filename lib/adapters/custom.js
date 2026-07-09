'use strict';
const { isRealPrompt } = require('./claude-code');

// Config-driven adapter: lets users wire up ANY tool that logs sessions as
// JSONL, without code changes. Definition (in config.json, adapters.custom[]):
//
// {
//   "id": "mytool",
//   "displayName": "MyTool",
//   "dir": "/home/me/.mytool/sessions",
//   "fields": {
//     "project":   "dir",          // dot-path to the project/cwd on a line
//     "timestamp": "when",         // dot-path to an ISO timestamp
//     "text":      "say",          // dot-path to the user's message text
//     "role":      "who",          // optional: only lines where this field...
//     "roleValue": "user",         //           ...equals this value count
//     "file":      "patch.path"    // optional: dot-path to an edited file
//   }
// }
//
// If a line has no project field, the last project seen in the same file is
// used (many tools log the cwd once per session).

function getPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function asText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map(item => (typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '')).join(' ');
  }
  return '';
}

function create(def) {
  if (!def || !def.id || !def.dir || !def.fields) {
    throw new Error('custom adapter needs id, dir and fields');
  }
  const f = def.fields;
  return {
    id: def.id,
    displayName: def.displayName || def.id,

    sessionRoots() {
      return [def.dir];
    },

    extractEvents(entries, fileState) {
      const events = [];
      for (const e of entries) {
        if (!e) continue;
        const proj = getPath(e, f.project);
        if (proj) fileState.project = proj;
        const ts = getPath(e, f.timestamp);
        const project = proj || fileState.project;
        if (!ts || !project) continue;

        if (f.role && String(getPath(e, f.role)) !== String(f.roleValue || 'user')) continue;

        const text = asText(getPath(e, f.text)).trim();
        if (text && isRealPrompt(text)) {
          events.push({ ts, project, source: this.displayName, kind: 'prompt', text });
        }
        const file = f.file ? getPath(e, f.file) : null;
        if (typeof file === 'string' && file) {
          events.push({ ts, project, source: this.displayName, kind: 'edit', file });
        }
      }
      return events;
    },
  };
}

module.exports = { create, getPath };
