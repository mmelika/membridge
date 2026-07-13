'use strict';
// Zero-dependency end-to-end tests. Everything runs against a throwaway temp
// dir via MEMBRIDGE_* env overrides — no real user files are read or written.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-test-'));
process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home');
process.env.MEMBRIDGE_CLAUDE_DIR = path.join(ROOT, 'claude-projects');
process.env.MEMBRIDGE_CODEX_DIR = path.join(ROOT, 'codex-sessions');
process.env.MEMBRIDGE_INTERVAL = '3600'; // daemon ticks once at boot, then stays quiet

const util = require('../lib/util');
const { syncOnce } = require('../lib/scan');
const digest = require('../lib/digest');
const { buildGraph } = require('../lib/graph');
const { startServer, teamPayload } = require('../lib/server');
const teamsync = require('../lib/teamsync');
const { createMockSupabase } = require('./mock-supabase');

const BIN = path.join(__dirname, '..', 'bin', 'membridge.js');
const proj1 = path.join(ROOT, 'projects', 'shop-app');
const proj2 = path.join(ROOT, 'projects', 'excluded-app');
const proj3 = path.join(ROOT, 'projects', 'marker-app');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([name, null]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push([name, err]);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const read = f => fs.readFileSync(f, 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

function setupFixtures() {
  for (const p of [proj1, proj2, proj3]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(proj1, 'CLAUDE.md'), '# Shop app\n\nOriginal notes that must survive.\n');
  fs.mkdirSync(path.join(proj1, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj1, 'src', 'login.js'), 'export const login = () => {};\n');
  fs.mkdirSync(path.join(proj1, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(proj1, 'node_modules', 'junk', 'index.js'), 'ignored\n');
  fs.writeFileSync(path.join(proj3, '.membridge-off'), '');

  // Claude Code sessions
  const cDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app');
  fs.mkdirSync(cDir, { recursive: true });
  fs.writeFileSync(path.join(cDir, 'sess1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Build the login page with OAuth' }, cwd: proj1, timestamp: '2026-07-09T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Use api_key=sk-test1234567890abcdef for the Stripe sandbox' }] }, cwd: proj1, timestamp: '2026-07-09T10:01:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: proj1, timestamp: '2026-07-09T10:02:00.000Z' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise must not appear' }, cwd: proj1, timestamp: '2026-07-09T10:03:00.000Z' },
    { type: 'user', message: { role: 'user', content: '<command-name>/help</command-name>' }, cwd: proj1, timestamp: '2026-07-09T10:04:00.000Z' },
  ]));
  const cDir2 = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-others');
  fs.mkdirSync(cDir2, { recursive: true });
  fs.writeFileSync(path.join(cDir2, 'sess2.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Excluded project work' }, cwd: proj2, timestamp: '2026-07-09T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'Marker project work' }, cwd: proj3, timestamp: '2026-07-09T10:00:00.000Z' },
  ]));

  // Codex rollout
  const xDir = path.join(process.env.MEMBRIDGE_CODEX_DIR, '2026', '07', '09');
  fs.mkdirSync(xDir, { recursive: true });
  fs.writeFileSync(path.join(xDir, 'rollout-1.jsonl'), jsonl([
    { timestamp: '2026-07-09T10:05:00.000Z', type: 'session_meta', payload: { id: 'abc', cwd: proj1 } },
    { timestamp: '2026-07-09T10:06:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add unit tests for the login form' }] } },
  ]));

  // A hypothetical third-party tool, wired via the custom adapter
  const mDir = path.join(ROOT, 'mytool-sessions');
  fs.mkdirSync(mDir, { recursive: true });
  fs.writeFileSync(path.join(mDir, 'log.jsonl'), jsonl([
    { when: '2026-07-09T10:07:00.000Z', dir: proj1, who: 'user', say: 'Refactor the login styles' },
    { when: '2026-07-09T10:07:30.000Z', dir: proj1, who: 'assistant', say: 'assistant chatter must not appear' },
  ]));

  // Config: exclude proj2, add the custom adapter
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.exclude = [proj2];
  cfg.adapters = cfg.adapters || {};
  cfg.adapters.custom = [{
    id: 'mytool',
    displayName: 'MyTool',
    dir: mDir,
    fields: { project: 'dir', timestamp: 'when', text: 'say', role: 'who', roleValue: 'user' },
  }];
  util.saveUserConfig(cfg);
}

