'use strict';
// BYOK advisor plumbing (PLAN M2/M3; multi-provider adapters land in PLAN
// "Multi-Provider Advisor" Task 6). This module owns the shared orchestration
// — prompt building, schema handling, JSON recovery, cost math — and
// delegates the actual vendor call to lib/advisors/<provider>.js.

const advisors = require('./advisors');

const DEFAULT_PROVIDER = 'anthropic';

// Effective advisor settings for the selected provider: config key first,
// then a legacy single-key `advisor.apiKey`/`advisor.model` (pre-multi-
// provider configs), then the adapter's standard env var(s).
//
// Lazy migration: an old config (`{ advisor: { apiKey, model } }`, no
// `provider`/`providers`) is read as-is — nothing is rewritten to disk here.
// Once a config carries `providers[provider]`, that entry wins over the
// legacy top-level fields for that provider.
function getAdvisorConfig(config) {
  const adv = (config && config.advisor) || {};
  const providers = adv.providers && typeof adv.providers === 'object' ? adv.providers : {};
  const provider = advisors.byId(adv.provider) ? adv.provider : DEFAULT_PROVIDER;
  const adapter = advisors.byId(provider);
  const pconf = providers[provider] || {};
  // Legacy flat apiKey/model migrate into anthropic, but only fill a slot the
  // provider entry hasn't set itself. Gating on the field (not on the entry's
  // mere existence) means writing just a model into providers.anthropic can
  // never shadow — and silently drop — a legacy top-level key.
  const legacyKey = provider === 'anthropic' && !pconf.apiKey ? (adv.apiKey || '') : '';
  const legacyModel = provider === 'anthropic' && !pconf.model ? adv.model : undefined;
  const envKey = (adapter.keyEnv || []).map(k => process.env[k]).find(Boolean) || '';
  const apiKey = pconf.apiKey || legacyKey || envKey;
  const baseUrl = adapter.needsBaseUrl ? (pconf.baseUrl || '') : '';
  const validModel = m => (adapter.models.length ? adapter.models.some(x => x.id === m) : !!m);
  const model = validModel(pconf.model) ? pconf.model
    : validModel(legacyModel) ? legacyModel
    : (adapter.models[0] ? adapter.models[0].id : (pconf.model || ''));
  return {
    provider, adapter, apiKey, baseUrl, model,
    source: pconf.apiKey ? 'config' : (legacyKey ? 'config' : (envKey ? 'env' : null)),
  };
}

// ---------------------------------------------------------------------------
// Roadmap generation (PLAN M3)
// ---------------------------------------------------------------------------

const PLAN_MAX_TOKENS = 4000;
const EXPECTED_OUTPUT_TOKENS = 1500;

// Real cost from a completed call: usage carries the model it was billed
// against (stamped by generatePlan below) so the right adapter price table
// is used even when the caller didn't pass one explicitly.
function actualCost(adapter, usage) {
  const [pin, pout] = adapter.priceFor ? adapter.priceFor(usage.model) : [0, 0];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTok * pin + (usage.output_tokens || 0) * pout) / 1e6;
}

// Rough but honest: ~4 chars per token over the user prompt plus the system
// prompt, typical output size from the schema. Exact cost is computed from
// real usage after the call via actualCost.
function estimateCost(model, promptChars, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  const [pin, pout] = adapter.priceFor(model);
  const inTokens = Math.ceil((promptChars + PLAN_SYSTEM.length) / 4);
  return (inTokens * pin + EXPECTED_OUTPUT_TOKENS * pout) / 1e6;
}

// Structured-outputs schema: the response is guaranteed-parseable JSON in
// exactly this shape — no brittle text parsing — for adapters that support
// it. Adapters without native schema support get it folded into the prompt
// instead (see systemFor) and fall back to advisors.extractJson.
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

const BRIEFING_MAX_TOKENS = 1200;

const BRIEFING_SYSTEM = `You are MemBridge's catch-up briefer. You read a digest of what a developer's teammates did with AI coding tools since the developer last looked, and you write a short, skimmable briefing that gets them caught up fast.

Write 2-4 short paragraphs or tight bullets in plain language. Lead with what matters most. Name the teammate and the project they touched, and group related work. Ground every claim in the digest — never invent activity that is not there; if the digest is thin, say so in one line. No preamble and no sign-off — just the briefing.`;

