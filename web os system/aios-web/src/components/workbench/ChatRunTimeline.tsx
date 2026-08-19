'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { StatusBadge } from '@/components/ui';
import { TERMINAL_RUN_PHASES, type RunStep } from './types';

function phaseIcon(phase: string) {
  const p = phase?.toLowerCase?.() ?? '';
  if (p === 'approved' || p === 'succeeded' || p === 'passed') {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  }
  if (p === 'rejected' || p === 'failed' || p === 'error' || p === 'timeout' || p === 'cancelled') {
    return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  }
  if (TERMINAL_RUN_PHASES.has(p)) {
    return <CheckCircle2 className="h-3.5 w-3.5 text-muted" />;
  }
  // In-progress: executing, verifying, awaiting_review, …
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />;
}

/** Live run steps under a user chat bubble (from run.step WS events with `phase`). */
export function ChatRunTimeline({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) {
    return (
      <div className="flex max-w-[80%] items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 等待執行中...
      </div>
    );
  }
  return (
    <div className="max-w-[80%] space-y-1.5 rounded-xl border border-border bg-panel px-3 py-2.5">
      {steps.map((s, idx) => (
        <div key={`${s.stepKey}-${s.round ?? idx}`} className="flex items-center gap-2 text-xs">
          {phaseIcon(s.phase)}
          <span className="font-medium">{s.stepKey}</span>
          {typeof s.round === 'number' && <span className="text-muted">第 {s.round} 輪</span>}
          <StatusBadge status={s.phase} />
          {s.verdict && <span className="text-muted">· {s.verdict}</span>}
        </div>
      ))}
    </div>
  );
}
