# Multi-Provider Advisor & Per-Session Prompt Sharing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Anthropic-only advisor with a provider-adapter registry (Anthropic/OpenAI/Gemini/local), and add a per-session "Visible to team" toggle on self feed cards.

**Architecture:** Part A creates `lib/advisors/` with one file per provider (common interface: `testKey`, `generate`), refactors `lib/advisor.js` into a thin orchestrator that reads the new config shape with lazy backward-compat migration, and updates server + UI. Part B adds `isShared(proj, sessionId)` to `teamsync.js`, changes `pushProject` to per-entry prompt gating, adds a `resharePromptsForSession` backfill/scrub function, a new `/api/share-session` endpoint, and a toggle rendered only on self cards.

**Tech Stack:** Node.js, zero-dependency raw `fetch`, existing `test/run-tests.js` offline test suite (mock HTTP server pattern already established at port 17944).

---

## PART A — Multi-Provider Advisor

### Task 1: Adapter registry + Anthropic adapter

**Files:**
- Create: `lib/advisors/index.js`
- Create: `lib/advisors/anthropic.js`
- Modify: `test/run-tests.js` (add adapter unit tests)

- [ ] **Step 1: Write failing tests**

Add this block to `test/run-tests.js` after the existing `check` setup and before the daemon section:

```js
// ---- Advisor adapter tests ----
{
  const advisors = require('../lib/advisors/index');
  check('advisors registry exports byId and list', () => {
    assert.ok(typeof advisors.byId === 'function', 'byId missing');
    assert.ok(Array.isArray(advisors.list()), 'list missing');
    const a = advisors.byId('anthropic');
    assert.ok(a, 'anthropic adapter missing');
    assert.ok(a.id === 'anthropic');
    assert.ok(Array.isArray(a.models) && a.models.length > 0);
    assert.ok(typeof a.testKey === 'function');
    assert.ok(typeof a.generate === 'function');
    assert.ok(!a.needsBaseUrl);
  });

  check('anthropic adapter testKey uses MEMBRIDGE_API_BASE', async () => {
    const a = advisors.byId('anthropic');
    // Use the already-running mockApi at 17944 set up below — but these
    // unit checks run before the daemon section, so use a tiny inline server.
    const srv = http.createServer((req, res) => {
      res.writeHead(req.headers['x-api-key'] === 'good' ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(req.headers['x-api-key'] === 'good' ? '{"input_tokens":1}' : '{"error":{}}');
    });
    await new Promise(r => srv.listen(17950, '127.0.0.1', r));
    process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17950';
    try {
      const ok = await a.testKey({ apiKey: 'good' });
      assert.ok(ok.ok, 'expected ok');
      const bad = await a.testKey({ apiKey: 'bad' });
      assert.ok(!bad.ok && bad.error, 'expected error');
      const none = await a.testKey({ apiKey: '' });
      assert.ok(!none.ok);
    } finally {
      delete process.env.MEMBRIDGE_API_BASE;
      await new Promise(r => srv.close(r));
    }
  });

  check('anthropic adapter generate (schema) returns text+usage', async () => {
    const a = advisors.byId('anthropic');
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 5 } }));
    });
    await new Promise(r => srv.listen(17951, '127.0.0.1', r));
    process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17951';
    try {
      const r = await a.generate({ apiKey: 'k', model: 'claude-haiku-4-5', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal });
      assert.ok(r.text === '{"ok":true}');
      assert.ok(r.usage && r.usage.input_tokens === 10);
    } finally {
      delete process.env.MEMBRIDGE_API_BASE;
      await new Promise(r => srv.close(r));
    }
  });
}
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|ok " | head -20
```

Expected: `FAIL  advisors registry exports byId and list` (module not found).

- [ ] **Step 3: Create `lib/advisors/index.js`**

```js
'use strict';
const anthropic = require('./anthropic');
// Remaining adapters added in Tasks 2–4.
const ADAPTERS = [anthropic];
const BY_ID = Object.fromEntries(ADAPTERS.map(a => [a.id, a]));
module.exports = {
  byId: id => BY_ID[id] || null,
  list: () => ADAPTERS.slice(),
  register: adapter => {
    ADAPTERS.push(adapter);
    BY_ID[adapter.id] = adapter;
  },
};
```

- [ ] **Step 4: Create `lib/advisors/anthropic.js`**

```js
'use strict';
const API_VERSION = '2023-06-01';
const MODELS = [
  { id: 'claude-haiku-4-5',  label: 'Fast & cheap (~1¢ per roadmap) — recommended', priceIn: 1,  priceOut: 5  },
  { id: 'claude-sonnet-5',   label: 'Smarter (~4¢)',                                  priceIn: 2,  priceOut: 10 },
  { id: 'claude-opus-4-8',   label: 'Deepest (~6¢)',                                  priceIn: 5,  priceOut: 25 },
];

function base() {
  return process.env.MEMBRIDGE_API_BASE || 'https://api.anthropic.com';
}

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'content-type': 'application/json',
  };
}

async function testKey({ apiKey }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base()}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ model: MODELS[0].id, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was rejected — check it and try again.' };
    let msg = `The Anthropic API answered with an error (${res.status}).`;
    try { const b = await res.json(); if (b?.error?.message) msg = b.error.message; } catch {}
    return { ok: false, error: msg };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching Anthropic — try again.' : 'Could not reach Anthropic — are you online?' };
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ apiKey, model, system, prompt, schema, maxTokens, signal }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (schema) body.output_config = { format: { type: 'json_schema', schema } };
  if (model === 'claude-sonnet-5') body.thinking = { type: 'disabled' };
  try {
    let res = await fetch(`${base()}/v1/messages`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal });
    if (res.status === 429 || res.status >= 500) {
      res = await fetch(`${base()}/v1/messages`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal });
    }
    if (res.status === 401) return { error: 'That key looks invalid — check Settings.' };
    if (!res.ok) {
      let msg = `Anthropic API error (${res.status}) — try again.`;
      try { const b = await res.json(); if (b?.error?.message) msg = b.error.message; } catch {}
      return { error: msg };
    }
    const data = await res.json();
    if (data.stop_reason === 'max_tokens') return { error: 'Response was cut off — try a narrower goal.' };
    const text = (data.content || []).find(b => b.type === 'text')?.text || '';
    const u = data.usage || {};
    return { text, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for Anthropic — try again.' : 'Could not reach Anthropic — are you online?' };
  }
}

module.exports = { id: 'anthropic', label: 'Anthropic (Claude)', needsBaseUrl: false, keyEnv: ['ANTHROPIC_API_KEY'], models: MODELS, testKey, generate };
```

- [ ] **Step 5: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|advisors" | head -10
```

Expected: three `ok` lines for the advisor adapter checks.

- [ ] **Step 6: Commit**

```bash
git add lib/advisors/index.js lib/advisors/anthropic.js test/run-tests.js
git commit -m "feat: advisor adapter registry + Anthropic adapter"
```

---

### Task 2: OpenAI adapter

**Files:**
- Create: `lib/advisors/openai.js`
- Modify: `lib/advisors/index.js` (register openai)
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

Add to the adapter unit-test block in `test/run-tests.js`:

```js
check('openai adapter registered and testKey calls /v1/models', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('openai');
  assert.ok(a && a.id === 'openai', 'openai adapter missing');
  assert.ok(!a.needsBaseUrl);
  const srv = http.createServer((req, res) => {
    const authed = req.headers['authorization'] === 'Bearer good';
    res.writeHead(authed ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(authed ? '{"data":[]}' : '{"error":{"message":"invalid"}}');
  });
  await new Promise(r => srv.listen(17952, '127.0.0.1', r));
  process.env.MEMBRIDGE_OPENAI_BASE = 'http://127.0.0.1:17952';
  try {
    const ok = await a.testKey({ apiKey: 'good' });
    assert.ok(ok.ok, 'expected ok true');
    const bad = await a.testKey({ apiKey: 'bad' });
    assert.ok(!bad.ok);
  } finally {
    delete process.env.MEMBRIDGE_OPENAI_BASE;
    await new Promise(r => srv.close(r));
  }
});

