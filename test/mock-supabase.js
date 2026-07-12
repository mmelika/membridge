'use strict';
// Minimal in-memory Supabase stand-in for the offline test suite: just enough
// GoTrue (signup / password grant / refresh) and PostgREST (the RPCs and the
// memory_entries table, with membership checks standing in for RLS) for
// lib/teamsync.js to run end-to-end without a network.
const http = require('http');
const crypto = require('crypto');

function createMockSupabase() {
  const users = new Map();          // email -> { id, email, password }
  const sessions = new Map();       // accessToken -> userId
  const refreshTokens = new Map();  // refreshToken -> userId
  const teams = new Map();          // teamId -> { id, name, inviteCode }
  const members = [];               // { teamId, userId, displayName, role }
  const projects = [];              // { id, teamId, name, repoUrl }
  const entries = [];               // memory_entries rows
  const stats = { refreshCalls: 0, inserts: 0, deniedInserts: 0 };

  const uuid = () => crypto.randomUUID();
  const isMember = (teamId, userId) => members.some(m => m.teamId === teamId && m.userId === userId);
  const projectTeam = projectId => (projects.find(p => p.id === projectId) || {}).teamId;

  function newSession(user) {
    const access = `at-${uuid()}`;
    const refresh = `rt-${uuid()}`;
    sessions.set(access, user.id);
    refreshTokens.set(refresh, user.id);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      user: { id: user.id, email: user.email },
    };
  }

  function authedUser(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
    return m ? sessions.get(m[1]) || null : null;
  }

  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  function handleRpc(res, fn, body, userId) {
    if (!userId) return json(res, 401, { message: 'not authenticated' });
    if (fn === 'create_team') {
      const team = { id: uuid(), name: body.p_name, inviteCode: uuid() };
      teams.set(team.id, team);
      members.push({ teamId: team.id, userId, displayName: body.p_display_name, role: 'owner' });
      return json(res, 200, [{ team_id: team.id, invite_code: team.inviteCode }]);
    }
    if (fn === 'join_team') {
      const team = [...teams.values()].find(t => t.inviteCode === body.p_code);
      if (!team) return json(res, 400, { message: 'invalid invite code' });
      if (!isMember(team.id, userId)) {
        members.push({ teamId: team.id, userId, displayName: body.p_display_name, role: 'member' });
      }
      return json(res, 200, [{ team_id: team.id, team_name: team.name }]);
    }
    if (fn === 'link_project') {
      if (!isMember(body.p_team, userId)) return json(res, 403, { message: 'not a member of this team' });
      let row = body.p_repo_url
        ? projects.find(p => p.teamId === body.p_team && p.repoUrl === body.p_repo_url)
        : null;
      if (!row) row = projects.find(p => p.teamId === body.p_team && p.name === body.p_name);
      if (!row) {
        row = { id: uuid(), teamId: body.p_team, name: body.p_name, repoUrl: body.p_repo_url || null };
        projects.push(row);
      }
      return json(res, 200, row.id);
    }
    if (fn === 'my_teams') {
      const rows = members.filter(m => m.userId === userId).map(m => ({
        team_id: m.teamId,
        team_name: teams.get(m.teamId).name,
        role: m.role,
        invite_code: teams.get(m.teamId).inviteCode,
      }));
      return json(res, 200, rows);
    }
    json(res, 404, { message: `unknown rpc ${fn}` });
  }

  function handleEntries(res, url, method, body, userId) {
    if (!userId) return json(res, 401, { message: 'not authenticated' });
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      for (const r of rows) {
        if (r.author_id !== userId || !isMember(projectTeam(r.project_id), userId)) {
          stats.deniedInserts++;
          return json(res, 403, { message: 'row-level security violation' });
        }
        const dup = entries.some(e => e.project_id === r.project_id &&
          e.author_id === r.author_id && e.ts === r.ts && e.source === r.source);
        if (dup) continue; // Prefer: resolution=ignore-duplicates
        stats.inserts++;
        entries.push({ ...r, id: entries.length + 1, created_at: new Date(Date.now() + entries.length).toISOString() });
      }
      res.writeHead(201);
      return res.end();
    }
    // GET with the exact filter shapes teamsync emits
    const p = url.searchParams;
    const eq = (p.get('project_id') || '').replace(/^eq\./, '');
    const neq = (p.get('author_id') || '').replace(/^neq\./, '');
    const gt = decodeURIComponent((p.get('created_at') || '').replace(/^gt\./, ''));
    if (!isMember(projectTeam(eq), userId)) return json(res, 200, []);
    const rows = entries
      .filter(e => e.project_id === eq && e.author_id !== neq && e.created_at > gt)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, parseInt(p.get('limit') || '200', 10));
    json(res, 200, rows);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {}
      const url = new URL(req.url, 'http://127.0.0.1');

      if (url.pathname === '/auth/v1/signup') {
        if (users.has(body.email)) return json(res, 400, { msg: 'User already registered' });
        const user = { id: uuid(), email: body.email, password: body.password };
        users.set(body.email, user);
        return json(res, 200, newSession(user));
      }
      if (url.pathname === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'password') {
          const user = users.get(body.email);
          if (!user || user.password !== body.password) {
            return json(res, 400, { error_description: 'Invalid login credentials' });
          }
          return json(res, 200, newSession(user));
        }
        const userId = refreshTokens.get(body.refresh_token);
        if (!userId) return json(res, 400, { error_description: 'Invalid refresh token' });
        stats.refreshCalls++;
        const user = [...users.values()].find(u => u.id === userId);
        return json(res, 200, newSession(user));
      }
      const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if (rpcMatch) return handleRpc(res, rpcMatch[1], body, authedUser(req));
      if (url.pathname === '/rest/v1/memory_entries') {
        return handleEntries(res, url, req.method, body, authedUser(req));
      }
      json(res, 404, { message: 'not found' });
    });
  });

  return { server, users, teams, members, projects, entries, stats };
}

module.exports = { createMockSupabase };
