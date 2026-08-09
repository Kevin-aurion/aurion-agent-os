'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  Download,
  FileCheck2,
  FlaskConical,
  GitBranch,
  History,
  Link2,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { EmptyState, PageHeader, Spinner } from '@/components/ui';
import {
  builderStatusLabel,
  type BuilderHarnessSnapshot,
  type BuilderIteration,
  type BuilderSession,
} from '@/components/workbench/types';
import { API, downloadToDevice } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';

type SourceFilter = 'ALL' | 'AIOS' | NonNullable<BuilderHarnessSnapshot['provenance']>['source'];

const SOURCE_LABELS: Record<SourceFilter, string> = {
  ALL: '全部來源',
  AIOS: 'AIOS 前臺',
  CLAUDE_DESKTOP: 'Claude Desktop',
  CLAUDE_CODE: 'Claude Code',
  CHATGPT: 'ChatGPT / Codex',
  CURSOR: 'Cursor',
  OTHER: '其他外部來源',
};

const ITERATION_STATUS_LABELS: Record<string, string> = {
  QUEUED: '排隊中',
  ANALYZING: '理解需求中',
  BUILDING: '更新中',
  READY: '草稿完成',
  FAILED: '更新失敗',
  SUPERSEDED: '已有新版',
};

const TRIGGER_LABELS: Record<string, string> = {
  message: '對話',
  file: '檔案',
  external_artifact: '外部 Agent 同步',
  test: '測試結果',
  system: '系統',
};

function latestHarnessIteration(session: BuilderSession): BuilderIteration | null {
  return [...session.iterations]
    .filter((iteration) => iteration.harness)
    .sort((a, b) => b.sequence - a.sequence)[0] ?? null;
}

function sourceOf(session: BuilderSession): Exclude<SourceFilter, 'ALL'> {
  const external = [...session.iterations]
    .filter((iteration) => iteration.harness?.provenance)
    .sort((a, b) => b.sequence - a.sequence)[0];
  return external?.harness?.provenance?.source ?? session.brief?.externalSource ?? 'AIOS';
}

function displayNameOf(session: BuilderSession): string {
  return latestHarnessIteration(session)?.harness?.identity.name
    ?? session.plan?.proposedAgentName
    ?? session.brief?.requestedAgentName
    ?? session.brief?.objective
    ?? '未命名 AI 員工';
}

function updatedAtOf(session: BuilderSession): string | undefined {
  return session.latestIteration?.updatedAt ?? session.updatedAt ?? session.createdAt;
}

function formatTime(value?: string): string {
  if (!value) return '尚無時間';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚無時間';
  return date.toLocaleString('zh-Hant-TW', { hour12: false });
}