check('openai adapter generate (schema) sends json_schema response_format', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('openai');
  let capturedBody = null;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise(r => srv.listen(17953, '127.0.0.1', r));
  process.env.MEMBRIDGE_OPENAI_BASE = 'http://127.0.0.1:17953';
  try {
    const r = await a.generate({ apiKey: 'k', model: 'gpt-4o-mini', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal });
    assert.ok(r.text === '{"ok":true}');
    assert.ok(capturedBody.response_format?.type === 'json_schema');
    assert.ok(r.usage.input_tokens === 10 && r.usage.output_tokens === 5);
  } finally {
    delete process.env.MEMBRIDGE_OPENAI_BASE;
    await new Promise(r => srv.close(r));
  }
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Create `lib/advisors/openai.js`**

```js
'use strict';
const MODELS = [
  { id: 'gpt-4o-mini', label: 'Fast & cheap (~2¢ per roadmap) — recommended', priceIn: 0.15,  priceOut: 0.6 },
  { id: 'gpt-4o',      label: 'Standard (~8¢)',                                priceIn: 2.5,   priceOut: 10  },
  { id: 'gpt-4.1',     label: 'Capable (~18¢)',                                priceIn: 2,     priceOut: 8   },
];

function base() {
  return process.env.MEMBRIDGE_OPENAI_BASE || 'https://api.openai.com';
}

async function testKey({ apiKey }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base()}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was rejected — check it and try again.' };
    return { ok: false, error: `OpenAI API error (${res.status}).` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching OpenAI.' : 'Could not reach OpenAI — are you online?' };
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ apiKey, model, system, prompt, schema, maxTokens, signal }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt  },
    ],
  };
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } };
  }
  try {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) return { error: 'That key looks invalid — check Settings.' };
    if (!res.ok) {
      let msg = `OpenAI API error (${res.status}) — try again.`;
      try { const b = await res.json(); if (b?.error?.message) msg = b.error.message; } catch {}
      return { error: msg };
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const u = data.usage || {};
    return { text, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for OpenAI.' : 'Could not reach OpenAI — are you online?' };
  }
}

module.exports = { id: 'openai', label: 'OpenAI (GPT)', needsBaseUrl: false, keyEnv: ['OPENAI_API_KEY'], models: MODELS, testKey, generate };
```

- [ ] **Step 4: Register in `lib/advisors/index.js`**

```js
'use strict';
const anthropic = require('./anthropic');
const openai    = require('./openai');
const ADAPTERS = [anthropic, openai];
const BY_ID = Object.fromEntries(ADAPTERS.map(a => [a.id, a]));
module.exports = {
  byId: id => BY_ID[id] || null,
  list: () => ADAPTERS.slice(),
  register: adapter => { ADAPTERS.push(adapter); BY_ID[adapter.id] = adapter; },
};
```

- [ ] **Step 5: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|openai adapter" | head -10
```

- [ ] **Step 6: Commit**

```bash
git add lib/advisors/openai.js lib/advisors/index.js test/run-tests.js
git commit -m "feat: OpenAI advisor adapter"
```

---

### Task 3: Google (Gemini) adapter

**Files:**
- Create: `lib/advisors/google.js`
- Modify: `lib/advisors/index.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

```js
check('google adapter registered and testKey calls /v1beta/models', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('google');
  assert.ok(a && a.id === 'google', 'google adapter missing');
  const srv = http.createServer((req, res) => {
    const authed = req.url.includes('key=good');
    res.writeHead(authed ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(authed ? '{"models":[]}' : '{"error":{"code":403}}');
  });
  await new Promise(r => srv.listen(17954, '127.0.0.1', r));
  process.env.MEMBRIDGE_GOOGLE_BASE = 'http://127.0.0.1:17954';
  try {
    assert.ok((await a.testKey({ apiKey: 'good' })).ok);
    assert.ok(!(await a.testKey({ apiKey: 'bad' })).ok);
  } finally {
    delete process.env.MEMBRIDGE_GOOGLE_BASE;
    await new Promise(r => srv.close(r));
  }
});

check('google adapter generate sends responseSchema in generationConfig', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('google');
  let capturedBody = null;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
      }));
    });
  });
  await new Promise(r => srv.listen(17955, '127.0.0.1', r));
  process.env.MEMBRIDGE_GOOGLE_BASE = 'http://127.0.0.1:17955';
  try {
    const r = await a.generate({ apiKey: 'good', model: 'gemini-2.0-flash', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal });
    assert.ok(r.text === '{"ok":true}');
    assert.ok(capturedBody.generationConfig?.responseSchema);
    assert.ok(capturedBody.generationConfig?.responseMimeType === 'application/json');
    assert.ok(r.usage.input_tokens === 8 && r.usage.output_tokens === 4);
  } finally {
    delete process.env.MEMBRIDGE_GOOGLE_BASE;
    await new Promise(r => srv.close(r));
  }
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Create `lib/advisors/google.js`**

```js
'use strict';
const MODELS = [
  { id: 'gemini-2.0-flash',  label: 'Fast & cheap (~0.5¢ per roadmap) — recommended', priceIn: 0.1,  priceOut: 0.4  },
  { id: 'gemini-2.5-flash',  label: 'Balanced (~2¢)',                                  priceIn: 0.3,  priceOut: 2.5  },
  { id: 'gemini-2.5-pro',    label: 'Most capable (~15¢)',                              priceIn: 1.25, priceOut: 10   },
];

function base() {
  return process.env.MEMBRIDGE_GOOGLE_BASE || 'https://generativelanguage.googleapis.com';
}

async function testKey({ apiKey }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base()}/v1beta/models?key=${encodeURIComponent(apiKey)}`, { signal: ctrl.signal });
    if (res.ok) return { ok: true };
    if (res.status === 400 || res.status === 403) return { ok: false, error: 'That key was rejected — check it and try again.' };
    return { ok: false, error: `Google API error (${res.status}).` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching Google.' : 'Could not reach Google — are you online?' };
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ apiKey, model, system, prompt, schema, maxTokens, signal }) {
  const genCfg = { maxOutputTokens: maxTokens };
  if (schema) {
    genCfg.responseMimeType = 'application/json';
    genCfg.responseSchema = schema;
  }
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: genCfg,
  };
  try {
    const url = `${base()}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (res.status === 400 || res.status === 403) return { error: 'That key looks invalid — check Settings.' };
    if (!res.ok) {
      let msg = `Google API error (${res.status}) — try again.`;
      try { const b = await res.json(); if (b?.error?.message) msg = b.error.message; } catch {}
      return { error: msg };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const u = data.usageMetadata || {};
    return { text, usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for Google.' : 'Could not reach Google — are you online?' };
  }
}

module.exports = { id: 'google', label: 'Google (Gemini)', needsBaseUrl: false, keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], models: MODELS, testKey, generate };
```

- [ ] **Step 4: Register in `lib/advisors/index.js`**

```js
'use strict';
const anthropic = require('./anthropic');
const openai    = require('./openai');
const google    = require('./google');
const ADAPTERS = [anthropic, openai, google];
const BY_ID = Object.fromEntries(ADAPTERS.map(a => [a.id, a]));
module.exports = {
  byId: id => BY_ID[id] || null,
  list: () => ADAPTERS.slice(),
  register: adapter => { ADAPTERS.push(adapter); BY_ID[adapter.id] = adapter; },
};
```

- [ ] **Step 5: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|google adapter" | head -10
```

- [ ] **Step 6: Commit**

```bash
git add lib/advisors/google.js lib/advisors/index.js test/run-tests.js
git commit -m "feat: Google/Gemini advisor adapter"
```

---

### Task 4: Local / OpenAI-compatible adapter (tolerant parse)

