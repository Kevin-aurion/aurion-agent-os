'use client';

import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { API } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import { PageHeader, Spinner, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';
import { auditZh, entityZh } from '@/lib/auditzh';

interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  detail?: unknown;
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

export default function AuditPage() {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['audit', 50],
    queryFn: () => API.get<AuditEntry[]>('/audit?limit=50'),
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (row) =>
        row.action.toLowerCase().includes(q) ||
        auditZh(row.action).toLowerCase().includes(q) ||
        row.entity.toLowerCase().includes(q) ||
        entityZh(row.entity).toLowerCase().includes(q) ||
        row.entityId?.toLowerCase().includes(q)
    );
  }, [data, filter]);

  return (
    <AppShell>
      <PageHeader title="稽核紀錄 Audit Log" subtitle="系統操作與事件的稽核追蹤" />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9"
            placeholder="依 action / entity / entityId 過濾"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {data && (
          <span className="text-sm text-muted">
            顯示 {filtered.length} / {data.length} 筆
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      )}

      {isError && <EmptyState title="無法載入稽核紀錄" hint="請稍後重試" />}

      {!isLoading && !isError && filtered.length === 0 && (
        <EmptyState title="沒有符合的稽核紀錄" hint="試試調整過濾條件" />
      )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Entity ID</th>
                <th className="px-3 py-2 font-medium">時間</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isOpen = expanded === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      key={row.id}
                      className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-white/[0.03]"
                      onClick={() => setExpanded(isOpen ? null : row.id)}
                    >
                      <td className="px-3 py-2 text-muted">
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </td>
                      <td className="px-3 py-2 font-medium">
                        {auditZh(row.action)}
                        <span className="ml-1.5 text-xs font-normal text-muted">{row.action}</span>
                      </td>
                      <td className="px-3 py-2 text-muted">{entityZh(row.entity)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted">{row.entityId}</td>
                      <td className="px-3 py-2 text-muted" title={new Date(row.createdAt).toLocaleString('zh-Hant-TW')}>
                        {timeAgo(row.createdAt)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={cn('border-b border-border/60 last:border-0 bg-black/10')}>
                        <td />
                        <td colSpan={4} className="px-3 py-3">
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-xs text-muted">
                            {row.detail ? JSON.stringify(row.detail, null, 2) : '（無詳細內容）'}
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
    </AppShell>
  );
}
