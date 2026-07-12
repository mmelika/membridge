'use strict';
// Neural map data: one node per project and per chat (session transcript),
// linked by membership plus file-overlap and TF-IDF idea similarity.
// Serves GET /api/graph. Prompt text is always redacted before it leaves here.
const path = require('path');
const { isProjectOff } = require('./util');
const digest = require('./digest');

// ~120 English function words plus generic dev filler; tokens under 3 chars
// never reach the set (tokenize drops them first).
const STOPWORDS = new Set([
  'the', 'and', 'you', 'for', 'with', 'this', 'that', 'have', 'has', 'had',
  'are', 'was', 'were', 'will', 'would', 'should', 'could', 'can', 'may', 'might',
  'must', 'shall', 'but', 'not', 'its', 'your', 'our', 'out', 'all', 'any',
  'some', 'one', 'two', 'from', 'into', 'they', 'them', 'their', 'there', 'here',
  'where', 'which', 'while', 'who', 'whom', 'what', 'when', 'how', 'why', 'been',
  'being', 'because', 'about', 'after', 'before', 'between', 'both', 'each', 'few', 'more',
  'most', 'other', 'only', 'over', 'same', 'such', 'too', 'very', 'than', 'then',
  'these', 'those', 'she', 'her', 'him', 'his', 'does', 'did', 'doing', 'down',
  'during', 'off', 'once', 'under', 'until', 'again', 'further', 'above', 'below', 'own',
  'also', 'use', 'using', 'used', 'make', 'makes', 'made', 'making', 'add', 'added',
  'just', 'like', 'want', 'need', 'needs', 'please', 'get', 'gets', 'got', 'getting',
  'put', 'now', 'new', 'fix', 'run', 'see', 'let', 'lets', 'know', 'dont',
  'doesnt', 'cant', 'ive', 'youre', 'etc', 'sure', 'way', 'well', 'back', 'still',
  'really', 'thing', 'things', 'something', 'going', 'take', 'look', 'try', 'instead', 'around',
  'done', 'able',
  'redacted', // the redaction placeholder must never surface as a shared idea
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function vecNorm(vec) {
  let s = 0;
  for (const t of Object.keys(vec)) s += vec[t] * vec[t];
  return Math.sqrt(s);
}

// Dot product plus the per-term contributions (used to rank link terms).
// Iterates the smaller vector.
function overlap(vecA, vecB) {
  let a = vecA;
  let b = vecB;
  if (Object.keys(a).length > Object.keys(b).length) {
    const t = a;
    a = b;
    b = t;
  }
  let dot = 0;
  const terms = [];
  for (const t of Object.keys(a)) {
    // own-property check: a plain-object vector must not resolve tokens like
    // 'constructor' through the prototype chain (number * function = NaN)
    if (!Object.prototype.hasOwnProperty.call(b, t) || !b[t]) continue;
    const w = a[t] * b[t];
    dot += w;
    terms.push([t, w]);
  }
  return { dot, terms };
}

// Cosine similarity of two token -> weight vectors.
function similarity(vecA, vecB) {
  const na = vecNorm(vecA);
  const nb = vecNorm(vecB);
  return na && nb ? overlap(vecA, vecB).dot / (na * nb) : 0;
}

// Same rel-path guard as digest.recentFiles, but never leaks a foreign
// absolute path: falls back to the basename when outside the project.
function displayPath(projectPath, file) {
  try {
    const r = path.relative(projectPath, file);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  } catch {}
  return path.basename(file);
}

function buildGraph(state, config) {
  const regexes = digest.compileRedactions(config);
  const gcfg = (config && config.graph) || {};
  const minSimilarity = gcfg.minSimilarity != null ? gcfg.minSimilarity : 0.18;
  const maxIdeaLinks = gcfg.maxIdeaLinks != null ? gcfg.maxIdeaLinks : 3; // 0 disables idea links
  const maxChats = gcfg.maxChats != null ? gcfg.maxChats : 500;

  // --- group each project's events into chats (one per session) ---
  const usedIds = new Set();
  const projectKeys = [];
  let chats = [];
  for (const [key, proj] of Object.entries((state && state.projects) || {})) {
    projectKeys.push(key);
    const bySession = new Map();
    for (const e of proj.events || []) {
      const sid = e.session || e.source; // legacy events: one bucket per tool
      let list = bySession.get(sid);
      if (!list) bySession.set(sid, (list = []));
      list.push(e);
    }
    for (const [sid, events] of bySession) {
      let id = 'c:' + sid;
      for (let n = 2; usedIds.has(id); n++) id = 'c:' + sid + ':' + n;
      usedIds.add(id);
      const prompts = events.filter(e => e.kind === 'prompt' && e.text);
      // Redact before clipping or tokenizing: truncation and tokenization
      // both break the anchors redaction patterns rely on.
      const promptTexts = prompts.map(p => digest.redactText(p.text, regexes));
      const fileSet = new Set();
      for (const e of events) if (e.kind === 'edit' && e.file) fileSet.add(e.file);
      chats.push({
        id,
        project: key,
        source: events[0].source,
        label: promptTexts.length ? digest.clip(promptTexts[0], 60) : '(file edits)',
        promptCount: prompts.length,
        doc: promptTexts.join(' '),
        fileSet,
        firstTs: events[0].ts,
        lastTs: events[events.length - 1].ts,
      });
    }
  }

  // --- performance guard: only the most recent chats participate ---
  chats.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
  const truncated = chats.length > maxChats;
  if (truncated) chats = chats.slice(0, maxChats);

  // --- TF-IDF vectors + norms, precomputed once for the O(n^2) pair loop ---
  const N = chats.length;
  const df = new Map();
  for (const c of chats) {
    const tf = new Map();
    for (const t of tokenize(c.doc)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    c.tf = tf;
  }
  for (const c of chats) {
    c.vec = {};
    for (const [t, n] of c.tf) c.vec[t] = (1 + Math.log(n)) * Math.log(1 + N / df.get(t));
    c.norm = vecNorm(c.vec);
    c.tf = null;
  }

  // --- nodes ---
  const chatCount = new Map();
  for (const c of chats) chatCount.set(c.project, (chatCount.get(c.project) || 0) + 1);
  const nodes = [];
  for (const key of projectKeys) {
    nodes.push({
      id: 'p:' + key,
      type: 'project',
      label: path.basename(key),
      path: key,
      paused: isProjectOff(key, config),
      chats: chatCount.get(key) || 0,
    });
  }
  for (const c of chats) {
    nodes.push({
      id: c.id,
      type: 'chat',
      label: c.label,
      project: c.project,
      source: c.source,
      prompts: c.promptCount,
      files: [...c.fileSet].map(f => displayPath(c.project, f)),
      firstTs: c.firstTs,
      lastTs: c.lastTs,
    });
  }

  // --- links ---
  const links = [];
  for (const c of chats) links.push({ source: c.id, target: 'p:' + c.project, type: 'member' });

  const ideaCandidates = [];
  for (let i = 0; i < chats.length; i++) {
    for (let j = i + 1; j < chats.length; j++) {
      const a = chats[i];
      const b = chats[j];
      const shared = [];
      const small = a.fileSet.size <= b.fileSet.size ? a.fileSet : b.fileSet;
      const big = small === a.fileSet ? b.fileSet : a.fileSet;
      for (const f of small) if (big.has(f)) shared.push(f);
      const o = a.norm && b.norm ? overlap(a.vec, b.vec) : { dot: 0, terms: [] };
      const sim = o.dot ? o.dot / (a.norm * b.norm) : 0;
      if (!shared.length && sim < minSimilarity) continue;
      const terms = sim > 0
        ? o.terms
          .sort((x, y) => y[1] - x[1])
          .map(x => x[0])
          .filter(t => digest.redactText(t, regexes) === t) // never leak a secret
          .slice(0, 3)
        : [];
      const link = {
        source: a.id,
        target: b.id,
        type: 'related',
        sharedFiles: shared.slice(0, 3).map(f => displayPath(a.project, f)),
        similarity: Math.round(sim * 1000) / 1000,
        terms,
      };
      if (shared.length) links.push(link); // file links always kept, uncapped
      else ideaCandidates.push({ link, sim });
    }
  }

  // Idea-only links: best-similarity-first, capped per chat.
  ideaCandidates.sort((x, y) => y.sim - x.sim);
  const ideaCount = new Map();
  for (const { link } of ideaCandidates) {
    const cs = ideaCount.get(link.source) || 0;
    const ct = ideaCount.get(link.target) || 0;
    if (cs >= maxIdeaLinks || ct >= maxIdeaLinks) continue;
    ideaCount.set(link.source, cs + 1);
    ideaCount.set(link.target, ct + 1);
    links.push(link);
  }

  return { generatedAt: new Date().toISOString(), truncated, nodes, links };
}

module.exports = { buildGraph, tokenize, similarity };