**Files:**
- Create: `lib/advisors/openai-compatible.js`
- Modify: `lib/advisors/index.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

```js
check('local adapter registered, needsBaseUrl true, testKey uses baseUrl/models', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('local');
  assert.ok(a && a.id === 'local', 'local adapter missing');
  assert.ok(a.needsBaseUrl, 'needsBaseUrl should be true');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"models":[]}');
  });
  await new Promise(r => srv.listen(17956, '127.0.0.1', r));
  try {
    const ok = await a.testKey({ apiKey: '', baseUrl: 'http://127.0.0.1:17956' });
    assert.ok(ok.ok, 'local testKey with reachable server should be ok');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

check('local adapter generate: tolerant parse extracts JSON from fenced text', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('local');
  const fencedResponse = '```json\n{"ok":true}\n```';
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: fencedResponse } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  await new Promise(r => srv.listen(17957, '127.0.0.1', r));
  try {
    const r = await a.generate({ apiKey: '', baseUrl: 'http://127.0.0.1:17957', model: 'llama3', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal });
    // tolerant parse should extract {"ok":true} from fenced text
    assert.ok(r.text, 'expected text');
    const parsed = JSON.parse(r.text);
    assert.ok(parsed.ok === true);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

check('local adapter generate: returns error when JSON unextractable', async () => {
  const advisors = require('../lib/advisors/index');
  const a = advisors.byId('local');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Sorry I cannot do that.' } }], usage: { prompt_tokens: 3, completion_tokens: 6 } }));
  });
  await new Promise(r => srv.listen(17958, '127.0.0.1', r));
  try {
    const r = await a.generate({ apiKey: '', baseUrl: 'http://127.0.0.1:17958', model: 'llama3', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 100, signal: new AbortController().signal });
    assert.ok(r.error, 'expected error when schema required but unparseable');
  } finally {
    await new Promise(r => srv.close(r));
  }
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Create `lib/advisors/openai-compatible.js`**

```js
'use strict';
// Generic OpenAI-shaped adapter for local/self-hosted endpoints (Ollama,
// LM Studio, OpenRouter). Uses response_format but cannot guarantee schema
// adherence, so apply a tolerant parse: JSON.parse → extract first {…} →
// strip markdown fences → error.

function tolerantParse(text) {
  // 1. Direct JSON parse
  try { return { text }; } catch {}
  // 2. Strip markdown fences
  const fenced = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  try { JSON.parse(fenced); return { text: fenced }; } catch {}
  // 3. Extract first balanced {...}
  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { const candidate = text.slice(start, i + 1); try { JSON.parse(candidate); return { text: candidate }; } catch {} break; } }
    }
  }
  return { error: 'The model answered with something unreadable — try again or switch to a cloud provider.' };
}

async function testKey({ apiKey, baseUrl }) {
  if (!baseUrl) return { ok: false, error: 'Enter a base URL first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    // Many local servers don't implement /models — try a tiny completion
    const res2 = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    });
    return res2.status < 500 ? { ok: true } : { ok: false, error: `Server error (${res2.status}) — is the local server running?` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out — is the local server running?' : `Could not reach ${baseUrl} — is it running?` };
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ apiKey, baseUrl, model, system, prompt, schema, maxTokens, signal }) {
  if (!baseUrl) return { error: 'No base URL configured — check Settings.' };
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system + (schema ? '\n\nRespond with valid JSON matching the requested schema.' : '') },
      { role: 'user',   content: prompt },
    ],
  };
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return { error: `Local server error (${res.status}) — try again.` };
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const u = data.usage || {};
    const result = schema ? tolerantParse(raw) : { text: raw };
    if (result.error) return result;
    return { text: result.text, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for local server.' : `Could not reach ${baseUrl} — is it running?` };
  }
}

module.exports = { id: 'local', label: 'Local / OpenAI-compatible', needsBaseUrl: true, keyEnv: [], models: [], testKey, generate };
```

- [ ] **Step 4: Register in `lib/advisors/index.js`**

```js
'use strict';
const anthropic = require('./anthropic');
const openai    = require('./openai');
const google    = require('./google');
const local     = require('./openai-compatible');
const ADAPTERS = [anthropic, openai, google, local];
const BY_ID = Object.fromEntries(ADAPTERS.map(a => [a.id, a]));
module.exports = {
  byId: id => BY_ID[id] || null,
  list: () => ADAPTERS.slice(),
  register: adapter => { ADAPTERS.push(adapter); BY_ID[adapter.id] = adapter; },
};
```

- [ ] **Step 5: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|local adapter" | head -10
```

- [ ] **Step 6: Commit**

```bash
git add lib/advisors/openai-compatible.js lib/advisors/index.js test/run-tests.js
git commit -m "feat: local/OpenAI-compatible advisor adapter with tolerant JSON parse"
```

---

### Task 5: Refactor `lib/advisor.js` as orchestrator + lazy config migration

**Files:**
- Modify: `lib/advisor.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

Add to the advisor test section in `test/run-tests.js`:

```js
check('getAdvisorConfig: lazy migration from legacy advisor.apiKey', () => {
  const { getAdvisorConfig } = require('../lib/advisor');
  // Legacy shape — no providers key
  const cfg = getAdvisorConfig({ advisor: { apiKey: 'sk-legacy', model: 'claude-haiku-4-5' } });
  assert.strictEqual(cfg.provider, 'anthropic');
  assert.strictEqual(cfg.apiKey, 'sk-legacy');
  assert.strictEqual(cfg.model, 'claude-haiku-4-5');
  assert.strictEqual(cfg.source, 'config');
});

check('getAdvisorConfig: new provider shape reads providers sub-key', () => {
  const { getAdvisorConfig } = require('../lib/advisor');
  const cfg = getAdvisorConfig({ advisor: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    providers: { openai: { apiKey: 'sk-oai' } },
  }});
  assert.strictEqual(cfg.provider, 'openai');
  assert.strictEqual(cfg.apiKey, 'sk-oai');
  assert.strictEqual(cfg.model, 'gpt-4o-mini');
});

check('getAdvisorConfig: local provider reads baseUrl from providers', () => {
  const { getAdvisorConfig } = require('../lib/advisor');
  const cfg = getAdvisorConfig({ advisor: {
    provider: 'local',
    model: 'llama3.1',
    providers: { local: { baseUrl: 'http://localhost:11434/v1', apiKey: '' } },
  }});
  assert.strictEqual(cfg.provider, 'local');
  assert.strictEqual(cfg.baseUrl, 'http://localhost:11434/v1');
  assert.strictEqual(cfg.model, 'llama3.1');
});

check('getAdvisorConfig: env fallback ANTHROPIC_API_KEY when no config key', () => {
  const { getAdvisorConfig } = require('../lib/advisor');
  process.env.ANTHROPIC_API_KEY = 'env-key';
  const cfg = getAdvisorConfig({});
  assert.strictEqual(cfg.apiKey, 'env-key');
  assert.strictEqual(cfg.source, 'env');
  delete process.env.ANTHROPIC_API_KEY;
});

check('getAdvisorConfig: estimateCost falls back to no-estimate for local', () => {
  const advisor = require('../lib/advisor');
  // local has no model pricing → estimateCost returns null
  const cfg = advisor.getAdvisorConfig({ advisor: { provider: 'local', model: 'llama3', providers: { local: { baseUrl: 'http://localhost:11434/v1' } } }});
  const cost = advisor.estimateCost(cfg, 'hello world prompt');
  assert.strictEqual(cost, null, 'local provider should return null cost estimate');
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Rewrite `lib/advisor.js`**

Replace the file entirely. The new file keeps the same exports (`generatePlan`, `generateBriefing`, `testKey`, `estimateCost`, `actualCost`, `getAdvisorConfig`, `buildPlanPrompt`, `buildBriefingPrompt`) but routes through adapters. The public function signatures change slightly: `generatePlan(adv, payload)` and `generateBriefing(adv, payload)` now take the full `adv` config object; `testKey(adv)` similarly. `server.js` callers are updated in Task 6.

```js
'use strict';
const advisors = require('./advisors/index');

const PLAN_MAX_TOKENS     = 4000;
const BRIEFING_MAX_TOKENS = 1200;
const EXPECTED_OUTPUT_TOKENS = 1500;

// Still exported for callers that read the model list. These are the
// Anthropic models; the full list per provider is on each adapter.
const PLANNER_MODELS = advisors.byId('anthropic').models;
const DEFAULT_MODEL  = PLANNER_MODELS[0].id;

// ── config ──────────────────────────────────────────────────────────────────

function envKey(adapter) {
  for (const k of (adapter.keyEnv || [])) {
    if (process.env[k]) return process.env[k];
  }
  return '';
}

function getAdvisorConfig(config) {
  const adv     = (config && config.advisor) || {};
  const hasNew  = adv.providers && typeof adv.providers === 'object';
  const provider = adv.provider || 'anthropic';
  const adapter  = advisors.byId(provider) || advisors.byId('anthropic');

  let apiKey, baseUrl, source;
  if (hasNew) {
    const pConf = (adv.providers[provider] || {});
    apiKey  = pConf.apiKey  || '';
    baseUrl = pConf.baseUrl || null;
    source  = pConf.apiKey ? 'config' : (envKey(adapter) ? 'env' : null);
    if (!apiKey) apiKey = envKey(adapter);
  } else {
    // Legacy: advisor.apiKey / advisor.model only (Anthropic implicit)
    apiKey  = adv.apiKey || '';
    baseUrl = null;
    source  = adv.apiKey ? 'config' : (process.env.ANTHROPIC_API_KEY ? 'env' : null);
    if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY || '';
  }

  // Validate model against adapter catalog (local: any non-empty id is ok)
  const model = (() => {
    const m = adv.model || '';
    if (provider === 'local') return m || 'llama3.1';
    return adapter.models.some(x => x.id === m) ? m : (adapter.models[0]?.id || DEFAULT_MODEL);
  })();

  return { provider, model, apiKey, baseUrl, source, adapter };
}

// ── cost ────────────────────────────────────────────────────────────────────

function estimateCost(adv, promptText) {
  const adapter = adv.adapter || advisors.byId(adv.provider) || advisors.byId('anthropic');
  if (!adapter.models.length) return null; // local — no pricing
  const modelMeta = adapter.models.find(m => m.id === adv.model) || adapter.models[0];
  const inTokens  = Math.ceil((String(promptText).length + PLAN_SYSTEM.length) / 4);
  return (inTokens * modelMeta.priceIn + EXPECTED_OUTPUT_TOKENS * modelMeta.priceOut) / 1e6;
}

function actualCost(adv, usage) {
  const adapter = adv.adapter || advisors.byId(adv.provider) || advisors.byId('anthropic');
  if (!adapter.models.length) return null;
  const modelMeta = adapter.models.find(m => m.id === adv.model) || adapter.models[0];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTok * modelMeta.priceIn + (usage.output_tokens || 0) * modelMeta.priceOut) / 1e6;
}

// ── prompt builders (unchanged) ──────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One short paragraph: where this project stands right now.' },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'A concrete action on this project.' },
                why: { type: 'string', description: 'One line on why this task matters.' },
                model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable', 'codex-check'] },
                model_reason: { type: 'string', description: 'One line on why this model tier fits.' },
                size: { type: 'string', enum: ['S', 'M', 'L'] },
              },
              required: ['task', 'why', 'model', 'model_reason', 'size'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'tasks'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' }, description: 'Decisions only the developer can make.' },
  },
  required: ['summary', 'phases', 'risks', 'questions'],
  additionalProperties: false,
};

