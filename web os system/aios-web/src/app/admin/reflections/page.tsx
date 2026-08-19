'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BrainCircuit,
  CheckCircle2,
  Clock3,
  FileCheck2,
  MessageSquareText,
  Play,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { API } from '@/lib/api';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';

interface ReflectionCycle {
  id: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  triggeredBy: string;
  sourceMessageCount: number;
  analyzedFeedbackCount: number;
  summary?: {
    overview?: string;
    themes?: string[];
    positiveCount?: number;
    negativeCount?: number;
    mixedCount?: number;
    neutralCount?: number;
  } | null;
  error?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  feedbackCount: number;
  suggestionCount: number;
}

interface ReflectionIndex {
  schedule: { cron: string; times: readonly string[]; timezone: string };
  agent: { id: string; name: string; slug: string };
  cycles: ReflectionCycle[];
}

interface Feedback {
  id: string;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
  categories: string[];
  excerpt: string;
  reason?: string | null;
  messageAt: string;
  user?: { displayName: string; email: string } | null;
  agent?: { name: string; slug: string } | null;
}

interface Suggestion {
  id: string;
  targetType: 'AGENT' | 'SKILL';
  title: string;
  rationale: string;
  proposedGuidance: string;
  evidenceMessageIds: string[];
  confidence?: number | null;
  priority: string;
  status: 'PENDING' | 'PROPOSED' | 'DISMISSED';
  changeProposalId?: string | null;
  agent?: { name: string; slug: string } | null;
  skill?: { name: string; slug: string } | null;
}

interface ReflectionDetail extends Omit<ReflectionCycle, 'feedbackCount' | 'suggestionCount'> {
  feedback: Feedback[];
  suggestions: Suggestion[];
}

const SENTIMENT = {
  POSITIVE: { label: '正面回饋', icon: ThumbsUp, className: 'bg-emerald-500/15 text-emerald-400' },
  NEGATIVE: { label: '困擾／負面', icon: ThumbsDown, className: 'bg-rose-500/15 text-rose-400' },
  MIXED: { label: '混合', icon: MessageSquareText, className: 'bg-amber-500/15 text-amber-400' },
  NEUTRAL: { label: '一般使用', icon: MessageSquareText, className: 'bg-zinc-500/15 text-zinc-400' },
} as const;

function dateTime(value: string) {
  return new Date(value).toLocaleString('zh-Hant-TW', { hour12: false });
}

