'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, ChevronDown, ChevronRight, FileText, GitBranch, RotateCcw, UserPlus } from 'lucide-react';
import { API } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { AppShell } from '@/components/AppShell';
import { ReviewInboxPanel } from '@/components/admin/ReviewInboxPanel';
import { PageHeader, Spinner, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  builderStatusLabel,
  type BuilderHarnessSnapshot,
  type BuilderMessageResult,
  type BuilderSession,
} from '@/components/workbench/types';

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

function HarnessSnapshotDetails({ harness }: { harness: BuilderHarnessSnapshot }) {
  return (
    <details className="mt-3 rounded-lg border border-brand/20 bg-brand/[0.03] p-3">
      <summary className="cursor-pointer text-xs font-medium text-brand">
        完整草稿：{harness.skills.length} 技能 · {harness.workflows?.length ?? 0} 流程 · {harness.memory.documents?.length ?? 0} 記憶文件
        {harness.provenance ? ` · ${harness.provenance.source}` : ''}
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <div>
          <div className="font-medium">身份與目的</div>
          <p className="mt-1 whitespace-pre-wrap text-muted">{harness.identity.name}：{harness.identity.purpose}</p>
          {harness.identity.workingStyle.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {harness.identity.workingStyle.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
        </div>

        {(harness.agentMarkdown || harness.claudeMarkdown) && (
          <div className="grid gap-2 lg:grid-cols-2">
            {harness.agentMarkdown && (
              <details className="rounded-md border border-border/70 p-2">
                <summary className="cursor-pointer font-medium">Agent Markdown</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{harness.agentMarkdown}</pre>
              </details>
            )}
            {harness.claudeMarkdown && (
              <details className="rounded-md border border-border/70 p-2">
                <summary className="cursor-pointer font-medium">Claude 操作備註</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{harness.claudeMarkdown}</pre>
              </details>
            )}
          </div>
        )}

        {harness.skills.length > 0 && (
          <div>
            <div className="font-medium">技能草稿</div>
            <div className="mt-1.5 space-y-2">
              {harness.skills.map((skill, index) => (
                <details key={`${skill.name}-${index}`} className="rounded-md border border-border/70 p-2">
                  <summary className="cursor-pointer font-medium">{skill.name}</summary>
                  <p className="mt-1 text-muted">{skill.purpose}</p>
                  {skill.contentMd ? (
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{skill.contentMd}</pre>
                  ) : (
                    <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-muted">
                      {skill.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
                    </ol>
                  )}
                </details>
              ))}
            </div>
          </div>
        )}

        {(harness.memory.documents?.length ?? 0) > 0 && (
          <div>
            <div className="font-medium">記憶文件</div>
            <div className="mt-1.5 space-y-2">
              {harness.memory.documents!.map((document) => (
                <details key={document.path} className="rounded-md border border-border/70 p-2">
                  <summary className="cursor-pointer font-mono">{document.path}</summary>
                  {document.purpose && <p className="mt-1 text-muted">{document.purpose}</p>}
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{document.contentMd}</pre>
                </details>
              ))}
            </div>
          </div>
        )}

        {(harness.workflows?.length ?? 0) > 0 && (
          <div>
            <div className="font-medium">工作流程草稿（正式匯入後仍預設停用）</div>
            <div className="mt-1.5 space-y-2">
              {harness.workflows!.map((workflow, index) => (
                <details key={`${workflow.name}-${index}`} className="rounded-md border border-border/70 p-2">
                  <summary className="cursor-pointer font-medium">{workflow.name} · {workflow.steps.length} 步</summary>
                  <p className="mt-1 text-muted">{workflow.description}</p>
                  <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-muted">
                    {workflow.steps.map((step) => <li key={step.stepKey}>{step.stepKey} · {step.type}</li>)}
                  </ol>
                </details>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-md border border-border/70 p-2">
            <div className="font-medium">工具／連線</div>
            {harness.tools.length ? (
              <ul className="mt-1 space-y-1 text-muted">
                {harness.tools.map((tool) => <li key={tool.name}>{tool.name} · {tool.status} · {tool.purpose}</li>)}
              </ul>
            ) : <p className="mt-1 text-muted">未提出工具。</p>}
          </div>
          <div className="rounded-md border border-border/70 p-2">
            <div className="font-medium">必須人工核准</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
              {harness.policies.requiresApproval.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </details>
  );
}

export default function ProposalsPage() {
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);
  const qc = useQueryClient();
  const [expandedEvolution, setExpandedEvolution] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const builderReviews = useQuery({
    queryKey: ['agent-builder-reviews'],
    queryFn: () => API.get<BuilderSession[]>('/api/agent-builder/review-queue'),
    enabled: isFde,
    refetchInterval: 5_000,
  });

  const builderEvolutions = useQuery({
    queryKey: ['agent-builder-evolutions'],
    queryFn: () => API.get<BuilderSession[]>('/api/agent-builder/evolution-queue'),
    enabled: isFde,
    refetchInterval: 3_000,
  });

  const approveBuilderMut = useMutation({
    mutationFn: (id: string) =>
      API.post<BuilderMessageResult>(`/api/agent-builder/sessions/${id}/approve-build`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-builder-reviews'] });
      setFlash('已核准建立員工草稿；技能仍待測試與最終確認');
      setActionError(null);
    },
    onError: (e: Error) => setActionError(e.message || '建立核准失敗'),
  });

  const finalizeBuilderMut = useMutation({
    mutationFn: (id: string) =>
      API.post<BuilderMessageResult>(`/api/agent-builder/sessions/${id}/finalize`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-builder-reviews'] });
      setFlash('已確認技能並啟用新員工');
      setActionError(null);
    },
    onError: (e: Error) => setActionError(e.message || '最終確認失敗'),
  });

  return (
    <AppShell>
      <PageHeader title="提案審核 Proposals" subtitle="FDE 審核待決的變更提案（Agent／技能／限制／身份卡）" />

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

          <section className="mb-8 space-y-3">
            <div>
              <h2 className="text-lg font-semibold">Agent 演進紀錄</h2>
              <p className="text-sm text-muted">
                使用者每次對話產生的非生效草稿版本；可檢查理解、技能、記憶、工具與政策如何改變。
              </p>
            </div>
            {builderEvolutions.isLoading && (
              <div className="card flex items-center justify-center py-8"><Spinner /></div>
            )}
            {!builderEvolutions.isLoading && (builderEvolutions.data?.length ?? 0) === 0 && (
              <div className="card px-4 py-5 text-sm text-muted">目前還沒有 Agent 對話演進紀錄。</div>
            )}
            {builderEvolutions.data?.map((flow) => {
              const latest = flow.latestIteration;
              const latestReady = [...flow.iterations].reverse().find((iteration) => iteration.status === 'READY');
              const open = expandedEvolution === flow.id;
              const displayName = latest?.harness?.identity.name
                ?? flow.plan?.proposedAgentName
                ?? flow.brief?.requestedAgentName
                ?? flow.brief?.objective
                ?? '未命名 AI 員工';
              const working = ['QUEUED', 'ANALYZING', 'BUILDING'].includes(latest?.status ?? '');
              return (
                <article key={flow.id} className="card overflow-hidden border-brand/15">
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 p-4 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                    onClick={() => setExpandedEvolution(open ? null : flow.id)}
                  >
                    <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{displayName}</span>
                        <span className="badge bg-brand/10 text-brand">{flow.iterations.length} 次迭代</span>
                        <span className={cn('badge', working ? 'bg-amber-500/15 text-amber-500' : latest?.status === 'FAILED' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-500')}>
                          {working ? '建置中' : latest?.status === 'FAILED' ? '失敗' : '草稿已更新'}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs text-muted">
                        {working
                          ? latestReady
                            ? `第 ${latest?.sequence ?? '?'} 版建置中；第 ${latestReady.sequence} 版草稿可檢查`
                            : '正在建立第一版非生效草稿'
                          : latest?.fdeSummary ?? latest?.userSummary ?? '等待第一版草稿完成'}
                      </span>
                    </span>
                    {open ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
                  </button>

                  {open && (
                    <div className="space-y-3 border-t border-border px-4 py-4">
                      {[...flow.iterations].reverse().map((iteration) => (
                        <div key={iteration.id} className="rounded-lg border border-border/70 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              第 {iteration.sequence} 版
                              <span className="badge bg-black/5 text-muted dark:bg-white/5">{iteration.triggerKind}</span>
                              <span className="badge bg-black/5 text-muted dark:bg-white/5">{iteration.status}</span>
                            </div>
                            <span className="text-xs text-muted">{timeAgo(iteration.updatedAt)}</span>
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-muted">觸發：{iteration.triggerSummary}</p>
                          {iteration.fdeSummary && (
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{iteration.fdeSummary}</p>
                          )}
                          {iteration.changes.length > 0 && (
                            <ul className="mt-2 space-y-1.5">
                              {iteration.changes.map((change, index) => (
                                <li key={`${iteration.id}-${index}`} className="flex gap-2 text-xs">
                                  <span className="badge bg-brand/10 text-brand">{change.area} · {change.action}</span>
                                  <span className="text-muted">{change.summary}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {iteration.understanding?.contradictions.length ? (
                            <div className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-600 dark:text-amber-300">
                              發現分歧：{iteration.understanding.contradictions.join('；')}
                            </div>
                          ) : null}
                          {iteration.harness && <HarnessSnapshotDetails harness={iteration.harness} />}
                        </div>
                      ))}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          disabled
                          title="介面先保留，回溯尚未實作"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          回溯到選定版本（尚未開放）
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <section className="mb-8 space-y-3">
            <div>
              <h2 className="text-lg font-semibold">Agent 建立審核</h2>
              <p className="text-sm text-muted">
                檢查前臺訪談、上傳來源、測試證據與權限邊界，再決定是否建立或啟用。
              </p>
            </div>
            {builderReviews.isLoading && (
              <div className="card flex items-center justify-center py-8"><Spinner /></div>
            )}
            {!builderReviews.isLoading && (builderReviews.data?.length ?? 0) === 0 && (
              <div className="card px-4 py-5 text-sm text-muted">目前沒有待審的 Agent 建立流程。</div>
            )}
            {builderReviews.data?.map((review) => {
              const sources = review.brief?.sourceFiles ?? [];
              const latestReviewHarness = [...review.iterations].reverse().find((iteration) => iteration.status === 'READY')?.harness ?? null;
              const proposedName = review.plan?.proposedAgentName ?? review.brief?.objective ?? '新 AI 員工';
              const buildApproval = review.status === 'AWAITING_FDE';
              const finalApproval = review.status === 'PASSED';
              const busy = busyId === review.id;
              return (
                <article key={review.id} className="card space-y-4 border-brand/20 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <UserPlus className="h-4 w-4 text-brand" />
                        <h3 className="font-semibold">{proposedName}</h3>
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        建立流程 {review.id.slice(0, 10)} · {new Date(review.updatedAt ?? '').toLocaleString('zh-Hant-TW')}
                      </div>
                    </div>
                    <span className="badge bg-brand/10 text-brand">{builderStatusLabel(review.status)}</span>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg border border-border/70 p-3">
                      <div className="mb-2 text-xs font-medium text-muted">前臺需求與權限</div>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">
                        {review.brief?.objective ?? review.transcript.find((entry) => entry.role === 'user')?.content}
                      </p>
                      {review.brief?.permissions && (
                        <p className="mt-2 text-xs leading-relaxed text-muted">{review.brief.permissions}</p>
                      )}
                    </div>
                    <div className="rounded-lg border border-border/70 p-3">
                      <div className="mb-2 text-xs font-medium text-muted">前臺上傳來源</div>
                      {sources.length === 0 ? (
                        <p className="text-sm text-muted">本次未提供檔案；可能以對話、公開來源或已連線系統為依據。</p>
                      ) : (
                        <ul className="space-y-2">
                          {sources.map((source) => (
                            <li key={source.name} className="flex items-center gap-2 text-sm">
                              <FileText className="h-4 w-4 text-brand" />
                              <span className="font-medium">{source.name}</span>
                              <span className="ml-auto text-xs text-muted">{source.content.length.toLocaleString()} 字</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {latestReviewHarness && <HarnessSnapshotDetails harness={latestReviewHarness} />}

                  {review.testResult && (
                    <div className={cn(
                      'rounded-lg border px-3 py-2 text-sm',
                      review.testResult.ok
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                        : 'border-rose-500/30 bg-rose-500/10 text-rose-400',
                    )}>
                      <div className="font-medium">{review.testResult.ok ? '測試已通過' : '測試未通過'}</div>
                      <div className="mt-1">{review.testResult.summary}</div>
                    </div>
                  )}

                  <div className="flex justify-end">
                    {buildApproval && (
                      <button
                        type="button"
                        className="btn-primary text-sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusyId(review.id);
                          try { await approveBuilderMut.mutateAsync(review.id); }
                          finally { setBusyId(null); }
                        }}
                      >
                        {busy ? <Spinner className="h-3.5 w-3.5" /> : <Check className="h-4 w-4" />}
                        核准建立草稿
                      </button>
                    )}
                    {finalApproval && (
                      <button
                        type="button"
                        className="btn-primary text-sm"
                        disabled={busy || !review.testResult?.ok}
                        onClick={async () => {
                          setBusyId(review.id);
                          try { await finalizeBuilderMut.mutateAsync(review.id); }
                          finally { setBusyId(null); }
                        }}
                      >
                        {busy ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-4 w-4" />}
                        確認技能並啟用
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>

          <section className="mb-8 space-y-3">
            <div>
              <h2 className="text-lg font-semibold">統一審核收件匣（提案＋執行核准）</h2>
              <p className="text-sm text-muted">
                ChangeProposal 與 ApprovalRequest 合併呈現；Langflow／Runtime checkpoint 僅供參考，唯一核准來源是 AIOS DB。
              </p>
            </div>
            <ReviewInboxPanel />
          </section>
        </>
      )}
    </AppShell>
  );
}