async function waitForHttp(url, ms = 15000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr && lastErr.message}`);
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function main() {
  console.log(`MemBridge test suite (fixtures in ${ROOT})\n`);
  setupFixtures();

  // --- 1. fresh sync ---
  const r1 = syncOnce();
  const claudeMd = () => read(path.join(proj1, 'CLAUDE.md'));
  const agentsMd = () => read(path.join(proj1, 'AGENTS.md'));

  check('fresh sync finds events from all three tools', () => {
    assert.ok(r1.newEvents >= 6, `expected >=6 events, got ${r1.newEvents}`);
  });
  check('CLAUDE.md gets the memory block and keeps original content', () => {
    const md = claudeMd();
    assert.ok(md.startsWith('# Shop app'), 'original heading lost');
    assert.ok(md.includes('Original notes that must survive.'), 'original body lost');
    assert.ok(md.includes(digest.BEGIN) && md.includes(digest.END), 'markers missing');
    assert.ok(md.includes('Build the login page with OAuth'), 'Claude prompt missing');
  });
  check('AGENTS.md is created with the same shared memory', () => {
    const md = agentsMd();
    assert.ok(md.includes(digest.BEGIN), 'markers missing');
    assert.ok(md.includes('Add unit tests for the login form'), 'Codex prompt missing');
  });
  check('cross-tool: Claude, Codex and custom-adapter prompts all present', () => {
    const md = claudeMd();
    assert.ok(md.includes('Claude Code:'), 'Claude Code source missing');
    assert.ok(md.includes('Codex:'), 'Codex source missing');
    assert.ok(md.includes('MyTool: Refactor the login styles'), 'custom adapter prompt missing');
  });
  check('noise is filtered (meta, command wrappers, assistant lines)', () => {
    const md = claudeMd();
    assert.ok(!md.includes('meta noise'), 'isMeta leaked');
    assert.ok(!md.includes('command-name'), 'command wrapper leaked');
    assert.ok(!md.includes('assistant chatter'), 'non-user custom line leaked');
  });
  check('secrets are redacted before injection', () => {
    const md = claudeMd();
    assert.ok(!md.includes('sk-test1234567890abcdef'), 'API key leaked');
    assert.ok(md.includes('[redacted]'), 'no redaction marker');
  });
  check('recently modified files are listed', () => {
    assert.ok(claudeMd().includes('login.js'), 'edited file missing');
  });
  check('project memory DB is created with entries referencing files', () => {
    const db = JSON.parse(read(path.join(proj1, '.membridge', 'memory.json')));
    assert.ok(db.entries.find(e => e.ask.includes('Build the login page')), 'entry missing');
    // the 10:02 edit belongs to the most recent ask before it (10:01)
    const withFile = db.entries.find(e => e.files.includes('src/login.js'));
    assert.ok(withFile, 'no entry references the edited file');
    assert.strictEqual(withFile.source, 'Claude Code');
    assert.strictEqual(withFile.ts, '2026-07-09T10:01:00.000Z', 'edit attached to wrong ask');
    const banned = db.entries.find(e => e.ask.includes('sk-test1234567890abcdef'));
    assert.ok(!banned, 'secret leaked into memory DB');
  });
  check('file index covers project files and skips ignored dirs', () => {
    const db = JSON.parse(read(path.join(proj1, '.membridge', 'memory.json')));
    const paths = db.fileIndex.files.map(f => f.path);
    assert.ok(paths.includes('src/login.js'), 'src/login.js not indexed');
    assert.ok(paths.includes('CLAUDE.md'), 'CLAUDE.md not indexed');
    assert.ok(!paths.some(p => p.startsWith('node_modules')), 'node_modules indexed');
    assert.ok(!paths.some(p => p.startsWith('.membridge')), 'own dir indexed');
    assert.ok(db.fileIndex.files.every(f => typeof f.size === 'number' && f.mtime), 'index entries incomplete');
  });
  check('memory.md renders the log and the injected block points to it', () => {
    const md = read(path.join(proj1, '.membridge', 'memory.md'));
    assert.ok(md.includes('Claude Code'), 'source missing in memory.md');
    assert.ok(md.includes('`src/login.js`'), 'file reference missing in memory.md');
    assert.ok(md.includes('File index:'), 'file index summary missing');
    assert.ok(claudeMd().includes('.membridge/memory.md'), 'context block does not point at memory log');
  });
  check('excluded/paused projects get no memory DB', () => {
    assert.ok(!fs.existsSync(path.join(proj2, '.membridge')), 'excluded project got a DB');
    assert.ok(!fs.existsSync(path.join(proj3, '.membridge')), 'marker project got a DB');
  });
  check('excluded project is untouched', () => {
    assert.ok(!fs.existsSync(path.join(proj2, 'CLAUDE.md')), 'exclude ignored');
    assert.ok(!fs.existsSync(path.join(proj2, 'AGENTS.md')), 'exclude ignored');
  });
  check('.membridge-off project is untouched', () => {
    assert.ok(!fs.existsSync(path.join(proj3, 'CLAUDE.md')), 'marker ignored');
  });

  // --- 2. incremental sync ---
  fs.appendFileSync(
    path.join(process.env.MEMBRIDGE_CODEX_DIR, '2026', '07', '09', 'rollout-1.jsonl'),
    JSON.stringify({ timestamp: '2026-07-09T10:10:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Wire up the payment API' } }) + '\n',
  );
  const r2 = syncOnce();
  check('incremental: only the appended event is read', () => {
    assert.strictEqual(r2.newEvents, 1, `expected 1 new event, got ${r2.newEvents}`);
  });
  check('incremental: block updated in place, no duplicates', () => {
    const md = claudeMd();
    assert.ok(md.includes('Wire up the payment API'), 'new prompt missing');
    assert.strictEqual(count(md, 'Build the login page with OAuth'), 1, 'duplicate prompt');
    assert.strictEqual(count(md, digest.BEGIN), 1, 'duplicate block');
  });
  check('sync with no new events changes nothing', () => {
    const before = claudeMd();
    const r3 = syncOnce();
    assert.strictEqual(r3.newEvents, 0);
    assert.strictEqual(r3.changes.length, 0);
    assert.strictEqual(claudeMd(), before);
  });

  // --- 3. remove ---
  check('remove strips blocks, restores originals, deletes the memory DB', () => {
    const out = spawnSync(process.execPath, [BIN, 'remove', '--project', proj1], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(claudeMd(), '# Shop app\n\nOriginal notes that must survive.\n', 'original not restored');
    assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'block-only file should be deleted');
    assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), 'memory DB not removed');
  });

  // --- 4. session ids, state migration, neural graph ---
  check('events carry per-chat session ids from the transcript filename', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === proj1.toLowerCase());
    assert.ok(key, 'proj1 missing from state');
    const events = state.projects[key].events;
    assert.ok(events.length && events.every(e => e.session), 'event without session id');
    const claudeEv = events.find(e => e.text === 'Build the login page with OAuth');
    const codexEv = events.find(e => e.text === 'Add unit tests for the login form');
    assert.ok(claudeEv && codexEv, 'expected events missing from state');
    assert.strictEqual(claudeEv.session, 'sess1');
    assert.strictEqual(codexEv.session, 'rollout-1');
    assert.notStrictEqual(claudeEv.session, codexEv.session, 'sessions not distinct per transcript');
  });

  // Simulate a pre-v2 state file: stripping `version` must trigger a full
  // rescan of every transcript from byte 0 on the next sync.
  const v1State = JSON.parse(read(util.statePath()));
  delete v1State.version;
  fs.writeFileSync(util.statePath(), JSON.stringify(v1State, null, 2));
  const rBackfill = syncOnce();
  check('versionless state is discarded and all transcripts are re-read', () => {
    const want = r1.newEvents + r2.newEvents;
    assert.ok(rBackfill.newEvents >= want, `expected >=${want} backfill events, got ${rBackfill.newEvents}`);
    assert.strictEqual(JSON.parse(read(util.statePath())).version, util.STATE_VERSION, 'state not re-stamped');
  });
  check('backfill re-injects exactly one block, no duplicated prompts', () => {
    const md = claudeMd();
    assert.strictEqual(count(md, digest.BEGIN), 1, 'duplicate block');
    assert.strictEqual(count(md, 'Build the login page with OAuth'), 1, 'duplicate prompt');
  });

  // A second Claude Code session in the same project: same idea (OAuth login),
  // same file — the graph must connect it to sess1.
  fs.writeFileSync(path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess3.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Improve the OAuth login redirect error handling' }, cwd: proj1, timestamp: '2026-07-09T10:20:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: proj1, timestamp: '2026-07-09T10:21:00.000Z' },
  ]));
  syncOnce();

  const graph = buildGraph(util.loadState(), util.getConfig());
  check('graph: project node exists with >=3 distinct chat nodes', () => {
    const pNode = graph.nodes.find(n => n.type === 'project' && String(n.path).toLowerCase() === proj1.toLowerCase());
    assert.ok(pNode, 'proj1 project node missing');
    assert.ok(pNode.chats >= 3, `expected >=3 chats on project node, got ${pNode.chats}`);
    const chats = graph.nodes.filter(n => n.type === 'chat' && String(n.project).toLowerCase() === proj1.toLowerCase());
    assert.ok(chats.length >= 3, `expected >=3 chat nodes, got ${chats.length}`);
    assert.strictEqual(new Set(chats.map(c => c.id)).size, chats.length, 'chat ids not distinct');
  });
  check('graph: every chat node has a member link to its project', () => {
    const chats = graph.nodes.filter(n => n.type === 'chat');
    assert.ok(chats.length, 'no chat nodes at all');
    for (const c of chats) {
      assert.ok(
        graph.links.some(l => l.type === 'member' && l.source === c.id && l.target === 'p:' + c.project),
        `no member link for ${c.id}`,
      );
    }
  });
  check('graph: sess1 and sess3 are related by shared file and oauth terms', () => {
    const rel = graph.links.find(l => l.type === 'related' &&
      ((l.source === 'c:sess1' && l.target === 'c:sess3') || (l.source === 'c:sess3' && l.target === 'c:sess1')));
    assert.ok(rel, 'related link between sess1 and sess3 missing');
    assert.ok(rel.sharedFiles.some(f => f.includes('login.js')), `sharedFiles lack login.js: ${JSON.stringify(rel.sharedFiles)}`);
    assert.ok(rel.similarity > 0, `similarity not positive: ${rel.similarity}`);
    assert.ok(rel.terms.some(t => /^(oauth|login|redirect)/.test(t)), `no oauth-family term: ${JSON.stringify(rel.terms)}`);
  });
  check('graph: redacted secret never appears in graph output', () => {
    assert.ok(!JSON.stringify(graph).includes('sk-test1234567890abcdef'), 'secret leaked into graph');
  });

  // Strip everything again so the daemon section starts from the same clean
  // slate it always did (no blocks, no AGENTS.md, no memory DB).
  check('remove still cleans up after the backfill', () => {
    const out = spawnSync(process.execPath, [BIN, 'remove', '--project', proj1], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.ok(!claudeMd().includes(digest.BEGIN), 'block not stripped');
    assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'AGENTS.md not deleted');
    assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), 'memory DB not removed');
  });

  // --- 5. daemon + dashboard ---
  const PORT = 17941;
  const child = spawn(process.execPath, [BIN, 'daemon'], {
    env: { ...process.env, MEMBRIDGE_PORT: String(PORT) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitForHttp(`${base}/api/status`);
    const status = await (await fetch(`${base}/api/status`)).json();
    check('dashboard /api/status reports daemon state', () => {
      assert.strictEqual(status.running, true);
      assert.ok(status.projectCount >= 1, 'no projects reported');
      assert.ok(status.adapters.includes('Claude Code') && status.adapters.includes('MyTool'), 'adapters missing');
    });
    const page = await fetch(base);
    const pageHtml = await page.text();
    check('dashboard page serves 200 html', () => {
      assert.strictEqual(page.status, 200);
    });
    check('dashboard page has Overview and Neural map tabs', () => {
      assert.ok(pageHtml.includes('Overview'), 'Overview tab missing');
      assert.ok(pageHtml.includes('Neural map'), 'Neural map tab missing');
    });
    check('dashboard page has the full Team workspace', () => {
      assert.ok(pageHtml.includes('view-auth'), 'account gate missing');
      assert.ok(pageHtml.includes('view-team'), 'team view missing');
      assert.ok(pageHtml.includes("path = '/api/team/' + kind"), 'account auth flow missing');
      assert.ok(pageHtml.includes('/api/team/create'), 'team creation UI missing');
      assert.ok(pageHtml.includes('/api/team/link'), 'project linking UI missing');
      assert.ok(pageHtml.includes("return 'auth'"), 'protected-route gate missing');
    });
    check('dashboard page has the Copy for AI button', () => {
      assert.ok(pageHtml.includes('Copy for AI'), 'Copy for AI button missing');
    });
    check('dashboard page has the project view', () => {
      assert.ok(pageHtml.includes('view-project'), 'project view missing');
    });
    check('dashboard page has the Settings screen without BYOK/plan remnants', () => {
      assert.ok(pageHtml.includes('view-settings'), 'settings view missing');
      assert.ok(pageHtml.includes('Syncing'), 'sync section missing');
      assert.ok(!pageHtml.includes('Anthropic API key'), 'BYOK key section still on the page');
      assert.ok(!pageHtml.includes('Planner model'), 'planner model section still on the page');
      assert.ok(!pageHtml.includes('data-ptab="plan"'), 'Plan tab still on the page');
    });
    const graphRes = await fetch(`${base}/api/graph`);
    const graphText = await graphRes.text();
    check('dashboard /api/graph serves nodes and links, secrets redacted', () => {
      assert.strictEqual(graphRes.status, 200);
      const g = JSON.parse(graphText);
      assert.ok(Array.isArray(g.nodes) && g.nodes.some(n => n.type === 'chat'), 'chat nodes missing');
      assert.ok(Array.isArray(g.links) && g.links.some(l => l.type === 'member'), 'member links missing');
      assert.ok(!graphText.includes('sk-test1234567890abcdef'), 'secret leaked over HTTP');
    });
    const projects = await (await fetch(`${base}/api/projects`)).json();
    check('dashboard /api/projects lists the project with prompts', () => {
      const p = projects.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p, 'project missing');
      assert.ok(p.prompts.length >= 3, 'prompts missing');
      assert.strictEqual(p.paused, false);
    });

    // pause via API, then prove a paused project is skipped
    const tog = await (await post(`${base}/api/projects/toggle`, { path: proj1 })).json();
    check('toggle pauses the project and persists to config', () => {
      assert.strictEqual(tog.paused, true);
      assert.ok(util.loadUserConfig().exclude.includes(proj1), 'exclude not persisted');
    });
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Implement the secret feature Zeta' }, cwd: proj1, timestamp: '2026-07-09T11:00:00.000Z' }) + '\n',
    );
    await post(`${base}/api/sync`);
    check('paused project is not injected even with new activity', () => {
      assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'paused project was written');
      assert.ok(!claudeMd().includes('Implement the secret feature Zeta'), 'paused project was written');
      assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), 'paused project got a memory DB');
    });

    // resume + force a project sync
    await post(`${base}/api/projects/toggle`, { path: proj1 });
    await post(`${base}/api/sync`, { project: proj1 });
    check('resume + sync re-injects, including events captured while paused', () => {
      assert.ok(claudeMd().includes('Implement the secret feature Zeta'), 'event lost');
      assert.ok(fs.existsSync(path.join(proj1, 'AGENTS.md')), 'AGENTS.md not recreated');
    });

    // Copy for AI: the digest served to the dashboard's clipboard button
    const copyRes = await post(`${base}/api/projects/copy`, { path: proj1 });
    const copyBody = await copyRes.json();
    const copyBad = await post(`${base}/api/projects/copy`, { path: path.join(ROOT, 'no-such-dir') });
    check('copy-for-AI digest has the project, prompts and files', () => {
      assert.strictEqual(copyRes.status, 200);
      assert.ok(copyBody.text.includes('shop-app'), 'project name missing');
      assert.ok(copyBody.text.includes('Build the login page with OAuth'), 'Claude prompt missing');
      assert.ok(copyBody.text.includes('Add unit tests for the login form'), 'Codex prompt missing');
      assert.ok(copyBody.text.includes('src/login.js'), 'touched file missing');
      assert.ok(copyBody.text.includes('Project top level:'), 'top-level listing missing');
      assert.ok(!copyBody.text.includes('node_modules'), 'ignored dir leaked into top level');
    });
    check('copy-for-AI digest is redacted, unknown project 404s', () => {
      assert.ok(!copyBody.text.includes('sk-test1234567890abcdef'), 'secret leaked into copy digest');
      assert.ok(copyBody.text.includes('[redacted]'), 'no redaction marker in copy digest');
      assert.strictEqual(copyBad.status, 404, 'unknown project was accepted');
    });

    // M1: grid payload + project page endpoints
    const projList = await (await fetch(`${base}/api/projects`)).json();
    check('/api/projects reports which tools were used per project', () => {
      const p = projList.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p && Array.isArray(p.tools), 'tools missing');
      assert.ok(p.tools.includes('Claude Code') && p.tools.includes('Codex'), `tools said: ${JSON.stringify(p && p.tools)}`);
    });
    const detRes = await fetch(`${base}/api/project?path=${encodeURIComponent(proj1)}`);
    const det = await detRes.json();
    const detBad = await fetch(`${base}/api/project?path=${encodeURIComponent(path.join(ROOT, 'no-such-dir'))}`);
    check('/api/project returns the full project-page detail', () => {
      assert.strictEqual(detRes.status, 200);
      assert.strictEqual(det.name, 'shop-app');
      assert.ok(det.entries.length >= 4, `expected >=4 entries, got ${det.entries.length}`);
      assert.ok(det.entries.some(e => e.files.includes('src/login.js')), 'no entry carries the edited file');
      assert.ok(!JSON.stringify(det).includes('sk-test1234567890abcdef'), 'secret leaked into detail');
      assert.ok(det.targets.some(t => t.file === 'CLAUDE.md' && t.exists), 'targets missing');
      assert.ok(det.tools.includes('Codex'), 'tools missing from detail');
      assert.strictEqual(det.memory.exists, true, 'memory.md not reported as existing');
      assert.strictEqual(detBad.status, 404, 'unknown project was accepted');
    });
    const memRes = await fetch(`${base}/api/project/memory?path=${encodeURIComponent(proj1)}`);
    const memText = await memRes.text();
    const memBad = await fetch(`${base}/api/project/memory?path=${encodeURIComponent(path.join(ROOT, 'no-such-dir'))}`);
    check('/api/project/memory serves the memory log read-only', () => {
      assert.strictEqual(memRes.status, 200);
      assert.ok(memText.includes('Project memory'), 'memory.md content missing');
      assert.ok(!memText.includes('sk-test1234567890abcdef'), 'secret in served memory.md');
      assert.strictEqual(memBad.status, 404, 'unknown project memory was served');
    });

    // M2: settings (sync interval + injection targets)
    const st0 = await (await fetch(`${base}/api/settings`)).json();
    const stSave = await (await post(`${base}/api/settings`, {
      intervalSec: 45, targets: ['CLAUDE.md', 'AGENTS.md'],
    })).json();
    check('settings: interval and targets save and persist', () => {
      assert.ok(Array.isArray(st0.targets) && st0.targets.includes('CLAUDE.md'), 'targets missing from payload');
      assert.deepStrictEqual(stSave.targets, ['CLAUDE.md', 'AGENTS.md']);
      const rawCfg = JSON.parse(read(util.configPath()));
      assert.strictEqual(rawCfg.intervalSec, 45, 'interval not persisted');
      assert.deepStrictEqual(rawCfg.targets, ['CLAUDE.md', 'AGENTS.md'], 'targets not persisted');
    });
    const lowSave = await post(`${base}/api/settings`, { intervalSec: 3 });
    check('settings: interval below the 15s floor is clamped', () => {
      assert.strictEqual(lowSave.status, 200);
      const rawCfg = JSON.parse(read(util.configPath()));
      assert.strictEqual(rawCfg.intervalSec, 15, `interval persisted as ${rawCfg.intervalSec}`);
    });

    // add a fresh, never-seen directory via the dashboard API
    const freshDir = path.join(ROOT, 'projects', 'fresh-app');
    fs.mkdirSync(freshDir, { recursive: true });
    const addFirst = await (await post(`${base}/api/projects/add`, { path: freshDir })).json();
    const afterAdd = await (await fetch(`${base}/api/projects`)).json();
    const addAgain = await (await post(`${base}/api/projects/add`, { path: freshDir })).json();
    const addBad = await post(`${base}/api/projects/add`, { path: path.join(ROOT, 'no-such-dir') });
    check('add project registers an empty project', () => {
      assert.strictEqual(addFirst.added, true, `first add said: ${JSON.stringify(addFirst)}`);
      const p = afterAdd.find(x => x.path.toLowerCase() === freshDir.toLowerCase());
      assert.ok(p, 'added project missing from /api/projects');
      assert.strictEqual(p.prompts.length, 0, 'empty project reported prompts');
      assert.strictEqual(addAgain.added, false, 'second add not reported as already tracked');
      assert.strictEqual(addBad.status, 400, 'nonexistent path was accepted');
    });

    const delRes = await (await post(`${base}/api/projects/delete`, { path: proj1 })).json();
    const afterDel = await (await fetch(`${base}/api/projects`)).json();
    check('delete project strips blocks, memory and state', () => {
      assert.strictEqual(delRes.deleted, true, `delete said: ${JSON.stringify(delRes)}`);
      const md = claudeMd();
      assert.ok(!md.includes(digest.BEGIN), 'block not stripped from CLAUDE.md');
      assert.ok(md.startsWith('# Shop app'), 'original heading lost');
      assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), '.membridge dir not removed');
      assert.ok(!afterDel.some(x => x.path.toLowerCase() === proj1.toLowerCase()), 'project still listed');
    });

    // new activity in a deleted project must bring it back (offsets were
    // already consumed, so only the appended event returns)
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ship the checkout flow' }, cwd: proj1, timestamp: '2026-07-09T12:00:00.000Z' }) + '\n',
    );
    await post(`${base}/api/sync`);
    const afterRevive = await (await fetch(`${base}/api/projects`)).json();
    check('deleted project reappears with new activity', () => {
      const p = afterRevive.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p, 'deleted project did not reappear');
      assert.ok(p.prompts.some(e => e.text.includes('Ship the checkout flow')), 'new prompt missing');
    });
  } finally {
    child.kill();
  }
  await new Promise(r => setTimeout(r, 300));

  // --- 6. CLI start/stop lifecycle ---
  const env2 = { ...process.env, MEMBRIDGE_PORT: '17942' };
  const startOut = spawnSync(process.execPath, [BIN, 'start'], { env: env2, encoding: 'utf8' });
  await new Promise(r => setTimeout(r, 1500));
  const statusOut = spawnSync(process.execPath, [BIN, 'status'], { env: env2, encoding: 'utf8' });
  const stopOut = spawnSync(process.execPath, [BIN, 'stop'], { env: env2, encoding: 'utf8' });
  const statusOut2 = spawnSync(process.execPath, [BIN, 'status'], { env: env2, encoding: 'utf8' });
  check('CLI start/status/stop lifecycle', () => {
    assert.ok(/started in the background/.test(startOut.stdout), `start said: ${startOut.stdout} ${startOut.stderr}`);
    assert.ok(/running \(pid \d+\)/.test(statusOut.stdout), `status said: ${statusOut.stdout}`);
    assert.ok(/Stopped MemBridge/.test(stopOut.stdout), `stop said: ${stopOut.stdout}`);
    assert.ok(/not running/.test(statusOut2.stdout), `status said: ${statusOut2.stdout}`);
  });

  // --- 7. dashboard port retry (EADDRINUSE) ---
  // A fast stop→start can find the port still held by the dying daemon: the
  // server must retry the bind instead of leaving a daemon with no dashboard.
  {
    const PORT3 = 17943;
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(PORT3, '127.0.0.1', r));
    const srv = startServer(PORT3, { retries: 40, retryDelayMs: 100 });
    await new Promise(r => setTimeout(r, 350)); // let a few binds fail first
    const logAfterRetries = read(util.logPath());
    await new Promise(r => blocker.close(r));
    const retryRes = await waitForHttp(`http://127.0.0.1:${PORT3}/api/status`);
    check('dashboard retries EADDRINUSE and binds once the port frees', () => {
      assert.ok(logAfterRetries.includes(`port ${PORT3} in use, retrying`), 'no retry log line');
      assert.ok(!logAfterRetries.includes(`dashboard on http://127.0.0.1:${PORT3}`), 'bound while port was blocked');
      assert.ok(retryRes.ok, 'dashboard never came up after the port freed');
      assert.ok(read(util.logPath()).includes(`dashboard on http://127.0.0.1:${PORT3}`), 'no bind log line');
    });
    await new Promise(r => srv.close(r));
  }

  // --- 8. team sync (mock Supabase: GoTrue + PostgREST + membership checks) ---
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(17945, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17945';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  const HOME_A = process.env.MEMBRIDGE_HOME; // homeDir() reads env per call
  const sameKey = (a, b) => a.toLowerCase() === path.resolve(b).toLowerCase();

  check('team: backend resolves env > config > baked default', () => {
    // env override in force now
    assert.ok(teamsync.backend(util.getConfig()), 'env override not honored');
    // with env cleared, this official build falls back to its baked backend,
    // and a config override still takes precedence.
    const savedUrl = process.env.MEMBRIDGE_TEAM_URL;
    const savedKey = process.env.MEMBRIDGE_TEAM_ANON_KEY;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    try {
      assert.ok(teamsync.backend({}), 'baked backend missing');
      assert.ok(teamsync.backend({ team: { url: 'https://x.supabase.co', anonKey: 'k' } }),
        'config override not honored');
    } finally {
      process.env.MEMBRIDGE_TEAM_URL = savedUrl;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey;
    }
  });

  try {
    // Marco: signup, team, link the shop-app project, first push.
    const credsA = await teamsync.signup(util.getConfig(), 'marco@test.dev', 'pw-a', 'Marco');
    check('team: signup stores credentials outside any project, chmod 600', () => {
      assert.strictEqual(credsA.email, 'marco@test.dev');
      assert.ok(teamsync.credentialsPath().startsWith(HOME_A), 'credentials not in MemBridge home');
      const stored = JSON.parse(read(teamsync.credentialsPath()));
      assert.strictEqual(stored.displayName, 'Marco');
      assert.ok(stored.refreshToken, 'refresh token missing');
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(teamsync.credentialsPath()).mode & 0o777, 0o600);
      }
    });

    const team = await teamsync.createTeam(util.getConfig(), 'Acme');
    const linkA = await teamsync.linkProject(util.getConfig(), proj1, team.team_id, 'Acme');
    check('team: create + link write .membridge/team.json with the project id', () => {
      assert.ok(team.team_id && team.invite_code, 'team ids missing');
      const l = JSON.parse(read(path.join(proj1, '.membridge', 'team.json')));
      assert.strictEqual(l.projectId, linkA.projectId);
      assert.strictEqual(l.teamId, team.team_id);
    });
    const dashboardTeam = await teamPayload();
    check('dashboard: team payload exposes identity, teams and linked projects without tokens', () => {
      assert.strictEqual(dashboardTeam.authenticated, true);
      assert.strictEqual(dashboardTeam.user.email, 'marco@test.dev');
      assert.ok(dashboardTeam.teams.some(t => t.team_id === team.team_id), 'team missing');
      assert.ok(dashboardTeam.linkedProjects.some(p => sameKey(p.path, proj1)), 'linked project missing');
      assert.ok(!JSON.stringify(dashboardTeam).includes(credsA.accessToken), 'access token exposed');
      assert.ok(!JSON.stringify(dashboardTeam).includes(credsA.refreshToken), 'refresh token exposed');
    });

    // proj1 was deleted+revived earlier, so its live history is the single
    // "Ship the checkout flow" ask — enough to prove the push path end to end.
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add the order confirmation email' }, cwd: proj1, timestamp: '2026-07-12T08:00:00.000Z' }) + '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Wire the receipt PDF, api_key=sk-test1234567890abcdef' }, cwd: proj1, timestamp: '2026-07-12T08:01:00.000Z' }) + '\n',
    );
    syncOnce(); // fold the new asks into proj1's history before the first push
    const rA = await teamsync.syncTeams();
    check('team: push uploads only redacted digest entries', () => {
      assert.ok(rA.synced.some(k => sameKey(k, proj1)), `synced said: ${JSON.stringify(rA)}`);
      assert.ok(mock.entries.length >= 3, `expected >=3 pushed entries, got ${mock.entries.length}`);
      const body = JSON.stringify(mock.entries);
      assert.ok(!body.includes('sk-test1234567890abcdef'), 'secret reached the server');
      assert.ok(body.includes('[redacted]'), 'redaction marker missing server-side');
      assert.ok(mock.entries.every(e => e.author_name === 'Marco'), 'author attribution wrong');
    });

    const pushedCount = mock.entries.length;
    await teamsync.syncTeams();
    check('team: re-sync is idempotent (cursor + server dedupe)', () => {
      assert.strictEqual(mock.entries.length, pushedCount, 'duplicate entries pushed');
    });

    // Andrew: second machine (own MemBridge home), same repo basename, joins
    // by invite code — link_project maps his clone to the same project row.
    const projB = path.join(ROOT, 'projects-b', 'shop-app');
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projB, 'CLAUDE.md'), '# B clone\n\nAndrew notes.\n');
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-b');
    util.ensureConfig();
    const stateB = util.loadState();
    stateB.projects = {
      [projB]: {
        events: [{ ts: '2026-07-12T09:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'Refactor checkout validation', session: 'b1' }],
      },
    };
    util.saveState(stateB);
    await teamsync.signup(util.getConfig(), 'andrew@test.dev', 'pw-b', 'Andrew');
    const joined = await teamsync.joinTeam(util.getConfig(), team.invite_code);
    const linkB = await teamsync.linkProject(util.getConfig(), projB, joined.team_id, joined.team_name);
    check('team: invite-code join maps the clone to the same project row', () => {
      assert.strictEqual(joined.team_id, team.team_id);
      assert.strictEqual(joined.team_name, 'Acme');
      assert.strictEqual(linkB.projectId, linkA.projectId, 'clone got a different project row');
    });

    const rB = await teamsync.syncTeams();
    for (const k of rB.changed) syncOnce({ project: k });
    check("team: Andrew pulls Marco's asks into his context block", () => {
      assert.ok(rB.changed.some(k => sameKey(k, projB)), `changed said: ${JSON.stringify(rB)}`);
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(md.startsWith('# B clone'), 'his own notes were lost');
      assert.ok(md.includes("Teammates' AI activity"), 'team section missing');
      assert.ok(md.includes('Marco'), 'author name missing');
      assert.ok(md.includes('Ship the checkout flow'), "Marco's ask missing");
      assert.ok(!md.includes('sk-test1234567890abcdef'), 'secret leaked into teammate file');
    });

    // Back to Marco: his next pass pulls Andrew's Codex ask.
    process.env.MEMBRIDGE_HOME = HOME_A;
    const rA2 = await teamsync.syncTeams();
    for (const k of rA2.changed) syncOnce({ project: k });
    check("team: Marco pulls Andrew's ask back, with attribution", () => {
      assert.ok(rA2.changed.some(k => sameKey(k, proj1)), `changed said: ${JSON.stringify(rA2)}`);
      const md = claudeMd();
      assert.ok(md.includes("Teammates' AI activity"), 'team section missing');
      assert.ok(md.includes('Andrew · Codex: Refactor checkout validation'), "Andrew's ask missing");
    });

    // Stale token: the next call must transparently use the refresh grant.
    const stale = teamsync.loadCredentials();
    stale.expiresAt = Date.now() - 1000;
    fs.writeFileSync(teamsync.credentialsPath(), JSON.stringify(stale));
    const refreshesBefore = mock.stats.refreshCalls;
    await teamsync.getAccessToken(util.getConfig());
    check('team: stale access token refreshes transparently', () => {
      assert.strictEqual(mock.stats.refreshCalls, refreshesBefore + 1, 'refresh grant not used');
    });

    // Mallory: signed up but never joined the team; a hand-crafted team.json
    // must not let her push into (or read) the team's project.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-c');
    util.ensureConfig();
    const projC = path.join(ROOT, 'projects-c', 'shop-app');
    fs.mkdirSync(path.join(projC, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(projC, '.membridge', 'team.json'),
      JSON.stringify({ projectId: linkA.projectId, teamId: team.team_id }));
    const stateC = util.loadState();
    stateC.projects = {
      [projC]: {
        events: [{ ts: '2026-07-12T10:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'sneaky non-member write', session: 'c1' }],
      },
    };
    util.saveState(stateC);
    await teamsync.signup(util.getConfig(), 'mallory@test.dev', 'pw-c', 'Mallory');
    const rC = await teamsync.syncTeams();
    check('team: a non-member cannot push into or pull from the project', () => {
      assert.strictEqual(rC.changed.length, 0, 'non-member pulled entries');
      assert.strictEqual(rC.errors.length, 1, `errors said: ${JSON.stringify(rC.errors)}`);
      assert.ok(/security|member/i.test(rC.errors[0]), `error said: ${rC.errors[0]}`);
      assert.ok(!JSON.stringify(mock.entries).includes('sneaky'), 'non-member row was stored');
      assert.ok(mock.stats.deniedInserts >= 1, 'mock never denied the insert');
    });

    // CLI: `team setup` persists the backend; `logout` clears credentials.
    const HOME_CLI = path.join(ROOT, 'home-cli');
    const envT = { ...process.env, MEMBRIDGE_HOME: HOME_CLI };
    const setupOut = spawnSync(process.execPath,
      [BIN, 'team', 'setup', '--url', 'http://127.0.0.1:17945', '--anon-key', 'anon-test'],
      { env: envT, encoding: 'utf8' });
    process.env.MEMBRIDGE_HOME = HOME_A;
    const logoutOut = spawnSync(process.execPath, [BIN, 'logout'], { env: { ...process.env }, encoding: 'utf8' });
    check('CLI: team setup persists the backend, logout clears credentials', () => {
      assert.ok(/team backend saved/i.test(setupOut.stdout), `setup said: ${setupOut.stdout} ${setupOut.stderr}`);
      const cfg = JSON.parse(read(path.join(HOME_CLI, 'config.json')));
      assert.strictEqual(cfg.team.url, 'http://127.0.0.1:17945');
      assert.ok(/Logged out/.test(logoutOut.stdout), `logout said: ${logoutOut.stdout}`);
      assert.ok(!fs.existsSync(teamsync.credentialsPath()), 'credentials survive logout');
    });
  } finally {
    process.env.MEMBRIDGE_HOME = HOME_A;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  // --- summary ---
  const failed = results.filter(([, e]) => e);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
  if (failed.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
