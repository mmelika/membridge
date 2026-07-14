import Link from 'next/link';

// Thin marketing landing. The product lives behind /feed.
export default function Landing() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <div className="flex items-center gap-2 font-bold">
        <span className="inline-block h-7 w-7 rounded-lg bg-gradient-to-br from-blue-600 to-blue-400" />
        MemBridge
      </div>
      <h1 className="mt-10 text-5xl font-light leading-tight tracking-tight">
        Your team&rsquo;s AI work, <span className="text-blue-600">one feed.</span>
      </h1>
      <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-500">
        Every teammate&rsquo;s Claude Code, Codex, and other coding agents — who asked what, which
        files changed — visible to the whole team without installing anything. Redacted before it
        ever leaves a laptop.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/login"
          className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Open your workspace
        </Link>
        <a
          href="https://github.com/mmelika/membridge#readme"
          className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold hover:border-blue-300"
        >
          Install the CLI
        </a>
      </div>
      <p className="mt-16 text-xs text-slate-400">
        Local-first: the free CLI never talks to a server. Team sync shares only redacted digests,
        only for projects you link.
      </p>
    </main>
  );
}