function buildPlanPrompt(payload) {
  const lines = [`Project: ${payload.projectName}`];
  if (payload.topLevel && payload.topLevel.length) {
    lines.push(`Top-level files and folders: ${payload.topLevel.join(', ')}`);
  }
  if (payload.recentAsks && payload.recentAsks.length) {
    lines.push('', 'Recent AI-assisted work (oldest first):');
    for (const e of payload.recentAsks) {
      lines.push(`- ${e.ts} · ${e.source}: ${e.ask || ''}${e.files && e.files.length ? ` [files: ${e.files.join(', ')}]` : ''}`);
    }
  } else {
    lines.push('', 'No AI activity captured in this project yet.');
  }
  lines.push('', `The developer's goal: ${payload.goal}`);
  return lines.join('\n');
}

function buildBriefingPrompt(payload) {
  const lines = [];
  if (payload.since) {
    lines.push(`Window: since ${payload.since}${payload.until ? ` until ${payload.until}` : ''}.`);
  }
  if (!payload.teammates || !payload.teammates.length) {
    lines.push('No teammate activity was captured in this window.');
    return lines.join('\n');
  }
  lines.push('', 'Recent teammate activity (grouped by teammate, oldest first):', '');
  for (const t of payload.teammates) {
    lines.push(`## ${t.name}`);
    for (const e of t.entries || []) {
      const detail = e.summary || e.ask || '';
      const files = e.files && e.files.length ? ` [files: ${e.files.join(', ')}]` : '';
      lines.push(`- ${e.ts} · ${e.source}${e.project ? ` · ${e.project}` : ''}: ${detail}${files}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Adapters that can't take a schema natively (e.g. local/OpenAI-compatible
// endpoints) get it folded into the system prompt instead; the response is
// then recovered with advisors.extractJson.
function systemFor(adapter, base, schema) {
  if (!schema || adapter.supportsSchema) return base;
  return base + '\n\nRespond with ONLY a single JSON object (no prose, no code fences) matching this JSON schema:\n' + JSON.stringify(schema);
}

// Generate a roadmap. Never throws for expected failures — returns
// { ok: false, status, error } with a message fit for the Plan tab.
// `opts.provider` selects the adapter (defaults to 'anthropic' so existing
// 3-arg callers keep working); `opts.baseUrl` is forwarded for adapters that
// need one.
async function generatePlan(apiKey, model, payload, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  if (!apiKey && !adapter.needsBaseUrl) return { ok: false, status: 400, error: `Add your ${adapter.label} key in Settings first.` };
  const r = await adapter.generate({
    apiKey, baseUrl: opts.baseUrl, model,
    system: systemFor(adapter, PLAN_SYSTEM, PLAN_SCHEMA),
    prompt: buildPlanPrompt(payload), schema: PLAN_SCHEMA, maxTokens: PLAN_MAX_TOKENS,
  });
  if (r.error) return { ok: false, status: r.status || 502, error: r.error };
  let plan = null;
  try { plan = JSON.parse(r.text); } catch { plan = advisors.extractJson(r.text); }
  if (!plan) return { ok: false, status: 502, error: 'The model answered with something unreadable — try again.' };
  const usage = { ...(r.usage || {}), model };
  return { ok: true, plan, model, usage, costUsd: actualCost(adapter, usage) };
}

// Generate a catch-up briefing from teammate activity. Mirrors generatePlan's
// error discipline (never throws for expected failures) but returns free-form
// prose: { text } on success, { error } on any expected failure.
async function generateBriefing(apiKey, model, payload, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  if (!apiKey && !adapter.needsBaseUrl) return { error: `Add your ${adapter.label} key in Settings first.` };
  const r = await adapter.generate({
    apiKey, baseUrl: opts.baseUrl, model,
    system: BRIEFING_SYSTEM, prompt: buildBriefingPrompt(payload), schema: null, maxTokens: BRIEFING_MAX_TOKENS,
  });
  if (r.error) return { error: r.error };
  if (!r.text || !r.text.trim()) return { error: 'The model returned an empty briefing — try again.' };
  return { text: r.text.trim() };
}

// The cheapest way to prove a key works, delegated to the adapter (e.g. a
// count_tokens request for Anthropic — no tokens are generated or billed).
// Returns { ok } or { ok: false, error } with a message fit for Settings.
async function testKey(apiKey, model, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  return adapter.testKey({ apiKey, baseUrl: opts.baseUrl });
}

module.exports = {
  // Copy so callers can't mutate the adapter's live catalog.
  PLANNER_MODELS: advisors.byId('anthropic').models.slice(),
  DEFAULT_MODEL: advisors.byId('anthropic').models[0].id,
  providers: advisors,
  getAdvisorConfig, testKey, estimateCost, actualCost,
  buildPlanPrompt, generatePlan, buildBriefingPrompt, generateBriefing,
};
