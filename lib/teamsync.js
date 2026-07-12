'use strict';
// Team sync: push this machine's redacted per-project memory entries to a
// Supabase backend and pull teammates' entries down, so every team member's
// AI tools see what the whole team's AIs did.
//
// Zero-dependency by design: raw fetch against Supabase's GoTrue (auth) and
// PostgREST (data) APIs. Tests point MEMBRIDGE_TEAM_URL at a local mock so
// the suite stays offline.
//
// Privacy: only entries already produced by memorydb.buildEntries leave the
// machine — redacted asks, relative file paths, timestamps, tool names. Never
// file contents, and only for projects explicitly linked with `team link`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('./util');
const memorydb = require('./memorydb');

const credentialsPath = () => path.join(util.homeDir(), 'credentials.json');
const teamFilePath = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'team.json');

const MAX_TEAM_ENTRIES = 100; // kept per project in state
const PUSH_BATCH = 50;
const PULL_LIMIT = 200;

// ---------------------------------------------------------------------------
// Backend location: config.team { url, anonKey }, env overrides for tests/CI.
// ---------------------------------------------------------------------------
function backend(config) {
  const team = (config && config.team) || {};
  const url = process.env.MEMBRIDGE_TEAM_URL || team.url || '';
  const anonKey = process.env.MEMBRIDGE_TEAM_ANON_KEY || team.anonKey || '';
  return url && anonKey ? { url: url.replace(/\/+$/, ''), anonKey } : null;
}

function isConfigured(config) {
  return !!backend(config || util.getConfig());
}

// ---------------------------------------------------------------------------
// Credentials: ~/.membridge/credentials.json, chmod 600. Never in a project.
// ---------------------------------------------------------------------------
function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2));
  try {
    fs.chmodSync(credentialsPath(), 0o600);
  } catch {}
}

function clearCredentials() {
  try {
    fs.unlinkSync(credentialsPath());
    return true;
  } catch {
    return false;
  }
}

