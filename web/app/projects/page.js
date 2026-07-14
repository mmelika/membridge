'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell from '../../components/Shell';
import { supabase } from '../../lib/supabase';

function ago(ts) {
  if (!ts) return 'no activity yet';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function ProjectsInner({ team }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase()
      .from('project_stats')
      .select('*')
      .eq('team_id', team.team_id)
      .order('last_activity', { ascending: false, nullsFirst: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRows(data || []);
      });
  }, [team.team_id]);

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  if (!rows) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <h2 className="text-lg font-semibold">No shared projects yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          Link one from any repo with{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5">membridge team link</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map(p => (
        <Link
          key={p.project_id}
          href={`/feed?project=${p.project_id}`}
          className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
        >
          <h2 className="font-semibold">{p.name}</h2>
          {p.repo_url && <p className="mt-0.5 truncate font-mono text-xs text-slate-400">{p.repo_url}</p>}
          <p className="mt-3 text-sm text-slate-500">
            {p.entries} update{p.entries === 1 ? '' : 's'} · {p.contributors} contributor
            {p.contributors === 1 ? '' : 's'}
          </p>
          <p className="mt-1 text-xs text-slate-400">Last activity {ago(p.last_activity)}</p>
          <p className="mt-3 text-xs font-semibold text-blue-600 opacity-0 transition group-hover:opacity-100">
            Open feed →
          </p>
        </Link>
      ))}
    </div>
  );
}

export default function ProjectsPage() {
  return <Shell>{({ team }) => <ProjectsInner team={team} />}</Shell>;
}
