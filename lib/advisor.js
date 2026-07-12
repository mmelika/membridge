'use strict';
// BYOK advisor plumbing (PLAN M2; M3 adds roadmap generation on top).
// Zero-dependency by design: raw Node fetch against the Anthropic API — we
// need exactly one endpoint family, so no SDK. Tests point MEMBRIDGE_API_BASE
// at a local mock so the suite stays offline.

const API_VERSION = '2023-06-01';

// Plain-English planner options, shown as radios in Settings. Cost estimates
// are per roadmap (~5K in / 1.5K out) from the pricing table in PLAN M3.
const PLANNER_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Fast & cheap (~1¢ per roadmap) — recommended' },
  { id: 'claude-sonnet-5', label: 'Smarter (~4¢)' },
  { id: 'claude-opus-4-8', label: 'Deepest (~6¢)' },
];
const DEFAULT_MODEL = PLANNER_MODELS[0].id;

function apiBase() {
  return process.env.MEMBRIDGE_API_BASE || 'https://api.anthropic.com';
}

// Effective advisor settings: config key first, then the standard env var.
function getAdvisorConfig(config) {
  const adv = (config && config.advisor) || {};
  const apiKey = adv.apiKey || process.env.ANTHROPIC_API_KEY || '';
  return {
    apiKey,
    source: adv.apiKey ? 'config' : apiKey ? 'env' : null,
    model: PLANNER_MODELS.some(m => m.id === adv.model) ? adv.model : DEFAULT_MODEL,
  };
}

// The cheapest way to prove a key works: a count_tokens request (no tokens
// are generated or billed). Returns { ok } or { ok: false, error } with a
// message fit for the Settings screen.
async function testKey(apiKey, model) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${apiBase()}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was rejected — check it and try again.' };
    let msg = `The Anthropic API answered with an error (${res.status}).`;
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) msg = body.error.message;
    } catch {}
    return { ok: false, error: msg };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError'
        ? 'Timed out reaching the Anthropic API — try again.'
        : 'Could not reach the Anthropic API — are you online?',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Roadmap generation (PLAN M3)
// ---------------------------------------------------------------------------

// USD per 1M tokens [input, output]. Sonnet 5 is intro pricing through
// 2026-08-31 ($3/$15 after).
const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5': [2, 10],
  'claude-opus-4-8': [5, 25],
};
const PLAN_MAX_TOKENS = 4000;
const EXPECTED_OUTPUT_TOKENS = 1500;

// Rough but honest: ~4 chars per token over the user prompt plus the system
// prompt, typical output size from the schema. Exact cost is computed from
// real usage after the call.
function estimateCost(model, promptChars) {
  const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
  const inTokens = Math.ceil((promptChars + PLAN_SYSTEM.length) / 4);
  return (inTokens * pin + EXPECTED_OUTPUT_TOKENS * pout) / 1e6;
}

function actualCost(model, usage) {
  const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
  const inTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTokens * pin + (usage.output_tokens || 0) * pout) / 1e6;
}

// Structured-outputs schema: the response is guaranteed-parseable JSON in
// exactly this shape — no brittle text parsing.
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

function buildPlanPrompt(payload) {
  const lines = [`Project: ${payload.projectName}`];
  if (payload.topLevel && payload.topLevel.length) {
    lines.push(`Top-level files and folders: ${payload.topLevel.join(', ')}`);
  }
  if (payload.recentAsks && payload.recentAsks.length) {
    lines.push('', 'Recent AI-assisted work (oldest first):');
    for (const e of payload.recentAsks) {
      lines.push(`- ${e.ts} · ${e.source}: ${e.ask}${e.files && e.files.length ? ` [files: ${e.files.join(', ')}]` : ''}`);
    }
  } else {
    lines.push('', 'No AI activity captured in this project yet.');
  }
  lines.push('', `The developer's goal: ${payload.goal}`);
  return lines.join('\n');
}

function postMessages(apiKey, body, signal) {
  return fetch(`${apiBase()}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

// Generate a roadmap. Never throws for expected failures — returns
// { ok: false, status, error } with a message fit for the Plan tab.
async function generatePlan(apiKey, model, payload) {
  if (!apiKey) return { ok: false, status: 400, error: 'Add your Anthropic key in Settings first.' };
  const body = {
    model,
    max_tokens: PLAN_MAX_TOKENS,
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: buildPlanPrompt(payload) }],
    output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
  };
  // Sonnet 5 runs adaptive thinking when the field is omitted; keep the spend
  // predictable and inside max_tokens. (Haiku/Opus default to off already.)
  if (model === 'claude-sonnet-5') body.thinking = { type: 'disabled' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    let res = await postMessages(apiKey, body, ctrl.signal);
    if (res.status === 429 || res.status >= 500) res = await postMessages(apiKey, body, ctrl.signal); // one retry
    if (res.status === 401) return { ok: false, status: 401, error: 'That key looks invalid — check Settings.' };
    if (!res.ok) {
      let msg = `The Anthropic API answered with an error (${res.status}) — try again in a minute.`;
      try {
        const b = await res.json();
        if (b && b.error && b.error.message) msg = b.error.message;
      } catch {}
      return { ok: false, status: 502, error: msg };
    }
    const data = await res.json();
    if (data.stop_reason === 'max_tokens') {
      return { ok: false, status: 502, error: 'The plan ran too long and was cut off — try a narrower goal.' };
    }
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    let plan;
    try {
      plan = JSON.parse(text);
    } catch {
      return { ok: false, status: 502, error: 'The model answered with something unreadable — try again.' };
    }
    const usage = data.usage || {};
    return { ok: true, plan, model: data.model || model, usage, costUsd: actualCost(model, usage) };
  } catch (err) {
    return {
      ok: false,
      status: 504,
      error: err.name === 'AbortError'
        ? 'Timed out waiting for the Anthropic API — try again.'
        : 'Could not reach the Anthropic API — are you online?',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  API_VERSION, PLANNER_MODELS, DEFAULT_MODEL, PRICES,
  apiBase, getAdvisorConfig, testKey,
  estimateCost, actualCost, buildPlanPrompt, generatePlan,
};