const PLAN_SYSTEM = `You are MemBridge's planning advisor. You turn a developer's goal, plus a digest of recent AI-assisted work in their project, into a practical phased roadmap they will execute with AI coding tools.

Model routing — assign each task the cheapest model tier that can genuinely do it:
- haiku: mechanical or small edits, boilerplate, renames, config, simple scripts
- sonnet: standard features, tests, docs, straightforward endpoints and UI
- opus: debugging, architecture, tricky integration, large refactors
- fable: ambiguous frontier work, novel design, long-horizon autonomous runs
- codex-check: an independent second opinion on completed work from a different vendor's model
When unsure, recommend starting cheap and escalating on failure — never the reverse.

Keep it concrete and grounded in the recent-work digest: 2-4 phases in build order, 3-6 tasks each, phrased as actions on this specific project. summary is one short paragraph on where the project stands. questions are decisions only the developer can make — never questions you could answer yourself. risks are short and real, not generic.`;

const BRIEFING_SYSTEM = `You are MemBridge's catch-up briefer. You read a digest of what a developer's teammates did with AI coding tools since the developer last looked, and you write a short, skimmable briefing that gets them caught up fast.

Write 2-4 short paragraphs or tight bullets in plain language. Lead with what matters most. Name the teammate and the project they touched, and group related work. Ground every claim in the digest — never invent activity that is not there; if the digest is thin, say so in one line. No preamble and no sign-off — just the briefing.`;

function buildPlanPrompt(payload) {
  const lines = [`Project: ${payload.projectName}`];
  if (payload.topLevel?.length) lines.push(`Top-level files and folders: ${payload.topLevel.join(', ')}`);
  if (payload.recentAsks?.length) {
    lines.push('', 'Recent AI-assisted work (oldest first):');
    for (const e of payload.recentAsks) {
      lines.push(`- ${e.ts} · ${e.source}: ${e.ask || ''}${e.files?.length ? ` [files: ${e.files.join(', ')}]` : ''}`);
    }
  } else {
    lines.push('', 'No AI activity captured in this project yet.');
  }
  lines.push('', `The developer's goal: ${payload.goal}`);
  return lines.join('\n');
}

function buildBriefingPrompt(payload) {
  const lines = [];
  if (payload.since) lines.push(`Window: since ${payload.since}${payload.until ? ` until ${payload.until}` : ''}.`);
  if (!payload.teammates?.length) { lines.push('No teammate activity was captured in this window.'); return lines.join('\n'); }
  lines.push('', 'Recent teammate activity (grouped by teammate, oldest first):', '');
  for (const t of payload.teammates) {
    lines.push(`## ${t.name}`);
    for (const e of t.entries || []) {
      lines.push(`- ${e.ts} · ${e.source}${e.project ? ` · ${e.project}` : ''}: ${e.summary || e.ask || ''}${e.files?.length ? ` [files: ${e.files.join(', ')}]` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ── generation ───────────────────────────────────────────────────────────────

async function generatePlan(adv, payload) {
  if (!adv.apiKey && adv.provider !== 'local') {
    return { ok: false, status: 400, error: `Add your ${adv.adapter?.label || 'provider'} key in Settings first.` };
  }
  if (adv.provider === 'local' && !adv.baseUrl) {
    return { ok: false, status: 400, error: 'Add a local server base URL in Settings first.' };
  }
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await adv.adapter.generate({
      apiKey: adv.apiKey, baseUrl: adv.baseUrl, model: adv.model,
      system: PLAN_SYSTEM, prompt: buildPlanPrompt(payload),
      schema: PLAN_SCHEMA, maxTokens: PLAN_MAX_TOKENS, signal: ctrl.signal,
    });
    if (r.error) return { ok: false, status: 502, error: r.error };
    let plan;
    try { plan = JSON.parse(r.text); } catch { return { ok: false, status: 502, error: 'The model answered with something unreadable — try again.' }; }
    return { ok: true, plan, model: adv.model, usage: r.usage, costUsd: actualCost(adv, r.usage) };
  } catch (err) {
    return { ok: false, status: 504, error: err.name === 'AbortError' ? 'Timed out — try again.' : 'Could not reach the provider — are you online?' };
  } finally {
    clearTimeout(timer);
  }
}

async function generateBriefing(adv, payload) {
  if (!adv.apiKey && adv.provider !== 'local') return { error: `Add your ${adv.adapter?.label || 'provider'} key in Settings first.` };
  if (adv.provider === 'local' && !adv.baseUrl) return { error: 'Add a local server base URL in Settings first.' };
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await adv.adapter.generate({
      apiKey: adv.apiKey, baseUrl: adv.baseUrl, model: adv.model,
      system: BRIEFING_SYSTEM, prompt: buildBriefingPrompt(payload),
      schema: null, maxTokens: BRIEFING_MAX_TOKENS, signal: ctrl.signal,
    });
    if (r.error) return { error: r.error };
    if (!r.text.trim()) return { error: 'The model returned an empty briefing — try again.' };
    return { text: r.text.trim() };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out — try again.' : 'Could not reach the provider — are you online?' };
  } finally {
    clearTimeout(timer);
  }
}

async function testKey(adv) {
  return adv.adapter.testKey({ apiKey: adv.apiKey, baseUrl: adv.baseUrl });
}

module.exports = {
  PLANNER_MODELS, DEFAULT_MODEL, PLAN_SCHEMA, PLAN_SYSTEM, BRIEFING_SYSTEM,
  getAdvisorConfig, estimateCost, actualCost,
  buildPlanPrompt, buildBriefingPrompt,
  generatePlan, generateBriefing, testKey,
  // Back-compat: server.js still reads PRICES for nothing — omit; apiBase removed
};
```

- [ ] **Step 4: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|getAdvisorConfig|estimateCost" | head -15
```

Expected: new config tests pass; existing advisor tests may need updating in Task 6.

- [ ] **Step 5: Commit**

```bash
git add lib/advisor.js test/run-tests.js
git commit -m "refactor: advisor.js becomes orchestrator, routes generate/testKey to adapter"
```

---

### Task 6: Update `lib/server.js` advisor endpoints

The existing `/api/settings` GET/POST and `/api/settings/test` must keep working. We add `GET /api/advisor`, `POST /api/advisor`, and `POST /api/advisor/test-key`. The existing `/api/plan/generate` and `/api/briefing/generate` callers update to pass `adv` (object) instead of `adv.apiKey, adv.model`.

**Files:**
- Modify: `lib/server.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

```js
check('GET /api/advisor returns provider list with keySet bool, no key values', async () => {
  const r = await fetch(`${base}/api/advisor`);
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.ok(d.provider, 'provider missing');
  assert.ok(Array.isArray(d.providers), 'providers array missing');
  const ant = d.providers.find(p => p.id === 'anthropic');
  assert.ok(ant, 'anthropic missing from providers list');
  assert.ok('keySet' in ant, 'keySet missing');
  assert.ok(!('apiKey' in ant), 'apiKey must not be returned');
});

check('POST /api/advisor sets provider and model', async () => {
  const r = await fetch(`${base}/api/advisor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: GOOD_KEY }),
  });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.ok(d.ok);
});

check('POST /api/advisor/test-key routes to adapter testKey', async () => {
  // First set a good key
  await fetch(`${base}/api/advisor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'anthropic', apiKey: GOOD_KEY }) });
  const r = await fetch(`${base}/api/advisor/test-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'anthropic' }),
  });
  const d = await r.json();
  assert.ok(d.ok, `test-key failed: ${d.error}`);
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Update `settingsPayload()` in server.js**

