'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Users,
  Wrench,
  Workflow,
  Plug,
  ScrollText,
  LogOut,
  Wifi,
  WifiOff,
  Network,
  FileCheck2,
  MessageSquare,
  Shield,
  ArrowLeftRight,
  MonitorSmartphone,
  BrainCircuit,
  GitBranch,
  BookOpen,
  Rocket,
} from 'lucide-react';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp } from '@/lib/awp';
import { API } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Spinner } from './ui';

/** FDE management routes — MEMBER must not remain here (frontend gate only). */
const ADMIN_PREFIXES = [
  '/admin',
  '/employees',
  '/org',
  '/skills',
  '/workflows',
  '/settings',
  '/audit',
  '/proposals',
] as const;

const ADMIN_NAV = [
  { href: '/admin', label: '總覽 Dashboard', icon: LayoutDashboard },
  { href: '/employees', label: '員工 Agents', icon: Users },
  { href: '/admin/devices', label: '裝置 Devices', icon: MonitorSmartphone },
  { href: '/admin/reflections', label: '反思與優化 Reflections', icon: BrainCircuit },
  { href: '/admin/runtime', label: 'Runtime 部署', icon: Rocket },
  { href: '/org', label: '組織 Org', icon: Network },
  { href: '/skills', label: '技能 Skills', icon: Wrench },
  { href: '/workflows', label: '工作流 Workflows', icon: Workflow },
  { href: '/settings', label: '設定 Settings', icon: Plug },
  { href: '/audit', label: '稽核 Audit', icon: ScrollText },
];

interface PendingProposalRow {
  id: string;
}

export function isAdminRoute(pathname: string): boolean {
  return ADMIN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isWorkRoute(pathname: string): boolean {
  return pathname === '/work' || pathname.startsWith('/work/');
}

export function isAgentBuildsRoute(pathname: string): boolean {
  return pathname === '/agent-builds' || pathname.startsWith('/agent-builds/');
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { connected } = useAwp(['run.*', 'agent.status', 'integration.status', 'skill.review_ready', 'workflow.triggered', 'schedule.fired', 'reflection.*', 'agent-builder.*']);
  const isFde = isFdeRole(user?.role);
  const onAdmin = isAdminRoute(pathname);
  const onWork = isWorkRoute(pathname);
  const onAgentBuilds = isAgentBuildsRoute(pathname);

  // Shared key with /proposals page — badge reuses cache when available.
  const proposalsQ = useQuery({
    queryKey: ['proposals'],
    queryFn: () => API.get<PendingProposalRow[]>('/api/proposals'),
    enabled: !!user && isFde && onAdmin,
    staleTime: 30_000,
  });
  const pendingCount = isFde && Array.isArray(proposalsQ.data) ? proposalsQ.data.length : null;

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, pathname, router]);

  // MEMBER must not remain on admin routes (frontend UX gate; backend guards remain authoritative).
  useEffect(() => {
    if (loading || !user) return;
    if (!isFde && onAdmin) {
      router.replace('/work');
    }
  }, [loading, user, isFde, onAdmin, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!user) return null;

  // MEMBER mid-redirect off admin: avoid flash of admin chrome.
  if (!isFde && onAdmin) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  // Dedicated Agent Builds portal: same identity, isolated single-purpose nav.
  if (onAgentBuilds) {
    return (
      <div className="flex h-screen">
        <aside className="flex w-64 flex-col border-r border-border bg-panel">
          <div className="flex items-center gap-2 px-5 py-4">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand font-bold text-white">L</div>
            <div>
              <div className="text-sm font-semibold leading-tight">Lazyoffice Builder</div>
              <div className="text-[11px] text-muted">Agent 建置入口</div>
            </div>
          </div>
          <nav className="flex-1 px-3">
            <Link
              href="/agent-builds"
              className="flex items-center gap-3 rounded-lg bg-brand/10 px-3 py-2 text-sm font-medium text-brand"
            >
              <GitBranch className="h-4 w-4" />
              Agent 建置
            </Link>
            <Link
              href="/install/agent-builder"
              className="mt-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-brand/10 hover:text-brand"
            >
              <BookOpen className="h-4 w-4" />
              安裝與文件
            </Link>
          </nav>
          <div className="border-t border-border px-3 py-3">
            <div className="mb-2 flex items-center gap-2 px-2 text-xs text-muted">
              {connected ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5 text-rose-400" />}
              {connected ? '建置同步中' : '同步連線中斷'}
            </div>
            <div className="flex items-center justify-between px-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{user.displayName}</div>
                <div className="truncate text-[11px] text-muted">{user.email}</div>
              </div>
              <button className="btn-ghost p-2" onClick={logout} title="登出">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-8 py-8">{children}</div>
        </main>
      </div>
    );
  }

  // Workbench surface: slim chrome + full-bleed main (Codex-style three-column lives in page).
  if (onWork) {
    return (
      <div className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-panel px-4">
          <div className="flex items-center gap-3">
            <div className="grid h-7 w-7 place-items-center rounded-md bg-brand text-xs font-bold text-white">A</div>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold">AIOS</span>
              <span className="text-muted">·</span>
              <span className="inline-flex items-center gap-1.5 text-muted">
                <MessageSquare className="h-3.5 w-3.5" />
                工作台
              </span>
            </div>
            {isFde && (
              <Link
                href="/admin"
                className="btn-ghost ml-2 h-8 gap-1.5 px-2.5 text-xs"
                title="切換到 FDE 管理中心"
              >
                <Shield className="h-3.5 w-3.5" />
                管理中心
                <ArrowLeftRight className="h-3 w-3 opacity-60" />
              </Link>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              {connected ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-rose-400" />
              )}
              {connected ? '即時連線' : '連線中斷'}
            </div>
            <div className="hidden min-w-0 text-right sm:block">
              <div className="truncate text-xs font-medium">{user.displayName}</div>
              <div className="truncate text-[10px] text-muted">{user.role}</div>
            </div>
            <button className="btn-ghost p-2" onClick={logout} title="登出">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    );
  }

  // FDE admin surface (and any non-work authenticated page).
  return (
    <div className="flex h-screen">
      <aside className="flex w-64 flex-col border-r border-border bg-panel">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white font-bold">A</div>
          <div>
            <div className="text-sm font-semibold leading-tight">AIOS</div>
            <div className="text-[11px] text-muted">FDE 管理中心</div>
          </div>
        </div>
        {isFde && (
          <div className="px-3 pb-2">
            <Link
              href="/work"
              className="flex items-center gap-2 rounded-lg border border-border bg-black/5 px-3 py-2 text-sm font-medium hover:bg-brand/10 hover:text-brand dark:bg-white/5"
            >
              <MessageSquare className="h-4 w-4" />
              回工作台
              <ArrowLeftRight className="ml-auto h-3.5 w-3.5 opacity-60" />
            </Link>
          </div>
        )}
        <nav className="flex-1 space-y-1 px-3">
          {ADMIN_NAV.map((n) => {
            const active =
              n.href === '/admin' ? pathname === '/admin' : pathname === n.href || pathname.startsWith(`${n.href}/`);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm',
                  active ? 'bg-brand/10 text-brand font-medium' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
                )}
              >
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
            <button className="btn-ghost p-2" onClick={logout} title="登出">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