function relativeTime(value?: string): string {
  if (!value) return '尚未更新';
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return '尚未更新';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function sourceClass(source: Exclude<SourceFilter, 'ALL'>): string {
  if (source === 'CLAUDE_DESKTOP') return 'bg-orange-500/15 text-orange-500';
  if (source === 'CHATGPT') return 'bg-emerald-500/15 text-emerald-500';
  if (source === 'CLAUDE_CODE') return 'bg-amber-500/15 text-amber-500';
  if (source === 'CURSOR') return 'bg-sky-500/15 text-sky-500';
  if (source === 'OTHER') return 'bg-violet-500/15 text-violet-500';
  return 'bg-brand/15 text-brand';
}

function sessionStatusClass(status: string): string {
  if (status === 'ACTIVE' || status === 'PASSED') return 'bg-emerald-500/15 text-emerald-500';
  if (status === 'FAILED') return 'bg-rose-500/15 text-rose-400';
  if (status === 'AWAITING_FDE') return 'bg-amber-500/15 text-amber-500';
  return 'bg-brand/10 text-brand';
}

function iterationStatusClass(status: string): string {
  if (status === 'READY') return 'bg-emerald-500/15 text-emerald-500';
  if (status === 'FAILED') return 'bg-rose-500/15 text-rose-400';
  if (status === 'SUPERSEDED') return 'bg-zinc-500/15 text-zinc-400';
  return 'bg-amber-500/15 text-amber-500';
}

function CountTile({ icon: Icon, label, value }: { icon: typeof Wrench; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/70 bg-black/[0.02] px-3 py-2.5 dark:bg-white/[0.02]">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SnapshotDetails({ harness }: { harness: BuilderHarnessSnapshot }) {
  return (
    <div className="space-y-5">
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border/70 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4 text-brand" />
            身份與工作方式
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted">{harness.identity.purpose || '尚未整理工作目的。'}</p>
          {harness.identity.workingStyle.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
              {harness.identity.workingStyle.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-border/70 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-brand" />
            權限邊界
          </div>
          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <PolicyList title="可執行" items={harness.policies.allowed} empty="尚未定義" tone="text-emerald-500" />
            <PolicyList title="需人工核准" items={harness.policies.requiresApproval} empty="沒有提出" tone="text-amber-500" />
            <PolicyList title="禁止" items={harness.policies.forbidden} empty="尚未定義" tone="text-rose-400" />
          </div>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Wrench className="h-4 w-4 text-brand" />
          技能草稿
        </div>
        {harness.skills.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">尚未產生技能草稿。</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {harness.skills.map((skill, index) => (
              <details key={`${skill.name}-${index}`} className="rounded-lg border border-border/70 p-3">
                <summary className="cursor-pointer text-sm font-medium">{skill.name}</summary>
                <p className="mt-2 text-xs leading-relaxed text-muted">{skill.purpose}</p>
                {skill.contentMd ? (
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-black/5 p-3 text-[11px] leading-relaxed text-muted dark:bg-white/5">{skill.contentMd}</pre>
                ) : skill.instructions.length > 0 ? (
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted">
                    {skill.instructions.map((instruction, instructionIndex) => (
                      <li key={`${instruction}-${instructionIndex}`}>{instruction}</li>
                    ))}
                  </ol>
                ) : null}
              </details>
            ))}
          </div>
        )}
      </section>

      {(harness.workflows?.length ?? 0) > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Workflow className="h-4 w-4 text-brand" />
            工作流程草稿
            <span className="text-xs font-normal text-muted">正式匯入後仍預設停用</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {harness.workflows!.map((workflow, index) => (
              <details key={`${workflow.name}-${index}`} className="rounded-lg border border-border/70 p-3">
                <summary className="cursor-pointer text-sm font-medium">{workflow.name} · {workflow.steps.length} 步</summary>
                <p className="mt-2 text-xs leading-relaxed text-muted">{workflow.description}</p>
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-muted">
                  {workflow.steps.map((step) => <li key={step.stepKey}>{step.stepKey} · {step.type}</li>)}
                </ol>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-3 lg:grid-cols-3">
        <CompactList
          icon={Link2}
          title="工具與連線"
          items={harness.tools.map((tool) => `${tool.name} · ${tool.status} — ${tool.purpose}`)}
          empty="尚未提出工具。"
        />
        <CompactList
          icon={Brain}
          title="記憶內容"
          items={[...harness.memory.facts, ...harness.memory.preferences, ...harness.memory.glossary]}
          empty="尚未整理記憶。"
        />
        <CompactList
          icon={FlaskConical}
          title="測試想法"
          items={harness.testIdeas.map((test) => `${test.name} — ${test.expected}`)}
          empty="尚未建立測試想法。"
        />
      </section>

      {(harness.memory.documents?.length ?? 0) > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Database className="h-4 w-4 text-brand" />
            記憶文件
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {harness.memory.documents!.map((document, index) => (
              <details key={`${document.path}-${index}`} className="rounded-lg border border-border/70 p-3">
                <summary className="cursor-pointer font-mono text-xs">{document.path}</summary>
                {document.purpose && <p className="mt-2 text-xs text-muted">{document.purpose}</p>}
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-black/5 p-3 text-[11px] leading-relaxed text-muted dark:bg-white/5">{document.contentMd}</pre>
              </details>
            ))}
          </div>
        </section>
      )}

      {(harness.agentMarkdown || harness.claudeMarkdown) && (
        <section className="grid gap-3 lg:grid-cols-2">
          {harness.agentMarkdown && <MarkdownDetails title="Agent Markdown" content={harness.agentMarkdown} />}
          {harness.claudeMarkdown && <MarkdownDetails title="Claude 操作備註" content={harness.claudeMarkdown} />}
        </section>
      )}
    </div>
  );
}

function PolicyList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: string }) {
  return (
    <div>
      <div className={cn('font-medium', tone)}>{title}</div>
      {items.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted">
          {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ul>
      ) : <p className="mt-1.5 text-muted">{empty}</p>}
    </div>
  );
}

function CompactList({ icon: Icon, title, items, empty }: { icon: typeof Link2; title: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-lg border border-border/70 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-brand" />
        {title}
      </div>
      {items.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted">
          {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ul>
      ) : <p className="mt-3 text-xs text-muted">{empty}</p>}
    </div>
  );
}

function MarkdownDetails({ title, content }: { title: string; content: string }) {
  return (
    <details className="rounded-lg border border-border/70 p-3">
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-black/5 p-3 text-[11px] leading-relaxed text-muted dark:bg-white/5">{content}</pre>
    </details>
  );
}

function BuildActions({
  session,
  harness,
  isFde,
}: {
  session: BuilderSession;
  harness: BuilderHarnessSnapshot | null;
  isFde: boolean;
}) {
  const queryClient = useQueryClient();
  const suggestedTest = harness?.testIdeas[0];
  const [testData, setTestData] = useState(suggestedTest?.input ?? '');
  const [expected, setExpected] = useState(suggestedTest?.expected ?? '');

  useEffect(() => {
    if (!testData && suggestedTest?.input) setTestData(suggestedTest.input);
    if (!expected && suggestedTest?.expected) setExpected(suggestedTest.expected);
  }, [expected, suggestedTest?.expected, suggestedTest?.input, testData]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent-builder-evolutions'] });
  };
  const submitReview = useMutation({
    mutationFn: () => API.post(`/api/agent-builder/sessions/${session.id}/submit-review`, { strategy: 'create' }),
    onSuccess: refresh,
  });
  const approveBuild = useMutation({
    mutationFn: () => API.post(`/api/agent-builder/sessions/${session.id}/approve-build`, {}),
    onSuccess: refresh,
  });
  const runTest = useMutation({
    mutationFn: async () => {
      await API.post(`/api/agent-builder/sessions/${session.id}/test-data`, {
        data: testData,
        expected,
      });
      return API.post(`/api/agent-builder/sessions/${session.id}/test`, {});
    },
    onSuccess: refresh,
  });
  const exportPackage = useMutation({
    mutationFn: () => downloadToDevice(`/api/agent-builder/sessions/${session.id}/export`),
  });
  const pending = submitReview.isPending || approveBuild.isPending || runTest.isPending || exportPackage.isPending;
  const error = submitReview.error ?? approveBuild.error ?? runTest.error ?? exportPackage.error;
  const latestReady = [...session.iterations].reverse().find((iteration) => iteration.status === 'READY' && iteration.harness);
  const canSubmit = Boolean(
    latestReady
    && session.ownedByCurrentUser !== false
    && ['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(session.status),
  );
  const canApprove = isFde && session.status === 'AWAITING_FDE';
  const canTest = ['AWAITING_TEST_DATA', 'FAILED', 'PASSED'].includes(session.status)
    && Boolean(session.builtAgentId || session.targetAgentId);

  return (
    <section className="rounded-xl border border-brand/20 bg-brand/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <FlaskConical className="h-4 w-4 text-brand" />
            建立與測試
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            對話會先在背景建立 Agent、Skill、記憶與流程草稿；正式待測版本與外部權限仍由 FDE 核准。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSubmit && (
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={pending} onClick={() => submitReview.mutate()}>
              {submitReview.isPending ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
              送交建立待測版本
            </button>
          )}
          {canApprove && (
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={pending} onClick={() => approveBuild.mutate()}>
              {approveBuild.isPending ? <Spinner /> : <ShieldCheck className="h-3.5 w-3.5" />}
              FDE 核准建立草稿
            </button>
          )}
          {session.status === 'ACTIVE' && (
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={pending} onClick={() => exportPackage.mutate()}>
              {exportPackage.isPending ? <Spinner /> : <Download className="h-3.5 w-3.5" />}
              匯出 Agent ZIP
            </button>
          )}
        </div>
      </div>

      {session.status === 'AWAITING_FDE' && !isFde && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">已送交 FDE；核准後即可在這裡放入測試資料並調用待測 Agent。</p>
      )}
      {session.status === 'TESTING' && (
        <p className="mt-3 rounded-lg bg-brand/10 px-3 py-2 text-xs text-brand">Agent 正在隔離試跑與跨模型驗證，完成後本頁會自動更新。</p>
      )}

      {canTest && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <label className="text-xs font-medium">
            測試資料
            <textarea className="input mt-1 min-h-28 resize-y text-xs" value={testData} onChange={(event) => setTestData(event.target.value)} placeholder="貼上匿名化測試資料或使用背景建議的案例" />
          </label>
          <label className="text-xs font-medium">
            預期結果
            <textarea className="input mt-1 min-h-28 resize-y text-xs" value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="描述什麼結果才算通過" />
          </label>
          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={pending || !testData.trim() || !expected.trim()} onClick={() => runTest.mutate()}>
              {runTest.isPending ? <Spinner /> : <FlaskConical className="h-3.5 w-3.5" />}
              調用 Agent 隔離試跑
            </button>
            {session.testResult && (
              <span className={cn('text-xs', session.testResult.ok ? 'text-emerald-500' : 'text-rose-400')}>
                {session.testResult.summary}
              </span>
            )}
          </div>
        </div>
      )}
      {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{error instanceof Error ? error.message : '操作失敗，請重試。'}</p>}
    </section>
  );
}