Replace the advisor section of `settingsPayload()`:

```js
function settingsPayload() {
  const config = getConfig();
  const raw = loadUserConfig();
  const adv = advisor.getAdvisorConfig(config);
  const team = raw.team && typeof raw.team === 'object' ? raw.team : {};
  const advisorProviders = advisors.list().map(a => {
    const pConf = ((raw.advisor && raw.advisor.providers) || {})[a.id] || {};
    return {
      id: a.id,
      label: a.label,
      needsBaseUrl: a.needsBaseUrl,
      models: a.models,
      keySet: !!(pConf.apiKey || (a.keyEnv || []).some(e => process.env[e])),
      baseUrl: a.needsBaseUrl ? (pConf.baseUrl || '') : undefined,
    };
  });
  return {
    hasKey: !!adv.apiKey,
    keySource: adv.source,
    keyHint: adv.source === 'config' ? `…${adv.apiKey.slice(-4)}` : '',
    model: adv.model,
    models: advisor.PLANNER_MODELS,   // back-compat for existing UI; full list is in providers
    provider: adv.provider,
    providers: advisorProviders,
    intervalSec: config.intervalSec,
    targets: config.targets,
    extraTargets: config.extraTargets,
    extraTargetFiles: EXTRA_TARGETS,
    hookInstalled: hooks.isHookInstalled(),
    distill: { enabled: config.distill.enabled, consent: config.distill.consent, minEdits: config.distill.minEdits, checkpointEvery: config.distill.checkpointEvery },
    team: { url: String(team.url || ''), anonKey: String(team.anonKey || ''), customBackend: !!(team.url && team.anonKey) },
  };
}
```

Add `const advisors = require('./advisors/index');` to the top of `lib/server.js` (alongside the existing `const advisor = require('./advisor');`).

- [ ] **Step 4: Update `saveSettings()` to write new advisor shape**

In `saveSettings(body)`, replace:
```js
  if (body.apiKey !== undefined) {
    raw.advisor = raw.advisor || {};
    raw.advisor.apiKey = String(body.apiKey || '').trim();
  }
  if (body.model !== undefined && advisor.PLANNER_MODELS.some(m => m.id === body.model)) {
    raw.advisor = raw.advisor || {};
    raw.advisor.model = body.model;
  }
```
with:
```js
  // Provider/model/key — also accept legacy body.apiKey path for back-compat.
  if (body.provider !== undefined || body.model !== undefined || body.apiKey !== undefined || body.baseUrl !== undefined) {
    raw.advisor = raw.advisor || {};
    const prov = String(body.provider || raw.advisor.provider || 'anthropic');
    const adapterForProv = advisors.byId(prov) || advisors.byId('anthropic');
    if (body.provider !== undefined) raw.advisor.provider = prov;
    if (body.model !== undefined) {
      const isValid = prov === 'local' ? !!String(body.model).trim() : adapterForProv.models.some(m => m.id === body.model);
      if (isValid) raw.advisor.model = String(body.model).trim();
    }
    if (body.apiKey !== undefined || body.baseUrl !== undefined) {
      raw.advisor.providers = raw.advisor.providers || {};
      raw.advisor.providers[prov] = raw.advisor.providers[prov] || {};
      if (body.apiKey !== undefined) raw.advisor.providers[prov].apiKey = String(body.apiKey || '').trim();
      if (body.baseUrl !== undefined) raw.advisor.providers[prov].baseUrl = String(body.baseUrl || '').trim();
    }
  }
```

- [ ] **Step 5: Add `GET /api/advisor`, `POST /api/advisor`, `POST /api/advisor/test-key` to the route handler**

In the big `if/else if` block in `handle()`, add before the final `json(res, 404, ...)`:

```js
    } else if (req.method === 'GET' && url.pathname === '/api/advisor') {
      const config = getConfig();
      const raw = loadUserConfig();
      const adv = advisor.getAdvisorConfig(config);
      const providers = advisors.list().map(a => {
        const pConf = ((raw.advisor && raw.advisor.providers) || {})[a.id] || {};
        return { id: a.id, label: a.label, needsBaseUrl: a.needsBaseUrl, models: a.models,
          keySet: !!(pConf.apiKey || (a.keyEnv || []).some(e => process.env[e])),
          baseUrl: a.needsBaseUrl ? (pConf.baseUrl || '') : undefined };
      });
      json(res, 200, { provider: adv.provider, model: adv.model, providers });
    } else if (req.method === 'POST' && url.pathname === '/api/advisor') {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...saveSettings(body) });
    } else if (req.method === 'POST' && url.pathname === '/api/advisor/test-key') {
      const body = await readBody(req);
      const prov = String(body.provider || 'anthropic');
      const config = getConfig();
      const adv = advisor.getAdvisorConfig(config);
      // If testing a different provider, resolve its key from config/env
      const targetAdv = adv.provider === prov ? adv : (() => {
        const raw = loadUserConfig();
        const pConf = ((raw.advisor && raw.advisor.providers) || {})[prov] || {};
        const a = advisors.byId(prov) || advisors.byId('anthropic');
        const envK = (a.keyEnv || []).reduce((found, k) => found || process.env[k] || '', '');
        return { ...adv, provider: prov, apiKey: pConf.apiKey || envK, baseUrl: pConf.baseUrl || null, adapter: a };
      })();
      json(res, 200, await advisor.testKey(targetAdv));
```

- [ ] **Step 6: Update callers of `generatePlan` and `generateBriefing` in server.js**

Find and replace the two generation call sites:

For `/api/plan/generate` (around line 943):
```js
      const adv = advisor.getAdvisorConfig(config);
      if (!adv.apiKey && adv.provider !== 'local') return json(res, 400, { error: `Add your ${adv.adapter.label} key in Settings first.` });
      const payload = planPayload(key, proj, config, goal);
      const r = await advisor.generatePlan(adv, payload);
```

For `/api/briefing/generate` (around line 970):
```js
      const adv = advisor.getAdvisorConfig(config);
      if (!adv.apiKey && adv.provider !== 'local') return json(res, 200, { degraded: true });
      // ...
      const r = await advisor.generateBriefing(adv, { since, until: now, teammates });
```

Also update `/api/settings/test` (around line 746):
```js
    } else if (req.method === 'POST' && url.pathname === '/api/settings/test') {
      const body = await readBody(req);
      const config = getConfig();
      const adv = advisor.getAdvisorConfig(config);
      const pastedKey = String(body.apiKey || '').trim();
      const testAdv = pastedKey ? { ...adv, apiKey: pastedKey } : adv;
      json(res, 200, await advisor.testKey(testAdv));
```

- [ ] **Step 7: Run full test suite**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|api/advisor" | head -20
```

Expected: advisor endpoint tests pass; no regressions in existing tests.

- [ ] **Step 8: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: multi-provider advisor API endpoints (GET/POST /api/advisor, test-key)"
```

---

### Task 7: Update `lib/dashboard.js` Settings UI for provider selector

**Files:**
- Modify: `lib/dashboard.js`
- Modify: `test/run-tests.js` (HTML checks)

- [ ] **Step 1: Write failing HTML-presence tests**

```js
check('dashboard settings UI has provider selector and provider-aware key field', () => {
  assert.ok(pageHtml.includes('data-adv-provider'), 'provider selector missing');
  assert.ok(pageHtml.includes('/api/advisor'), 'advisor endpoint missing from settings');
  assert.ok(pageHtml.includes('data-adv-key'), 'provider key input missing');
  assert.ok(pageHtml.includes('data-adv-test'), 'test button missing');
  assert.ok(pageHtml.includes('data-adv-baseurl') || pageHtml.includes('base URL'), 'base URL field for local missing');
});
```

