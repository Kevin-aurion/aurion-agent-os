'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Users, Wrench, Workflow, Plug, ScrollText, LogOut, Wifi, WifiOff, Network, FileCheck2 } from 'lucide-react';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp } from '@/lib/awp';
import { API } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Spinner } from './ui';

const NAV = [
  { href: '/', label: '總覽 Dashboard', icon: LayoutDashboard },
  { href: '/employees', label: '員工 Agents', icon: Users },
  { href: '/org', label: '組織 Org', icon: Network },
  { href: '/skills', label: '技能 Skills', icon: Wrench },
  { href: '/workflows', label: '工作流 Workflows', icon: Workflow },
  { href: '/settings', label: '設定 Settings', icon: Plug },
  { href: '/audit', label: '稽核 Audit', icon: ScrollText },
];

interface PendingProposalRow {
  id: string;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { connected } = useAwp(['run.*', 'agent.status', 'integration.status', 'skill.review_ready', 'workflow.triggered', 'schedule.fired']);
  const isFde = isFdeRole(user?.role);

  // Shared key with /proposals page — badge reuses cache when available.
  const proposalsQ = useQuery({
    queryKey: ['proposals'],
    queryFn: () => API.get<PendingProposalRow[]>('/api/proposals'),
    enabled: !!user && isFde,
    staleTime: 30_000,
  });
  const pendingCount = isFde && Array.isArray(proposalsQ.data) ? proposalsQ.data.length : null;

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading) return <div className="flex h-screen items-center justify-center"><Spinner className="h-6 w-6" /></div>;
  if (!user) return null;

  return (
    <div className="flex h-screen">
      <aside className="flex w-64 flex-col border-r border-border bg-panel">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white font-bold">A</div>
          <div>
            <div className="text-sm font-semibold leading-tight">AIOS</div>
            <div className="text-[11px] text-muted">本地代理工作站</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((n) => {
            const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                className={cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', active ? 'bg-brand/10 text-brand font-medium' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5')}>
                <n.icon className="h-4 w-4" /> {n.label}
              </Link>
            );
          })}
          {isFde && (
            <Link
              href="/proposals"
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm',
                pathname.startsWith('/proposals')
                  ? 'bg-brand/10 text-brand font-medium'
                  : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              <FileCheck2 className="h-4 w-4" />
              <span className="flex-1">提案審核 Proposals</span>
              {pendingCount !== null && pendingCount > 0 && (
                <span className="badge bg-brand/15 text-brand tabular-nums">{pendingCount}</span>
              )}
            </Link>
          )}
        </nav>
        <div className="border-t border-border px-3 py-3">
          <div className="mb-2 flex items-center gap-2 px-2 text-xs text-muted">
            {connected ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5 text-rose-400" />}
            {connected ? '即時連線中' : '連線中斷'}
          </div>
          <div className="flex items-center justify-between px-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{user.displayName}</div>
              <div className="truncate text-[11px] text-muted">{user.email}</div>
            </div>
            <button className="btn-ghost p-2" onClick={logout} title="登出"><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto"><div className="mx-auto max-w-6xl px-8 py-8">{children}</div></main>
    </div>
  );
}
