'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Bot, BrainCircuit, ChevronDown, CircleGauge, Database, GitBranch, LogOut,
  Menu, Network, Puzzle, Rocket, Search, ShieldCheck, Sparkles, X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { studioSections } from '@/lib/presentation';

const iconByHref: Record<string, LucideIcon> = {
  '/studio': CircleGauge,
  '/studio/agents': Bot,
  '/studio/models': BrainCircuit,
  '/studio/tools': Network,
  '/studio/knowledge': Database,
  '/studio/skills': Puzzle,
  '/studio/graph': GitBranch,
  '/studio/runtime': Rocket,
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, pathname, router, user]);
  const groups = useMemo(() => [...new Set(studioSections.map((item) => item.group))], []);
  if (loading || !user) return <div className="app-loading"><Sparkles className="spin-slow" /><span>Aurion AIOS Studio</span></div>;

  return <div className="app-frame">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark">L</div><div><strong>Aurion</strong><span>AIOS Studio</span></div><button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="關閉導覽"><X size={18} /></button></div>
      <div className="nav-search"><Search size={16} /><span>尋找設定</span><kbd>⌘ K</kbd></div>
      <nav aria-label="主要導覽">
        {groups.map((group) => <div className="nav-group" key={group}><p>{group}</p>{studioSections.map((item) => {
          if (item.group !== group) return null;
          const Icon = iconByHref[item.href] ?? CircleGauge;
          const active = item.href === '/studio' ? pathname === item.href : pathname.startsWith(item.href);
          return <Link key={item.href} href={item.href} className={active ? 'nav-link active' : 'nav-link'} onClick={() => setMenuOpen(false)}><Icon size={18} /><span>{item.label}</span>{active && <i />}</Link>;
        })}</div>)}
      </nav>
      <div className="sidebar-footer"><div className="sync-state"><span className="pulse-dot" />控制平面已連線</div><div className="user-menu"><div className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{user.displayName}</strong><span>{user.role}</span></div><button className="icon-button" onClick={logout} aria-label="登出"><LogOut size={17} /></button></div></div>
    </aside>
    {menuOpen && <button className="mobile-overlay" aria-label="關閉導覽" onClick={() => setMenuOpen(false)} />}
    <main className="main-column"><div className="topbar"><button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="開啟導覽"><Menu size={20} /></button><div className="environment"><ShieldCheck size={15} /><span>Governed workspace</span><ChevronDown size={14} /></div><div className="topbar-actions"><span className="topbar-note">新版獨立介面 · 原系統不受影響</span></div></div><div className="page-canvas">{children}</div></main>
  </div>;
}
