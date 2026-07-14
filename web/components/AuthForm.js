'use client';
import { useState } from 'react';
import { supabase } from '../lib/supabase';

// Inline login/signup used by /login and the /join/<token> landing.
// onDone(user) fires once a session exists.
export default function AuthForm({ onDone, defaultMode = 'login' }) {
  const [mode, setMode] = useState(defaultMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const sb = supabase();
      if (signup) {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { display_name: name || email.split('@')[0] } },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice(`Check ${email} for a confirmation link, then log in here.`);
          setMode('login');
          return;
        }
        onDone(data.session.user);
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onDone(data.session.user);
      }
    } catch (err) {
      setError(err.message || 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('login')}
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${!signup ? 'bg-blue-600 text-white' : 'text-slate-500'}`}
        >
          Log in
        </button>
        <button
          type="button"
          onClick={() => setMode('signup')}
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${signup ? 'bg-blue-600 text-white' : 'text-slate-500'}`}
        >
          Create account
        </button>
      </div>
      {signup && (
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Display name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="How teammates see you"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-blue-600"
            required
          />
        </label>
      )}
      <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Email
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-blue-600"
          required
        />
      </label>
      <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Password
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="At least 6 characters"
          autoComplete={signup ? 'new-password' : 'current-password'}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-blue-600"
          required
        />
      </label>
      {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button
        disabled={busy}
        className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'One moment…' : signup ? 'Create my account' : 'Log in'}
      </button>
    </form>
  );
}
