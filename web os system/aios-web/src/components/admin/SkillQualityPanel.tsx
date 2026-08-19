'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  History,
  Play,
  Rocket,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import { API, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { EmptyState, Spinner, StatusBadge } from '@/components/ui';

// ── Types (mirror backend Slice 2 eval REST) ─────────────────────────────────

type Engine = 'CLAUDE_CODE' | 'CODEX' | 'GROK';
type EvalRunStatus = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR';
type EvalResultStatus = 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';

interface SkillRow {
  id: string;
  name: string;
  slug?: string;
  reviewStatus: string;
  stableVersionId: string | null;
  canaryVersionId: string | null;
}

interface EvalSuiteSummary {
  id: string;
  skillId: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
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
  status: EvalRunStatus | string;
  passedCases: number;
  failedCases: number;
  totalCases: number;
  results: Array<{
    id: string;
    caseId: string;
    status: EvalResultStatus;
    engine: string | null;
    highRisk: boolean;
    resolved: boolean;
    evidence: string;
  }>;
}

const ENGINES: Engine[] = ['CLAUDE_CODE', 'CODEX', 'GROK'];

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

function truncate(s: string, n = 280): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ── Suite row (run + expand results) ─────────────────────────────────────────

function SuiteRow({
  suite,
  skillId,
  executeEngine,
  candidateVersionId,
}: {
  suite: EvalSuiteSummary;
  skillId: string;
  executeEngine: Engine;
  candidateVersionId: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const lastRunId = suite.lastRun?.id ?? null;

  const suiteDetailQuery = useQuery({
    queryKey: ['eval-suite', suite.id],
    queryFn: () => API.get<EvalSuiteDetail>(`/api/eval-suites/${suite.id}`),
    enabled: open,
  });

  const runDetailQuery = useQuery({
    queryKey: ['eval-run', lastRunId],
    queryFn: () => API.get<EvalRunDetail>(`/api/eval-runs/${lastRunId}`),
    enabled: open && !!lastRunId,
    refetchInterval: open ? 15000 : false,
  });

  const runMut = useMutation({
    mutationFn: () => {
      const body: { executeEngine: Engine; candidateVersionId?: string } = {
        executeEngine,
      };
      const vid = candidateVersionId.trim();
      if (vid) body.candidateVersionId = vid;
      return API.post(`/api/eval-suites/${suite.id}/run`, body);
    },
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['eval-suites', skillId] });
      void qc.invalidateQueries({ queryKey: ['eval-suite', suite.id] });
      if (lastRunId) void qc.invalidateQueries({ queryKey: ['eval-run', lastRunId] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const caseNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of suiteDetailQuery.data?.cases ?? []) {
      map.set(c.id, `${c.kind} · ${c.name}`);
    }
    return map;
  }, [suiteDetailQuery.data]);

  const last = suite.lastRun;

  return (
    <div className="rounded-lg border border-border/70 bg-black/[0.02] dark:bg-white/[0.02]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium hover:text-brand"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
          )}
          <span className="truncate">{suite.name}</span>
        </button>

        {last ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusBadge status={last.status} />
            <span className="text-muted">
              {last.passed}/{last.totalCases} 通過
              {last.failed > 0 ? ` · ${last.failed} 失敗` : ''}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted">尚無評測</span>
        )}

        <button
          type="button"
          disabled={runMut.isPending}
          onClick={() => runMut.mutate()}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
        >
          {runMut.isPending ? <Spinner className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          執行評測
        </button>
      </div>

      {actionError && (
        <div className="mx-3 mb-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-400">
          {actionError}
        </div>
      )}

      {open && (
        <div className="border-t border-border/60 px-3 py-3">
          {!lastRunId ? (
            <p className="text-xs text-muted">此套件尚無執行紀錄。請先「執行評測」。</p>
          ) : runDetailQuery.isLoading ? (
            <div className="flex justify-center py-4">
              <Spinner className="h-4 w-4" />
            </div>
          ) : runDetailQuery.isError ? (
            <p className="text-xs text-rose-400">無法載入評測結果：{errorMessage(runDetailQuery.error)}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>
                  Run {runDetailQuery.data?.id?.slice(0, 10)}…
                </span>
                {runDetailQuery.data && (
                  <>
                    <StatusBadge status={String(runDetailQuery.data.status)} />
                    <span>
                      {runDetailQuery.data.passedCases}/{runDetailQuery.data.totalCases} 通過 ·{' '}
                      {runDetailQuery.data.failedCases} 失敗
                    </span>
                  </>
                )}
              </div>
              <ul className="space-y-2">
                {(runDetailQuery.data?.results ?? []).map((r) => (
                  <li
                    key={r.id}
                    className="rounded-md border border-border/50 bg-bg px-2.5 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {caseNameById.get(r.caseId) ?? `case ${r.caseId.slice(0, 8)}`}
                      </span>
                      <StatusBadge status={r.status} />
                      {r.engine && (
                        <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-muted dark:bg-white/10">
                          verify: {r.engine}
                        </span>
                      )}
                      {r.highRisk && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-400">
                          <ShieldAlert className="h-3 w-3" />
                          highRisk{r.resolved ? ' (已解除)' : ''}
                        </span>
                      )}
                    </div>
                    {r.evidence ? (
                      <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-2 text-[11px] text-muted dark:bg-white/5">
                        {truncate(r.evidence, 600)}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-skill card ───────────────────────────────────────────────────────────

function SkillQualityCard({ skill }: { skill: SkillRow }) {
  const qc = useQueryClient();
  const [engine, setEngine] = useState<Engine>('CLAUDE_CODE');
  const [versionId, setVersionId] = useState(
    () => skill.canaryVersionId ?? skill.stableVersionId ?? '',
  );
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateOk, setGateOk] = useState<string | null>(null);

  const suitesQuery = useQuery({
    queryKey: ['eval-suites', skill.id],
    queryFn: () => API.get<EvalSuiteSummary[]>(`/api/skills/${skill.id}/eval-suites`),
    refetchInterval: 30000,
  });

  const latestStatus = useMemo(() => {
    const suites = suitesQuery.data ?? [];
    let best: EvalSuiteSummary['lastRun'] = null;
    for (const s of suites) {
      if (!s.lastRun) continue;
      if (!best) {
        best = s.lastRun;
        continue;
      }
      const a = s.lastRun.finishedAt ? new Date(s.lastRun.finishedAt).getTime() : 0;
      const b = best.finishedAt ? new Date(best.finishedAt).getTime() : 0;
      if (a >= b) best = s.lastRun;
    }
    return best;
  }, [suitesQuery.data]);

  const promoteMut = useMutation({
    mutationFn: (vid: string) =>
      API.post(`/api/skills/${skill.id}/promote`, { versionId: vid }),
    onSuccess: () => {
      setGateError(null);
      setGateOk('已發布至 stable');
      void qc.invalidateQueries({ queryKey: ['skills'] });
      void qc.invalidateQueries({ queryKey: ['eval-suites', skill.id] });
    },
    onError: (e) => {
      setGateOk(null);
      setGateError(errorMessage(e));
    },
  });

  const rollbackMut = useMutation({
    mutationFn: (vid: string) =>
      API.post(`/api/skills/${skill.id}/rollback`, { versionId: vid }),
    onSuccess: () => {
      setGateError(null);
      setGateOk('已回復 stable 指標');
      void qc.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (e) => {
      setGateOk(null);
      setGateError(errorMessage(e));
    },
  });

  const canPromote = versionId.trim().length > 0;
  const busy = promoteMut.isPending || rollbackMut.isPending;

  return (
    <div className="border-b border-border/60 last:border-0">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{skill.name}</span>
            <StatusBadge status={skill.reviewStatus} />
            {latestStatus ? (
              <StatusBadge status={latestStatus.status} />
            ) : (
              <span className="text-xs text-muted">無 eval</span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>
              stable:{' '}
              {skill.stableVersionId ? (
                <code className="text-fg">{skill.stableVersionId.slice(0, 12)}…</code>
              ) : (
                <span className="text-amber-500">無</span>
              )}
            </span>
            <span>
              canary:{' '}
              {skill.canaryVersionId ? (
                <code className="text-fg">{skill.canaryVersionId.slice(0, 12)}…</code>
              ) : (
                '—'
              )}
            </span>
            {latestStatus && (
              <span>
                最近評測 {latestStatus.passed}/{latestStatus.totalCases}
                {latestStatus.failed > 0 ? ` · ${latestStatus.failed} fail` : ''}
              </span>
            )}
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[280px]">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-muted">引擎</label>
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as Engine)}
              className="rounded-md border border-border bg-bg px-2 py-1 text-xs"
            >
              {ENGINES.map((en) => (
                <option key={en} value={en}>
                  {en}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              placeholder="候選 versionId（canary / stable）"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canPromote || busy}
              title={canPromote ? 'fail-closed 發布閘' : '需候選版本 versionId'}
              onClick={() => {
                setGateError(null);
                setGateOk(null);
                promoteMut.mutate(versionId.trim());
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium',
                canPromote
                  ? 'bg-brand/15 text-brand hover:bg-brand/25'
                  : 'cursor-not-allowed bg-black/5 text-muted dark:bg-white/5',
              )}
            >
              {promoteMut.isPending ? <Spinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
              發布 (promote)
            </button>
            <button
              type="button"
              disabled={!canPromote || busy}
              title={canPromote ? '回復 stable 指標' : '需版本 versionId'}
              onClick={() => {
                setGateError(null);
                setGateOk(null);
                rollbackMut.mutate(versionId.trim());
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/5"
            >
              {rollbackMut.isPending ? <Spinner className="h-3 w-3" /> : <Undo2 className="h-3 w-3" />}
              回復 (rollback)
            </button>
          </div>
          {!canPromote && (
            <p className="flex items-center gap-1 text-[11px] text-muted">
              <History className="h-3 w-3" />
              需候選版本 — 請貼入 versionId（預設 canary）
            </p>
          )}
          {gateError && (
            <div className="flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{gateError}</span>
            </div>
          )}
          {gateOk && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-400">
              {gateOk}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 px-4 pb-4">
        {suitesQuery.isLoading ? (
          <div className="flex justify-center py-3">
            <Spinner className="h-4 w-4" />
          </div>
        ) : suitesQuery.isError ? (
          <p className="text-xs text-rose-400">無法載入評測套件：{errorMessage(suitesQuery.error)}</p>
        ) : !(suitesQuery.data?.length) ? (
          <p className="text-xs text-muted">此技能尚無 EvalSuite（請由 FDE 後端建立）。</p>
        ) : (
          suitesQuery.data.map((s) => (
            <SuiteRow
              key={s.id}
              suite={s}
              skillId={skill.id}
              executeEngine={engine}
              candidateVersionId={versionId}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Panel root ───────────────────────────────────────────────────────────────

export function SkillQualityPanel() {
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => API.get<SkillRow[]>('/api/skills'),
    refetchInterval: 30000,
  });

  return (
    <div className="mt-8 card">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-brand" />
          <div>
            <h2 className="text-sm font-semibold">技能品質 / 發布狀態</h2>
            <p className="text-[11px] text-muted">
              Eval suites · fail-closed promote 閘 · 僅 TRAINER/OWNER 可發布
            </p>
          </div>
        </div>
        {skillsQuery.isFetching && <Spinner className="h-4 w-4" />}
      </div>

      {skillsQuery.isLoading ? (
        <div className="flex h-28 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : skillsQuery.isError ? (
        <div className="p-6">
          <EmptyState title="無法載入技能清單" hint={errorMessage(skillsQuery.error)} />
        </div>
      ) : !(skillsQuery.data?.length) ? (
        <div className="p-6">
          <EmptyState title="尚無技能" hint="建立技能後可在此檢視評測與發布狀態" />
        </div>
      ) : (
        <div>
          {skillsQuery.data.map((skill) => (
            <SkillQualityCard key={skill.id} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}