function BuildCard({ session, open, onToggle, isFde }: { session: BuilderSession; open: boolean; onToggle: () => void; isFde: boolean }) {
  const harnessIteration = latestHarnessIteration(session);
  const harness = harnessIteration?.harness ?? null;
  const source = sourceOf(session);
  const latest = session.latestIteration;
  const working = latest ? ['QUEUED', 'ANALYZING', 'BUILDING'].includes(latest.status) : false;
  const memoryCount = (harness?.memory.documents?.length ?? 0)
    + (harness?.memory.facts.length ?? 0)
    + (harness?.memory.preferences.length ?? 0)
    + (harness?.memory.glossary.length ?? 0);

  return (
    <article className={cn('card overflow-hidden transition-colors', open && 'border-brand/35')}>
      <button
        type="button"
        className="w-full p-5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
        onClick={onToggle}
        aria-expanded={open}
      >
        <div className="flex items-start gap-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold">{displayNameOf(session)}</h2>
              <span className={cn('badge', sourceClass(source))}>{SOURCE_LABELS[source]}</span>
              <span className={cn('badge', sessionStatusClass(session.status))}>{builderStatusLabel(session.status)}</span>
              {working && <span className="badge bg-amber-500/15 text-amber-500">正在更新</span>}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {harness?.identity.purpose
                ?? session.brief?.objective
                ?? latest?.fdeSummary
                ?? '等待同步 Agent 的目的與能力。'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" />{session.iterations.length} 次迭代</span>
              <span className="inline-flex items-center gap-1.5"><MessageSquareText className="h-3.5 w-3.5" />{session.transcript.length} 則訓練對話</span>
              <span className="inline-flex items-center gap-1.5" title={formatTime(updatedAtOf(session))}><Clock3 className="h-3.5 w-3.5" />{relativeTime(updatedAtOf(session))}</span>
              <span className="font-mono">{session.id.slice(0, 12)}</span>
            </div>
          </div>
          {open ? <ChevronDown className="h-5 w-5 shrink-0 text-muted" /> : <ChevronRight className="h-5 w-5 shrink-0 text-muted" />}
        </div>

        {harness && (
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/70 pt-4 sm:grid-cols-3 lg:grid-cols-6">
            <CountTile icon={Wrench} label="技能" value={harness.skills.length} />
            <CountTile icon={Workflow} label="工作流" value={harness.workflows?.length ?? 0} />
            <CountTile icon={Brain} label="記憶項目" value={memoryCount} />
            <CountTile icon={Link2} label="工具" value={harness.tools.length} />
            <CountTile icon={FlaskConical} label="測試" value={harness.testIdeas.length} />
            <CountTile icon={History} label="版本" value={session.iterations.length} />
          </div>
        )}
      </button>

      {open && (
        <div className="space-y-6 border-t border-border px-5 py-5">
          <div className={cn('flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3', session.status === 'ACTIVE' ? 'border-emerald-500/25 bg-emerald-500/[0.06]' : 'border-amber-500/25 bg-amber-500/[0.06]')}>
            <div className="flex items-start gap-2 text-sm">
              <ShieldCheck className={cn('mt-0.5 h-4 w-4 shrink-0', session.status === 'ACTIVE' ? 'text-emerald-500' : 'text-amber-500')} />
              <div>
                <div className="font-medium">{session.status === 'ACTIVE' ? '已通過治理並啟用' : '目前是受治理的建置草稿'}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-muted">{session.status === 'ACTIVE' ? '可匯出成標準資料夾結構的 ZIP；憑證與啟用排程不會被帶出。' : '顯示在此不代表已啟用；正式建立、技能確認與上線仍必須經 FDE 審核。'}</div>
              </div>
            </div>
            {isFde && (
              <Link href="/proposals" className="btn-ghost border border-border px-3 py-1.5 text-xs">
                <FileCheck2 className="h-3.5 w-3.5" />
                完整審核紀錄
              </Link>
            )}
          </div>

          <BuildActions session={session} harness={harness} isFde={isFde} />

          {harness ? <SnapshotDetails harness={harness} /> : (
            <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted">尚未完成第一份 Agent 草稿。</div>
          )}

          {session.transcript.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <MessageSquareText className="h-4 w-4 text-brand" />
                訓練對話紀錄
              </div>
              <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border/70 p-3">
                {session.transcript.slice(-12).map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className={cn('rounded-lg px-3 py-2 text-xs leading-relaxed', entry.role === 'user' ? 'ml-8 bg-brand/10' : 'mr-8 bg-black/5 dark:bg-white/5')}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                      <span>{entry.role === 'user' ? '使用者／外部 Client' : entry.role}</span>
                      <span>{formatTime(entry.at)}</span>
                    </div>
                    <div className="whitespace-pre-wrap">{entry.content}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <GitBranch className="h-4 w-4 text-brand" />
              版本與演進歷程
            </div>
            <div className="space-y-2">
              {[...session.iterations].sort((a, b) => b.sequence - a.sequence).map((iteration, index) => (
                <details key={iteration.id} open={index === 0} className="rounded-lg border border-border/70 p-3">
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center gap-2">
                      <CircleDot className="h-3.5 w-3.5 text-brand" />
                      <span className="text-sm font-medium">第 {iteration.sequence} 版</span>
                      <span className="badge bg-black/5 text-muted dark:bg-white/5">{TRIGGER_LABELS[iteration.triggerKind] ?? iteration.triggerKind}</span>
                      <span className={cn('badge', iterationStatusClass(iteration.status))}>{ITERATION_STATUS_LABELS[iteration.status] ?? iteration.status}</span>
                      <span className="ml-auto text-xs text-muted">{formatTime(iteration.updatedAt)}</span>
                    </div>
                  </summary>
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <p className="text-xs leading-relaxed text-muted">觸發：{iteration.triggerSummary}</p>
                    {(iteration.fdeSummary || iteration.userSummary) && (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{iteration.fdeSummary ?? iteration.userSummary}</p>
                    )}
                    {iteration.changes.length > 0 && (
                      <ul className="mt-3 space-y-1.5">
                        {iteration.changes.map((change, changeIndex) => (
                          <li key={`${iteration.id}-${changeIndex}`} className="flex items-start gap-2 text-xs">
                            <span className="badge shrink-0 bg-brand/10 text-brand">{change.area} · {change.action}</span>
                            <span className="text-muted">{change.summary}{change.reason ? ` — ${change.reason}` : ''}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {iteration.error && <p className="mt-2 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{iteration.error}</p>}
                  </div>
                </details>
              ))}
            </div>
          </section>
        </div>
      )}
    </article>
  );
}

export default function AgentBuildsPage() {
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);
  const queryClient = useQueryClient();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const builds = useQuery({
    queryKey: ['agent-builder-evolutions'],
    queryFn: () => API.get<BuilderSession[]>('/api/agent-builder/evolution-queue'),
    enabled: Boolean(user),
    refetchInterval: 5_000,
  });
  useAwp(['agent-builder.*'], () => {
    void queryClient.invalidateQueries({ queryKey: ['agent-builder-evolutions'] });
  });

  const sessions = builds.data ?? [];
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-Hant-TW');
    return sessions.filter((session) => {
      const source = sourceOf(session);
      if (sourceFilter !== 'ALL' && source !== sourceFilter) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        displayNameOf(session),
        session.id,
        session.brief?.objective,
        latestHarnessIteration(session)?.harness?.identity.purpose,
      ].filter(Boolean).join(' ').toLocaleLowerCase('zh-Hant-TW');
      return haystack.includes(normalizedQuery);
    });
  }, [query, sessions, sourceFilter]);

  const externalCount = sessions.filter((session) => sourceOf(session) !== 'AIOS').length;
  const awaitingFdeCount = sessions.filter((session) => session.status === 'AWAITING_FDE').length;
  const activeCount = sessions.filter((session) => session.status === 'ACTIVE').length;
  const workingCount = sessions.filter((session) => ['QUEUED', 'ANALYZING', 'BUILDING'].includes(session.latestIteration?.status ?? '')).length;

  return (
    <AppShell>
      <PageHeader
        title="Agent 建置中心"
        subtitle="統一檢視從 AIOS、Claude Desktop、Claude Code 與 Cursor 同步進來的新 Agent、能力草稿與演進版本"
        action={(
          <button type="button" className="btn-ghost border border-border" onClick={() => void builds.refetch()} disabled={builds.isFetching}>
            {builds.isFetching ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            重新整理
          </button>
        )}
      />

      <div className="mb-5 flex items-start gap-3 rounded-xl border border-brand/20 bg-brand/[0.05] px-4 py-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <div className="text-sm leading-relaxed">
          <span className="font-medium">對話會自動保存，Agent 與 Skill 會在背景持續更新。</span>
          <span className="text-muted"> 你不需要在 Claude 裡反覆提醒系統記錄；待測草稿、隔離試跑與 FDE 核准都可在這個獨立入口完成。</span>
        </div>
      </div>

      <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="全部建置" value={sessions.length} icon={Bot} />
        <SummaryCard label="外部同步" value={externalCount} icon={Link2} />
        <SummaryCard label="背景處理中" value={workingCount} icon={RefreshCw} />
        <SummaryCard label="等待 FDE" value={awaitingFdeCount} icon={ShieldCheck} />
        <SummaryCard label="已啟用" value={activeCount} icon={CircleDot} />
      </section>

      <section className="card mb-5 space-y-3 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" />
          <input
            className="input pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜尋 Agent 名稱、目的或建置 ID…"
            aria-label="搜尋 Agent 建置"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((source) => (
            <button
              key={source}
              type="button"
              className={cn('rounded-lg border px-3 py-1.5 text-xs transition-colors', sourceFilter === source ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:text-foreground')}
              onClick={() => setSourceFilter(source)}
            >
              {SOURCE_LABELS[source]}
            </button>
          ))}
        </div>
      </section>

      {builds.isLoading && <div className="card flex items-center justify-center py-16"><Spinner className="h-6 w-6" /></div>}
      {builds.isError && <EmptyState title="無法載入 Agent 建置資料" hint="請確認後端連線後重新整理" />}
      {!builds.isLoading && !builds.isError && sessions.length === 0 && (
        <EmptyState title="目前還沒有 Agent 建置紀錄" hint="從 Claude、Cursor 或 AIOS 開始建置後，資料會自動出現在這裡" />
      )}
      {!builds.isLoading && !builds.isError && sessions.length > 0 && filtered.length === 0 && (
        <EmptyState title="沒有符合條件的 Agent" hint="請調整搜尋文字或來源篩選" />
      )}
      {filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((session) => (
            <BuildCard
              key={session.id}
              session={session}
              open={expandedId === session.id}
              onToggle={() => setExpandedId(expandedId === session.id ? null : session.id)}
              isFde={isFde}
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}

function SummaryCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Bot }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand/10 text-brand"><Icon className="h-4 w-4" /></div>
      <div>
        <div className="text-xs text-muted">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}