async function authRequest(be, pathname, body) {
  const res = await fetch(`${be.url}/auth/v1/${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: be.anonKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.msg || data.error_description || data.message || `auth error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function sessionToCredentials(session, displayName) {
  const prev = loadCredentials() || {};
  return {
    userId: session.user.id,
    email: session.user.email,
    displayName: displayName || prev.displayName || String(session.user.email || '').split('@')[0],
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    // expires_in is seconds; keep a 60s safety margin on every check
    expiresAt: Date.now() + (session.expires_in || 3600) * 1000,
  };
}

async function signup(config, email, password, displayName) {
  const be = backend(config);
  if (!be) throw new Error('team backend not configured — run `membridge team setup` first');
  const data = await authRequest(be, 'signup', { email, password });
  // With email confirmation enabled Supabase returns a user but no session.
  if (!data.access_token) {
    return { needsConfirmation: true, email };
  }
  const creds = sessionToCredentials(data, displayName);
  saveCredentials(creds);
  return creds;
}

async function login(config, email, password, displayName) {
  const be = backend(config);
  if (!be) throw new Error('team backend not configured — run `membridge team setup` first');
  const data = await authRequest(be, 'token?grant_type=password', { email, password });
  const creds = sessionToCredentials(data, displayName);
  saveCredentials(creds);
  return creds;
}

// Valid access token, refreshing when it is stale. Returns null when logged out.
async function getAccessToken(config) {
  const be = backend(config);
  const creds = loadCredentials();
  if (!be || !creds || !creds.refreshToken) return null;
  if (creds.expiresAt && creds.expiresAt - Date.now() > 60000) return creds;
  const data = await authRequest(be, 'token?grant_type=refresh_token', {
    refresh_token: creds.refreshToken,
  });
  const next = sessionToCredentials(data, creds.displayName);
  saveCredentials(next);
  return next;
}

// ---------------------------------------------------------------------------
// PostgREST helper
// ---------------------------------------------------------------------------
async function rest(config, creds, method, pathname, body, headers) {
  const be = backend(config);
  const res = await fetch(`${be.url}/rest/v1/${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: be.anonKey,
      Authorization: `Bearer ${creds.accessToken}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && (data.message || data.hint)) || `${method} ${pathname}: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function rpc(config, creds, fn, args) {
  return rest(config, creds, 'POST', `rpc/${fn}`, args || {});
}

// ---------------------------------------------------------------------------
// Teams and project linking
// ---------------------------------------------------------------------------
async function createTeam(config, name) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'create_team', {
    p_name: name,
    p_display_name: creds.displayName,
  });
  return rows[0]; // { team_id, invite_code }
}

async function joinTeam(config, inviteCode) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'join_team', {
    p_code: inviteCode,
    p_display_name: creds.displayName,
  });
  return rows[0]; // { team_id, team_name }
}

async function listTeams(config) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  return rpc(config, creds, 'my_teams', {});
}

// Normalized git remote so every teammate's clone maps to one project row:
// git@github.com:user/repo.git and https://github.com/user/repo both become
// github.com/user/repo.
function repoUrl(projectPath) {
  try {
    const r = spawnSync('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.status !== 0) return null;
    let u = String(r.stdout || '').trim();
    if (!u) return null;
    u = u.replace(/\.git$/, '');
    const ssh = u.match(/^[\w.-]+@([\w.-]+):(.+)$/);
    if (ssh) u = `${ssh[1]}/${ssh[2]}`;
    u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
    return u.toLowerCase();
  } catch {
    return null;
  }
}

function loadTeamLink(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(teamFilePath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

async function linkProject(config, projectPath, teamId, teamName) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const resolved = path.resolve(projectPath);
  const projectId = await rpc(config, creds, 'link_project', {
    p_team: teamId,
    p_name: path.basename(resolved),
    p_repo_url: repoUrl(resolved) || '',
  });
  const link = { projectId, teamId, teamName: teamName || '', linkedBy: creds.email, linkedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(resolved, memorydb.DIR_NAME), { recursive: true });
  fs.writeFileSync(teamFilePath(resolved), JSON.stringify(link, null, 2));
  return link;
}

function unlinkProject(projectPath) {
  try {
    fs.unlinkSync(teamFilePath(projectPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------
async function pushProject(config, creds, projectPath, proj, link) {
  const cursor = proj.teamPushTs || '';
  const entries = memorydb.buildEntries(projectPath, proj, config)
    .filter(e => e.ts > cursor);
  if (!entries.length) return 0;
  let pushed = 0;
  for (let i = 0; i < entries.length; i += PUSH_BATCH) {
    const rows = entries.slice(i, i + PUSH_BATCH).map(e => ({
      project_id: link.projectId,
      author_id: creds.userId,
      author_name: creds.displayName,
      ts: e.ts,
      source: e.source,
      ask: e.ask,
      files: e.files,
    }));
    await rest(config, creds, 'POST',
      'memory_entries?on_conflict=project_id,author_id,ts,source',
      rows,
      { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    pushed += rows.length;
  }
  proj.teamPushTs = entries[entries.length - 1].ts;
  return pushed;
}

async function pullProject(config, creds, proj, link) {
  const cursor = proj.teamPullTs || '1970-01-01T00:00:00.000Z';
  const q = `memory_entries?project_id=eq.${link.projectId}` +
    `&author_id=neq.${creds.userId}` +
    `&created_at=gt.${encodeURIComponent(cursor)}` +
    `&order=created_at.asc&limit=${PULL_LIMIT}` +
    '&select=author_name,ts,source,ask,files,created_at';
  const rows = await rest(config, creds, 'GET', q);
  if (!rows || !rows.length) return 0;
  const existing = proj.teamEntries || [];
  const seen = new Set(existing.map(e => `${e.author}|${e.ts}|${e.source}`));
  for (const r of rows) {
    const k = `${r.author_name}|${r.ts}|${r.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    existing.push({
      author: r.author_name,
      ts: r.ts,
      source: r.source,
      ask: r.ask,
      files: Array.isArray(r.files) ? r.files : [],
    });
  }
  existing.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  proj.teamEntries = existing.slice(-MAX_TEAM_ENTRIES);
  proj.teamPullTs = rows[rows.length - 1].created_at;
  return rows.length;
}

// One team-sync pass over every linked, unpaused project. Returns the project
// keys whose teamEntries changed (their context blocks need a re-render).
// Never throws on a per-project failure: team sync is best-effort on top of
// local sync, and one bad project or a network blip must not break the rest.
async function syncTeams(opts = {}) {
  const config = util.getConfig();
  if (!isConfigured(config)) return { synced: [], changed: [], errors: [] };
  let creds;
  try {
    creds = await getAccessToken(config);
  } catch (err) {
    return { synced: [], changed: [], errors: [`auth: ${err.message}`] };
  }
  if (!creds) return { synced: [], changed: [], errors: [] };

  const state = util.loadState();
  const synced = [];
  const changed = [];
  const errors = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (opts.project && path.resolve(opts.project) !== path.resolve(key)) continue;
    if (util.isProjectOff(key, config)) continue;
    const link = loadTeamLink(key);
    if (!link || !link.projectId) continue;
    try {
      if (!Array.isArray(proj.events)) proj.events = [];
      await pushProject(config, creds, key, proj, link);
      const pulled = await pullProject(config, creds, proj, link);
      synced.push(key);
      if (pulled > 0) {
        proj.dirty = true; // the next injection pass rewrites this project's block
        changed.push(key);
      }
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  if (synced.length) util.saveState(state);
  return { synced, changed, errors };
}

module.exports = {
  isConfigured, backend,
  signup, login, clearCredentials, loadCredentials, getAccessToken,
  createTeam, joinTeam, listTeams, linkProject, unlinkProject, loadTeamLink, repoUrl,
  syncTeams, credentialsPath, teamFilePath,
};
