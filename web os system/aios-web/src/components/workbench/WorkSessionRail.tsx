'use client';

import Link from 'next/link';
import { CheckCircle2, Loader2, Shield, Square, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RunDetailView, WorkSessionState } from '@/lib/worksession';

const SUCCESS_PHASES = new Set(['approved', 'succeeded', 'passed']);
const FAIL_PHASES = new Set(['rejected', 'failed', 'error', 'timeout', 'cancelled']);

function phaseIcon(phase: string) {
  const p = (phase ?? '').toLowerCase();
  if (SUCCESS_PHASES.has(p)) {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />;
  }
  if (FAIL_PHASES.has(p)) {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />;
  }
  // In-progress: executing, verifying, awaiting_review, …
  return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" aria-hidden />;
}

function statusLabel(status: WorkSessionState['status']): string {
  switch (status) {
    case 'idle':
      return '準備中';
    case 'running':
      return '執行中';
    case 'awaiting_approval':
      return '等待核准';
    case 'finished':
      return '已完成';
    case 'failed':
      return '未完成';
    default:
      return '準備中';
  }
}

/**
 * When rehydrating an old thread (session still idle), fall back to runDetail
 * status so the rail does not show「準備中」while artifacts already exist.
 */
function displayStatusLabel(
  session: WorkSessionState,
  runDetail: RunDetailView | null,
): { label: string; tone: 'idle' | 'running' | 'awaiting_approval' | 'finished' | 'failed' } {
  if (session.status === 'idle' && runDetail?.status) {
    const rs = runDetail.status;
    if (rs === 'SUCCEEDED') return { label: '已完成', tone: 'finished' };
    if (rs === 'FAILED' || rs === 'CANCELLED') return { label: '未完成', tone: 'failed' };
    if (rs === 'RUNNING') return { label: '執行中', tone: 'running' };
    if (rs === 'AWAITING_REVIEW') return { label: '等待核准', tone: 'awaiting_approval' };
  }
  return { label: statusLabel(session.status), tone: session.status };
}

export function WorkSessionRail({
  session,
  runDetail,
  isFde,
  sourceLabel,
  onStop,
  stopping = false,
}: {
  session: WorkSessionState;
  runDetail: RunDetailView | null;
  isFde: boolean;
  sourceLabel?: string | null;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const toolSteps = session.steps.filter((s) => s.isTool);
  const artifacts = runDetail?.artifacts ?? [];
  const { label: statusText, tone: statusTone } = displayStatusLabel(session, runDetail);

  // Live session steps preferred; rehydrate from runDetail when empty.
  const progressFromSession = session.steps.length > 0;
  const detailSteps =
    !progressFromSession && runDetail?.steps && runDetail.steps.length > 0
      ? runDetail.steps
      : null;
  const showWaiting =
    session.steps.length === 0 && !detailSteps && session.status === 'running';
  const showEmpty =
    session.steps.length === 0 && !detailSteps && session.status !== 'running';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Status strip */}
      <div className="border-b border-border px-4 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted">任務狀態</span>
          <span
            className={cn(
              'font-medium',
              statusTone === 'finished' && 'text-emerald-400',
              statusTone === 'failed' && 'text-rose-400',
              statusTone === 'awaiting_approval' && 'text-amber-300',
              statusTone === 'running' && 'text-brand',
            )}
          >
            {statusText}
          </span>
        </div>
        {statusTone === 'running' && onStop && (
          <button
            type="button"
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
            onClick={onStop}
            disabled={stopping}
          >
            {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            停止這次執行
          </button>
        )}
      </div>

      {/* 1. Task progress */}
      <section className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          任務進度
        </div>
        {showWaiting && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            等待執行中…
          </div>
        )}
        {showEmpty && <p className="text-xs text-muted">尚無步驟</p>}
        {progressFromSession && (
          <ul className="space-y-2">
            {session.steps.map((s, idx) => (
              <li
                key={`${s.stepKey}-${s.round}-${idx}`}
                className="flex items-start gap-2 text-sm"
              >
                {phaseIcon(s.phase)}
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-snug">{s.kindLabel}</div>
                  <div className="truncate text-[11px] text-muted">{s.stepKey}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {detailSteps && (
          <ul className="space-y-2">
            {detailSteps.map((s, idx) => (
              <li
                key={`detail-${s.stepKey}-${s.round}-${idx}`}
                className="flex items-start gap-2 text-sm"
              >
                {phaseIcon(s.phase)}
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-snug">{s.stepKey || '處理步驟'}</div>
                  <div className="text-[11px] text-muted">第 {s.round} 輪</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 2. Tool calls — only live session.steps (history has no type) */}
      <section className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          工具呼叫
        </div>
        {toolSteps.length === 0 ? (
          <p className="text-xs text-muted">本次沒有使用工具</p>
        ) : (
          <ul className="space-y-1.5">
            {toolSteps.map((s, idx) => (
              <li
                key={`tool-${s.stepKey}-${s.round}-${idx}`}
                className="flex items-center gap-2 text-sm"
              >
                {phaseIcon(s.phase)}
                <span className="min-w-0 truncate font-medium">{s.kindLabel}</span>
                <span className="shrink-0 text-[11px] text-muted">{s.stepKey}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Approval banner — no approve/reject buttons on workbench */}
      {session.approvalPending && (
        <section className="border-b border-border p-4">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-100">
            <div className="font-medium text-amber-200">需要核准</div>
            <p className="mt-1 text-amber-100/90">
              已暫停，等待訓練師核准後才會繼續
            </p>
            {isFde && (
              <Link
                href="/admin"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
              >
                <Shield className="h-3.5 w-3.5" aria-hidden />
                前往管理中心處理
              </Link>
            )}
          </div>
        </section>
      )}

      {/* 4. Artifacts */}
      <section className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          產出
        </div>
        {artifacts.length === 0 ? (
          <p className="text-xs text-muted">任務完成後會在這裡顯示產出</p>
        ) : (
          <div className="space-y-2">
            {artifacts.map((a, idx) => (
              <details
                key={`art-${a.stepKey}-${idx}`}
                className="rounded-lg border border-border bg-panel px-3 py-2"
              >
                <summary className="cursor-pointer text-sm font-medium">
                  第 {idx + 1} 項產出
                  {a.stepKey ? (
                    <span className="ml-1.5 text-[11px] font-normal text-muted">
                      {a.stepKey}
                    </span>
                  ) : null}
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">
                  {a.content}
                </pre>
              </details>
            ))}
          </div>
        )}
      </section>

      {/* 5. Source */}
      <section className="p-4 text-xs text-muted">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide">來源</div>
        <p>
          {sourceLabel
            ? `來自任務：${sourceLabel}`
            : '來自此任務對話'}
        </p>
      </section>
    </div>
  );
}
