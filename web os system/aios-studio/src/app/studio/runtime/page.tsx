'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight, BookOpenCheck, Boxes, CheckCircle2, CircleAlert, Clock3,
  Database, ExternalLink, FileSearch, GitBranch, LoaderCircle, Play,
  Radio, RefreshCw, Rocket, ShieldCheck,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { API, ApiError } from '@/lib/api';
import type { Deployment, KnowledgePilotRun, KnowledgePilotStatus } from '@/lib/types';
import {
  EmptyState, ErrorState, GateNotice, LoadingState, Metric, PageHeader,
  Section, StatusBadge,
} from '@/components/ui';
import { isFde, useAuth } from '@/lib/auth';
import { formatRuntimeDuration, isKnowledgePilotReady } from '@/lib/presentation';

function TraceView({ run, busy = false }: { run?: KnowledgePilotRun | null; busy?: boolean }) {
  const placeholder = [
    ['validate_input', '檢查輸入與權限'],
    ['query_index', '查詢 AI 知識索引'],
    ['evidence_gate', '建立證據與引用'],
    ['langflow_sandbox', 'Langflow Sandbox 執行'],
    ['persist_trace', '保存執行紀錄'],
  ];
  const items = run?.trace ?? placeholder.map(([key, label]) => ({
    key, label, status: 'PENDING', durationMs: 0, detail: '等待前一階段完成',
  }));
  return <div className="trace-list" data-testid="knowledge-trace">
    {items.map((step, index) => <div className={`trace-row trace-${String(step.status).toLowerCase()}`} key={`${step.key}-${index}`}>
      <div className="trace-state">
        {busy && !run && index === 0 ? <LoaderCircle className="spin" size={16} />
          : step.status === 'FAILED' ? <CircleAlert size={16} />
            : step.status === 'PENDING' ? <span className="trace-dot" />
              : <CheckCircle2 size={16} />}
      </div>
      <div><strong>{step.label}</strong><span>{step.detail}</span></div>
      <small>{step.status === 'PENDING' ? '等待中' : formatRuntimeDuration(step.durationMs)}</small>
    </div>)}
  </div>;
}

function RunResult({ run }: { run: KnowledgePilotRun }) {
  return <div className="knowledge-result" data-testid="knowledge-result">
    <div className="result-heading">
      <div><span className="eyebrow">GROUNDED ANSWER</span><h3>知識庫回答</h3></div>
      <div className="result-meta"><StatusBadge status={run.status} /><span>{formatRuntimeDuration(run.durationMs)}</span></div>
    </div>
    {run.error ? <ErrorState message={run.error} /> : <pre className="answer-copy">{run.answer}</pre>}
    <div className="citation-list">
      <h4>引用來源 · {run.citations.length}</h4>
      {run.citations.length === 0 ? <p className="citation-empty">這次沒有足夠證據，因此系統沒有補造引用。</p> : run.citations.map((citation) => <a
        className="citation-card"
        href={citation.url}
        target="_blank"
        rel="noreferrer"
        key={`${citation.id}-${citation.url}`}
      >
        <span className="citation-number">{citation.id}</span>
        <span className="citation-copy"><strong>{citation.title}</strong><small>{citation.channel} · {citation.timestamp}{citation.label ? ` · ${citation.label}` : ''}</small><em>{citation.excerpt}</em></span>
        <ExternalLink size={15} />
      </a>)}
    </div>
    <details className="disclosure" open>
      <summary><span><strong>本次執行過程</strong><small>Run {run.id} · 只有 redacted 記錄會保存</small></span></summary>
      <div className="disclosure-body"><TraceView run={run} /></div>
    </details>
  </div>;
}

