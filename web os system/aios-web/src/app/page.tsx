'use client';

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Wrench,
  CheckCircle2,
  Clock3,
  Workflow,
  Plug,
  Wifi,
  Activity,
  CheckCircle,
  XCircle,
  Ban,
  Eye,
  Cog,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { PageHeader, EmptyState, StatusBadge, Spinner } from '@/components/ui';
import { API } from '@/lib/api';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';
import { auditZh, entityZh } from '@/lib/auditzh';

interface DashboardSummary {
  agents: { active: number };
  skills: Record<string, number>;
  workflows: { enabled: number };
  runsToday: Record<string, number>;
  connectedAccounts: unknown[];
  wsConnections: number;
}

interface RecentRun {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
}

interface AuditItem {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  detail?: unknown;
}

interface PreflightResult {
  engines?: Record<string, boolean>;
  integrations?: Record<string, boolean>;
  ok?: boolean;
  [key: string]: unknown;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return '剛剛';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小時前`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} 天前`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: typeof Bot;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'brand';
}) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <div
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-lg',
          tone === 'brand' ? 'bg-brand/15 text-brand' : 'bg-black/5 text-fg dark:bg-white/10',
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted">{label}</div>
        <div className="mt-0.5 text-2xl font-semibold tracking-tight">{value}</div>
        {hint && <div className="mt-0.5 truncate text-[11px] text-muted">{hint}</div>}
      </div>
    </div>
  );
}

const RUN_STATUS_ICON: Record<string, typeof Activity> = {
  RUNNING: Activity,
  SUCCEEDED: CheckCircle,
  FAILED: XCircle,
  CANCELLED: Ban,
  AWAITING_REVIEW: Eye,
};

function sumStatuses(byStatus: Record<string, number> | undefined): number {
  if (!byStatus) return 0;
  return Object.values(byStatus).reduce((a, b) => a + b, 0);
}