export default function ReflectionsPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const indexQ = useQuery({
    queryKey: ['reflections'],
    queryFn: () => API.get<ReflectionIndex>('/api/reflections'),
    refetchInterval: 30_000,
  });
  useEffect(() => {
    if (!selectedId && indexQ.data?.cycles[0]?.id) setSelectedId(indexQ.data.cycles[0].id);
  }, [indexQ.data, selectedId]);

  const detailQ = useQuery({
    queryKey: ['reflection', selectedId],
    queryFn: () => API.get<ReflectionDetail>(`/api/reflections/${selectedId}`),
    enabled: !!selectedId,
  });

  useAwp(['reflection.*'], () => {
    void qc.invalidateQueries({ queryKey: ['reflections'] });
    void qc.invalidateQueries({ queryKey: ['reflection'] });
  });

  const runMut = useMutation({
    mutationFn: () => API.post<{ jobId: string; status: string }>('/api/reflections/run'),
    onSuccess: () => { setNotice('已排入反思佇列；完成後頁面會自動更新。'); setError(null); },
    onError: (e: Error) => setError(e.message),
  });
  const proposeMut = useMutation({
    mutationFn: (id: string) => API.post<{ proposalId: string }>(`/api/reflection-suggestions/${id}/propose`),
    onSuccess: () => {
      setNotice('建議已送到提案審核；尚未變更 Agent 或 Skill。');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['reflection', selectedId] });
      void qc.invalidateQueries({ queryKey: ['proposals'] });
    },
    onError: (e: Error) => setError(e.message),
  });
  const dismissMut = useMutation({
    mutationFn: (id: string) => API.post(`/api/reflection-suggestions/${id}/dismiss`),
    onSuccess: () => {
      setNotice('已忽略這項建議。');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['reflection', selectedId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const pendingCount = useMemo(
    () => detailQ.data?.suggestions.filter((item) => item.status === 'PENDING').length ?? 0,
    [detailQ.data],
  );

  return (
    <AppShell>
      <PageHeader
        title="反思與優化 Reflections"
        subtitle="定時整理員工回饋，由獨立 Agent 提出建議；任何變更仍需 FDE 核准。"
        action={(
          <button className="btn-primary text-sm" disabled={runMut.isPending} onClick={() => runMut.mutate()}>
            {runMut.isPending ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            立即整理
          </button>
        )}
      />

      {notice && <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</div>}
      {error && <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}

      {indexQ.isLoading && <div className="grid place-items-center py-20"><Spinner /></div>}
      {indexQ.isError && <EmptyState title="無法載入反思中心" hint="請確認後端與資料庫連線" />}

      {indexQ.data && (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <section className="card p-5 lg:col-span-2">
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand/15 text-brand"><BrainCircuit className="h-5 w-5" /></div>
                <div>
                  <div className="font-semibold">{indexQ.data.agent.name}</div>
                  <p className="mt-1 text-sm leading-relaxed text-muted">只讀取已遮罩的員工訊息並提出建議，不具備自動修改 Agent／Skill 的權限。</p>
                </div>
              </div>
            </section>
            <section className="card p-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Clock3 className="h-4 w-4 text-brand" />固定整理時間</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {indexQ.data.schedule.times.map((time) => <span key={time} className="badge bg-brand/10 text-brand">{time}</span>)}
              </div>
              <div className="mt-2 text-xs text-muted">時區：{indexQ.data.schedule.timezone}</div>
            </section>
          </div>

          <div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
            <aside className="space-y-2">
              <div className="mb-3 text-sm font-medium">整理紀錄</div>
              {indexQ.data.cycles.length === 0 && <div className="card p-4 text-sm text-muted">尚無反思紀錄，可先按「立即整理」。</div>}
              {indexQ.data.cycles.map((cycle) => (
                <button
                  key={cycle.id}
                  type="button"
                  onClick={() => setSelectedId(cycle.id)}
                  className={cn('card w-full p-4 text-left transition-colors', selectedId === cycle.id && 'border-brand/50 bg-brand/5')}
                >
                  <div className="flex items-center justify-between gap-2"><StatusBadge status={cycle.status} /><span className="text-xs text-muted">{cycle.suggestionCount} 建議</span></div>
                  <div className="mt-3 text-sm font-medium">{dateTime(cycle.windowStart)}</div>
                  <div className="mt-0.5 text-xs text-muted">至 {dateTime(cycle.windowEnd)}</div>
                  <div className="mt-2 text-xs text-muted">{cycle.sourceMessageCount} 則員工訊息</div>
                </button>
              ))}
            </aside>

            <main className="min-w-0 space-y-6">
              {detailQ.isLoading && <div className="grid place-items-center py-20"><Spinner /></div>}
              {detailQ.data && (
                <>
                  <section className="card p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div><h2 className="font-semibold">本期摘要</h2><p className="mt-1 text-xs text-muted">{dateTime(detailQ.data.windowStart)} ～ {dateTime(detailQ.data.windowEnd)}</p></div>
                      <div className="flex gap-2"><span className="badge bg-emerald-500/15 text-emerald-400">正面 {detailQ.data.summary?.positiveCount ?? 0}</span><span className="badge bg-rose-500/15 text-rose-400">負面 {detailQ.data.summary?.negativeCount ?? 0}</span><span className="badge bg-amber-500/15 text-amber-400">混合 {detailQ.data.summary?.mixedCount ?? 0}</span></div>
                    </div>
                    {detailQ.data.summary?.overview && <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">{detailQ.data.summary.overview}</p>}
                    {(detailQ.data.summary?.themes?.length ?? 0) > 0 && <div className="mt-4 flex flex-wrap gap-2">{detailQ.data.summary!.themes!.map((theme) => <span key={theme} className="badge bg-black/5 text-muted dark:bg-white/5">{theme}</span>)}</div>}
                    {detailQ.data.error && <p className="mt-4 text-sm text-rose-400">{detailQ.data.error}</p>}
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between"><div><h2 className="font-semibold">優化建議</h2><p className="text-sm text-muted">{pendingCount} 項待 FDE 決定</p></div><Link href="/proposals" className="btn-ghost text-xs"><FileCheck2 className="h-4 w-4" />前往提案審核</Link></div>
                    {detailQ.data.suggestions.length === 0 && <EmptyState title="本期沒有足夠證據提出建議" hint="反思 Agent 不會為了湊數產生變更" />}
                    {detailQ.data.suggestions.map((item) => (
                      <article key={item.id} className="card p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-brand" /><h3 className="font-semibold">{item.title}</h3></div><p className="mt-1 text-xs text-muted">{item.targetType === 'SKILL' ? `Skill：${item.skill?.name ?? item.skill?.slug ?? '未知'}` : `Agent：${item.agent?.name ?? item.agent?.slug ?? '未知'}`} · 證據 {item.evidenceMessageIds.length} 則</p></div>
                          <span className={cn('badge', item.priority === 'high' ? 'bg-rose-500/15 text-rose-400' : item.priority === 'medium' ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-500/15 text-zinc-400')}>{item.status} · {item.priority}</span>
                        </div>
                        <p className="mt-4 text-sm leading-relaxed">{item.rationale}</p>
                        <div className="mt-4 rounded-lg border border-border bg-black/5 p-3 dark:bg-black/20"><div className="mb-1 text-xs font-medium text-muted">建議追加的指引</div><p className="whitespace-pre-wrap text-sm leading-relaxed">{item.proposedGuidance}</p></div>
                        {item.status === 'PENDING' && <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost text-sm text-rose-400" disabled={dismissMut.isPending || proposeMut.isPending} onClick={() => dismissMut.mutate(item.id)}><X className="h-4 w-4" />忽略</button><button className="btn-primary text-sm" disabled={dismissMut.isPending || proposeMut.isPending} onClick={() => proposeMut.mutate(item.id)}><CheckCircle2 className="h-4 w-4" />送交變更審核</button></div>}
                        {item.status === 'PROPOSED' && <p className="mt-4 text-right text-xs text-amber-400">已送交提案；尚未套用，需在提案審核頁再次核准。</p>}
                      </article>
                    ))}
                  </section>

                  <section className="space-y-3">
                    <div><h2 className="font-semibold">員工原始回饋（已遮罩）</h2><p className="text-sm text-muted">包含正面、負面與一般使用訊息，方便 FDE 對照建議。</p></div>
                    {detailQ.data.feedback.length === 0 && <EmptyState title="這個時段沒有員工訊息" />}
                    {detailQ.data.feedback.map((item) => {
                      const sentiment = SENTIMENT[item.sentiment];
                      const Icon = sentiment.icon;
                      return <article key={item.id} className="card p-4"><div className="flex flex-wrap items-center gap-2"><span className={cn('badge', sentiment.className)}><Icon className="mr-1 h-3 w-3" />{sentiment.label}</span><span className="text-sm font-medium">{item.user?.displayName ?? '未知員工'}</span><span className="text-xs text-muted">對 {item.agent?.name ?? '未知 Agent'}</span><span className="ml-auto text-xs text-muted">{dateTime(item.messageAt)}</span></div><blockquote className="mt-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-relaxed">{item.excerpt}</blockquote>{item.reason && <p className="mt-2 text-xs text-muted">判斷：{item.reason}</p>}{item.categories.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{item.categories.map((category) => <span key={category} className="badge bg-black/5 text-muted dark:bg-white/5">{category}</span>)}</div>}</article>;
                    })}
                  </section>
                </>
              )}
            </main>
          </div>
        </>
      )}
    </AppShell>
  );
}
