'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '../../components/Shell';
import { supabase, colorFor } from '../../lib/supabase';

function Card({ title, children, sub }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h2 className="font-semibold">{title}</h2>
      {sub && <p className="mt-1 text-sm text-slate-500">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SettingsInner({ user, team }) {
  const sb = supabase();
  const manager = team.role === 'owner' || team.role === 'admin';
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [name, setName] = useState(team.team_name);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { data: m } = await sb.rpc('team_members_list', { p_team: team.team_id });
    setMembers(m || []);
    const { data: inv } = await sb
      .from('invites')
      .select('*')
      .eq('team_id', team.team_id)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    setInvites(inv || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.team_id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(fn, args, doneMsg) {
    setError('');
    setNotice('');
    const { error } = await sb.rpc(fn, args);
    if (error) setError(error.message);
    else {
      setNotice(doneMsg);
      refresh();
    }
  }

  async function createInvite() {
    setError('');
    const { data, error } = await sb.rpc('create_invite', {
      p_team: team.team_id,
      p_expires_at: null,
      p_max_uses: null,
    });
    if (error) {
      setError(error.message);
      return;
    }
    const token = data && data[0] && data[0].token;
    const url = `${location.origin}/join/${token}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    setNotice(`Invite link copied: ${url}`);
    refresh();
  }

  const btn = 'rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold hover:border-blue-300';

  return (
    <div className="grid gap-4">
      {notice && <p className="break-all rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <Card title="Members" sub="Who can see this team's activity.">
        <div className="divide-y divide-slate-100">
          {members.map(m => (
            <div key={m.user_id} className="flex items-center gap-3 py-2.5">
              <span
                className="grid h-8 w-8 place-items-center rounded-lg text-xs font-bold text-white"
                style={{ background: colorFor(m.display_name) }}
              >
                {m.display_name.charAt(0).toUpperCase()}
              </span>
              <div className="grow">
                <p className="text-sm font-semibold">
                  {m.display_name}
                  {m.user_id === user.id && <span className="ml-1 text-xs font-normal text-slate-400">(you)</span>}
                </p>
                <p className="text-xs text-slate-400">{m.role}</p>
              </div>
              {team.role === 'owner' && m.role !== 'owner' && (
                <button
                  className={btn}
                  onClick={() =>
                    run(
                      'set_role',
                      { p_team: team.team_id, p_user: m.user_id, p_role: m.role === 'admin' ? 'member' : 'admin' },
                      'Role updated.',
                    )
                  }
                >
                  {m.role === 'admin' ? 'Make member' : 'Make admin'}
                </button>
              )}
              {manager && m.role !== 'owner' && m.user_id !== user.id && (
                <button
                  className={`${btn} text-red-600`}
                  onClick={() => run('remove_member', { p_team: team.team_id, p_user: m.user_id }, 'Member removed.')}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>

      {manager && (
        <Card
          title="Invite links"
          sub="Anyone with a link joins as a member — never more. Revoke any time."
        >
          <button
            onClick={createInvite}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Create & copy invite link
          </button>
          <div className="mt-4 divide-y divide-slate-100">
            {invites.map(i => (
              <div key={i.token} className="flex items-center gap-3 py-2.5">
                <code className="grow truncate text-xs text-slate-500">
                  {location.origin}/join/{i.token}
                </code>
                <span className="text-xs text-slate-400">
                  {i.use_count} use{i.use_count === 1 ? '' : 's'}
                  {i.max_uses ? ` / ${i.max_uses}` : ''}
                  {i.expires_at ? ` · expires ${i.expires_at.slice(0, 10)}` : ''}
                </span>
                <button
                  className={`${btn} text-red-600`}
                  onClick={() => run('revoke_invite', { p_token: i.token }, 'Invite revoked.')}
                >
                  Revoke
                </button>
              </div>
            ))}
            {!invites.length && <p className="py-2 text-sm text-slate-400">No active links.</p>}
          </div>
        </Card>
      )}

      {manager && (
        <Card title="Team name">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="grow rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-600"
            />
            <button
              className="rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700"
              onClick={() => run('rename_team', { p_team: team.team_id, p_name: name }, 'Team renamed — reload to see it everywhere.')}
            >
              Save
            </button>
          </div>
        </Card>
      )}

      {team.role !== 'owner' && (
        <Card title="Leave team" sub="You'll lose access to this team's activity. Your local MemBridge keeps working.">
          <button
            className={`${btn} text-red-600`}
            onClick={() => run('leave_team', { p_team: team.team_id }, 'You left the team — reload.')}
          >
            Leave {team.team_name}
          </button>
        </Card>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return <Shell>{({ user, team }) => <SettingsInner user={user} team={team} />}</Shell>;
}