(Add these to the dashboard HTML checks block that already checks for `view-home`, etc.)

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL.*provider" | head -5
```

- [ ] **Step 3: Replace `settingsKeySection()` in `lib/dashboard.js`**

Find the function `settingsKeySection()` (around line 3392) and replace it:

```js
function settingsKeySection() {
  var lbl = '<div style="' + STLABEL + '">AI briefings &amp; roadmaps</div>';
  var s = stSettings || {};
  var provider = s.provider || 'anthropic';
  var providers = Array.isArray(s.providers) ? s.providers : [];
  var currentP = providers.find(function (p) { return p.id === provider; }) || { id: provider, label: 'Anthropic (Claude)', models: [], keySet: false, needsBaseUrl: false };
  var models = currentP.models || [];
  var currentModel = s.model || (models[0] && models[0].id) || '';
  var keySet = !!currentP.keySet;
  var keyStatus = keySet ? 'active' : 'no key';
  var keyStatusColor = keySet ? 'var(--green)' : 'var(--text3)';

  var providerOptions = providers.map(function (p) {
    return '<option value="' + esc(p.id) + '"' + (p.id === provider ? ' selected' : '') + '>' + esc(p.label) + '</option>';
  }).join('');

  var modelOptions = provider === 'local'
    ? '<input data-adv-model type="text" placeholder="llama3.1" value="' + esc(currentModel) + '" style="flex:1;height:36px;padding:0 11px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;outline:none" />'
    : '<select data-adv-model style="flex:1;height:36px;padding:0 11px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;outline:none">' +
        models.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === currentModel ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('') +
      '</select>';

  var baseUrlField = currentP.needsBaseUrl
    ? '<div style="margin-top:8px"><input data-adv-baseurl type="text" placeholder="http://localhost:11434/v1" value="' + esc(currentP.baseUrl || '') + '" spellcheck="false" autocomplete="off" style="width:100%;box-sizing:border-box;height:36px;padding:0 11px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:monospace;font-size:12px;outline:none" /></div>'
    : '';

  return lbl +
    '<div style="' + STCARD + ';margin-bottom:34px;padding:16px 18px">' +
      '<div style="font-size:13px;color:var(--text2);margin-bottom:12px">Bring your own key. Used only to write your briefing and roadmaps &mdash; session memories never leave your team&rsquo;s sync.</div>' +
      '<div style="margin-bottom:10px">' +
        '<select data-adv-provider style="width:100%;height:36px;padding:0 11px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none">' +
          providerOptions +
        '</select>' +
      '</div>' +
      '<div style="display:flex;gap:9px;align-items:center">' +
        (currentP.needsBaseUrl
          ? '<input data-adv-key type="password" placeholder="API key (optional for local)" spellcheck="false" autocomplete="off" style="flex:1;height:44px;padding:0 13px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:monospace;font-size:12px;outline:none" />'
          : '<input data-adv-key type="password" placeholder="Paste your API key&hellip;" spellcheck="false" autocomplete="off" style="flex:1;height:44px;padding:0 13px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:monospace;font-size:12px;outline:none" />') +
        '<button data-adv-test style="flex:none;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text2);font-size:12px;cursor:pointer">Test</button>' +
        '<span id="stKeyStatus" style="font-family:monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:' + keyStatusColor + ';font-weight:500;flex:none">' + keyStatus + '</span>' +
      '</div>' +
      baseUrlField +
      '<div style="margin-top:10px;display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:12px;color:var(--text3)">Model:</span>' + modelOptions +
      '</div>' +
      '<div id="stKeyHint" style="font-size:11.5px;color:var(--text3);margin-top:9px">Clear the key to use only local access &mdash; headlines and project state still work.</div>' +
    '</div>';
}
```

- [ ] **Step 4: Add delegated event handlers for the new provider-aware settings**

In the `settingsRoot` event listeners block, add handling for `data-adv-provider`, `data-adv-key`, `data-adv-test`, `data-adv-model`, `data-adv-baseurl`. Replace the existing `data-st-key` change handler with a new `data-adv-key` flow, and add handlers for the new elements:

```js
  // Provider selector — reload settings UI for new provider
  settingsRoot.addEventListener('change', function (e) {
    var sel = e.target.closest('[data-adv-provider]');
    if (!sel) return;
    var prov = sel.value;
    fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: prov }) })
      .then(function () { loadSettings(); }).catch(function () {});
  });
  // Model change
  settingsRoot.addEventListener('change', function (e) {
    var el = e.target.closest('[data-adv-model]');
    if (!el) return;
    fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: el.value }) })
      .then(function () { loadSettings(); }).catch(function () {});
  });
  // Base URL change (local provider)
  settingsRoot.addEventListener('change', function (e) {
    var el = e.target.closest('[data-adv-baseurl]');
    if (!el) return;
    fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: el.value.trim() }) })
      .then(function () {}).catch(function () {});
  });
  // API key paste — test then save
  settingsRoot.addEventListener('change', function (e) {
    var input = e.target.closest('[data-adv-key]');
    if (!input) return;
    var v = input.value.trim();
    var status = document.getElementById('stKeyStatus');
    if (!v) {
      fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) })
        .then(function () { loadSettings(); }).catch(function () {});
      return;
    }
    if (status) { status.textContent = 'testing'; status.style.color = 'var(--text3)'; }
    fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: v }) })
      .then(function () {
        return fetch('/api/advisor/test-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: (stSettings && stSettings.provider) || 'anthropic' }) });
      })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (status) { status.textContent = d.ok ? 'active' : 'invalid'; status.style.color = d.ok ? 'var(--green)' : '#DC2626'; }
        if (d.ok) { input.value = ''; loadSettings(); }
      }).catch(function () { if (status) { status.textContent = 'error'; status.style.color = '#DC2626'; } });
  });
  // Test button
  settingsRoot.addEventListener('click', function (e) {
    if (!e.target.closest('[data-adv-test]')) return;
    var status = document.getElementById('stKeyStatus');
    if (status) { status.textContent = 'testing'; status.style.color = 'var(--text3)'; }
    var provider = stSettings && stSettings.provider || 'anthropic';
    fetch('/api/advisor/test-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (status) { status.textContent = d.ok ? 'active' : (d.error || 'invalid'); status.style.color = d.ok ? 'var(--green)' : '#DC2626'; }
      }).catch(function () { if (status) { status.textContent = 'error'; status.style.color = '#DC2626'; } });
  });
```

Also update the places in dashboard.js where "Add your Anthropic key" is hard-coded — make them provider-aware:

Find `'add an API key'` references near the roadmap "noKey" guard and `'Add your Anthropic key in'` and replace with a dynamic version using `stSettings && stSettings.provider` to pick the right label.

- [ ] **Step 5: Run tests**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|provider selector" | head -10
```

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "feat: multi-provider advisor settings UI (provider selector, key field, model picker)"
```

---

## PART B — Per-Session Prompt Sharing

### Task 8: `isShared` helper + update `pushProject` in teamsync.js

**Files:**
- Modify: `lib/teamsync.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

```js
check('isShared: default off when sharedSessions absent', () => {
  const ts = require('../lib/teamsync');
  assert.ok(!ts.isShared({}, 'sess-1'), 'should be unshared by default');
  assert.ok(!ts.isShared({ sharedSessions: [] }, 'sess-1'), 'empty array = not shared');
});

check('isShared: per-session flag is authoritative', () => {
  const ts = require('../lib/teamsync');
  assert.ok(ts.isShared({ sharedSessions: ['sess-1'] }, 'sess-1'), 'should be shared');
  assert.ok(!ts.isShared({ sharedSessions: ['sess-1'] }, 'sess-2'), 'other session not shared');
});

check('isShared: legacy sharePrompts fallback when sharedSessions absent entirely', () => {
  const ts = require('../lib/teamsync');
  // Legacy: global sharePrompts true, sharedSessions not set at all
  assert.ok(ts.isShared({ sharePrompts: true }, 'any-sess'), 'legacy fallback: should be shared');
  // Legacy overridden once sharedSessions exists (even empty)
  assert.ok(!ts.isShared({ sharePrompts: true, sharedSessions: [] }, 'any-sess'), 'sharedSessions present = legacy ignored');
});

check('isShared: null session is never individually shareable', () => {
  const ts = require('../lib/teamsync');
  assert.ok(!ts.isShared({ sharedSessions: ['null'] }, null), 'null session should not match');
});

check('pushProject: ask/goal null for unshared sessions, scrubbed for shared', async () => {
  const ts = require('../lib/teamsync');
  const mb = require('../lib/memorydb');
  // Build a minimal in-memory project with two sessions
  const proj = {
    events: [
      { ts: '2026-07-21T00:00:00.000Z', source: 'Claude Code', ask: 'Build auth', goal: 'Login page', session: 'sess-private', files: [] },
      { ts: '2026-07-21T00:01:00.000Z', source: 'Claude Code', ask: 'Fix bug', goal: 'Fix payment', session: 'sess-public',  files: [] },
    ],
    sharedSessions: ['sess-public'],
    teamPushTs: '',
  };
  const capturedRows = [];
  // Monkey-patch rest to capture rows
  const orig = ts.__testExportRest;  // see Step 3 for __testExportRest
  // We use the mock supabase pattern instead
  const { createMockSupabase } = require('./mock-supabase');
  const mockSb = createMockSupabase();
  // Override config to use mock
  const config = { team: { url: mockSb.url, anonKey: mockSb.anonKey }, advisor: {}, targets: [proj1], intervalSec: 3600, distill: { enabled: false }, redact: [] };
  const link = { projectId: 'proj-uuid-1', teamId: 'team-uuid-1' };
  const creds = { userId: 'user-1', accessToken: 'token', displayName: 'Marco' };
  await ts.pushProject(config, creds, proj1, proj, link, null);
  const rows = mockSb.getInserted('memory_entries');
  const priv = rows.find(r => r.session === 'sess-private');
  const pub  = rows.find(r => r.session === 'sess-public');
  assert.ok(priv, 'private session row missing');
  assert.ok(pub, 'public session row missing');
  assert.strictEqual(priv.ask, null, 'private session ask should be null');
  assert.ok(pub.ask, 'public session ask should be set');
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Add `isShared` to `lib/teamsync.js` and update `pushProject`**

Add after the existing imports in `lib/teamsync.js`:

```js
// isShared: single source of truth for whether a session's verbatim prompts
// are shared with the team. sharedSessions is authoritative; the legacy global
// sharePrompts flag acts as a fallback only when sharedSessions is absent
// entirely (i.e. the user has never touched a per-session toggle).
function isShared(proj, sessionId) {
  if (!sessionId) return false;
  const ss = proj && proj.sharedSessions;
  if (Array.isArray(ss)) return ss.includes(sessionId);
  // Legacy fallback: no per-session array yet, honor old global flag
  return !!(proj && proj.sharePrompts);
}
```

In `pushProject`, replace line 568:
```js
  const share = ((config && config.team) || {}).sharePrompts === true;
