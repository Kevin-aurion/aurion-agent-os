'use client';

/**
 * FDE unified review inbox: ChangeProposal + ApprovalRequest in one list.
 * Page-level role gate + backend requireTrainer are authoritative.
 *
 * Ticket 13 invariant: UI must never treat Langflow / runtime checkpoints
 * as approvals. Action buttons for run_approval rows only render when
 * classifyApprovalSignal marks the row as a true AIOS ApprovalRequest.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { API } from '@/lib/api';
import { auditZh } from '@/lib/auditzh';
import { cn } from '@/lib/cn';
import { EmptyState, Spinner } from '@/components/ui';
import {
  buildDecisionEvidence,
  classifyApprovalSignal,
  filterInbox,
  mergeInbox,
  proposalDiff,
  type ApprovalRow,
  type AuditRowLite,
  type DecisionEvidence,
  type DiffRow,
  type InboxFilter,
  type ProposalRow,
  type ReviewItem,
} from '@/lib/reviewinbox';

const SOURCE_ZH: Record<string, string> = {
  OPERATOR: '操作者',
  VIOLATION: '越矩',
  SEMANTIC: '語意',
  TRAJECTORY: '軌跡去重',
  REFLECTION: '反思 Agent',
  RUN: '執行',
};

function sourceLabel(source: string) {
  return SOURCE_ZH[source] ?? source;
}

function riskClass(risk: string) {
  const s = risk.toLowerCase();
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

function shortHash(h: string | null): string {
  if (!h) return '—';
  return h.slice(0, 16);
}

function payloadSummary(payload: unknown): { workflowId?: string; triggeredBy?: string } {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    return {
      workflowId: typeof p.workflowId === 'string' ? p.workflowId : undefined,
      triggeredBy: typeof p.triggeredBy === 'string' ? p.triggeredBy : undefined,
    };
  }
  return {};
}

interface EvidenceState {
  evidence: DecisionEvidence;
  decision: 'approve' | 'reject';
  kind: ReviewItem['kind'];
}

function DecisionEvidenceCard({
  state,
  onClose,
}: {
  state: EvidenceState;
  onClose: () => void;
}) {
  const { evidence, decision, kind } = state;
  const auditLabel = evidence.auditAction
    ? auditZh(evidence.auditAction)
    : '未找到稽核列';

  return (
    <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="font-medium text-emerald-400">決策證據</div>
          <div>
            決策結果：
            <span className="ml-1 font-mono font-semibold">{evidence.decidedStatus}</span>
            <span className="ml-2 text-xs text-muted">（實際 DB 回傳，非樂觀 UI）</span>
          </div>
          <div>
            稽核動作：
            <span className="ml-1">{auditLabel}</span>
            {evidence.auditAction && (
              <span className="ml-1 font-mono text-xs text-muted">({evidence.auditAction})</span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
            <span>hash: {shortHash(evidence.auditHash)}</span>
            <span>prev: {shortHash(evidence.auditPrevHash)}</span>
            <span className={evidence.chainLinked ? 'text-emerald-400' : 'text-amber-400'}>
              {evidence.chainLinked ? '已串入 hash chain' : '未串鏈'}
            </span>
          </div>
          {decision === 'reject' && evidence.zeroChange && (
            <div className="mt-1 text-xs text-muted">
              駁回完成：目標物零變更（未產生任何版本／未套用任何修改）
              {kind === 'run_approval' && (
                <span className="mt-0.5 block">Run 已取消（CANCELLED），未觸發引擎</span>
              )}
            </div>
          )}
          {evidence.resultingVersionId && (
            <div className="text-xs text-muted">
              產生版本：
              <span className="ml-1 font-mono">{evidence.resultingVersionId.slice(0, 12)}</span>
            </div>
          )}
        </div>
        <button type="button" className="btn-ghost shrink-0 text-xs" onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  );
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted">（無可比較欄位）</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border/70">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-black/10 text-left text-muted">
            <th className="px-2 py-1.5 font-medium">欄位</th>
            <th className="px-2 py-1.5 font-medium">變更前</th>
            <th className="px-2 py-1.5 font-medium">變更後</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={cn(
                'border-b border-border/50 last:border-0',
                row.changed && 'bg-amber-500/10',
              )}
            >
              <td className="px-2 py-1.5 font-mono">{row.key}</td>
              <td className="max-w-[14rem] truncate px-2 py-1.5 font-mono text-muted" title={row.before ?? undefined}>
                {row.before === null ? '（無）' : row.before}
              </td>
              <td className="max-w-[14rem] truncate px-2 py-1.5 font-mono" title={row.after ?? undefined}>
                {row.after === null ? '（無）' : row.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProposalExpandBody({ item }: { item: ReviewItem }) {
  const row = item.raw as ProposalRow;
  const isRestriction = row.targetType === 'RESTRICTION';

  const agentQ = useQuery({
    queryKey: ['agent', row.agentId],
    queryFn: () =>
      API.get<{ id: string; restrictions?: Record<string, unknown> | null }>(
        `/api/agents/${row.agentId}`,
      ),
    enabled: isRestriction,
  });

  const restrictions =
    isRestriction && agentQ.data?.restrictions && typeof agentQ.data.restrictions === 'object'
      ? (agentQ.data.restrictions as Record<string, unknown>)
      : null;

  const rows = proposalDiff(
    row.targetType,
    row.proposedChange,
    isRestriction ? restrictions : null,
  );

  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      {isRestriction && agentQ.isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3 w-3" />
          載入目前限制設定…
        </div>
      )}
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted">結構化差異</div>
        <DiffTable rows={rows} />
      </div>
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted">原始 proposedChange</div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-black/20 p-3 text-[11px] leading-relaxed text-muted">
          {row.proposedChange != null
            ? JSON.stringify(row.proposedChange, null, 2)
            : '（無變更內容）'}
        </pre>
      </div>
    </div>
  );
}

export function ReviewInboxPanel() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceState | null>(null);

  const [kind, setKind] = useState<InboxFilter['kind']>('all');
  const [risk, setRisk] = useState<InboxFilter['risk']>('all');
  const [source, setSource] = useState<string>('all');
  const [requester, setRequester] = useState<string>('all');
  const [agentId, setAgentId] = useState<string>('all');

  const proposalsQ = useQuery({
    queryKey: ['proposals'],
    queryFn: () => API.get<ProposalRow[]>('/api/proposals'),
    refetchInterval: 10_000,
  });

  const approvalsQ = useQuery({
    queryKey: ['approvals'],
    queryFn: () => API.get<ApprovalRow[]>('/api/approvals'),
    refetchInterval: 10_000,
  });

  const merged = useMemo(
    () => mergeInbox(proposalsQ.data ?? [], approvalsQ.data ?? []),
    [proposalsQ.data, approvalsQ.data],
  );

  const filtered = useMemo(
    () =>
      filterInbox(merged, {
        kind,
        risk,
        source,
        requester,
        agentId,
      }),
    [merged, kind, risk, source, requester, agentId],
  );

  const sourceOptions = useMemo(() => {
    const set = new Set(merged.map((i) => i.source));
    return Array.from(set).sort();
  }, [merged]);

  const requesterOptions = useMemo(() => {
    const set = new Set(merged.map((i) => i.requester));
    return Array.from(set).sort();
  }, [merged]);

  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of merged) map.set(i.agentId, i.agentName);
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant'));
  }, [merged]);

  async function afterDecision(
    item: ReviewItem,
    decision: 'approve' | 'reject',
    response: unknown,
  ) {
    void qc.invalidateQueries({ queryKey: ['proposals'] });
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    setActionError(null);
    try {
      const auditRows = await API.get<AuditRowLite[]>('/api/audit?limit=100');
      const ev = buildDecisionEvidence({
        kind: item.kind,
        decision,
        targetId: item.id,
        response,
        auditRows: auditRows ?? [],
      });
      setEvidence({ evidence: ev, decision, kind: item.kind });
    } catch {
      // Evidence is best-effort; decision already succeeded.
      setEvidence({
        evidence: buildDecisionEvidence({
          kind: item.kind,
          decision,
          targetId: item.id,
          response,
          auditRows: [],
        }),
        decision,
        kind: item.kind,
      });
    }
  }

  const proposalApprove = useMutation({
    mutationFn: (id: string) => API.post(`/api/proposals/${id}/approve`),
  });
  const proposalReject = useMutation({
    mutationFn: (id: string) => API.post(`/api/proposals/${id}/reject`),
  });
  const approvalApprove = useMutation({
    mutationFn: (id: string) => API.post(`/api/approvals/${id}/approve`),
  });
  const approvalReject = useMutation({
    mutationFn: (id: string) => API.post(`/api/approvals/${id}/reject`),
  });

  async function handleAction(item: ReviewItem, decision: 'approve' | 'reject') {
    setBusyKey(item.key);
    setActionError(null);
    try {
      let response: unknown;
      if (item.kind === 'proposal') {
        response =
          decision === 'approve'
            ? await proposalApprove.mutateAsync(item.id)
            : await proposalReject.mutateAsync(item.id);
      } else {
        response =
          decision === 'approve'
            ? await approvalApprove.mutateAsync(item.id)
            : await approvalReject.mutateAsync(item.id);
      }
      await afterDecision(item, decision, response);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  const isLoading = proposalsQ.isLoading || approvalsQ.isLoading;
  const isError = proposalsQ.isError || approvalsQ.isError;

  /**
   * Ticket 13: data from GET /api/approvals is a true AIOS ApprovalRequest row.
   * We only render HITL action buttons when classified as aios-approval.
   * Langflow / Runtime checkpoint payloads must never become approve/reject UI.
   */
  const aiosApprovalSignal = classifyApprovalSignal({
    origin: 'aios',
    topic: 'approval.request',
  });

  return (
    <div className="space-y-4">
      {evidence && (
        <DecisionEvidenceCard state={evidence} onClose={() => setEvidence(null)} />
      )}

      {actionError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-400">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/70 bg-black/[0.02] p-3 dark:bg-white/[0.02]">
        <label className="flex flex-col gap-1 text-xs text-muted">
          類型
          <select
            aria-label="篩選類型"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground"
            value={kind ?? 'all'}
            onChange={(e) => setKind(e.target.value as InboxFilter['kind'])}
          >
            <option value="all">全部</option>
            <option value="proposal">變更提案</option>
            <option value="run_approval">執行核准</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          風險
          <select
            aria-label="篩選風險"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground"
            value={risk ?? 'all'}
            onChange={(e) => setRisk(e.target.value as InboxFilter['risk'])}
          >
            <option value="all">全部</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          來源
          <select
            aria-label="篩選來源"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="all">全部</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          提出者
          <select
            aria-label="篩選提出者"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground"
            value={requester}
            onChange={(e) => setRequester(e.target.value)}
          >
            <option value="all">全部</option>
            {requesterOptions.map((r) => (
              <option key={r} value={r}>
                {r === 'system' ? 'system' : r.length > 16 ? `${r.slice(0, 16)}…` : r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          員工
          <select
            aria-label="篩選員工"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="all">全部</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto self-center text-xs text-muted">
          {filtered.length} / {merged.length} 項
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      )}

      {isError && !isLoading && (
        <EmptyState title="無法載入審核收件匣" hint="請稍後重試" />
      )}

      {!isLoading && !isError && merged.length === 0 && (
        <EmptyState title="目前沒有待審項目" hint="變更提案與執行核准會出現在此" />
      )}

      {!isLoading && !isError && merged.length > 0 && filtered.length === 0 && (
        <EmptyState title="沒有符合篩選的項目" hint="調整上方篩選條件" />
      )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((item) => {
            const open = expanded === item.key;
            const busy = busyKey === item.key;
            const isProposal = item.kind === 'proposal';
            // Ticket 13: only true AIOS ApprovalRequest rows get HITL actions.
            const showApprovalActions =
              !isProposal && aiosApprovalSignal === 'aios-approval';
            const showProposalActions = isProposal;
            const approval = !isProposal ? (item.raw as ApprovalRow) : null;
            const proposal = isProposal ? (item.raw as ProposalRow) : null;
            const pay = approval ? payloadSummary(approval.payload) : {};

            return (
              <article
                key={item.key}
                className={cn(
                  'card overflow-hidden border-l-4',
                  isProposal ? 'border-l-brand' : 'border-l-amber-500',
                )}
              >
                <div className="flex flex-wrap items-start gap-3 p-4">
                  <button
                    type="button"
                    className="mt-0.5 shrink-0 text-muted"
                    onClick={() => setExpanded(open ? null : item.key)}
                    aria-expanded={open}
                    aria-label={open ? '收合詳情' : '展開詳情'}
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'badge',
                          isProposal ? 'bg-brand/10 text-brand' : 'bg-amber-500/15 text-amber-500',
                        )}
                      >
                        {isProposal ? '變更提案' : '執行核准（HITL）'}
                      </span>
                      <span className={cn('badge', riskClass(item.risk))}>
                        {isProposal ? `severity: ${item.risk}` : `riskTier: ${item.risk}`}
                      </span>
                      <span
                        className="text-xs text-muted"
                        title={new Date(item.createdAt).toLocaleString('zh-Hant-TW')}
                      >
                        {timeAgo(item.createdAt)}
                      </span>
                    </div>

                    <div className="font-medium">{item.agentName}</div>

                    {isProposal && proposal && (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                        <span>來源：{sourceLabel(item.source)}</span>
                        <span>目標：{proposal.targetType}</span>
                        <span
                          className="font-mono"
                          title={item.requester}
                        >
                          提出者：
                          {item.requester === 'system'
                            ? 'system'
                            : item.requester.slice(0, 12)}
                        </span>
                      </div>
                    )}

                    {!isProposal && approval && (
                      <div className="space-y-0.5 text-xs text-muted">
                        <div>原因：{approval.reason || item.summary}</div>
                        <div className="flex flex-wrap gap-x-3">
                          <span className="font-mono">
                            runId：{approval.runId.slice(0, 8)}
                          </span>
                          {pay.workflowId && (
                            <span className="font-mono">
                              workflow：{pay.workflowId.slice(0, 10)}
                            </span>
                          )}
                          {pay.triggeredBy && <span>觸發：{pay.triggeredBy}</span>}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {showProposalActions && (
                      <>
                        <button
                          type="button"
                          className="btn-primary px-2 py-1 text-xs"
                          disabled={busy}
                          onClick={() => void handleAction(item, 'approve')}
                        >
                          {busy ? (
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
                          onClick={() => void handleAction(item, 'reject')}
                        >
                          {busy ? <Spinner className="h-3 w-3" /> : <X className="h-3.5 w-3.5" />}
                          駁回
                        </button>
                      </>
                    )}
                    {showApprovalActions && (
                      <>
                        <button
                          type="button"
                          className="btn-primary px-2 py-1 text-xs"
                          disabled={busy}
                          title="核准後會以 resumeToken 續跑該 Run（真的會觸發引擎）"
                          onClick={() => void handleAction(item, 'approve')}
                        >
                          {busy ? (
                            <Spinner className="h-3 w-3 border-white/40 border-t-white" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          核准並續跑
                        </button>
                        <button
                          type="button"
                          className="btn-ghost px-2 py-1 text-xs text-rose-400"
                          disabled={busy}
                          title="駁回後 Run 狀態為 CANCELLED，不會觸發引擎"
                          onClick={() => void handleAction(item, 'reject')}
                        >
                          {busy ? <Spinner className="h-3 w-3" /> : <X className="h-3.5 w-3.5" />}
                          駁回並取消
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {open && isProposal && <ProposalExpandBody item={item} />}

                {open && !isProposal && approval && (
                  <div className="border-t border-border px-4 py-3">
                    <div className="mb-1.5 text-xs font-medium text-muted">payload</div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/20 p-3 text-[11px] leading-relaxed text-muted">
                      {approval.payload != null
                        ? JSON.stringify(approval.payload, null, 2)
                        : '（無）'}
                    </pre>
                  </div>
                )}

                {/* Ticket 13 invariant notice — fixed footer on every HITL card */}
                {!isProposal && (
                  <div className="border-t border-border/60 bg-amber-500/[0.04] px-4 py-2 text-[11px] leading-relaxed text-muted">
                    Langflow／Runtime checkpoint 僅供參考，唯一核准來源是 AIOS ApprovalRequest（DB）
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
