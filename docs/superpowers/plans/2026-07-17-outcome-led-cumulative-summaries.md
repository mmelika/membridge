# Outcome-Led Cumulative Session Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session summary checkpoints become outcome-phrased and cumulative (newest line = whole session), delivered as one discreet auto-approved tool call — per [the approved spec](../specs/2026-07-17-outcome-led-cumulative-summaries-design.md).

**Architecture:** Three seams, all in the Stop-hook subsystem: (1) `lib/membridge-hook.js` gains an argv-dispatched `append` mode (validated, fail-loud) implemented in `lib/hooks.js`; (2) `blockReason` in `lib/hooks.js` is rewritten to demand a cumulative, outcome-phrased line written via that canonical command with no commentary; (3) `setup-hooks`/`remove-hooks` install/remove a narrow `permissions.allow` auto-approve rule for the command. Storage, scan merge, render, and team sync are untouched — every surface already picks the newest distilled line.

**Tech Stack:** Zero-dependency Node (CommonJS). Custom test harness `test/run-tests.js` (`check(name, fn)` + `assert`), run with `node test/run-tests.js`. All tests use temp dirs via `MEMBRIDGE_*` env overrides — never real user files.

**Conventions:** Commit format `<type>: <description>` (no attribution footer — disabled globally). Fail-open discipline everywhere in the stop path; the `append` command is the deliberate fail-loud exception (agent-facing, must be correctable).

---

## File structure

- Modify: `lib/membridge-hook.js` — argv dispatch: `append` → `runAppend`, else `runStop` (stays ~12 lines).
- Modify: `lib/hooks.js` — add `runAppend` + `appendAllowRule` + `upsertAllowRule`; rewrite `blockReason`; extend `readSettings` validation; extend `setupHooks`/`removeHooks`. Stays well under 500 lines.
- Modify: `test/run-tests.js` — new checks in the existing checkpoint section (~line 3100) and setup-hooks section (~line 2700); two existing `blockReason` checks replaced.
- Modify: `README.md` (Session summaries section) and `CHANGELOG.md` — Task 4.

No new files; this follows the existing subsystem layout.

---

### Task 1: `append` mode — validated, fail-loud line writer

**Files:**
- Modify: `lib/hooks.js` (add `runAppend`, export it)
- Modify: `lib/membridge-hook.js` (argv dispatch)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing tests**

In `test/run-tests.js`, directly after the closing `});` of the check named `'checkpoint: countSummaryLines ignores malformed lines, empty did, and other sessions'` (~line 3100), insert:

```js
  const HOOK_SCRIPT = path.join(__dirname, '..', 'lib', 'membridge-hook.js');
  const runAppendCli = args => spawnSync(process.execPath, [HOOK_SCRIPT, 'append', ...args], { encoding: 'utf8' });
  check('append: writes one validated line, creates .membridge, never truncates', () => {
    const proj = path.join(ROOT, 'projects', 'append-app');
    fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const line = f => JSON.stringify({ session: 'ap1', ts: '2026-07-17T00:00:00Z', goal: 'g', did: 'shipped the thing', decisions: '', gotchas: '', highlights: [], ...f });
    const out = runAppendCli([target, line({})]);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stdout, '', 'append must be silent on success');
    const rows = read(target).trim().split('\n');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(JSON.parse(rows[0]).did, 'shipped the thing');
    const out2 = runAppendCli([target, line({ did: 'second line' })]);
    assert.strictEqual(out2.status, 0, out2.stderr);
    const rows2 = read(target).trim().split('\n');
    assert.strictEqual(rows2.length, 2, 'second append must not truncate the first');
    assert.strictEqual(JSON.parse(rows2[1]).did, 'second line');
  });
  check('append: rejects bad input loudly and writes nothing', () => {
    const proj = path.join(ROOT, 'projects', 'append-bad');
    fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const mk = f => JSON.stringify({ session: 's1', did: 'real work', ...f });
    for (const [args, why] of [
      [[target, 'not json {'], 'malformed JSON'],
      [[target, '["array"]'], 'JSON but not an object'],
      [[target, mk({ session: '  ' })], 'blank session'],
      [[target, mk({ did: '' })], 'empty did'],
      [[path.join(proj, 'elsewhere.jsonl'), mk({})], 'target not a .membridge/summaries.jsonl path'],
      [[target], 'missing json argument'],
    ]) {
      const out = runAppendCli(args);
      assert.notStrictEqual(out.status, 0, `${why}: expected non-zero exit`);
      assert.ok(out.stderr.trim(), `${why}: expected a stderr message`);
    }
    assert.ok(!fs.existsSync(target), 'invalid input must write nothing');
  });
  check('append: bare invocation still runs the stop hook (allows on garbage stdin)', () => {
    const out = spawnSync(process.execPath, [HOOK_SCRIPT], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stdout, '');
  });
```

