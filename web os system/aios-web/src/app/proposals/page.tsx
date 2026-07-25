'use client';

import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { API } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { AppShell } from '@/components/AppShell';
import { PageHeader, Spinner, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface PendingProposal {
  id: string;
  agentId: string;
  runId?: string | null;
  source: 'OPERATOR' | 'VIOLATION' | 'SEMANTIC' | string;
  proposedBy: string;
  targetType: 'SKILL' | 'RESTRICTION' | 'IDENTITY_CARD' | string;
  targetId?: string | null;
  proposedChange: unknown;
  severity: string;
  confidence?: number | null;
  status: string;
  createdAt: string;
  agent?: { id: string; name: string; slug: string } | null;
}

interface ApproveResult {
  proposal: PendingProposal;
  resultingVersionId?: string;
}

const SOURCE_ZH: Record<string, string> = {
  OPERATOR: '操作者',
  VIOLATION: '越矩',
  SEMANTIC: '語意',
};

const TARGET_ZH: Record<string, string> = {
  SKILL: '技能',
  RESTRICTION: '限制',
  IDENTITY_CARD: '身份卡',
};

function sourceLabel(source: string) {
  return SOURCE_ZH[source] ?? source;
}

function targetLabel(t: string) {
  return TARGET_ZH[t] ?? t;
}

function severityClass(severity: string) {
  const s = severity.toLowerCase();
  if (s === 'high') return 'bg-rose-500/15 text-rose-400';
  if (s === 'medium') return 'bg-amber-500/15 text-amber-400';
  return 'bg-zinc-500/15 text-zinc-400';
}

function timeAgo(iso: string) {
  const d = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - d);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleString('zh-Hant-TW');
}

function changeSummary(change: unknown, max = 80): string {
  try {
    const raw = typeof change === 'string' ? change : JSON.stringify(change);
    if (raw.length <= max) return raw;
    return raw.slice(0, max) + '…';
  } catch {
    return String(change);
  }
}

export default function ProposalsPage() {
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Role gate: only FDE may fetch the inbox.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['proposals'],
    queryFn: () => API.get<PendingProposal[]>('/api/proposals'),
    enabled: isFde,
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => API.post<ApproveResult>(`/api/proposals/${id}/approve`),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      if (result.resultingVersionId) {
        setFlash(`已產生版本 ${result.resultingVersionId.slice(0, 8)}`);
      } else {
        setFlash('已核准提案');
      }
      setActionError(null);
    },
    onError: (e: Error) => {
      setActionError(e.message || '核准失敗');
    },
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => API.post<PendingProposal>(`/api/proposals/${id}/reject`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      setFlash('已駁回提案');
      setActionError(null);
    },
    onError: (e: Error) => {
      setActionError(e.message || '駁回失敗');
    },
  });

  async function handleApprove(id: string) {
    setBusyId(id);
    try {
      await approveMut.mutateAsync(id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string) {
    setBusyId(id);
    try {
      await rejectMut.mutateAsync(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell>
      <PageHeader title="提案審核 Proposals" subtitle="FDE 審核待決的變更提案（技能／限制／身份卡）" />

      {!isFde && (
        <EmptyState title="僅 FDE 可審核提案" hint="此頁面僅供 OWNER / TRAINER 使用" />
      )}

      {isFde && (
        <>
          {flash && (
            <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-400">
              {flash}
              <button type="button" className="ml-3 text-xs underline" onClick={() => setFlash(null)}>
                關閉
              </button>
            </div>
          )}
          {actionError && (
            <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-400">
              {actionError}
            </div>
          )}

          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Spinner />
            </div>
          )}

          {isError && <EmptyState title="無法載入待審提案" hint="請稍後重試" />}

          {!isLoading && !isError && (data?.length ?? 0) === 0 && (
            <EmptyState title="目前沒有待審提案" hint="操作者送出或系統偵測到的變更會出現在此" />
          )}

          {!isLoading && !isError && data && data.length > 0 && (
            <div className="card overflow-hidden p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="w-8 px-3 py-2" />
                    <th className="px-3 py-2 font-medium">員工</th>
                    <th className="px-3 py-2 font-medium">來源</th>
                    <th className="px-3 py-2 font-medium">目標</th>
                    <th className="px-3 py-2 font-medium">嚴重度</th>
                    <th className="px-3 py-2 font-medium">提出者</th>
                    <th className="px-3 py-2 font-medium">時間</th>
                    <th className="px-3 py-2 font-medium">變更摘要</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => {
                    const isOpen = expanded === row.id;
                    const busy = busyId === row.id;
                    return (
                      <Fragment key={row.id}>
                        <tr className="border-b border-border/60 last:border-0 hover:bg-white/[0.03]">
                          <td
                            className="cursor-pointer px-3 py-2 text-muted"
                            onClick={() => setExpanded(isOpen ? null : row.id)}
                          >
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="px-3 py-2 font-medium">
                            {row.agent?.name ?? row.agentId.slice(0, 8)}
                            {row.agent?.slug && (
                              <span className="ml-1.5 text-xs font-normal text-muted">{row.agent.slug}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted">{sourceLabel(row.source)}</td>
                          <td className="px-3 py-2 text-muted">
                            {targetLabel(row.targetType)}
                            {row.targetId && (
                              <span className="ml-1 font-mono text-xs text-muted/70">
                                {row.targetId.slice(0, 8)}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={cn('badge', severityClass(row.severity))}>{row.severity}</span>
                          </td>
                          <td className="max-w-[8rem] truncate px-3 py-2 font-mono text-xs text-muted" title={row.proposedBy}>
                            {row.proposedBy === 'system' ? 'system' : row.proposedBy.slice(0, 10)}
                          </td>
                          <td
                            className="px-3 py-2 text-muted"
                            title={new Date(row.createdAt).toLocaleString('zh-Hant-TW')}
                          >
                            {timeAgo(row.createdAt)}
                          </td>
                          <td
                            className="max-w-[12rem] cursor-pointer truncate px-3 py-2 font-mono text-xs text-muted"
                            title={changeSummary(row.proposedChange, 200)}
                            onClick={() => setExpanded(isOpen ? null : row.id)}
                          >
                            {changeSummary(row.proposedChange)}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                className="btn-primary px-2 py-1 text-xs"
                                disabled={busy}
                                onClick={() => void handleApprove(row.id)}
                                title="核准"
                              >
                                {busy && approveMut.isPending ? (
                                  <Spinner className="h-3 w-3 border-white/40 border-t-white" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                核准
                              </button>
                              <button
                                type="button"
                                className="btn-ghost px-2 py-1 text-xs text-rose-400"
                                disabled={busy}
                                onClick={() => void handleReject(row.id)}
                                title="駁回"
                              >
                                {busy && rejectMut.isPending ? (
                                  <Spinner className="h-3 w-3" />
                                ) : (
                                  <X className="h-3.5 w-3.5" />
                                )}
                                駁回
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-border/60 last:border-0 bg-black/10">
                            <td />
                            <td colSpan={8} className="px-3 py-3">
                              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-xs text-muted">
                                {row.proposedChange
                                  ? JSON.stringify(row.proposedChange, null, 2)
                                  : '（無變更內容）'}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
