'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ExternalLink,
  FlaskConical,
  Rocket,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { API } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { cn } from '@/lib/cn';
import {
  artifactStatusTone,
  deploymentActions,
  groupDeployments,
  readinessLabel,
  sandboxUrl,
  shortDigest,
  summarizeReadiness,
  type ArtifactDetail,
  type ArtifactRow,
  type DeploymentRow,
} from '@/lib/runtimeadmin';

type Env = 'SANDBOX' | 'STAGING' | 'PRODUCTION';
type Channel = 'CANARY' | 'STABLE';

function dateTime(value: string) {
  try {
    return new Date(value).toLocaleString('zh-Hant-TW', { hour12: false });
  } catch {
    return value;
  }
}

function toneClass(tone: ReturnType<typeof artifactStatusTone>): string {
  if (tone === 'ok') return 'bg-emerald-500/15 text-emerald-400';
  if (tone === 'warn') return 'bg-amber-500/15 text-amber-400';
  if (tone === 'bad') return 'bg-rose-500/15 text-rose-400';
  return 'bg-zinc-500/15 text-zinc-400';
}

export default function AdminRuntimePage() {
  const { user, loading: authLoading } = useAuth();
  const isFde = isFdeRole(user?.role);
  const router = useRouter();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<Env>('PRODUCTION');
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!isFde) {
      router.replace('/work');
    }
  }, [authLoading, isFde, router]);

  const artifactsQ = useQuery({
    queryKey: ['runtime-artifacts'],
    queryFn: () => API.get<ArtifactRow[]>('/api/runtime/artifacts'),
    enabled: isFde,
    refetchInterval: 30_000,
  });

  const detailQ = useQuery({
    queryKey: ['runtime-artifact', selectedId],
    queryFn: () => API.get<ArtifactDetail>(`/api/runtime/artifacts/${selectedId}`),
    enabled: isFde && !!selectedId,
  });

  const deploymentsQ = useQuery({
    queryKey: ['runtime-deployments'],
    queryFn: () => API.get<DeploymentRow[]>('/api/runtime/deployments'),
    enabled: isFde,
    refetchInterval: 30_000,
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['runtime-artifacts'] });
    void qc.invalidateQueries({ queryKey: ['runtime-artifact'] });
    void qc.invalidateQueries({ queryKey: ['runtime-deployments'] });
  };

  const validateMut = useMutation({
    mutationFn: (id: string) =>
      API.post<{ id: string; status: string }>(`/api/runtime/artifacts/${id}/validate`),
    onSuccess: () => {
      setFlash('Runtime 驗證完成（VALIDATED）');
      setActionError(null);
      invalidateAll();
    },
    onError: (e: Error) => setActionError(e.message || '驗證失敗'),
  });

  const activateMut = useMutation({
    mutationFn: (args: { artifactId: string; environment: Env; channel: Channel }) =>
      API.post<DeploymentRow>('/api/runtime/deployments', args),
    onSuccess: (data) => {
      setFlash(
        data.active
          ? `已啟用 ${data.channel}（${data.environment}）`
          : `部署結果：${data.channel}`,
      );
      setActionError(null);
      invalidateAll();
    },
    onError: (e: Error) => setActionError(e.message || '啟用失敗'),
  });

  const deactivateMut = useMutation({
    mutationFn: (id: string) =>
      API.post<DeploymentRow>(`/api/runtime/deployments/${id}/deactivate`),
    onSuccess: () => {
      setFlash('已停用部署（Kill switch；列仍保留）');
      setActionError(null);
      invalidateAll();
    },
    onError: (e: Error) => setActionError(e.message || '停用失敗'),
  });

  const rollbackMut = useMutation({
    mutationFn: (id: string) =>
      API.post<DeploymentRow>(`/api/runtime/deployments/${id}/rollback`),
    onSuccess: () => {
      setFlash('已回滾至此版本（僅切換 active pointer，不刪歷史）');
      setActionError(null);
      invalidateAll();
    },
    onError: (e: Error) => setActionError(e.message || '回滾失敗'),
  });

  const rows = artifactsQ.data ?? [];
  const detail = detailQ.data;
  const readinessSummary = useMemo(
    () => (detail ? summarizeReadiness(detail.readiness) : null),
    [detail],
  );
  const deploymentGroups = useMemo(
    () => groupDeployments(deploymentsQ.data ?? []),
    [deploymentsQ.data],
  );
  const sandbox = sandboxUrl();
  const busy =
    validateMut.isPending ||
    activateMut.isPending ||
    deactivateMut.isPending ||
    rollbackMut.isPending;

  if (authLoading || !isFde) {
    return (
      <AppShell>
        <div className="grid place-items-center py-20">
          <Spinner className="h-6 w-6" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Runtime 部署"
        subtitle="Flow Artifact digest、驗證、Canary／Stable 啟用與回滾。所有生效動作皆經後端 FDE 閘，前端不可自行生效。"
      />

      {flash && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {flash}
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {actionError}
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        {/* Sandbox entry — FDE only; never equals publish */}
        <section className="card p-5 lg:col-span-1">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-violet-500/15 text-violet-300">
              <FlaskConical className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Langflow 沙盒</div>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Langflow 沙盒僅供 FDE 視覺化測試；沙盒的 Save／Publish
                <strong className="text-fg"> 不會</strong>
                改變 AIOS Production 狀態。正式生效唯一路徑是本頁的 FDE 部署閘。
              </p>
              <a
                href={sandbox}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost border border-border mt-3 inline-flex items-center gap-2 text-sm"
              >
                開啟沙盒 <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="mt-2 break-all text-xs text-muted">{sandbox}</p>
            </div>
          </div>
        </section>

        <section className="card p-5 lg:col-span-2">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand/15 text-brand">
              <Rocket className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold">部署治理原則</div>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted">
                <li>validate / activate / rollback / kill-switch 一律呼叫後端 requireTrainer 閘</li>
                <li>digest drift、評測未過、same-family 等阻擋原因由後端決定性回傳並顯示於此</li>
                <li>回滾與 Kill switch 只切 active pointer，歷史列永不刪除</li>
              </ul>
            </div>
          </div>
        </section>
      </div>

      {/* Artifacts table */}
      <section className="card mb-6 overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <h2 className="font-semibold">Flow Artifacts</h2>
          <p className="text-xs text-muted">點列展開詳情、Skill IR、readiness 與部署動作</p>
        </div>
        {artifactsQ.isLoading && (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        )}
        {artifactsQ.isError && (
          <div className="p-6">
            <EmptyState title="無法載入 Artifacts" hint={(artifactsQ.error as Error)?.message} />
          </div>
        )}
        {artifactsQ.data && rows.length === 0 && (
          <div className="p-6">
            <EmptyState title="尚無 Flow Artifact" hint="請先由技能 IR 編譯產物" />
          </div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-black/5 text-xs uppercase tracking-wide text-muted dark:bg-white/5">
                <tr>
                  <th className="px-4 py-2 font-medium">模板</th>
                  <th className="px-4 py-2 font-medium">來源技能</th>
                  <th className="px-4 py-2 font-medium">Runtime</th>
                  <th className="px-4 py-2 font-medium">Digest</th>
                  <th className="px-4 py-2 font-medium">狀態</th>
                  <th className="px-4 py-2 font-medium">Active</th>
                  <th className="px-4 py-2 font-medium">建立</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const selected = selectedId === row.id;
                  const tone = artifactStatusTone(row.status);
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        'cursor-pointer border-t border-border/60 transition-colors hover:bg-black/5 dark:hover:bg-white/5',
                        selected && 'bg-brand/10',
                      )}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.template}</div>
                        <div className="text-xs text-muted">{row.templateVersion ?? '—'}</div>
                      </td>
                      <td className="px-4 py-3">
                        {row.skill ? (
                          <>
                            <div>{row.skill.name}</div>
                            <div className="text-xs text-muted">
                              v{row.skill.version}
                              {row.skill.schemaVersion ? ` · ${row.skill.schemaVersion}` : ''}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{row.runtimeKind}</td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs" title={row.digest}>
                          {shortDigest(row.digest)}
                        </span>
                        {!row.digestOk && (
                          <span className="ml-2 inline-flex rounded bg-rose-500/20 px-1.5 py-0.5 text-xs font-medium text-rose-400">
                            digest 不符
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('badge', toneClass(tone))}>{row.status}</span>
                      </td>
                      <td className="px-4 py-3">{row.activeDeployments}</td>
                      <td className="px-4 py-3 text-xs text-muted">{dateTime(row.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Detail panel */}
      {selectedId && (
        <section className="card mb-6 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Artifact 詳情</h2>
            <button
              type="button"
              className="text-sm text-muted hover:text-fg"
              onClick={() => setSelectedId(null)}
            >
              關閉
            </button>
          </div>

          {detailQ.isLoading && (
            <div className="grid place-items-center py-10">
              <Spinner />
            </div>
          )}
          {detailQ.isError && (
            <EmptyState
              title="無法載入詳情"
              hint={(detailQ.error as Error)?.message}
            />
          )}

          {detail && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="text-xs text-muted">ID</div>
                  <div className="font-mono text-sm break-all">{detail.artifact.id}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Digest</div>
                  <div className="font-mono text-sm break-all" title={detail.artifact.digest}>
                    {detail.artifact.digest}
                    {!detail.artifact.digestOk && (
                      <span className="ml-2 text-rose-400">（digest 不符）</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted">狀態</div>
                  <StatusBadge status={detail.artifact.status} />
                </div>
                <div>
                  <div className="text-xs text-muted">Runtime / Template</div>
                  <div className="text-sm">
                    {detail.artifact.runtimeKind} · {detail.artifact.template}
                  </div>
                </div>
              </div>

              {/* Skill IR */}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Skill IR</h3>
                {detail.skillIr ? (
                  <div className="rounded-lg border border-border bg-black/5 p-3 dark:bg-white/5">
                    <div className="mb-2 text-xs text-muted">
                      schemaVersion: {detail.skillIr.schemaVersion ?? '—'}
                    </div>
                    <pre className="max-h-64 overflow-auto text-xs leading-relaxed">
                      {JSON.stringify(detail.skillIr.specJson, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm text-muted">此 Artifact 未關聯 SkillVersion IR</p>
                )}
              </div>

              {/* artifactJson collapsible */}
              <details className="rounded-lg border border-border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  artifactJson 摘要（已遮罩）
                </summary>
                <pre className="max-h-72 overflow-auto border-t border-border p-3 text-xs">
                  {JSON.stringify(detail.artifact.artifactJson, null, 2)}
                </pre>
              </details>

              {/* Readiness checklist */}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Readiness 檢核（唯讀投影）</h3>
                <p className="mb-3 text-xs text-muted">
                  阻擋原因來自後端決定性資料。實際啟用仍走 fail-closed 八閘，本清單不可替代後端閘。
                </p>
                <ul className="space-y-2">
                  {detail.readiness.checks.map((c) => (
                    <li
                      key={c.key}
                      className={cn(
                        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
                        c.ok
                          ? 'border-emerald-500/20 bg-emerald-500/5'
                          : 'border-rose-500/30 bg-rose-500/10',
                      )}
                    >
                      {c.ok ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium">{readinessLabel(c.key)}</div>
                        <div className={cn('text-xs', c.ok ? 'text-muted' : 'text-rose-300')}>
                          {c.reason}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {readinessSummary && !readinessSummary.canActivate && (
                  <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                    <div className="mb-1 flex items-center gap-2 font-medium">
                      <ShieldAlert className="h-4 w-4" />
                      目前不可啟用（{readinessSummary.gaps.length} 項缺口）
                    </div>
                    <ul className="list-inside list-disc text-xs">
                      {readinessSummary.gaps.map((g) => (
                        <li key={g.key}>
                          {g.label}：{g.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
                <label className="block text-sm">
                  <span className="label">Environment</span>
                  <select
                    className="input mt-1"
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value as Env)}
                    disabled={busy}
                  >
                    <option value="PRODUCTION">PRODUCTION</option>
                    <option value="STAGING">STAGING</option>
                    <option value="SANDBOX">SANDBOX</option>
                  </select>
                </label>

                <button
                  type="button"
                  className="btn-ghost border border-border text-sm"
                  disabled={busy}
                  onClick={() => validateMut.mutate(detail.artifact.id)}
                >
                  {validateMut.isPending ? <Spinner className="h-4 w-4" /> : null}
                  執行 Runtime 驗證
                </button>

                <button
                  type="button"
                  className="btn-primary text-sm"
                  disabled={busy || !detail.readiness.canActivate}
                  title={
                    detail.readiness.canActivate
                      ? '啟用 CANARY'
                      : 'readiness 未通過；後端仍為權威'
                  }
                  onClick={() =>
                    activateMut.mutate({
                      artifactId: detail.artifact.id,
                      environment,
                      channel: 'CANARY',
                    })
                  }
                >
                  啟用 CANARY
                </button>

                <button
                  type="button"
                  className="btn-primary text-sm"
                  disabled={busy || !detail.readiness.canActivate}
                  title={
                    detail.readiness.canActivate
                      ? '升級 STABLE'
                      : 'readiness 未通過；後端仍為權威'
                  }
                  onClick={() =>
                    activateMut.mutate({
                      artifactId: detail.artifact.id,
                      environment,
                      channel: 'STABLE',
                    })
                  }
                >
                  升級 STABLE
                </button>
              </div>

              {/* Per-artifact deployments */}
              <div>
                <h3 className="mb-2 text-sm font-semibold">此 Artifact 的部署</h3>
                {detail.deployments.length === 0 ? (
                  <p className="text-sm text-muted">尚無部署紀錄</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.deployments.map((dep) => {
                      const acts = deploymentActions(dep);
                      return (
                        <li
                          key={dep.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                        >
                          <div>
                            <span className="font-medium">
                              {dep.environment}/{dep.channel}
                            </span>
                            {dep.active ? (
                              <span className="ml-2 badge bg-emerald-500/15 text-emerald-400">
                                active
                              </span>
                            ) : (
                              <span className="ml-2 badge bg-zinc-500/15 text-zinc-400">
                                inactive
                              </span>
                            )}
                            <div className="text-xs text-muted">
                              {dateTime(dep.activatedAt)}
                              {dep.deactivatedAt
                                ? ` → ${dateTime(dep.deactivatedAt)}`
                                : ''}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {acts.canKill && (
                              <button
                                type="button"
                                className="btn-ghost border border-border text-xs text-rose-300"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      '確定要 Kill switch 停用此部署？列會保留、僅取消 active。',
                                    )
                                  ) {
                                    return;
                                  }
                                  deactivateMut.mutate(dep.id);
                                }}
                              >
                                <ShieldAlert className="h-3.5 w-3.5" />
                                Kill switch 停用
                              </button>
                            )}
                            {acts.canRollback && (
                              <button
                                type="button"
                                className="btn-ghost border border-border text-xs"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      '確定回滾至此版本？僅切換 active pointer，不刪歷史。',
                                    )
                                  ) {
                                    return;
                                  }
                                  rollbackMut.mutate(dep.id);
                                }}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                回滾至此版本
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Global deployments card */}
      <section className="card p-5">
        <h2 className="mb-1 font-semibold">Deployments（全域）</h2>
        <p className="mb-4 text-xs text-muted">
          依 environment × channel 分組。歷史紀錄永不刪除；回滾只切 pointer。
        </p>
        {deploymentsQ.isLoading && (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        )}
        {deploymentsQ.isError && (
          <EmptyState
            title="無法載入 Deployments"
            hint={(deploymentsQ.error as Error)?.message}
          />
        )}
        {deploymentsQ.data && deploymentGroups.length === 0 && (
          <EmptyState title="尚無部署" hint="啟用 CANARY 或 STABLE 後會出現在此" />
        )}
        <div className="space-y-4">
          {deploymentGroups.map((g) => (
            <div
              key={`${g.environment}-${g.channel}`}
              className="rounded-lg border border-border p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="font-semibold">
                  {g.environment} / {g.channel}
                </span>
                {g.active ? (
                  <span className="badge bg-emerald-500/15 text-emerald-400">有 active</span>
                ) : (
                  <span className="badge bg-zinc-500/15 text-zinc-400">無 active</span>
                )}
              </div>
              {g.active && (
                <div className="mb-2 rounded bg-emerald-500/10 px-3 py-2 text-sm">
                  <div className="font-mono text-xs text-muted">{g.active.id}</div>
                  <div>
                    artifact{' '}
                    <button
                      type="button"
                      className="text-brand underline"
                      onClick={() => setSelectedId(g.active!.artifactId)}
                    >
                      {g.active.artifactId}
                    </button>
                  </div>
                  <div className="text-xs text-muted">
                    啟用於 {dateTime(g.active.activatedAt)}
                  </div>
                  <button
                    type="button"
                    className="btn-ghost border border-border mt-2 text-xs text-rose-300"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          '確定要 Kill switch 停用此部署？列會保留、僅取消 active。',
                        )
                      ) {
                        return;
                      }
                      deactivateMut.mutate(g.active!.id);
                    }}
                  >
                    Kill switch 停用
                  </button>
                </div>
              )}
              {g.history.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">歷史（保留）</div>
                  <ul className="space-y-1 text-sm">
                    {g.history.map((h) => (
                      <li
                        key={h.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-2 py-1.5"
                      >
                        <div>
                          <span className="font-mono text-xs">{h.id.slice(0, 10)}…</span>
                          <span className="ml-2 text-xs text-muted">
                            {dateTime(h.activatedAt)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn-ghost border border-border text-xs"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                '確定回滾至此版本？僅切換 active pointer，不刪歷史。',
                              )
                            ) {
                              return;
                            }
                            rollbackMut.mutate(h.id);
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          回滾
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