(`path`, `fs`, `spawnSync`, `ROOT`, `read`, `assert` are already in scope at the top of the file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep -A1 "append:"`
Expected: the three `append:` checks FAIL (the script currently ignores argv and runs `runStop`, which exits 0 silently — so assertions about file contents and non-zero exits fail).

- [ ] **Step 3: Implement `runAppend` in `lib/hooks.js`**

Insert after the `blockReason` function (before `runStop`):

```js
// `membridge-hook.js append <target> '<json-line>'` — the canonical summary
// write named by blockReason and auto-approved by the setup-hooks allow rule.
// Because that rule pre-approves this command, it must be safe by
// construction: validate everything, only ever append one normalized line,
// and only to a .membridge/summaries.jsonl path. Unlike the stop path this
// fails LOUD (non-zero + stderr): it is agent-facing, and a clear error lets
// the agent correct the line and retry inside its summary turn.
function runAppend(argv) {
  const fail = msg => { process.stderr.write(msg + '\n'); process.exitCode = 1; };
  const [target, line] = argv || [];
  const suffix = path.join(memorydb.DIR_NAME, SUMMARIES_FILE);
  if (!target || !line) return fail(`usage: membridge-hook.js append <path ending in ${suffix}> '<json-line>'`);
  if (!String(target).endsWith(suffix)) return fail(`refusing to write: target must end with ${suffix}`);
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return fail('invalid JSON: pass exactly one JSON object as a single argument');
  }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return fail('invalid JSON: expected a JSON object');
  if (typeof e.session !== 'string' || !e.session.trim()) return fail('invalid line: "session" must be a non-empty string');
  if (typeof e.did !== 'string' || !e.did.trim()) return fail('invalid line: "did" must be a non-empty string');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify(e) + '\n'); // re-stringified: guaranteed one line
}
```

Add `runAppend` to the `module.exports` object at the bottom of `lib/hooks.js`, next to `runStop`.

- [ ] **Step 4: Add the dispatch in `lib/membridge-hook.js`**

Replace the last line (`require('./hooks').runStop();`) with:

```js
// argv dispatch: `append <target> '<json>'` writes one validated summary
// line (see hooks.runAppend); anything else is the Stop-hook entry point.
const argv = process.argv.slice(2);
if (argv[0] === 'append') require('./hooks').runAppend(argv.slice(1));
else require('./hooks').runStop();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep -E "append:|FAIL" | head`
Expected: three `ok    append:` lines, no FAIL lines.

- [ ] **Step 6: Commit**

```bash
git add lib/hooks.js lib/membridge-hook.js test/run-tests.js
git commit -m "feat: validated append mode in membridge-hook (discreet summary write)"
```

---

### Task 2: `blockReason` — cumulative, outcome-phrased, discreet

**Files:**
- Modify: `lib/hooks.js:66-82` (`blockReason`)
- Test: `test/run-tests.js:3076-3089` (replace two existing checks)

- [ ] **Step 1: Replace the two existing `blockReason` checks with failing tests**

In `test/run-tests.js`, delete the two checks named `'checkpoint: blockReason scopes later checkpoints to only new work'` (~line 3076) and `'hooks: blockReason asks for goal and highlights'` (~line 3084) — their delta-scoping assertions encode the old spec — and put in their place:

```js
  check('checkpoint: blockReason asks every checkpoint for a cumulative whole-session line', () => {
    const first = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 0);
    const later = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 2);
    assert.ok(/whole session/i.test(first), 'first checkpoint asks for the whole session');
    assert.ok(/whole session/i.test(later), 'later checkpoint asks for the whole session');
    assert.ok(/supersed/i.test(later), 'later checkpoint declares it supersedes earlier lines');
    assert.ok(later.includes('2 earlier lines'), 'later checkpoint states the count');
    assert.ok(/never modify existing lines/i.test(later), 'append-only rule preserved');
    assert.ok(!/only the work done since/i.test(later), 'delta scoping must be gone');
  });
  check('checkpoint: blockReason demands outcome phrasing and the discreet append command', () => {
    const r = hooks.blockReason('/p/.membridge/summaries.jsonl', 'sess-x', 0);
    assert.ok(/what changed in the project/i.test(r), 'outcome phrasing present');
    assert.ok(/never a list of files edited/i.test(r), 'activity-list phrasing forbidden');
    assert.ok(r.includes(hooks.hookCommand() + ' append "/p/.membridge/summaries.jsonl"'), 'canonical append command with quoted target');
    assert.ok(/no commentary/i.test(r), 'no-commentary instruction present');
    assert.ok(/exactly ONE command/.test(r), 'single-command instruction present');
    assert.ok(r.includes('"sess-x"'), 'session id present in the template');
    assert.ok(/"goal"/.test(r) && /"did"/.test(r) && /"highlights"/.test(r), 'field template intact');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep -E "blockReason|FAIL" | head`
Expected: both new checks FAIL (current text says "cover ONLY the work done since your previous summary line" and instructs a raw JSON append, not the command).

- [ ] **Step 3: Rewrite `blockReason`**

Replace the whole `blockReason` function in `lib/hooks.js` (including its leading comment) with:

```js
// n is the count of checkpoints already written for this session. Every
// checkpoint asks for a CUMULATIVE line — the whole session so far, newest
// line wins on every render surface — phrased as the project outcome a
// teammate would experience, not AI activity. Delivery is discreet: one
// pre-approved append command (see runAppend / appendAllowRule), no
// commentary, so the summary turn is a single quiet tool call.
function blockReason(target, sessionId, n) {
  const scope = n > 0
    ? `summarize the whole session so far — this line supersedes the ${n} earlier line${n === 1 ? '' : 's'} already written for this session (never modify existing lines; just append)`
    : 'summarize the whole session so far';
  return 'MemBridge session distillation: before stopping, save a session summary by running exactly ONE command — ' +
    'no commentary before or after it, and do not restate the summary in your reply: ' +
    `${hookCommand()} append ${quoteArg(target)} '<json>' ` +
    `where <json> is ONE line: {"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","goal":"...","did":"...","decisions":"...","gotchas":"...","highlights":[{"file":"<path>","note":"..."}]} ` +
    '— goal: 1 short line on what the user asked for; ' +
    `did: 1-3 plain-text sentences that ${scope}, phrased as what changed in the project from a teammate's point of view (the outcome), never a list of files edited or tools run; ` +
    'decisions: key choices a teammate would need to know, or ""; ' +
    'gotchas: surprises or pitfalls hit, or ""; ' +
    'highlights: up to 2 of the most important files with a short note each, or []. ' +
    'Only what a teammate needs — no markdown. Then stop again.';
}
```

Note: `quoteArg` and `hookCommand` are defined lower in the file than `blockReason` — that's fine: `blockReason` only executes at stop time, long after the module has fully loaded. Do not move them.

- [ ] **Step 4: Run the full suite**

Run: `node test/run-tests.js 2>&1 | tail -5`
Expected: summary line reports 0 failures. If any *other* check fails on the new wording (e.g. a fixture asserting the old instruction text), fix that check's expectation to the new text — the spec changed deliberately.

- [ ] **Step 5: Commit**

```bash
git add lib/hooks.js test/run-tests.js
git commit -m "feat: cumulative outcome-phrased blockReason via discreet append command"
```

---

### Task 3: auto-approve rule in setup-hooks / remove-hooks

**Files:**
- Modify: `lib/hooks.js` (`readSettings` validation, new `appendAllowRule`/`upsertAllowRule`, `setupHooks`, `removeHooks`, exports)
- Test: `test/run-tests.js` (setup-hooks section, after the last `removeOut`-related check ~line 2701+)

- [ ] **Step 1: Write the failing tests**

In `test/run-tests.js`, find the setup-hooks/remove-hooks test block (starts with the comment `// setup-hooks / remove-hooks: surgical merge into a user's settings.json.` ~line 2609). After the last check in that block that references `removeOut`, insert:

```js
  check('distill: setup-hooks installs the append auto-approve rule; remove-hooks strips it, user rules survive', () => {
    const permFile = path.join(ROOT, 'claude-settings-perm.json');
    fs.writeFileSync(permFile, JSON.stringify({ permissions: { allow: ['Bash(npm run test:*)'] } }, null, 2));
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: permFile };
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    const after = JSON.parse(read(permFile));
    assert.ok(after.permissions.allow.includes(hooks.appendAllowRule()), 'allow rule missing after setup');
    assert.ok(after.permissions.allow.includes('Bash(npm run test:*)'), 'user rule dropped by setup');
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' }); // idempotent
    const after2 = JSON.parse(read(permFile));
    assert.strictEqual(after2.permissions.allow.filter(r => /membridge/i.test(r)).length, 1, 'rule duplicated on re-run');
    spawnSync(process.execPath, [BIN, 'remove-hooks'], { env, encoding: 'utf8' });
    const after3 = JSON.parse(read(permFile));
    const allow3 = ((after3.permissions || {}).allow) || [];
    assert.ok(!allow3.some(r => /membridge/i.test(r)), 'rule not removed by remove-hooks');
    assert.ok(allow3.includes('Bash(npm run test:*)'), 'user rule dropped by remove-hooks');
  });
  check('distill: setup-hooks upgrades a stale append allow rule in place', () => {
    const staleFile = path.join(ROOT, 'claude-settings-stale-rule.json');
    fs.writeFileSync(staleFile, JSON.stringify({
      permissions: { allow: ['Bash("/old/node" "/old/lib/membridge-hook.js" append:*)'] },
    }, null, 2));
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: staleFile };
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    const after = JSON.parse(read(staleFile));
    assert.deepStrictEqual(after.permissions.allow.filter(r => /membridge/i.test(r)), [hooks.appendAllowRule()], 'stale rule not rewritten to current form');
  });
  check('distill: setup-hooks refuses a settings file whose permissions shape is malformed', () => {
    const badFile = path.join(ROOT, 'claude-settings-badperm.json');
    const badBody = JSON.stringify({ permissions: [] });
    fs.writeFileSync(badFile, badBody);
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: badFile };
    const out = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    assert.ok(/refusing/i.test(out.stdout + out.stderr), 'expected a refusal message');
    assert.strictEqual(read(badFile), badBody, 'malformed file must not be rewritten');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep -E "allow|stale append|malformed$|FAIL" | head`
Expected: first two checks FAIL (`hooks.appendAllowRule` is not a function / rule never written). The malformed-permissions check may pass or fail depending on current behavior — it must pass after Step 3.

- [ ] **Step 3: Implement rule handling in `lib/hooks.js`**

**3a.** In `readSettings`, after the existing `hooks.Stop` validation (the `if (settings.hooks && settings.hooks.Stop !== undefined ...)` block), add:

```js
  if (settings.permissions !== undefined && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions) || settings.permissions === null)) {
    throw new Error(`refusing to touch ${file}: "permissions" is not an object`);
  }
  if (settings.permissions && settings.permissions.allow !== undefined && !Array.isArray(settings.permissions.allow)) {
    throw new Error(`refusing to touch ${file}: "permissions.allow" is not an array`);
  }
```

**3b.** After the `commandExecutable`/`executableResolves` helpers, add:

```js
// The narrow auto-approve rule for the summary append command. Bash
// permission rules are prefix-matched, so this approves exactly
// `<node> <membridge-hook.js> append ...` and nothing else; runAppend
// keeps the approved surface safe (validated line, summaries.jsonl only).
function appendAllowRule() {
  return `Bash(${hookCommand()} append:*)`;
}

// Ensure the allow rule is present, rewriting stale MemBridge append rules
// (previous install paths) in place. Returns the new allow array, or null
// when nothing needs to change. User-owned rules are never touched.
function upsertAllowRule(settings) {
  const rule = appendAllowRule();
  const isOurs = v => typeof v === 'string' && v.toLowerCase().includes('membridge') && v.includes(' append');
  const allow = ((settings.permissions || {}).allow) || [];
  let stale = false;
  const next = allow.map(v => {
    if (!isOurs(v) || v === rule) return v;
    stale = true;
    return rule;
  });
  if (next.includes(rule)) return stale ? next : null;
  return [...next, rule];
}
```

**3c.** Rework `setupHooks`: keep the upgrade loop as-is, then replace everything from `if (current && !upgraded)` to the end of the function with:

```js
  const newAllow = upsertAllowRule(settings);
  if (current && !upgraded && !newAllow) {
    return `Claude Code Stop hook already installed in ${file} — nothing changed.`;
  }
  // Stop hooks take no matcher; 10s is generous for a local state read.
  const finalStop = (current || upgraded)
    ? upgradedStop
    : [...upgradedStop, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  const next = { ...settings, hooks: { ...(settings.hooks || {}), Stop: finalStop } };
  if (newAllow) next.permissions = { ...(settings.permissions || {}), allow: newAllow };
  writeSettings(file, next);
  if (current && !upgraded) {
    return `Added the MemBridge auto-approve rule for the summary append command in ${file}.
Undo anytime with: membridge remove-hooks`;
  }
  if (upgraded) {
    return `Updated the MemBridge Stop hook command in ${file} (${upgraded} entr${upgraded === 1 ? 'y' : 'ies'} rewritten to the current install path).
Undo anytime with: membridge remove-hooks`;
  }
  return `Installed the MemBridge Stop hook in ${file} (appended after your existing hooks), plus one narrow auto-approve rule so the summary append never raises a permission prompt.
On every Claude Code session stop, \`${command}\` asks the agent for a short outcome summary of sessions that edited files, saved via the append command to <project>/.membridge/summaries.jsonl.
Undo anytime with: membridge remove-hooks`;
```

**3d.** In `removeHooks`, replace the block from `if (!removed) return ...` to the end of the function with:

```js
  const allow = ((settings.permissions || {}).allow) || [];
  const keptAllow = allow.filter(v => !mentionsMembridge(v));
  const removedAllow = allow.length - keptAllow.length;
  if (!removed && !removedAllow) return `No MemBridge hook found in ${file} — nothing changed.`;
  if (removed) {
    settings.hooks.Stop = kept;
    if (!kept.length) delete settings.hooks.Stop;
  }
  if (removedAllow) {
    settings.permissions.allow = keptAllow;
    if (!keptAllow.length) delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  writeSettings(file, settings);
  const total = removed + removedAllow;
  return `Removed the MemBridge Stop hook from ${file} (${total} entr${total === 1 ? 'y' : 'ies'}); your other hooks are untouched.
Re-enable anytime with: membridge setup-hooks`;
```

**3e.** Add `appendAllowRule` to `module.exports` (next to `hookCommand`).

- [ ] **Step 4: Run the full suite**

Run: `node test/run-tests.js 2>&1 | tail -5`
Expected: 0 failures — including the pre-existing setup-hooks checks (`'distill: setup-hooks appends once and preserves user hooks byte-for-byte'` etc.), which must still pass because hook-entry behavior is unchanged. If the byte-for-byte check fails because the settings file now also gains a `permissions` key, that is expected new behavior: update only that check to allow the added `permissions.allow` rule while still asserting user hooks are preserved.

- [ ] **Step 5: Commit**

```bash
git add lib/hooks.js test/run-tests.js
git commit -m "feat: setup-hooks installs narrow auto-approve rule for summary append"
```

---

### Task 4: docs, full verification, app rebuild

**Files:**
- Modify: `README.md:199-228`
- Modify: `CHANGELOG.md` (top)

- [ ] **Step 1: Update README's Session summaries section**

Three edits in `README.md`:

1. Replace (line ~199-200) `the hook blocks the stop once and asks the agent to append one JSON line to` with `the hook blocks the stop once and asks the agent to save one JSON line — via a single pre-approved append command, no narration — to`.
2. Replace the example JSON (line ~203) with:
```json
{"session":"<id>","ts":"<ISO time>","goal":"What was asked.","did":"What changed in the project.","decisions":"Key choices.","gotchas":"Surprises.","highlights":[{"file":"lib/feed.js","note":"why it matters"}]}
```
3. In the **Checkpoints, not one-shot** paragraph, replace `asks for a fresh line covering only the new work. Each line is appended; earlier ones are never edited.` with `asks for a fresh line summarizing the whole session so far, phrased as the outcome a teammate would experience. Each line is appended, never edited — the newest line is the summary; older ones are the session's history.`
4. In the **Consent model** paragraph, replace `they append without disturbing your existing hooks, and turning it off strips exactly what was added.` with `they append without disturbing your existing hooks — the Stop hook plus one narrow auto-approve rule so the summary write never raises a permission prompt — and turning it off strips exactly what was added.`

- [ ] **Step 2: Add a CHANGELOG entry**

At the top of `CHANGELOG.md`, directly under the `# Changelog` heading, insert:

```markdown
## Unreleased

- **Session summaries are now cumulative and outcome-phrased.** Every
  checkpoint rewrites the whole-session summary (newest line wins on every
  surface) as *what changed in the project*, not AI activity — so a long
  session's card no longer shows only its last increment. The summary turn
  is discreet: one pre-approved `membridge-hook.js append` command (narrow
  `permissions.allow` rule installed/removed by `setup-hooks`/`remove-hooks`),
  no narration, no permission prompt.
```

(If an `## Unreleased` section already exists by then, append the bullet to it instead.)

- [ ] **Step 3: Full suite, one last time**

Run: `node test/run-tests.js 2>&1 | tail -5`
Expected: 0 failures.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document cumulative outcome summaries and discreet append delivery"
```

- [ ] **Step 5: Rebuild and reinstall MemBridge.app** (project convention after behavior changes — the installed app's asar ships `lib/`, and installed users' Stop hooks point at the app's copy of `membridge-hook.js`)

Run: `npm run dist:mac`
Expected: electron-builder completes; then reinstall the built app from `dist/` over `/Applications/MemBridge.app` and relaunch it. After reinstall, run `membridge setup-hooks` once (or toggle Settings → Session summaries) so the new auto-approve rule is added to `~/.claude/settings.json`.

---

## Verification against the spec

- Outcome phrasing → Task 2 (`blockReason` text + tests).
- Cumulative scope, append-only, newest-wins with no render change → Task 2; render untouched by design.
- Discreet delivery: no commentary → Task 2; canonical validated append → Task 1; auto-approve rule installed/removed → Task 3.
- Fail-open stop path unchanged; fail-loud append → Task 1 tests.
- setup/remove surgical discipline incl. malformed-permissions refusal → Task 3 tests.
- README/CHANGELOG truthful about new behavior → Task 4.
