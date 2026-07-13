'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, FlaskConical, Hand, Pencil, Play, Webhook, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { API } from '@/lib/api';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';

interface Agent {
  id: string;
  name: string;
  description?: string | null;
  avatar?: string | null;
  status: string;
  skillCount: number;
  workflowCount: number;
}

interface TriggerLike {
  type?: string;
  cron?: string;
  timezone?: string;
  schedule?: string;
  keywords?: string[];
  event?: string;
  topic?: string;
  [key: string]: unknown;
}

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string | null;
  trigger?: TriggerLike | null;
  enabled: boolean;
  stepCount?: number;
}

/** Mode badge: 定期 (schedule) / 手動 (manual) / 觸發 (webhook, event, keyword). */
const TRIGGER_MODE: Record<string, { label: string; icon: typeof Clock; tone: string }> = {
  schedule: { label: '定期', icon: Clock, tone: 'bg-blue-500/15 text-blue-400' },
  manual: { label: '手動', icon: Hand, tone: 'bg-black/10 text-muted dark:bg-white/10' },
  webhook: { label: '觸發', icon: Webhook, tone: 'bg-amber-500/15 text-amber-400' },
  event: { label: '觸發', icon: Zap, tone: 'bg-amber-500/15 text-amber-400' },
  keyword: { label: '觸發', icon: Zap, tone: 'bg-amber-500/15 text-amber-400' },
};

function triggerDetail(t?: TriggerLike | null): string | null {
  if (!t) return null;
  if (t.type === 'schedule') return t.cron ?? t.schedule ?? null;
  if (t.type === 'event') return t.topic ?? t.event ?? null;
  if (t.type === 'webhook') return 'webhook';
  return null;
}

function TriggerBadge({ trigger }: { trigger?: TriggerLike | null }) {
  const type = trigger?.type && TRIGGER_MODE[trigger.type] ? trigger.type : 'manual';
  const mode = TRIGGER_MODE[type];
  const detail = triggerDetail(trigger);
  const keywords = type === 'keyword' ? trigger?.keywords ?? [] : [];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cn('badge shrink-0', mode.tone)}>
        <mode.icon className="mr-1 h-3 w-3" /> {mode.label}
      </span>
      {detail && <span className="truncate font-mono text-xs text-muted">{detail}</span>}
      {keywords.map((kw) => (
        <span key={kw} className="badge shrink-0 bg-black/10 text-muted dark:bg-white/10">
          {kw}
        </span>
      ))}
    </div>
  );
}

export default function WorkflowsPage() {
  const router = useRouter();
  const qc = useQueryClient();

  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: () => API.get<Agent[]>('/api/agents') });
  const agents = agentsQ.data ?? [];

  const workflowQueries = useQueries({
    queries: agents.map((a) => ({
      queryKey: ['agent-workflows', a.id],
      queryFn: () => API.get<WorkflowSummary[]>(`/api/agents/${a.id}/workflows`),
    })),
  });

  useAwp(['workflow.triggered', 'schedule.fired'], (frame) => {
    if (frame.kind === 'event' && (frame.topic === 'workflow.triggered' || frame.topic === 'schedule.fired')) {
      agents.forEach((a) => qc.invalidateQueries({ queryKey: ['agent-workflows', a.id] }));
    }
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => API.patch(`/api/workflows/${id}`, { enabled }),
    onSuccess: () => agents.forEach((a) => qc.invalidateQueries({ queryKey: ['agent-workflows', a.id] })),
  });

  const runMut = useMutation({
    mutationFn: (id: string) => API.post<{ runId: string }>(`/api/workflows/${id}/run`, {}),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => API.post<{ runId: string }>(`/api/workflows/${id}/test`, {}),
  });

  async function handleRun(id: string) {
    try {
      const { runId } = await runMut.mutateAsync(id);
      router.push(`/workflows/${id}?run=${runId}`);
    } catch {
      // surfaced via runMut.isError on this row's button state
    }
  }

  async function handleTest(id: string) {
    try {
      const { runId } = await testMut.mutateAsync(id);
      router.push(`/workflows/${id}?run=${runId}`);
    } catch {
      // surfaced via testMut.isError on this row's button state
    }
  }

  const loading = agentsQ.isLoading || workflowQueries.some((q) => q.isLoading);

  return (
    <AppShell>
      <PageHeader title="工作流 Workflows" subtitle="跨員工的自動化流程總覽" />

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      )}

      {!loading && agents.length === 0 && <EmptyState title="尚無員工" hint="請先建立員工 Agent，才能為其設定工作流" />}

      {!loading && agents.length > 0 && (
        <div className="space-y-6">
          {agents.map((agent, idx) => {
            const wfQuery = workflowQueries[idx];
            const workflows = wfQuery?.data ?? [];
            return (
              <section key={agent.id} className="card p-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-brand/10 text-sm font-semibold text-brand">
                    {agent.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={agent.avatar} alt="" className="h-9 w-9 object-cover" />
                    ) : (
                      agent.name.slice(0, 1)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{agent.name}</div>
                    <div className="truncate text-xs text-muted">{agent.description || '—'}</div>
                  </div>
                  <StatusBadge status={agent.status} />
                </div>

                {wfQuery?.isError ? (
                  <p className="py-4 text-center text-sm text-rose-400">載入此員工的工作流失敗</p>
                ) : workflows.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted">此員工尚無工作流</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {workflows.map((wf) => (
                      <li key={wf.id} className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap">
                        <WorkflowIcon className="h-4 w-4 shrink-0 text-muted" />
                        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                          <Link href={`/workflows/${wf.id}`} className="font-medium hover:text-brand">
                            {wf.name}
                          </Link>
                          {wf.description && <p className="truncate text-xs text-muted">{wf.description}</p>}
                          <div className="mt-1.5">
                            <TriggerBadge trigger={wf.trigger} />
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0 transition-colors', wf.enabled ? 'bg-brand' : 'bg-border')}
                            onClick={() => toggleMut.mutate({ id: wf.id, enabled: !wf.enabled })}
                            title={wf.enabled ? '已啟用（點擊停用）' : '已停用（點擊啟用）'}
                          >
                            <span
                              className={cn(
                                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                                wf.enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
                              )}
                            />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost shrink-0 whitespace-nowrap"
                            onClick={() => handleTest(wf.id)}
                            disabled={testMut.isPending}
                            title="以測試模式執行，不影響正式紀錄"
                          >
                            <FlaskConical className="h-3.5 w-3.5" /> 測試
                          </button>
                          <button type="button" className="btn-primary shrink-0 whitespace-nowrap" onClick={() => handleRun(wf.id)} disabled={runMut.isPending}>
                            <Play className="h-3.5 w-3.5" /> 執行
                          </button>
                          <Link href={`/workflows/${wf.id}`} className="btn-ghost shrink-0 p-2" title="編輯">
                            <Pencil className="h-4 w-4" />
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