export default function DashboardPage() {
  const qc = useQueryClient();

  const summaryQuery = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => API.get<DashboardSummary>('/dashboard/summary'),
    refetchInterval: 30000,
  });

  const recentRunsQuery = useQuery({
    queryKey: ['dashboard', 'recent-runs'],
    queryFn: () => API.get<RecentRun[]>('/dashboard/recent-runs?limit=20'),
    refetchInterval: 30000,
  });

  const auditQuery = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => API.get<AuditItem[]>('/audit?limit=50'),
    refetchInterval: 60000,
  });

  const preflightQuery = useQuery({
    queryKey: ['preflight'],
    queryFn: () => API.get<PreflightResult>('/preflight'),
    retry: false,
    refetchInterval: 60000,
  });

  useAwp(['run.*'], (frame) => {
    if (frame.topic?.startsWith('run.')) {
      qc.invalidateQueries({ queryKey: ['dashboard', 'summary'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'recent-runs'] });
    }
  });

  const summary = summaryQuery.data;
  const skillsConfirmed = summary?.skills?.CONFIRMED ?? 0;
  const skillsPending =
    (summary?.skills?.PENDING_UNDERSTANDING ?? 0) + (summary?.skills?.AWAITING_USER_CONFIRM ?? 0);
  const runsTodayTotal = useMemo(() => sumStatuses(summary?.runsToday), [summary]);

  const engineEntries = Object.entries(preflightQuery.data?.engines ?? {});
  const integrationEntries = Object.entries(preflightQuery.data?.integrations ?? {});

  return (
    <AppShell>
      <PageHeader title="總覽 Dashboard" subtitle="AIOS 代理工作站即時狀態" />

      {summaryQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : summaryQuery.isError ? (
        <EmptyState title="無法載入總覽資料" hint="請確認後端服務是否正常運作" />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard icon={Bot} label="活躍員工 Agents" value={summary?.agents?.active ?? 0} tone="brand" />
          <StatCard
            icon={Wrench}
            label="技能 Skills"
            value={skillsConfirmed}
            hint={skillsPending > 0 ? `${skillsPending} 待審核` : '全部已確認'}
          />
          <StatCard icon={Workflow} label="工作流 Workflows" value={summary?.workflows?.enabled ?? 0} />
          <StatCard
            icon={Clock3}
            label="今日執行 Runs today"
            value={runsTodayTotal}
            hint={summary?.runsToday ? Object.entries(summary.runsToday).map(([k, v]) => `${k}: ${v}`).join(' · ') : undefined}
          />
          <StatCard icon={Plug} label="已連結帳號 Accounts" value={summary?.connectedAccounts?.length ?? 0} />
          <StatCard icon={Wifi} label="即時連線 WS" value={summary?.wsConnections ?? 0} tone="brand" />
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border p-4">
            <h2 className="text-sm font-semibold">近期執行 Recent runs</h2>
            {recentRunsQuery.isFetching && <Spinner className="h-4 w-4" />}
          </div>
          {recentRunsQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner className="h-5 w-5" />
            </div>
          ) : recentRunsQuery.isError ? (
            <div className="p-6">
              <EmptyState title="無法載入執行紀錄" />
            </div>
          ) : !recentRunsQuery.data?.length ? (
            <div className="p-6">
              <EmptyState title="尚無執行紀錄" hint="當工作流開始執行時會顯示於此" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">員工 Agent</th>
                    <th className="px-4 py-2 font-medium">狀態</th>
                    <th className="px-4 py-2 font-medium">觸發來源</th>
                    <th className="px-4 py-2 font-medium">開始時間</th>
                    <th className="px-4 py-2 font-medium">結束時間</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRunsQuery.data.map((run) => {
                    const Icon = RUN_STATUS_ICON[run.status] ?? Activity;
                    return (
                      <tr key={run.id} className="border-b border-border/60 last:border-0 hover:bg-black/5 dark:hover:bg-white/5">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <Icon className="h-3.5 w-3.5 text-muted" />
                            <span className="font-medium">{run.agentName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={run.status} />
                        </td>
                        <td className="px-4 py-2.5 text-muted">{run.triggeredBy}</td>
                        <td className="px-4 py-2.5 text-muted" title={run.startedAt}>
                          {relativeTime(run.startedAt)}
                        </td>
                        <td className="px-4 py-2.5 text-muted" title={run.finishedAt ?? undefined}>
                          {run.finishedAt ? relativeTime(run.finishedAt) : '進行中'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center gap-2 border-b border-border p-4">
            <Cog className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold">系統健康 System health</h2>
          </div>
          {preflightQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner className="h-5 w-5" />
            </div>
          ) : preflightQuery.isError ? (
            <div className="p-6">
              <EmptyState title="無法取得健康檢查" hint="/preflight 端點無回應" />
            </div>
          ) : (
            <div className="space-y-4 p-4">
              {engineEntries.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-medium text-muted">執行引擎 Engines</div>
                  <div className="space-y-1.5">
                    {engineEntries.map(([name, ok]) => (
                      <div key={name} className="flex items-center justify-between text-sm">
                        <span>{name}</span>
                        {ok ? (
                          <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 已安裝</span>
                        ) : (
                          <span className="flex items-center gap-1 text-rose-400"><XCircle className="h-3.5 w-3.5" /> 未安裝</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {integrationEntries.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-medium text-muted">整合服務 Integrations</div>
                  <div className="space-y-1.5">
                    {integrationEntries.map(([name, ok]) => (
                      <div key={name} className="flex items-center justify-between text-sm">
                        <span className="capitalize">{name}</span>
                        {ok ? (
                          <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 已設定</span>
                        ) : (
                          <span className="flex items-center gap-1 text-muted"><XCircle className="h-3.5 w-3.5" /> 未設定</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {engineEntries.length === 0 && integrationEntries.length === 0 && (
                <EmptyState title="無健康檢查資料" />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 card">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-sm font-semibold">稽核紀錄 Audit log</h2>
          {auditQuery.isFetching && <Spinner className="h-4 w-4" />}
        </div>
        {auditQuery.isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner className="h-5 w-5" />
          </div>
        ) : auditQuery.isError ? (
          <div className="p-6">
            <EmptyState title="無法載入稽核紀錄" />
          </div>
        ) : !auditQuery.data?.length ? (
          <div className="p-6">
            <EmptyState title="尚無稽核紀錄" />
          </div>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto">
            {auditQuery.data.slice(0, 10).map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{auditZh(item.action)}</span>
                  <span className="text-muted"> ({item.action})</span>
                  <span className="text-muted"> · {entityZh(item.entity)}#{item.entityId?.slice(0, 8)}</span>
                </div>
                <span className="shrink-0 text-xs text-muted">{relativeTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