export default function RuntimePage() {
  const { user } = useAuth();
  const client = useQueryClient();
  const fde = isFde(user?.role);
  const [question, setQuestion] = useState('PDF 轉文字工具有哪些？');
  const [currentRun, setCurrentRun] = useState<KnowledgePilotRun | null>(null);
  const deployments = useQuery({ queryKey: ['deployments'], enabled: fde, queryFn: () => API.get<Deployment[]>('/api/runtime/deployments') });
  const status = useQuery({ queryKey: ['knowledge-pilot-status'], enabled: fde, queryFn: () => API.get<KnowledgePilotStatus>('/api/runtime/knowledge-pilot') });
  const history = useQuery({ queryKey: ['knowledge-pilot-runs'], enabled: fde, queryFn: () => API.get<KnowledgePilotRun[]>('/api/runtime/knowledge-pilot/runs?limit=8') });
  const runQuery = useMutation({
    mutationFn: () => API.post<KnowledgePilotRun>('/api/runtime/knowledge-pilot/query', { question, limit: 4 }),
    onSuccess: async (record) => {
      setCurrentRun(record);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['knowledge-pilot-status'] }),
        client.invalidateQueries({ queryKey: ['knowledge-pilot-runs'] }),
      ]);
    },
  });

  if (!fde) return <><PageHeader eyebrow="RUNTIME GOVERNANCE" title="Deployment" description="正式部署與知識 Sandbox 僅對 FDE 開放。" /><GateNotice><strong>你目前是 {user?.role}。</strong><span> 可以查看 Agent 的工作配置，但不能操作受治理 Runtime。</span></GateNotice></>;
  if (status.isLoading || deployments.isLoading || history.isLoading) return <LoadingState label="正在載入 Runtime 與知識索引" />;
  if (status.error) return <ErrorState message={status.error instanceof ApiError ? status.error.message : '無法載入知識 Sandbox。'} />;

  const pilot = status.data!;
  const ready = isKnowledgePilotReady(pilot);
  const result = currentRun ?? pilot.latestRun;
  const mutationError = runQuery.error instanceof ApiError ? runQuery.error.message : runQuery.error ? '知識查詢執行失敗' : null;
  const refresh = () => Promise.all([status.refetch(), deployments.refetch(), history.refetch()]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCurrentRun(null);
    runQuery.mutate();
  };

  return <>
    <PageHeader
      eyebrow="RUNTIME GOVERNANCE"
      title="Deployment"
      description="在受限制的 Langflow Sandbox 實際查詢 AI 知識庫；正式 Production 仍由 AIOS 治理。"
      actions={<button className="secondary-button" onClick={refresh}><RefreshCw size={15} />重新檢查</button>}
    />
    <GateNotice><strong>Langflow 是受限制 Runtime，不是資料真實來源。</strong><span> AIOS 先從既有唯讀索引取得證據與時間碼，再把 redacted answer envelope 交給 Langflow 執行。</span></GateNotice>

    <div className="metric-grid compact">
      <Metric label="已索引來源" value={pilot.knowledgeIndex.documentCount} hint={pilot.knowledgeIndex.detail} tone={pilot.knowledgeIndex.ready ? 'positive' : 'danger'} />
      <Metric label="Langflow Sandbox" value={pilot.langflow.healthy ? '可用' : '中斷'} hint={pilot.langflow.healthy ? `健康檢查 ${formatRuntimeDuration(pilot.langflow.latencyMs)}` : (pilot.langflow.detail || '無法連線')} tone={pilot.langflow.healthy ? 'positive' : 'danger'} />
      <Metric label="Production" value="未啟用" hint="需 Artifact、Eval、FDE、Canary／Stable" tone="warning" />
    </div>

    <Section title="AI 知識採集 · 實際 Sandbox 查詢" description="輸入問題後，系統會查 311 份已收錄來源、建立引用、實跑 Langflow，並保存安全執行紀錄。">
      <div className="pilot-card grounded-pilot-card">
        <div className="pilot-icon"><Radio /></div>
        <div className="pilot-main"><span className="eyebrow">SANDBOX · PRIVATE · READ ONLY</span><h3>{pilot.flowName}</h3><p>AIOS Index → Evidence Gate → Langflow Runtime → Cited Answer</p><code>Flow {pilot.flowId}</code></div>
        <div className="pilot-proof"><StatusBadge status={ready ? 'READY' : 'BLOCKED'} /><strong>{formatRuntimeDuration(pilot.langflow.latencyMs)}</strong><span>Production 未啟用</span></div>
      </div>
      <div className="knowledge-query-grid">
        <form className="query-composer" onSubmit={submit}>
          <label htmlFor="knowledge-question"><FileSearch size={17} /><span><strong>想查什麼？</strong><small>只使用已收錄資料，不會自動搜尋網路。</small></span></label>
          <textarea
            id="knowledge-question"
            data-testid="knowledge-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={800}
            rows={5}
            placeholder="例如：有哪些工具可以把 PDF 轉成 Markdown？"
          />
          <div className="query-actions"><span>{question.trim().length}/800</span><button data-testid="knowledge-submit" className="primary-button" type="submit" disabled={!ready || question.trim().length < 2 || runQuery.isPending}>{runQuery.isPending ? <><LoaderCircle className="spin" size={16} />正在執行</> : <><Play size={16} />執行唯讀查詢</>}</button></div>
          {mutationError && <ErrorState message={mutationError} />}
        </form>
        <div className="query-progress"><div className="progress-heading"><Clock3 size={17} /><div><strong>{runQuery.isPending ? '正在查詢' : result ? '最近一次執行' : '等待執行'}</strong><span>{result ? `Run ${result.id}` : '完成後會顯示每一階段與耗時'}</span></div></div><TraceView run={runQuery.isPending ? null : result} busy={runQuery.isPending} /></div>
      </div>
      {result && !runQuery.isPending && <RunResult run={result} />}
    </Section>

    <Section title="最近 Sandbox 執行" description={`${history.data?.length ?? 0} 筆 redacted 本地執行紀錄；不保存 Langflow credential。`}>
      {history.data?.length ? <div className="run-history">{history.data.map((run) => <button key={run.id} onClick={() => setCurrentRun(run)} className="run-history-row"><span className="run-status-icon">{run.status === 'SUCCEEDED' ? <BookOpenCheck size={17} /> : <CircleAlert size={17} />}</span><span><strong>{run.question}</strong><small>{new Date(run.startedAt).toLocaleString('zh-TW')} · {run.citations.length} 筆引用 · {formatRuntimeDuration(run.durationMs)}</small></span><StatusBadge status={run.status} /><ArrowUpRight size={15} /></button>)}</div> : <EmptyState title="目前沒有知識 Sandbox 執行紀錄" description="完成第一個查詢後，這裡會顯示結果、耗時與狀態。" />}
    </Section>

    <Section title="Runtime Deployments" description={`${deployments.data?.length ?? 0} 筆受治理部署紀錄。`}>
      {deployments.error ? <ErrorState message={deployments.error instanceof ApiError ? deployments.error.message : '無法載入部署紀錄'} /> : deployments.data?.length ? <div className="registry-table"><div className="table-head"><span>Deployment</span><span>Runtime</span><span>Environment</span><span>Channel</span><span>Status</span></div>{deployments.data.map((item) => <div className="table-row" key={item.id}><div className="registry-name"><div className="entity-icon"><Rocket size={17} /></div><span><strong>{item.id.slice(0, 12)}</strong><small>Artifact {item.artifactId.slice(0, 10)}</small></span></div><span>{item.runtimeKind || 'Native'}</span><StatusBadge status={item.environment} /><span>{item.channel}</span><StatusBadge status={item.active ? 'ACTIVE' : 'INACTIVE'} /></div>)}</div> : <EmptyState title="目前沒有正式 RuntimeDeployment" description="Sandbox 已能實際查詢，不代表 Production 已放行；正式啟用仍必須通過 AIOS 八道閘門。" />}
    </Section>
    <div className="governance-path horizontal"><div><Boxes /><strong>Artifact</strong><span>Digest verified</span></div><i /><div><CheckCircle2 /><strong>Eval</strong><span>Cross-model pass</span></div><i /><div><ShieldCheck /><strong>FDE</strong><span>Manual approval</span></div><i /><div><GitBranch /><strong>Deploy</strong><span>Canary / Stable</span></div></div>
  </>;
}
