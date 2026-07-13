'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, ChevronDown, ChevronUp, Clock, FlaskConical, Hand, Play, Plus, Save, Sparkles, Trash2, Webhook, Zap } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Field, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { API } from '@/lib/api';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';

// ---- types -----------------------------------------------------------

type StepType = 'DO' | 'TOOL' | 'AGENT' | 'CONDITION' | 'NOTIFY' | 'COMPUTER_CONTROL';

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

type TriggerType = 'manual' | 'schedule' | 'event' | 'keyword' | 'webhook';

/** Mode badge: 定期 (schedule) / 手動 (manual) / 觸發 (webhook, event, keyword). */
const TRIGGER_MODE: Record<TriggerType, { label: string; icon: typeof Clock; tone: string }> = {
  schedule: { label: '定期', icon: Clock, tone: 'bg-blue-500/15 text-blue-400' },
  manual: { label: '手動', icon: Hand, tone: 'bg-black/10 text-muted dark:bg-white/10' },
  webhook: { label: '觸發', icon: Webhook, tone: 'bg-amber-500/15 text-amber-400' },
  event: { label: '觸發', icon: Zap, tone: 'bg-amber-500/15 text-amber-400' },
  keyword: { label: '觸發', icon: Zap, tone: 'bg-amber-500/15 text-amber-400' },
};

function TriggerBadge({ type, detail, keywords }: { type: TriggerType; detail?: string; keywords?: string[] }) {
  const mode = TRIGGER_MODE[type];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cn('badge shrink-0', mode.tone)}>
        <mode.icon className="mr-1 h-3 w-3" /> {mode.label}
      </span>
      {detail && <span className="truncate font-mono text-xs text-muted">{detail}</span>}
      {(keywords ?? []).map((kw) => (
        <span key={kw} className="badge shrink-0 bg-black/10 text-muted dark:bg-white/10">
          {kw}
        </span>
      ))}
    </div>
  );
}

interface WorkflowStep {
  stepKey: string;
  type: StepType;
  config: Record<string, unknown>;
  verifyRubric?: string | null;
  onFail?: unknown;
  position: number;
}

interface WorkflowDetail {
  id: string;
  name: string;
  agentId?: string;
  description?: string | null;
  trigger?: TriggerLike | null;
  enabled?: boolean;
  steps: WorkflowStep[];
}

interface RunStep {
  stepKey: string;
  round: number;
  status: string;
  output?: unknown;
  verdict?: string | null;
  approved?: boolean | null;
}

interface RunDetail {
  id: string;
  status: string;
  agentId?: string;
  agentName?: string;
  triggeredBy?: string;
  startedAt?: string;
  finishedAt?: string;
  steps: RunStep[];
}

interface EditableStep {
  localId: string;
  stepKey: string;
  type: StepType;
  prompt: string;
  toolName: string;
  toolArgsText: string;
  expr: string;
  channelBindingId: string;
  template: string;
  skillId: string;
  configText: string;
  verifyRubric: string;
  onFailText: string;
}

const STEP_TYPES: { value: StepType; label: string }[] = [
  { value: 'DO', label: 'DO 執行指令' },
  { value: 'TOOL', label: 'TOOL 呼叫工具' },
  { value: 'AGENT', label: 'AGENT 委派員工' },
  { value: 'CONDITION', label: 'CONDITION 條件判斷' },
  { value: 'NOTIFY', label: 'NOTIFY 發送通知' },
  { value: 'COMPUTER_CONTROL', label: 'COMPUTER_CONTROL 電腦操作' },
];

