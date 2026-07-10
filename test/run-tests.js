'use strict';
// Zero-dependency end-to-end tests. Everything runs against a throwaway temp
// dir via MEMBRIDGE_* env overrides — no real user files are read or written.
const assert = require('assert');
const fs = require('fs');
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

  // --- 4. daemon + dashboard ---
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
    check('dashboard page serves 200 html', () => {
      assert.strictEqual(page.status, 200);
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
  } finally {
    child.kill();
  }
  await new Promise(r => setTimeout(r, 300));

  // --- 5. CLI start/stop lifecycle ---
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