```
with (no new variable needed — the map uses `isShared` per entry):
```js
  // share is now per-entry (see isShared call in the map below)
```

And in the `plainRows` map (line 571), change:
```js
      ask:  share ? scrub(e.ask, 400)  : null,
      goal: share ? scrub(e.goal, 200) : null,
```
to:
```js
      ask:  isShared(proj, e.session) ? scrub(e.ask, 400)  : null,
      goal: isShared(proj, e.session) ? scrub(e.goal, 200) : null,
```

Export `isShared` from `module.exports` at the bottom of `lib/teamsync.js`.

- [ ] **Step 4: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|isShared|pushProject.*session" | head -15
```

- [ ] **Step 5: Commit**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat: isShared helper + per-session pushProject prompt gating"
```

---

### Task 9: `resharePromptsForSession` in teamsync.js

**Files:**
- Modify: `lib/teamsync.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

```js
check('resharePromptsForSession: backfill sets ask/goal for shared session', async () => {
  const ts = require('../lib/teamsync');
  const { createMockSupabase } = require('./mock-supabase');
  const mockSb = createMockSupabase();
  const config = { team: { url: mockSb.url, anonKey: mockSb.anonKey }, advisor: {}, targets: [proj1], intervalSec: 3600, distill: { enabled: false }, redact: [] };
  const proj = {
    events: [
      { ts: '2026-07-21T00:05:00.000Z', source: 'Claude Code', ask: 'Build auth', goal: 'Login', session: 'sess-A', files: [] },
    ],
    sharedSessions: [],
    teamPushTs: '',
  };
  const link = { projectId: 'proj-uuid-2', teamId: 'team-uuid-2' };
  const creds = { userId: 'user-2', accessToken: 'tok', displayName: 'Test' };
  await ts.resharePromptsForSession(config, creds, proj1, proj, link, 'sess-A', true, null);
  const rows = mockSb.getUpserted('memory_entries');
  const row = rows.find(r => r.session === 'sess-A');
  assert.ok(row, 'row missing after reshare');
  assert.ok(row.ask, 'ask should be set after share=true');
});

check('resharePromptsForSession: scrub sets ask/goal null for unshared session', async () => {
  const ts = require('../lib/teamsync');
  const { createMockSupabase } = require('./mock-supabase');
  const mockSb = createMockSupabase();
  const config = { team: { url: mockSb.url, anonKey: mockSb.anonKey }, advisor: {}, targets: [proj1], intervalSec: 3600, distill: { enabled: false }, redact: [] };
  const proj = {
    events: [
      { ts: '2026-07-21T00:06:00.000Z', source: 'Claude Code', ask: 'Build auth', goal: 'Login', session: 'sess-B', files: [] },
    ],
    sharedSessions: ['sess-B'],
    teamPushTs: '',
  };
  const link = { projectId: 'proj-uuid-3', teamId: 'team-uuid-3' };
  const creds = { userId: 'user-3', accessToken: 'tok', displayName: 'Test' };
  await ts.resharePromptsForSession(config, creds, proj1, proj, link, 'sess-B', false, null);
  const rows = mockSb.getUpserted('memory_entries');
  const row = rows.find(r => r.session === 'sess-B');
  assert.ok(row, 'row missing after scrub');
  assert.strictEqual(row.ask, null, 'ask should be null after share=false');
});
```

Note: `createMockSupabase()` needs a `getUpserted(table)` method alongside `getInserted`. Check `test/mock-supabase.js` and add it if missing.

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Check `test/mock-supabase.js` and add `getUpserted` if missing**

Read `test/mock-supabase.js` and confirm there's a `getUpserted` (or `getInserted` for merge-duplicates upsert). Add if needed:

```js
// In createMockSupabase, track merge-duplicates upserts separately:
const upserted = {};
// In the POST handler, if Prefer header includes 'merge-duplicates':
//   upserted[tableName] = (upserted[tableName] || []).concat(rows);
// expose:
getUpserted: (table) => upserted[table] || [],
```

- [ ] **Step 4: Extract row-insert helper and add `resharePromptsForSession` in `lib/teamsync.js`**

First, extract the retry loop from `pushProject` into a shared helper `insertRows(config, creds, rows)`:

```js
async function insertRows(config, creds, rows, prefer) {
  let attempt = rows;
  for (;;) {
    try {
      await rest(config, creds, 'POST',
        'memory_entries?on_conflict=project_id,author_id,ts,source',
        attempt,
        { Prefer: prefer + ',return=minimal' });
      return;
    } catch (err) {
      const m = /'(summary|goal|decisions|gotchas|changes|ciphertext|nonce|key_epoch)' column/i.exec(err.message);
      if (!m) throw err;
      const drop = m[1];
      attempt = attempt.map(({ [drop]: _omit, ...bare }) => bare);
    }
  }
}
```

Update `pushProject` to call `insertRows(config, creds, rows, 'resolution=ignore-duplicates')` instead of the inline loop.

Then add:

```js
async function resharePromptsForSession(config, creds, projectPath, proj, link, sessionId, share, crypto) {
  const entries = memorydb.buildEntries(projectPath, proj, config)
    .filter(e => e.session === sessionId);
  if (!entries.length) return;
  const regexes = digest.compileRedactions(config);
  const scrub = (text, n) => (text ? digest.clip(digest.redactText(text, regexes), n) : text);
  const plainRows = entries.map(e => ({
    project_id:  link.projectId,
    author_id:   creds.userId,
    author_name: creds.displayName,
    ts:          e.ts,
    source:      e.source,
    session:     e.session || null,
    ask:         share ? scrub(e.ask, 400)  : null,
    goal:        share ? scrub(e.goal, 200) : null,
    decisions:   e.decisions ? scrub(e.decisions, 240) : null,
    gotchas:     e.gotchas   ? scrub(e.gotchas,   240) : null,
    files:       e.files,
    changes:     Array.isArray(e.changes) && e.changes.length ? e.changes.map(c => ({ ...c, note: scrub(c.note, 80) })) : null,
    summary:     e.summary ? scrub(e.summary, 300) : null,
  }));
  let rows = plainRows;
  if (crypto && crypto.teamKey) {
    try {
      rows = plainRows.map(r => encryptRow(r, crypto.teamKey, crypto.epoch, { teamcrypto: crypto.teamcrypto }));
    } catch {
      rows = plainRows;
    }
  }
  await insertRows(config, creds, rows, 'resolution=merge-duplicates');
}
```

Export `resharePromptsForSession` in `module.exports`.

- [ ] **Step 5: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|reshare" | head -10
```

- [ ] **Step 6: Commit**

```bash
git add lib/teamsync.js test/mock-supabase.js test/run-tests.js
git commit -m "feat: resharePromptsForSession for retroactive prompt backfill/scrub"
```

---

### Task 10: `POST /api/share-session` endpoint + `promptShared` in feed

**Files:**
- Modify: `lib/server.js`
- Modify: `lib/feed.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing tests**

```js
check('POST /api/share-session: updates sharedSessions and returns ok', async () => {
  // Need a project with a session to share
  const r = await fetch(`${base}/api/share-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: proj1, session: 'sess1', share: true }),
  });
  const d = await r.json();
  assert.ok(r.status === 200, `unexpected status ${r.status}`);
  assert.ok(d.ok, `share-session failed: ${JSON.stringify(d)}`);
});