function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id_${Math.random().toString(36).slice(2)}`;
}

function newStep(type: StepType, index: number): EditableStep {
  return {
    localId: uid(),
    stepKey: `step_${index + 1}`,
    type,
    prompt: '',
    toolName: '',
    toolArgsText: '{}',
    expr: '',
    channelBindingId: '',
    template: '',
    skillId: '',
    configText: type === 'AGENT' ? '{\n  "agentId": "",\n  "input": ""\n}' : '{}',
    verifyRubric: '',
    onFailText: '',
  };
}

function stepToEditable(s: WorkflowStep): EditableStep {
  const cfg = (s.config ?? {}) as Record<string, any>;
  const isKnown = ['DO', 'TOOL', 'CONDITION', 'NOTIFY', 'COMPUTER_CONTROL'].includes(s.type);
  return {
    localId: uid(),
    stepKey: s.stepKey,
    type: s.type,
    prompt: s.type === 'DO' ? (cfg.prompt ?? '') : '',
    toolName: s.type === 'TOOL' ? (cfg.tool ?? '') : '',
    toolArgsText: s.type === 'TOOL' ? JSON.stringify(cfg.args ?? {}, null, 2) : '{}',
    expr: s.type === 'CONDITION' ? (cfg.expr ?? '') : '',
    channelBindingId: s.type === 'NOTIFY' ? (cfg.channelBindingId ?? '') : '',
    template: s.type === 'NOTIFY' ? (cfg.template ?? '') : '',
    skillId: s.type === 'COMPUTER_CONTROL' ? (cfg.skillId ?? '') : '',
    configText: !isKnown || s.type === 'AGENT' ? JSON.stringify(cfg, null, 2) : '{}',
    verifyRubric: s.verifyRubric ?? '',
    onFailText: s.onFail != null ? JSON.stringify(s.onFail, null, 2) : '',
  };
}

/** The canonical accounting review shape: scan (TOOL) -> condition (CONDITION) -> notify (NOTIFY) -> mark (DO). */
function accountingExampleSteps(): EditableStep[] {
  const scan = { ...newStep('TOOL', 0), stepKey: 'scan', toolName: 'scan_invoices', toolArgsText: JSON.stringify({ folder: 'Invoices/Inbox' }, null, 2) };
  const condition = { ...newStep('CONDITION', 1), stepKey: 'condition', expr: 'result.totalAmount > 10000' };
  const notify = {
    ...newStep('NOTIFY', 2),
    stepKey: 'notify',
    channelBindingId: '',
    template: '發現大額發票 {{result.totalAmount}} 元，已觸發人工複核通知',
  };
  const mark = { ...newStep('DO', 3), stepKey: 'mark', prompt: '將此發票標記為已複核，並將記帳系統中的狀態更新為 done' };
  return [scan, condition, notify, mark];
}

function buildServerSteps(steps: EditableStep[]): { ok: true; steps: WorkflowStep[] } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: WorkflowStep[] = steps.map((s, idx) => {
    let config: Record<string, unknown> = {};
    if (s.type === 'DO') {
      config = { prompt: s.prompt };
    } else if (s.type === 'TOOL') {
      let args: unknown = {};
      try {
        args = s.toolArgsText.trim() ? JSON.parse(s.toolArgsText) : {};
      } catch {
        errors[s.localId] = 'TOOL 參數 (Args) 必須是有效的 JSON';
      }
      config = { tool: s.toolName, args };
    } else if (s.type === 'CONDITION') {
      config = { expr: s.expr };
    } else if (s.type === 'NOTIFY') {
      config = { channelBindingId: s.channelBindingId, template: s.template };
    } else if (s.type === 'COMPUTER_CONTROL') {
      config = { skillId: s.skillId };
    } else {
      try {
        config = s.configText.trim() ? JSON.parse(s.configText) : {};
      } catch {
        errors[s.localId] = 'Agent 設定必須是有效的 JSON';
      }
    }

    let onFail: unknown = null;
    if (s.onFailText.trim()) {
      try {
        onFail = JSON.parse(s.onFailText);
      } catch {
        errors[s.localId] = (errors[s.localId] ? errors[s.localId] + '；' : '') + 'onFail 必須是有效的 JSON';
      }
    }

    return {
      stepKey: s.stepKey.trim() || `step_${idx + 1}`,
      type: s.type,
      config,
      verifyRubric: s.verifyRubric.trim() || null,
      onFail,
      position: idx,
    };
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, steps: out };
}

// ---- step card ---------------------------------------------------------

function StepCard({
  step,
  index,
  total,
  error,
  onChange,
  onTypeChange,
  onRemove,
  onMove,
}: {
  step: EditableStep;
  index: number;
  total: number;
  error?: string;
  onChange: (patch: Partial<EditableStep>) => void;
  onTypeChange: (t: StepType) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-black/10 text-xs font-medium dark:bg-white/10">{index + 1}</span>
        <input className="input w-40" value={step.stepKey} onChange={(e) => onChange({ stepKey: e.target.value })} placeholder="stepKey" />
        <select className="input w-auto" value={step.type} onChange={(e) => onTypeChange(e.target.value as StepType)}>
          {STEP_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="btn-ghost p-1.5" disabled={index === 0} onClick={() => onMove(-1)} title="上移">
            <ChevronUp className="h-4 w-4" />
          </button>
          <button type="button" className="btn-ghost p-1.5" disabled={index === total - 1} onClick={() => onMove(1)} title="下移">
            <ChevronDown className="h-4 w-4" />
          </button>
          <button type="button" className="btn-ghost p-1.5 text-rose-400" onClick={onRemove} title="刪除">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {step.type === 'DO' && (
        <Field label="Prompt 指令內容">
          <textarea className="input" rows={3} value={step.prompt} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="描述這一步要執行的指令..." />
        </Field>
      )}

      {step.type === 'TOOL' && (
        <div className="space-y-2">
          <Field label="工具名稱 Tool">
            <input className="input" value={step.toolName} onChange={(e) => onChange({ toolName: e.target.value })} placeholder="例如 scan_invoices" />
          </Field>
          <Field label="參數 Args（JSON）">
            <textarea className="input font-mono text-xs" rows={4} value={step.toolArgsText} onChange={(e) => onChange({ toolArgsText: e.target.value })} />
          </Field>
        </div>
      )}

      {step.type === 'CONDITION' && (
        <Field label="條件表達式 Expr">
          <textarea className="input font-mono text-xs" rows={2} value={step.expr} onChange={(e) => onChange({ expr: e.target.value })} placeholder="例如 result.totalAmount > 10000" />
        </Field>
      )}

      {step.type === 'NOTIFY' && (
        <div className="space-y-2">
          <Field label="通知管道 Channel Binding ID">
            <input className="input" value={step.channelBindingId} onChange={(e) => onChange({ channelBindingId: e.target.value })} placeholder="channelBindingId" />
          </Field>
          <Field label="訊息範本 Template">
            <textarea className="input" rows={2} value={step.template} onChange={(e) => onChange({ template: e.target.value })} placeholder="支援 {{變數}} 內插" />
          </Field>
        </div>
      )}

      {step.type === 'COMPUTER_CONTROL' && (
        <Field label="技能 Skill ID">
          <input className="input" value={step.skillId} onChange={(e) => onChange({ skillId: e.target.value })} placeholder="skillId" />
        </Field>
      )}

      {step.type === 'AGENT' && (
        <Field label="Agent 設定（JSON）">
          <textarea className="input font-mono text-xs" rows={4} value={step.configText} onChange={(e) => onChange({ configText: e.target.value })} />
        </Field>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="驗證標準 Verify Rubric（選填）">
          <textarea className="input" rows={2} value={step.verifyRubric} onChange={(e) => onChange({ verifyRubric: e.target.value })} />
        </Field>
        <Field label="失敗處理 onFail（選填，JSON）">
          <textarea className="input font-mono text-xs" rows={2} value={step.onFailText} onChange={(e) => onChange({ onFailText: e.target.value })} />
        </Field>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </div>
  );
}

// ---- page ---------------------------------------------------------------

export default function WorkflowEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  const wfQuery = useQuery({ queryKey: ['workflow', id], queryFn: () => API.get<WorkflowDetail>(`/api/workflows/${id}`) });

  const [hydrated, setHydrated] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [triggerType, setTriggerType] = useState<TriggerType>('manual');
  const [triggerCron, setTriggerCron] = useState('');
  const [triggerEvent, setTriggerEvent] = useState('');
  const [triggerKeywordsText, setTriggerKeywordsText] = useState('');
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savedMsg, setSavedMsg] = useState('');
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    const r = searchParams.get('run');
    if (r) setRunId(r);
  }, [searchParams]);

  useEffect(() => {
    if (wfQuery.data && !hydrated) {
      const wf = wfQuery.data;
      setName(wf.name ?? '');
      setDescription(wf.description ?? '');
      setEnabled(wf.enabled ?? true);
      const t = wf.trigger ?? {};
      setTriggerType((t.type as TriggerType) ?? 'manual');
      setTriggerCron(t.cron ?? t.schedule ?? '');
      setTriggerEvent(t.event ?? t.topic ?? '');
      setTriggerKeywordsText((t.keywords ?? []).join(', '));
      setSteps((wf.steps ?? []).slice().sort((a, b) => a.position - b.position).map(stepToEditable));
      setHydrated(true);
    }
  }, [wfQuery.data, hydrated]);

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  const patchMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => API.patch(`/api/workflows/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow', id] });
      flash('已儲存');
    },
  });

  function saveBasicInfo() {
    let trigger: TriggerLike;
    if (triggerType === 'schedule') trigger = { type: 'schedule', cron: triggerCron };
    else if (triggerType === 'event') trigger = { type: 'event', topic: triggerEvent };
    else if (triggerType === 'keyword')
      trigger = { type: 'keyword', keywords: triggerKeywordsText.split(',').map((k) => k.trim()).filter(Boolean) };
    else if (triggerType === 'webhook') trigger = { type: 'webhook' };
    else trigger = { type: 'manual' };
    patchMut.mutate({ name, description, trigger });
  }

  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    patchMut.mutate({ enabled: next });
  }

  const stepsMut = useMutation({
    mutationFn: (body: { steps: WorkflowStep[] }) => API.put(`/api/workflows/${id}/steps`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow', id] });
      flash('步驟已儲存');
    },
  });

  function saveSteps() {
    const result = buildServerSteps(steps);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    stepsMut.mutate({ steps: result.steps });
  }

  function addStep() {
    setSteps((prev) => [...prev, newStep('DO', prev.length)]);
  }
  function removeStep(localId: string) {
    setSteps((prev) => prev.filter((s) => s.localId !== localId));
  }
  function moveStep(localId: string, dir: -1 | 1) {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.localId === localId);
      const newIdx = idx + dir;
      if (idx < 0 || newIdx < 0 || newIdx >= prev.length) return prev;
      const copy = prev.slice();
      [copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]];
      return copy;
    });
  }
  function updateStep(localId: string, patch: Partial<EditableStep>) {
    setSteps((prev) => prev.map((s) => (s.localId === localId ? { ...s, ...patch } : s)));
  }
  function changeType(localId: string, type: StepType) {
    setSteps((prev) =>
      prev.map((s) => {
        if (s.localId !== localId) return s;
        const next = { ...s, type };
        if (type === 'TOOL' && !next.toolArgsText.trim()) next.toolArgsText = '{}';
        if (type === 'AGENT' && !next.configText.trim()) next.configText = '{\n  "agentId": "",\n  "input": ""\n}';
        return next;
      }),
    );
  }
  function insertExample() {
    if (steps.length > 0 && !window.confirm('這會取代目前的步驟內容，確定要帶入記帳審核範例嗎？')) return;
    setSteps(accountingExampleSteps());
  }

  const runMut = useMutation({
    mutationFn: () => API.post<{ runId: string }>(`/api/workflows/${id}/run`, {}),
    onSuccess: (r) => setRunId(r.runId),
  });

  const testMut = useMutation({
    mutationFn: () => API.post<{ runId: string }>(`/api/workflows/${id}/test`, {}),
    onSuccess: (r) => setRunId(r.runId),
  });

  const runQuery = useQuery({
    queryKey: ['run', runId],
    queryFn: () => API.get<RunDetail>(`/api/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === 'RUNNING' || status === 'AWAITING_REVIEW' ? 2000 : false;
    },
  });

  useAwp(['run.*'], (frame) => {
    if (!runId || frame.kind !== 'event') return;
    const payload = frame.payload as { runId?: string; id?: string } | undefined;
    const matches = frame.topic === `run.${runId}` || payload?.runId === runId || payload?.id === runId;
    if (matches) qc.invalidateQueries({ queryKey: ['run', runId] });
  });

  const cancelMut = useMutation({
    mutationFn: () => API.post(`/api/runs/${runId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  });

  return (
    <AppShell>
      {/* 從員工頁進來的編輯，返回時應回到該員工的工作流分頁，而非全域列表 */}
      <Link
        href={wfQuery.data?.agentId ? `/employees/${wfQuery.data.agentId}?tab=workflows` : '/workflows'}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" /> {wfQuery.data?.agentId ? '返回員工頁面' : '返回工作流列表'}
      </Link>

      {wfQuery.isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      )}

      {wfQuery.isError && <EmptyState title="無法載入工作流" hint="請確認連結是否正確，或此工作流已被刪除" />}

      {wfQuery.data && (
        <>
          <PageHeader
            title={name || wfQuery.data.name}
            subtitle={`工作流 ID: ${id}`}
            action={
              <div className="flex items-center gap-3">
                {savedMsg && <span className="text-xs text-emerald-400">{savedMsg}</span>}
                <button
                  type="button"
                  className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0 transition-colors', enabled ? 'bg-brand' : 'bg-border')}
                  onClick={toggleEnabled}
                  title={enabled ? '已啟用（點擊停用）' : '已停用（點擊啟用）'}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                      enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
                    )}
                  />
                </button>
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={() => testMut.mutate()} disabled={testMut.isPending}>
                  <FlaskConical className="h-4 w-4" /> 測試
                </button>
                <button type="button" className="btn-primary whitespace-nowrap" onClick={() => runMut.mutate()} disabled={runMut.isPending}>
                  <Play className="h-4 w-4" /> 執行
                </button>
              </div>
            }
          />

          <div className="space-y-6">
          {/* basic info */}
          <section className="card space-y-4 p-6">
            <h2 className="font-medium">基本資訊</h2>
            <Field label="名稱">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="描述">
              <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="觸發方式 Trigger">
                <select className="input" value={triggerType} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
                  <option value="manual">手動 Manual</option>
                  <option value="schedule">排程 Schedule</option>
                  <option value="event">事件 Event</option>
                  <option value="keyword">關鍵字 Keyword</option>
                  <option value="webhook">Webhook 觸發</option>
                </select>
              </Field>
              {triggerType === 'schedule' && (
                <Field label="Cron 表達式">
                  <input className="input" placeholder="0 9 * * *" value={triggerCron} onChange={(e) => setTriggerCron(e.target.value)} />
                </Field>
              )}
              {triggerType === 'event' && (
                <Field label="事件名稱">
                  <input className="input" placeholder="file.created" value={triggerEvent} onChange={(e) => setTriggerEvent(e.target.value)} />
                </Field>
              )}
              {triggerType === 'keyword' && (
                <Field label="關鍵字（逗號分隔）">
                  <input className="input" placeholder="請假, 出貨" value={triggerKeywordsText} onChange={(e) => setTriggerKeywordsText(e.target.value)} />
                </Field>
              )}
              {triggerType === 'webhook' && <p className="self-center text-xs text-muted">由外部系統呼叫 Webhook 端點觸發，無需額外設定</p>}
            </div>
            <div>
              <div className="mb-1.5 label">目前設定</div>
              <TriggerBadge
                type={triggerType}
                detail={
                  triggerType === 'schedule' ? triggerCron || undefined : triggerType === 'event' ? triggerEvent || undefined : undefined
                }
                keywords={triggerType === 'keyword' ? triggerKeywordsText.split(',').map((k) => k.trim()).filter(Boolean) : undefined}
              />
            </div>
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={saveBasicInfo} disabled={patchMut.isPending}>
                <Save className="h-4 w-4" /> 儲存基本資訊
              </button>
            </div>
          </section>

          {/* steps editor */}
          <section className="card space-y-4 p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">步驟編輯 Steps</h2>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={insertExample}>
                  <Sparkles className="h-4 w-4" /> 帶入記帳審核範例
                </button>
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={addStep}>
                  <Plus className="h-4 w-4" /> 新增步驟
                </button>
              </div>
            </div>
            <p className="text-xs text-muted">
              範例形狀：<span className="font-mono">scan</span> (TOOL) → <span className="font-mono">condition</span> (CONDITION) →{' '}
              <span className="font-mono">notify</span> (NOTIFY) → <span className="font-mono">mark</span> (DO)，即「掃描發票 → 判斷金額 → 發送通知 → 標記已處理」。
            </p>

            {steps.length === 0 ? (
              <EmptyState title="尚無步驟" hint="點擊「新增步驟」或帶入範例開始設計工作流" />
            ) : (
              <div className="space-y-3">
                {steps.map((s, idx) => (
                  <StepCard
                    key={s.localId}
                    step={s}
                    index={idx}
                    total={steps.length}
                    error={fieldErrors[s.localId]}
                    onChange={(patch) => updateStep(s.localId, patch)}
                    onTypeChange={(t) => changeType(s.localId, t)}
                    onRemove={() => removeStep(s.localId)}
                    onMove={(dir) => moveStep(s.localId, dir)}
                  />
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={saveSteps} disabled={stepsMut.isPending}>
                <Save className="h-4 w-4" /> 儲存步驟
              </button>
            </div>
          </section>

          {/* run timeline */}
          <section className="card space-y-4 p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">執行紀錄 Run Timeline</h2>
              {runId && runQuery.data?.status === 'RUNNING' && (
                <button type="button" className="btn-ghost whitespace-nowrap text-rose-400" onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending}>
                  <Ban className="h-4 w-4" /> 取消執行
                </button>
              )}
            </div>

            {!runId && <p className="text-sm text-muted">尚未執行。點擊上方「測試」或「執行」以啟動工作流並即時查看每個步驟的進度。</p>}

            {runId && runQuery.isLoading && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}

            {runId && runQuery.isError && <p className="text-sm text-rose-400">無法載入此次執行紀錄</p>}

            {runId && runQuery.data && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <StatusBadge status={runQuery.data.status} />
                  <span className="text-muted">Run ID: {runQuery.data.id}</span>
                  {runQuery.data.startedAt && <span className="text-muted">開始 {new Date(runQuery.data.startedAt).toLocaleString()}</span>}
                  {runQuery.data.finishedAt && <span className="text-muted">結束 {new Date(runQuery.data.finishedAt).toLocaleString()}</span>}
                </div>

                {(runQuery.data.steps ?? []).length === 0 ? (
                  <p className="text-sm text-muted">尚無步驟輸出</p>
                ) : (
                  <ol className="space-y-3 border-l border-border pl-4">
                    {(runQuery.data.steps ?? []).map((rs, i) => (
                      <li key={`${rs.stepKey}-${rs.round}-${i}`} className="relative">
                        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand" />
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{rs.stepKey}</span>
                          <span className="text-xs text-muted">Round {rs.round}</span>
                          <StatusBadge status={rs.status} />
                          {rs.verdict && <span className="badge bg-black/10 dark:bg-white/10">verdict: {rs.verdict}</span>}
                          {rs.approved != null && <span className="badge bg-black/10 dark:bg-white/10">{rs.approved ? '已核准' : '未核准'}</span>}
                        </div>
                        {rs.output != null && (
                          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/20 p-2 text-xs">
                            {typeof rs.output === 'string' ? rs.output : JSON.stringify(rs.output, null, 2)}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </section>
          </div>
        </>
      )}
    </AppShell>
  );
}
