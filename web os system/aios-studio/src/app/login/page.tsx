'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Blocks, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';

function LoginForm() {
  const { user, login } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (user) router.replace(search.get('next') || '/studio'); }, [router, search, user]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSubmitting(true);
    try { await login(email, password); router.replace(search.get('next') || '/studio'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '無法登入'); }
    finally { setSubmitting(false); }
  }
  return <main className="login-page"><section className="login-story"><div className="login-brand"><div className="brand-mark">L</div>LazyOffice AIOS Studio</div><div className="story-copy"><span className="story-pill"><Sparkles size={14} />全新的配置體驗</span><h1>把 AI 員工的<br />每一項能力，放在<br /><em>清楚的控制範圍內。</em></h1><p>Agent、模型、工具、知識、技能與部署，在同一個治理工作空間逐步完成。</p><div className="story-points"><span><Blocks size={18} />模組化配置</span><span><ShieldCheck size={18} />FDE 放行</span><span><LockKeyhole size={18} />預設拒絕</span></div></div></section><section className="login-form-wrap"><form className="login-card" onSubmit={submit}><div><p className="eyebrow">WELCOME BACK</p><h2>登入 Studio</h2><p>使用既有 LazyOffice AIOS 帳號。</p></div><label>電子郵件<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="name@company.com" /></label><label>密碼<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="輸入密碼" /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={submitting}>{submitting ? '登入中…' : '進入工作空間'}<ArrowRight size={17} /></button><div className="login-foot"><ShieldCheck size={15} />正式變更仍須由 FDE 審核</div></form></section></main>;
}

export default function LoginPage() {
  return <Suspense fallback={<div className="app-loading"><Sparkles className="spin-slow" />LazyOffice AIOS Studio</div>}><LoginForm /></Suspense>;
}
