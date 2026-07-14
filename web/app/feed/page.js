'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Shell from '../../components/Shell';
import { supabase, colorFor, toolColor } from '../../lib/supabase';

const PAGE = 50;

function day(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function time(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function Entry({ e }) {
  const [open, setOpen] = useState(false);
  const files = Array.isArray(e.files) ? e.files : [];
  return (
    <div className="flex gap-3 py-3">
      <span
        className="mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-lg text-xs font-bold text-white"
        style={{ background: colorFor(e.author_name) }}
        title={e.author_name}
      >
        {e.author_name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <strong className="text-slate-700">{e.author_name}</strong>
          <span
            className="rounded border px-1.5 font-mono text-[10px] font-semibold"
            style={{ color: toolColor(e.source), borderColor: toolColor(e.source) }}
          >
            {e.source}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {e.project_name}
          </span>
          <span>{time(e.ts)}</span>
        </div>
        <p className="mt-1 text-sm leading-relaxed">{e.ask}</p>
        {files.length > 0 && (
          <button
            onClick={() => setOpen(!open)}
            className="mt-1 text-xs font-semibold text-blue-600"
          >
            {open ? 'Hide' : `${files.length} file${files.length === 1 ? '' : 's'} touched`}
          </button>
        )}
        {open && (
          <p className="mt-1 break-all font-mono text-xs text-slate-500">{files.join(', ')}</p>
        )}
      </div>
    </div>
  );
}

function FeedInner({ team }) {
  const params = useSearchParams();
  const [rows, setRows] = useState([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [author, setAuthor] = useState('');
  const [project, setProject] = useState(params.get('project') || '');
  const [source, setSource] = useState('');

  useEffect(() => {
    const sb = supabase();
    sb.rpc('team_members_list', { p_team: team.team_id }).then(({ data }) => setMembers(data || []));
    sb.from('project_stats')
      .select('project_id,name')
      .eq('team_id', team.team_id)
      .then(({ data }) => setProjects(data || []));
  }, [team.team_id]);

  const load = useCallback(
    async reset => {
      setBusy(true);
      setError('');
      const last = reset ? null : rows[rows.length - 1];
      const { data, error } = await supabase().rpc('team_feed', {
        p_team: team.team_id,
        p_limit: PAGE,
        p_before_created_at: last ? last.created_at : null,
        p_before_id: last ? last.id : null,
        p_author: author || null,
        p_project: project || null,
        p_source: source || null,
      });
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      setDone((data || []).length < PAGE);
      setRows(reset ? data || [] : [...rows, ...(data || [])]);
    },
    [team.team_id, author, project, source, rows],
  );

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.team_id, author, project, source]);

  const groups = [];
  for (const r of rows) {
    const d = day(r.ts);
    if (!groups.length || groups[groups.length - 1].day !== d) groups.push({ day: d, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }

  const sel = 'rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm';
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={author} onChange={e => setAuthor(e.target.value)} className={sel} aria-label="Person">
          <option value="">Everyone</option>
          {members.map(m => (
            <option key={m.user_id} value={m.user_id}>
              {m.display_name}
            </option>
          ))}
        </select>
        <select value={project} onChange={e => setProject(e.target.value)} className={sel} aria-label="Project">
          <option value="">All projects</option>
          {projects.map(p => (
            <option key={p.project_id} value={p.project_id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={source} onChange={e => setSource(e.target.value)} className={sel} aria-label="Tool">
          <option value="">All tools</option>
          {[...new Set(rows.map(r => r.source))].map(s => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!rows.length && !busy && !error && (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <h2 className="text-lg font-semibold">Nothing here yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            Activity appears when teammates link a project:{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">membridge team link</code> inside
            any repo.
          </p>
        </div>
      )}

      {groups.map(g => (
        <section key={g.day} className="mb-2">
          <h3 className="sticky top-0 bg-neutral-50 py-2 text-xs font-bold uppercase tracking-widest text-slate-400">
            {g.day}
          </h3>
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4">
            {g.rows.map(e => (
              <Entry key={e.id} e={e} />
            ))}
          </div>
        </section>
      ))}

      {!done && rows.length > 0 && (
        <button
          onClick={() => load(false)}
          disabled={busy}
          className="mt-4 w-full rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-semibold text-slate-600 hover:border-blue-300 disabled:opacity-50"
        >
          {busy ? 'Loading…' : 'Load older activity'}
        </button>
      )}
    </>
  );
}

export default function FeedPage() {
  return (
    <Shell>
      {({ team }) => (
        <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
          <FeedInner team={team} />
        </Suspense>
      )}
    </Shell>
  );
}
