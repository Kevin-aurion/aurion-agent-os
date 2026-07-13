'use client';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

export function Spinner({ className }: { className?: string }) {
  return <div className={cn('h-4 w-4 animate-spin rounded-full border-2 border-border border-t-brand', className)} />;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-1 p-10 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  RUNNING: 'bg-blue-500/15 text-blue-400',
  SUCCEEDED: 'bg-emerald-500/15 text-emerald-400',
  FAILED: 'bg-rose-500/15 text-rose-400',
  CANCELLED: 'bg-zinc-500/15 text-zinc-400',
  AWAITING_REVIEW: 'bg-amber-500/15 text-amber-400',
  CONNECTED: 'bg-emerald-500/15 text-emerald-400',
  CONFIRMED: 'bg-emerald-500/15 text-emerald-400',
  PENDING_UNDERSTANDING: 'bg-amber-500/15 text-amber-400',
  AWAITING_USER_CONFIRM: 'bg-amber-500/15 text-amber-400',
  REJECTED: 'bg-rose-500/15 text-rose-400',
  EXPIRED: 'bg-rose-500/15 text-rose-400',
  ACTIVE: 'bg-emerald-500/15 text-emerald-400',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={cn('badge', STATUS_COLORS[status] ?? 'bg-black/10 dark:bg-white/10 text-muted')}>{status}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
