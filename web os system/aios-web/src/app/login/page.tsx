'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Field, Spinner } from '@/components/ui';

export default function LoginPage() {
  const { user, login, register } = useAuth();
  const router = useRouter();
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { API.get<{ initialized: boolean }>('/api/auth/status').then((s) => setInitialized(s.initialized)).catch(() => setInitialized(true)); }, []);
  useEffect(() => { if (user) router.replace('/'); }, [user, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (initialized) await login(email, password);
      else await register(email, displayName, password);
      router.replace('/');
    } catch (e: any) { setErr(e.message ?? '失敗'); } finally { setBusy(false); }
  }

  const registering = initialized === false;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-8">
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand text-lg font-bold text-white">A</div>
          <h1 className="text-lg font-semibold">{registering ? '建立擁有者帳號' : '登入 AIOS'}</h1>
          <p className="text-xs text-muted">{registering ? '第一個帳號將成為系統擁有者' : '本地代理工作站'}</p>
        </div>
        {registering && <Field label="顯示名稱"><input className="input" value={displayName} onChange={(e) => setName(e.target.value)} required /></Field>}
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="密碼"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></Field>
        {err && <p className="text-sm text-rose-400">{err}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy || initialized === null}>
          {busy && <Spinner className="border-white/40 border-t-white" />} {registering ? '建立並登入' : '登入'}
        </button>
      </form>
    </div>
  );
}
