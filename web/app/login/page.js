'use client';
import { useRouter } from 'next/navigation';
import AuthForm from '../../components/AuthForm';

export default function Login() {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <div className="mb-8 flex items-center gap-2 font-bold">
        <span className="inline-block h-6 w-6 rounded-lg bg-gradient-to-br from-blue-600 to-blue-400" />
        MemBridge
      </div>
      <h1 className="mb-1 text-2xl font-semibold">Welcome back</h1>
      <p className="mb-6 text-sm text-slate-500">
        Same account as the MemBridge CLI — one login everywhere.
      </p>
      <AuthForm onDone={() => router.replace('/feed')} />
    </main>
  );
}
