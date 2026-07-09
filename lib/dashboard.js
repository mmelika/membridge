'use strict';

// Self-contained dashboard page: no build step, no external assets, works
// offline, adapts to light/dark. Served by lib/server.js at /.
function dashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemBridge</title>
<style>
:root {
  --bg: #f7f6f3; --card: #ffffff; --text: #1a1a18; --muted: #6f6e69;
  --border: #e3e1db; --accent: #185fa5; --accent-bg: #e6f1fb;
  --ok: #0f6e56; --ok-bg: #e1f5ee; --warn-bg: #faeeda; --warn: #854f0b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1b19; --card: #262624; --text: #ececea; --muted: #9c9b96;
    --border: #3a3a37; --accent: #85b7eb; --accent-bg: #0c447c;
    --ok: #5dcaa5; --ok-bg: #085041; --warn-bg: #633806; --warn: #fac775;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
h1 { font-size: 20px; font-weight: 600; margin: 0; flex: 1; }
h1 small { font-weight: 400; color: var(--muted); font-size: 13px; margin-left: 8px; }
.pill { font-size: 13px; padding: 3px 12px; border-radius: 999px; background: var(--ok-bg); color: var(--ok); }
.pill.off { background: var(--warn-bg); color: var(--warn); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
.stat .k { font-size: 12px; color: var(--muted); }
.stat .v { font-size: 22px; font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 14px; }
.card.paused { opacity: .6; }
.card h2 { font-size: 15px; font-weight: 600; margin: 0; }
.row { display: flex; align-items: center; gap: 10px; }
.row .grow { flex: 1; min-width: 0; }
.path { font-size: 12px; color: var(--muted); font-family: ui-monospace, Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; font-size: 13px; padding: 4px 14px; border-radius: 8px;
  border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
button:hover { border-color: var(--muted); }
.entries { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; font-size: 13px; }
.entry { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
.entry .t { color: var(--muted); white-space: nowrap; font-size: 12px; }
.badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap;
  background: var(--accent-bg); color: var(--accent); }
.badge.b1 { background: var(--ok-bg); color: var(--ok); }
.files { margin-top: 8px; font-size: 12px; color: var(--muted); }
.footer { font-size: 12px; color: var(--muted); margin-top: 20px; }
.empty { color: var(--muted); font-size: 14px; padding: 30px 0; text-align: center; }
</style>
</head>
<body>
<main>
<header>
  <h1>MemBridge<small>shared memory across your AI coding tools</small></h1>
  <span class="pill" id="pill">Running</span>
  <button id="syncNow">Sync now</button>
</header>
<div class="stats" id="stats"></div>
<div id="projects"><div class="empty">Loading…</div></div>
<p class="footer">Everything stays on this machine. Pause a project to stop injecting memory into it,
or drop a <code>.membridge-off</code> file in its root. Config: <code>~/.membridge/config.json</code></p>
</main>
<script>
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago = iso => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
const badgeClass = src => /claude/i.test(src) ? 'badge b1' : 'badge';

async function load() {
  try {
    const [status, projects] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ]);
    document.getElementById('pill').textContent = 'Running';
    document.getElementById('pill').className = 'pill';
    document.getElementById('stats').innerHTML =
      stat('Projects watched', status.projectCount) +
      stat('Tools connected', status.adapters.length) +
      stat('Last sync', ago(status.lastSync)) +
      stat('Interval', status.intervalSec + 's');
    const wrap = document.getElementById('projects');
    if (!projects.length) {
      wrap.innerHTML = '<div class="empty">No AI activity found yet. Use Claude Code or Codex in any project and it will appear here after the next sync.</div>';
      return;
    }
    wrap.innerHTML = projects.map(card).join('');
    for (const btn of wrap.querySelectorAll('button[data-path]')) {
      btn.onclick = async () => {
        await fetch('/api/projects/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ path: btn.dataset.path }) });
        load();
      };
    }
  } catch (e) {
    document.getElementById('pill').textContent = 'Unreachable';
    document.getElementById('pill').className = 'pill off';
  }
}
const stat = (k, v) => '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
function card(p) {
  const prompts = p.prompts.map(e =>
    '<div class="entry"><span class="t">' + esc((e.ts || '').slice(5, 16).replace('T', ' ')) + '</span>' +
    '<span class="' + badgeClass(e.source) + '">' + esc(e.source) + '</span>' +
    '<span>' + esc(e.text) + '</span></div>').join('');
  const files = p.files.length ? '<div class="files">Recently touched: ' + esc(p.files.map(f => f.file).join(', ')) + '</div>' : '';
  const targets = p.targets.map(t => (t.exists ? '✓ ' : '· ') + esc(t.file)).join(' &nbsp; ');
  return '<div class="card' + (p.paused ? ' paused' : '') + '">' +
    '<div class="row"><div class="grow"><h2>' + esc(p.name) + '</h2><div class="path">' + esc(p.path) + '</div></div>' +
    '<button data-path="' + esc(p.path) + '">' + (p.paused ? 'Resume' : 'Pause') + '</button></div>' +
    '<div class="entries">' + (prompts || '<span class="t">No prompts captured yet</span>') + files +
    '<div class="files">' + targets + ' &nbsp;·&nbsp; synced ' + esc(ago(p.lastSync)) + '</div></div></div>';
}
document.getElementById('syncNow').onclick = async () => {
  await fetch('/api/sync', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
  load();
};
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}

module.exports = { dashboardPage };
