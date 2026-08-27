'use client';

import { CheckCircle2, Loader2, Square, XCircle } from 'lucide-react';
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
function runStatusLabel(status?: string): string | null {
  if (status === 'SUCCEEDED') return '已完成';
  if (status === 'FAILED') return '執行失敗';
  if (status === 'CANCELLED') return '已停止';
  if (status === 'AWAITING_REVIEW') return '等待核准';
  return null;
}

export function ChatRunTimeline({
  steps,
  status,
  onStop,
  stopping = false,
}: {
  steps: RunStep[];
  status?: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const terminal = status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
  const statusText = runStatusLabel(status);
  if (steps.length === 0) {
    return (
      <div className="flex max-w-[80%] items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2 text-xs text-muted">
        {terminal ? (
          status === 'SUCCEEDED' ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-rose-400" />
          )
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
        {statusText ?? '等待執行中...'}
        {status === 'RUNNING' && onStop && (
          <button
            type="button"
            className="ml-2 inline-flex items-center gap-1 text-rose-400 hover:text-rose-300"
            onClick={onStop}
            disabled={stopping}
          >
            {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            停止
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-[80%] space-y-1.5 rounded-xl border border-border bg-panel px-3 py-2.5">
      {steps.map((s, idx) => {
        const visiblePhase = terminal && !TERMINAL_RUN_PHASES.has(s.phase.toLowerCase())
          ? status!.toLowerCase()
          : s.phase;
        return (
        <div key={`${s.stepKey}-${s.round ?? idx}`} className="flex items-center gap-2 text-xs">
          {phaseIcon(visiblePhase)}
          <span className="font-medium">{s.stepKey}</span>
          {typeof s.round === 'number' && <span className="text-muted">第 {s.round} 輪</span>}
          <StatusBadge status={visiblePhase} />
          {s.verdict && <span className="text-muted">· {s.verdict}</span>}
        </div>
        );
      })}
      {status === 'RUNNING' && onStop && (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300"
          onClick={onStop}
          disabled={stopping}
        >
          {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
          停止執行
        </button>
      )}
    </div>
  );
}
