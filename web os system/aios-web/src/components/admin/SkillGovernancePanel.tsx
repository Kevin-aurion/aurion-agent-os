'use client';

/**
 * FDE Skill 版本／差異／發布閘／評測證據／回滾治理介面（唯讀閘為 UX，後端為權威）。
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  GitCompare,
  History,
  Rocket,
  ShieldAlert,
  Undo2,
  X,
} from 'lucide-react';
import { API, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  buildVersionTimeline,
  describeRollback,
  diffLines,
  gateCheckLabel,
  summarizeGate,
  type DiffRow,
  type TimelineVersion,
} from '@/lib/skillgovernance';
import { EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/ui';

// ── API shapes (mirror aios-server skillgovernance + eval REST) ──────────────

interface SkillVersionsData {
  skill: {
    id: string;
    name: string;
    slug: string;
    reviewStatus: string;
    confirmedBy: string | null;
    confirmedAt: string | null;
    stableVersionId: string | null;
    canaryVersionId: string | null;
  };
  versions: Array<{
    id: string;
    version: number;
    contentHash: string;
    channel: string;
    schemaVersion: string | null;
    createdBy: string | null;
    createdAt: string;
    contentMd: string;
  }>;
}

interface PromoteGateData {
  canPromote: boolean;
  checks: Array<{
    key: string;
    ok: boolean;
    reason: string;
    evalRunId?: string;
  }>;
}

type EvalRunStatus = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR' | string;

interface EvalSuiteSummary {
  id: string;
  skillId: string;
  name: string;
  description: string | null;
  lastRun: null | {
    id: string;
    status: EvalRunStatus;
    passed: number;
    failed: number;
    totalCases: number;
    finishedAt: string | null;
  };
}

interface EvalSuiteDetail {
  id: string;
  name: string;
  cases: Array<{ id: string; kind: string; name: string }>;
}

interface EvalRunDetail {
  id: string;
  status: EvalRunStatus;
  passedCases: number;
  failedCases: number;
  totalCases: number;
  results: Array<{
    id: string;
    caseId: string;
    status: string;
    engine: string | null;
    highRisk: boolean;
    resolved: boolean;
    evidence: string;
  }>;
}

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

function truncate(s: string, n = 320): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-Hant-TW');
  } catch {
    return iso;
  }
}

function channelBadgeClass(channel: string): string {
  if (channel === 'stable') return 'bg-emerald-500/15 text-emerald-400';
  if (channel === 'canary') return 'bg-sky-500/15 text-sky-400';
  if (channel === 'archived') return 'bg-zinc-500/15 text-zinc-400';
  return 'bg-black/10 text-muted dark:bg-white/10';
}

function channelLabel(channel: string): string {
  if (channel === 'stable') return 'stable';
  if (channel === 'canary') return 'canary';
  if (channel === 'archived') return 'archived';
  return channel;
}

// ── Diff view ────────────────────────────────────────────────────────────────

function DiffView({ rows }: { rows: DiffRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted">兩個版本內容相同（或皆為空）。</p>;
  }
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border bg-panel/40 font-mono text-[11px] leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-all px-2 py-0.5',
            r.type === 'del' && 'bg-rose-500/15 text-rose-300',
            r.type === 'add' && 'bg-emerald-500/15 text-emerald-300',
            r.type === 'same' && 'text-muted',
          )}
        >
          <span className="mr-2 inline-block w-3 select-none opacity-60">
            {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}
          </span>
          {r.text || ' '}
        </div>
      ))}
    </div>
  );
}

// ── Eval evidence (read-only) ────────────────────────────────────────────────

function EvalSuiteExpand({ suite }: { suite: EvalSuiteSummary }) {
  const [open, setOpen] = useState(false);
  const lastRunId = suite.lastRun?.id ?? null;

  const suiteQ = useQuery({
    queryKey: ['eval-suite', suite.id],
    queryFn: () => API.get<EvalSuiteDetail>(`/api/eval-suites/${suite.id}`),
    enabled: open,
  });

  const runQ = useQuery({
    queryKey: ['eval-run', lastRunId],
    queryFn: () => API.get<EvalRunDetail>(`/api/eval-runs/${lastRunId}`),
    enabled: open && !!lastRunId,
  });

  const caseNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of suiteQ.data?.cases ?? []) {
      map.set(c.id, `${c.kind} · ${c.name}`);
    }
    return map;
  }, [suiteQ.data]);

  const last = suite.lastRun;
  const failedish =
    last?.status === 'FAILED' || last?.status === 'ERROR' || (last != null && last.failed > 0);

  return (
    <div
      className={cn(
        'rounded-lg border border-border/70',
        failedish && 'border-rose-500/40 bg-rose-500/[0.04]',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{suite.name}</span>
        {last ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={String(last.status)} />
            <span className="text-[11px] text-muted">
              {last.passed}/{last.totalCases} 通過
            </span>
          </span>
        ) : (
          <span className="text-[11px] text-muted">尚無執行</span>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          {(suiteQ.isLoading || runQ.isLoading) && (
            <div className="flex justify-center py-4">
              <Spinner className="h-4 w-4" />
            </div>
          )}
          {(suiteQ.isError || runQ.isError) && (
            <p className="text-xs text-rose-400">
              {errorMessage(suiteQ.error ?? runQ.error)}
            </p>
          )}
          {!lastRunId && !suiteQ.isLoading && (
            <p className="text-xs text-muted">此套件尚未有評測執行紀錄。</p>
          )}
          {runQ.data && (
            <ul className="space-y-2">
              {runQ.data.results.map((r) => {
                const fail = r.status === 'FAIL' || r.status === 'ERROR';
                return (
                  <li
                    key={r.id}
                    className={cn(
                      'rounded-md border border-border/50 px-2.5 py-2',
                      r.highRisk && 'border-rose-500/50 bg-rose-500/10',
                      fail && !r.highRisk && 'border-rose-500/30 bg-rose-500/[0.04]',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">
                        {caseNameById.get(r.caseId) ?? r.caseId.slice(0, 8)}
                      </span>
                      <StatusBadge status={r.status} />
                      {r.engine && (
                        <span className="text-[10px] text-muted">驗證引擎 {r.engine}</span>
                      )}
                      {r.highRisk && (
                        <span className="badge bg-rose-500/20 text-rose-300">
                          高風險{r.resolved ? ' · 已解除' : ' · 未解除'}
                        </span>
                      )}
                    </div>
                    {r.evidence && (
                      <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted">
                        {truncate(r.evidence)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function SkillGovernancePanel({ skillId }: { skillId: string }) {
  const qc = useQueryClient();
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [rollbackTargetId, setRollbackTargetId] = useState<string>('');
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const versionsQ = useQuery({
    queryKey: ['skill-versions', skillId],
    queryFn: () => API.get<SkillVersionsData>(`/api/skills/${skillId}/versions`),
    enabled: !!skillId,
    retry: false,
  });

  const skill = versionsQ.data?.skill;
  const versions = versionsQ.data?.versions ?? [];

  const timeline = useMemo(
    () =>
      buildVersionTimeline(
        versions,
        skill?.stableVersionId,
        skill?.canaryVersionId,
      ),
    [versions, skill?.stableVersionId, skill?.canaryVersionId],
  );

  // Seed (or re-seed on skill change) candidate / compare when versions load
  useEffect(() => {
    if (!versionsQ.data || versionsQ.data.skill.id !== skillId) return;
    const rows = versionsQ.data.versions;
    const sk = versionsQ.data.skill;
    const sorted = [...rows].sort((a, b) => b.version - a.version);
    const prefer =
      sk.canaryVersionId && rows.some((v) => v.id === sk.canaryVersionId)
        ? sk.canaryVersionId
        : sorted[0]?.id ?? null;
    setCandidateId(prefer);
    setCompareId(sorted.find((t) => t.id !== prefer)?.id ?? null);
    setRollbackTargetId('');
    setConfirmRollback(false);
    setActionOk(null);
    setActionError(null);
    // Only re-seed when skill identity or first successful payload for that skill changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: avoid clobbering user selection on every invalidate
  }, [skillId, versionsQ.data?.skill.id]);

  const candidate = versions.find((v) => v.id === candidateId) ?? null;
  const compare = versions.find((v) => v.id === compareId) ?? null;

  const diffRows = useMemo(() => {
    if (!candidate) return [] as DiffRow[];
    const beforeMd = compare?.contentMd ?? '';
    const afterMd = candidate.contentMd ?? '';
    // 比較版 → 候選：del=比較有而候選無、add=候選新增
    return diffLines(beforeMd, afterMd);
  }, [candidate, compare]);

  const gateQ = useQuery({
    queryKey: ['skill-promote-gate', skillId, candidateId],
    queryFn: () =>
      API.get<PromoteGateData>(
        `/api/skills/${skillId}/promote-gate?versionId=${encodeURIComponent(candidateId!)}`,
      ),
    enabled: !!skillId && !!candidateId,
    retry: false,
  });

  const suitesQ = useQuery({
    queryKey: ['eval-suites', skillId],
    queryFn: () => API.get<EvalSuiteSummary[]>(`/api/skills/${skillId}/eval-suites`),
    enabled: !!skillId,
    retry: false,
  });

  const promoteMut = useMutation({
    mutationFn: (versionId: string) =>
      API.post(`/api/skills/${skillId}/promote`, { versionId }),
    onSuccess: () => {
      setActionError(null);
      setActionOk('已發布至 stable。');
      void qc.invalidateQueries({ queryKey: ['skill-versions', skillId] });
      void qc.invalidateQueries({ queryKey: ['skill-promote-gate', skillId] });
      void qc.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (e) => {
      setActionOk(null);
      setActionError(errorMessage(e));
    },
  });

  const rollbackMut = useMutation({
    mutationFn: (versionId: string) =>
      API.post(`/api/skills/${skillId}/rollback`, { versionId }),
    onSuccess: async () => {
      setActionError(null);
      setConfirmRollback(false);
      await qc.invalidateQueries({ queryKey: ['skill-versions', skillId] });
      await qc.invalidateQueries({ queryKey: ['skill-promote-gate', skillId] });
      void qc.invalidateQueries({ queryKey: ['skills'] });
      const refreshed = await qc.fetchQuery({
        queryKey: ['skill-versions', skillId],
        queryFn: () => API.get<SkillVersionsData>(`/api/skills/${skillId}/versions`),
      });
      const n = refreshed.versions.length;
      const stable = refreshed.versions.find((v) => v.id === refreshed.skill.stableVersionId);
      setActionOk(
        `已回滾。目前 stable 指向 v${stable?.version ?? '—'}，版本總數仍為 ${n}（歷史未刪）。`,
      );
    },
    onError: (e) => {
      setActionOk(null);
      setActionError(errorMessage(e));
    },
  });

  const gateSummary = useMemo(
    () =>
      gateQ.data
        ? summarizeGate(gateQ.data)
        : { canPromote: false, gaps: [] as ReturnType<typeof summarizeGate>['gaps'] },
    [gateQ.data],
  );

  const promoteDisabled =
    !candidateId || !gateQ.data?.canPromote || promoteMut.isPending || gateQ.isLoading;
  const promoteTitle = !candidateId
    ? '請先選擇候選版本'
    : gateQ.isLoading
      ? '正在檢查發布條件…'
      : !gateQ.data?.canPromote
        ? gateSummary.gaps.map((g) => `${g.label}：${g.reason}`).join('；') ||
          '尚未滿足發布條件'
        : '將此版本發布為 stable';

  const nonStableOptions = timeline.filter((t) => t.id !== skill?.stableVersionId);
  const rollbackDesc = describeRollback(
    versions,
    skill?.stableVersionId,
    rollbackTargetId || null,
  );

  // ── Loading / error / not found ──────────────────────────────────────────
  if (!skillId) {
    return <EmptyState title="缺少技能編號" hint="請從技能列表進入治理頁" />;
  }

  if (versionsQ.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (versionsQ.isError) {
    const msg = errorMessage(versionsQ.error);
    const notFound = msg.toLowerCase().includes('not found') || msg.includes('找不到');
    return (
      <div className="space-y-4">
        <Link
          href="/skills"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 回技能列表
        </Link>
        <EmptyState
          title={notFound ? '找不到此技能' : '載入失敗'}
          hint={msg}
        />
      </div>
    );
  }

  if (!skill) {
    return <EmptyState title="找不到此技能" hint="請確認連結是否正確" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={skill.name}
        subtitle={`技能治理 · ${skill.slug}`}
        action={
          <Link href="/skills" className="btn-ghost text-xs">
            <ArrowLeft className="h-3.5 w-3.5" />
            回列表
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={skill.reviewStatus} />
        {skill.confirmedBy && (
          <span className="text-xs text-muted">
            確認人 {skill.confirmedBy.slice(0, 12)}
            {skill.confirmedBy.length > 12 ? '…' : ''}
          </span>
        )}
        {skill.confirmedAt && (
          <span className="text-xs text-muted">· {formatTime(skill.confirmedAt)}</span>
        )}
      </div>

      {(actionOk || actionError) && (
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-sm',
            actionOk && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
            actionError && 'border-rose-500/30 bg-rose-500/10 text-rose-300',
          )}
          role={actionError ? 'alert' : 'status'}
        >
          {actionOk ?? actionError}
        </div>
      )}

      {/* ── 版本歷史 ── */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold">版本歷史</h2>
          <span className="text-xs text-muted">共 {timeline.length} 個版本</span>
        </div>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted">尚無版本紀錄。確認技能後建立內容版本即可。</p>
        ) : (
          <ul className="divide-y divide-border">
            {timeline.map((v: TimelineVersion) => {
              const isCand = v.id === candidateId;
              const isComp = v.id === compareId;
              return (
                <li
                  key={v.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 py-3',
                    isCand && 'bg-brand/5',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">v{v.version}</span>
                      <span className={cn('badge', channelBadgeClass(v.channel))}>
                        {channelLabel(v.channel)}
                      </span>
                      {v.roles.includes('stable') && (
                        <span className="badge bg-emerald-500/20 text-emerald-300">
                          目前 stable
                        </span>
                      )}
                      {v.roles.includes('canary') && (
                        <span className="badge bg-sky-500/20 text-sky-300">目前 canary</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted">
                      <span className="font-mono">{v.contentHash.slice(0, 12)}</span>
                      <span>{formatTime(v.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      className={cn(
                        'btn-ghost text-xs',
                        isCand && 'bg-brand/15 text-brand',
                      )}
                      onClick={() => {
                        setCandidateId(v.id);
                        setActionOk(null);
                        setActionError(null);
                      }}
                    >
                      {isCand ? '候選中' : '設為候選'}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'btn-ghost text-xs',
                        isComp && 'bg-sky-500/15 text-sky-300',
                      )}
                      onClick={() => setCompareId(v.id)}
                      disabled={v.id === candidateId}
                      title={v.id === candidateId ? '請選另一版本做比較' : '與候選比較'}
                    >
                      {isComp ? '比較中' : '與候選比較'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── 版本差異 ── */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold">版本差異</h2>
        </div>
        {!candidate ? (
          <p className="text-sm text-muted">請先在上方選擇候選版本。</p>
        ) : !compare ? (
          <p className="text-sm text-muted">
            目前候選為 v{candidate.version}。請再選一個版本做「與候選比較」。
          </p>
        ) : compare.id === candidate.id ? (
          <p className="text-sm text-muted">請選擇與候選不同的版本進行比較。</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted">
              比較 v{compare.version} → 候選 v{candidate.version}
              <span className="ml-2 text-rose-400/80">紅＝刪除</span>
              <span className="ml-2 text-emerald-400/80">綠＝新增</span>
            </p>
            <DiffView rows={diffRows} />
          </>
        )}
      </section>

      {/* ── 發布閘 ── */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-2">
          <Rocket className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold">發布閘</h2>
          {candidate && (
            <span className="text-xs text-muted">候選 v{candidate.version}</span>
          )}
        </div>

        {!candidateId && (
          <p className="text-sm text-muted">請選擇候選版本以檢查是否可發布。</p>
        )}
        {candidateId && gateQ.isLoading && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" /> 檢查發布條件…
          </div>
        )}
        {candidateId && gateQ.isError && (
          <p className="text-sm text-rose-400">{errorMessage(gateQ.error)}</p>
        )}
        {gateQ.data && (
          <div className="space-y-3">
            <ul className="space-y-1.5">
              {gateQ.data.checks.map((c) => (
                <li key={c.key} className="flex items-start gap-2 text-sm">
                  {c.ok ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                  )}
                  <div className="min-w-0">
                    <span className="font-medium">{gateCheckLabel(c.key)}</span>
                    {c.ok && c.evalRunId && (
                      <span className="ml-2 font-mono text-[10px] text-muted">
                        評測 {c.evalRunId.slice(0, 10)}…
                      </span>
                    )}
                    {!c.ok && c.reason && (
                      <p className="text-xs text-rose-300/90">{c.reason}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {!gateSummary.canPromote && gateSummary.gaps.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-300">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  為何還不能發布
                </div>
                <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-100/90">
                  {gateSummary.gaps.map((g) => (
                    <li key={g.key}>
                      <span className="font-medium">{g.label}</span>
                      {g.reason ? `：${g.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              className="btn-primary"
              disabled={promoteDisabled}
              title={promoteTitle}
              onClick={() => {
                if (!candidateId) return;
                setActionOk(null);
                setActionError(null);
                promoteMut.mutate(candidateId);
              }}
            >
              {promoteMut.isPending ? (
                <Spinner className="border-white/40 border-t-white" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              發布至 stable
            </button>
          </div>
        )}
      </section>

      {/* ── 評測證據 ── */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold">評測證據</h2>
          <span className="text-xs text-muted">唯讀 · 執行評測請至管理面板</span>
        </div>
        {suitesQ.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner className="h-4 w-4" />
          </div>
        )}
        {suitesQ.isError && (
          <p className="text-sm text-rose-400">{errorMessage(suitesQ.error)}</p>
        )}
        {suitesQ.data && suitesQ.data.length === 0 && (
          <p className="text-sm text-muted">尚無評測套件。</p>
        )}
        {suitesQ.data && suitesQ.data.length > 0 && (
          <div className="space-y-2">
            {suitesQ.data.map((s) => (
              <EvalSuiteExpand key={s.id} suite={s} />
            ))}
          </div>
        )}
      </section>

      {/* ── 回滾 ── */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-2">
          <Undo2 className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold">回滾 stable</h2>
        </div>
        <p className="mb-3 text-xs text-muted">
          回滾只切換 stable 指標，不會刪除任何版本歷史。
        </p>
        {nonStableOptions.length === 0 ? (
          <p className="text-sm text-muted">沒有可回滾的非 stable 版本。</p>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="label">目標版本</span>
              <select
                className="input"
                value={rollbackTargetId}
                onChange={(e) => {
                  setRollbackTargetId(e.target.value);
                  setConfirmRollback(false);
                }}
              >
                <option value="">選擇版本…</option>
                {nonStableOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} · {channelLabel(v.channel)} · {v.contentHash.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>

            {!confirmRollback ? (
              <button
                type="button"
                className="btn-ghost"
                disabled={!rollbackTargetId || rollbackMut.isPending}
                onClick={() => setConfirmRollback(true)}
              >
                <Undo2 className="h-4 w-4" />
                回滾至 v
                {rollbackDesc.toVersion ?? '…'}
              </button>
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 space-y-3">
                <p className="text-sm leading-relaxed">
                  確定要將 stable
                  {rollbackDesc.fromVersion != null
                    ? ` 從 v${rollbackDesc.fromVersion}`
                    : ''}{' '}
                  切換到 v{rollbackDesc.toVersion}？
                  <br />
                  <span className="text-muted">
                    只切換 stable 指標，不會刪除任何版本；目前共{' '}
                    {rollbackDesc.retainedCount}{' '}
                    個版本將全數保留。
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={rollbackMut.isPending}
                    onClick={() => {
                      setActionOk(null);
                      setActionError(null);
                      rollbackMut.mutate(rollbackTargetId);
                    }}
                  >
                    {rollbackMut.isPending ? (
                      <Spinner className="border-white/40 border-t-white" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    確認回滾
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={rollbackMut.isPending}
                    onClick={() => setConfirmRollback(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