check('GET /api/feed local entries include promptShared field', async () => {
  const r = await fetch(`${base}/api/feed?limit=10`);
  const d = await r.json();
  const local = (d.entries || []).filter(e => e.origin === 'local' && e.session);
  if (local.length > 0) {
    assert.ok('promptShared' in local[0], 'promptShared field missing from local entry');
  }
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL" | head -5
```

- [ ] **Step 3: Add `promptShared` to `lib/feed.js` normalizeLocal**

In `normalizeLocal`, add `promptShared` to the return object:

```js
    promptShared: !!(meta.sharedSessions && e.session && meta.sharedSessions.includes(e.session)),
```

This goes after the `cursor: null` line. Also add it to `normalizeTeam` as `promptShared: false` (team rows are never toggled by us).

- [ ] **Step 4: Update `feedPayload` in `lib/server.js` to inject `sharedSessions` into meta**

In `feedPayload`, update the meta construction:

```js
    const meta = {
      projectPath: key, projectName: path.basename(key),
      projectId: link ? link.projectId : null,
      authorId: selfUserId, redact,
      sharedSessions: Array.isArray(proj.sharedSessions) ? proj.sharedSessions : [],
    };
```

- [ ] **Step 5: Add `POST /api/share-session` route in `lib/server.js`**

```js
    } else if (req.method === 'POST' && url.pathname === '/api/share-session') {
      const body = await readBody(req);
      const projectPath = String(body.project || '').trim();
      const sessionId   = String(body.session  || '').trim();
      const share       = !!body.share;
      if (!projectPath || !sessionId) return json(res, 400, { error: 'project and session required' });
      const state = loadState();
      const key   = findProjectKey(state, projectPath);
      const proj  = key ? state.projects[key] : null;
      if (!proj) return json(res, 404, { error: 'unknown project' });
      // Update sharedSessions — persist flag first, reshare second
      const ss = Array.isArray(proj.sharedSessions) ? proj.sharedSessions.slice() : [];
      const idx = ss.indexOf(sessionId);
      if (share && idx === -1) ss.push(sessionId);
      else if (!share && idx !== -1) ss.splice(idx, 1);
      proj.sharedSessions = ss;
      saveState(state);
      // Attempt retroactive reshare (best-effort; local flag already saved)
      const link   = teamsync.loadTeamLink(key);
      const creds  = teamsync.loadCredentials();
      if (link && creds) {
        try {
          await teamsync.resharePromptsForSession(getConfig(), creds, key, proj, link, sessionId, share, null);
        } catch (err) {
          log(`share-session reshare error: ${err.message}`);
          return json(res, 200, { ok: true, warning: 'Saved locally but team sync failed — it will retry on next sync.' });
        }
      }
      json(res, 200, { ok: true });
```

- [ ] **Step 6: Run tests to confirm PASS**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL|share-session|promptShared" | head -10
```

- [ ] **Step 7: Commit**

```bash
git add lib/server.js lib/feed.js test/run-tests.js
git commit -m "feat: /api/share-session endpoint + promptShared field in local feed entries"
```

---

### Task 11: Dashboard toggle on self session cards

**Files:**
- Modify: `lib/dashboard.js`
- Modify: `test/run-tests.js`

- [ ] **Step 1: Write failing test**

```js
check('dashboard HTML has share-session toggle markup', () => {
  assert.ok(pageHtml.includes('data-share-session') || pageHtml.includes('share-session'), 'share-session toggle missing from dashboard');
  assert.ok(pageHtml.includes('Visible to team') || pageHtml.includes('Hidden from team'), 'share toggle label missing');
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep "FAIL.*share" | head -5
```

- [ ] **Step 3: Add toggle rendering in `threadHtml` in `lib/dashboard.js`**

In `threadHtml`, after building `kidsBlock` and before the closing `</article>`, add the share toggle for self entries with a session:

```js
  var shareToggle = '';
  if (newest.self && newest.session) {
    var shared = !!newest.promptShared;
    shareToggle = '<div style="display:flex;align-items:center;justify-content:flex-end;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">' +
      '<button data-share-session="' + esc(newest.session) + '" data-share-project="' + esc(newest.projectPath || '') + '" data-share-state="' + (shared ? '1' : '0') + '" ' +
        'style="display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;font-size:11.5px;color:' + (shared ? 'var(--accent)' : 'var(--text3)') + ';padding:2px 0;font-weight:500">' +
        (shared ? '&#10003; Visible to team' : '&#8212; Hidden from team') +
      '</button>' +
    '</div>';
  }
  return '<article style="border:0.5px solid var(--border);border-radius:14px;background:var(--card);padding:16px 18px;margin-bottom:14px">' + head + kidsBlock + shareToggle + '</article>';
```

- [ ] **Step 4: Add delegated click handler for `data-share-session`**

In the main feed `click` handler (the `homeRoot.addEventListener` block), add before the `data-card-toggle` check:

```js
    var shareBtn = e.target.closest('[data-share-session]');
    if (shareBtn) {
      e.stopPropagation();
      var sess    = shareBtn.getAttribute('data-share-session');
      var projP   = shareBtn.getAttribute('data-share-project');
      var current = shareBtn.getAttribute('data-share-state') === '1';
      var next    = !current;
      shareBtn.style.opacity = '0.4';
      fetch('/api/share-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projP, session: sess, share: next }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.ok) {
          shareBtn.setAttribute('data-share-state', next ? '1' : '0');
          shareBtn.style.color = next ? 'var(--accent)' : 'var(--text3)';
          shareBtn.innerHTML = next ? '&#10003; Visible to team' : '&#8212; Hidden from team';
        } else {
          shareBtn.style.opacity = '1'; // revert
        }
      }).catch(function () { shareBtn.style.opacity = '1'; });
      return;
    }
```

Do the same in the `pjRoot` and any other root that hosts feed cards (project page uses `pjRoot`).

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/marco/Documents/Membridge && node test/run-tests.js 2>&1 | grep -E "FAIL" | head -20
```

Expected: all tests pass. Fix any regressions before committing.

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "feat: per-session 'Visible to team' toggle on self feed cards"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Covered by |
|---|---|
| Provider adapter registry (`lib/advisors/`) | Tasks 1–4 |
| Anthropic adapter ports existing code | Task 1 |
| OpenAI Chat Completions + json_schema | Task 2 |
| Gemini generateContent + responseSchema | Task 3 |
| Local tolerant parse (fenced/extract/{}) | Task 4 |
| `testKey` per adapter | Tasks 1–4 |
| No vendor SDKs, raw fetch only | All adapters |
| `getAdvisorConfig` lazy migration from legacy shape | Task 5 |
| Env fallbacks per adapter `keyEnv` | Task 5 |
| Local: `needsBaseUrl`, any non-empty model id | Task 4, Task 5 |
| Cost: adapters carry `[priceIn, priceOut]`; local returns `null` | Tasks 1–4, Task 5 |
| `GET /api/advisor` — never leaks key values, only `keySet` | Task 6 |
| `POST /api/advisor` — validates model against catalog | Task 6 |
| `POST /api/advisor/test-key` | Task 6 |
| Settings UI: provider selector + key field + model dropdown + Test | Task 7 |
| Copy "Add your Anthropic key" made provider-aware | Task 7 |
| `isShared`: off by default, per-session authoritative, legacy fallback | Task 8 |
| `pushProject`: per-entry `isShared` check | Task 8 |
| `resharePromptsForSession`: backfill + scrub + encrypted + merge-duplicates upsert | Task 9 |
| Missing-column retry loop reused | Task 9 |
| `POST /api/share-session`: persist flag first, reshare second | Task 10 |
| `promptShared` field in local feed entries | Task 10 |
| Toggle: only on `self` cards with session id | Task 11 |
| Toggle reflects current `isShared` state | Task 11 |
| Optimistic update + revert on error | Task 11 |
| Sessions with no `session` id never togglable | Task 11 (check `newest.session`) |
| Legacy `sharePrompts` honored during deprecation window | Task 8 |

### Placeholder scan

No TBDs. All code blocks are complete or reference specific lines/functions to modify. Task 3 Step 4 (provider-aware "Add key" copy) defers the exact search to the implementer but specifies what to find and what to change it to — acceptable given the many hard-coded strings scattered across dashboard.js.

### Type consistency

- `adv` from `getAdvisorConfig` consistently carries `{ provider, model, apiKey, baseUrl, source, adapter }` — matched in Tasks 5, 6, and 7.
- `generate()` always returns `{ text, usage }` or `{ error }` — consistent across Tasks 1–4, consumed in Task 5.
- `isShared(proj, sessionId)` signature consistent across Tasks 8, 9, 10.
- `resharePromptsForSession(config, creds, projectPath, proj, link, sessionId, share, crypto)` — consistent Task 9 → Task 10.
