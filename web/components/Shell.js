'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase, displayNameOf } from '../lib/supabase';

const TABS = [
  { href: '/feed', label: 'Feed' },
  { href: '/projects', label: 'Projects' },
  { href: '/settings', label: 'Settings' },
];

// Signed-in chrome: header with team switcher + tabs. Children render once a
// session and a selected team exist; both are passed down via the render prop.
export default function Shell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(undefined); // undefined = loading
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const sb = supabase();
    sb.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        router.replace('/login');
        return;
      }
      setUser(data.user);
      const { data: rows, error } = await sb.rpc('my_teams');
      if (error) {
        setError(error.message);
        return;
      }
      setTeams(rows || []);
      const saved = localStorage.getItem('membridge.team');
      const pick = (rows || []).find(t => t.team_id === saved) || (rows || [])[0];
      if (pick) setTeamId(pick.team_id);
    });
  }, [router]);

  function switchTeam(id) {
    localStorage.setItem('membridge.team', id);
    setTeamId(id);
  }

  async function logout() {
    await supabase().auth.signOut();
    router.replace('/login');
  }

  if (user === undefined) return <p className="p-10 text-sm text-slate-500">Loading…</p>;
  const team = teams.find(t => t.team_id === teamId) || null;

  return (
    <div className="mx-auto max-w-4xl px-5 pb-20">
      <header className="flex flex-wrap items-center gap-3 py-5">
        <Link href="/feed" className="flex items-center gap-2 font-bold">
          <span className="inline-block h-6 w-6 rounded-lg bg-gradient-to-br from-blue-600 to-blue-400" />
          MemBridge
        </Link>
        {teams.length > 0 && (
          <select
            value={teamId || ''}
            onChange={e => switchTeam(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
            aria-label="Team"
          >
            {teams.map(t => (
              <option key={t.team_id} value={t.team_id}>
                {t.team_name}
              </option>
            ))}
          </select>
        )}
        <nav className="flex gap-1">
          {TABS.map(t => (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${pathname.startsWith(t.href) ? 'bg-blue-600/10 text-blue-700' : 'text-slate-500 hover:text-slate-900'}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
          <span>{displayNameOf(user)}</span>
          <button onClick={logout} className="font-semibold text-slate-400 hover:text-slate-900">
            Log out
          </button>
        </div>
      </header>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {teams.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <h2 className="text-lg font-semibold">No team yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            Ask a teammate for an invite link, or create a team from the MemBridge CLI:{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">membridge team create &lt;name&gt;</code>
          </p>
        </div>
      ) : (
        children({ user, team, teams })
      )}
    </div>
  );
}
