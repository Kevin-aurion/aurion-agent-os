'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  ExternalLink,
  File as FileIcon,
  Folder,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  Trash2,
  Workflow,
  Wrench,
  X,
  XCircle,
  Wifi,
  WifiOff,
  Link2,
  Unlink,
} from 'lucide-react';
import { API } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp, type AwpFrame } from '@/lib/awp';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Field, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  type AgentDeviceBinding,
  type SafeDevice,
  deviceStatusLabel,
  errorMessage as deviceErrorMessage,
  platformLabel,
  relativeTime as deviceRelativeTime,
  parseCapabilities,
} from '@/lib/devices';

// ---------- Types ----------

// GET /api/agents/:id returns skills as AgentSkill join rows:
// { agentId, skillId, skill: { id, name, kind, reviewStatus, ... } }
interface AgentSkillRef {
  agentId: string;
  skillId: string;
  skill: {
    id: string;
    name: string;
    reviewStatus: string;
    kind: string;
    executionEnv?: string;
  };
}
// fileTargets come back as AgentFileTarget rows with the CloudFileRef nested:
// { agentId, cloudFileRefId, purpose, cloudFileRef: { name, path, ... } }
interface AgentFileTarget {
  cloudFileRefId: string;
  purpose?: string | null;
  cloudFileRef?: {
    id: string;
    name: string;
    path: string;
    webUrl?: string | null;
  } | null;
}
interface AgentWorkflowRef {
  id: string;
  name: string;
  enabled: boolean;
}
interface AgentDetail {
  id: string;
  name: string;
  description: string;
  department?: string | null;
  rolePrompt: string;
  engineExecute: string;
  engineVerify?: string | null;
  maxRounds: number;
  avatar?: string | null;
  status: string;
  skills: AgentSkillRef[];
  fileTargets: AgentFileTarget[];
  workflows: AgentWorkflowRef[];
  restrictions?: AgentRestrictions | null;
}
// Agent capability restrictions, enforced server-side (prompt rules + CLI
// flags + COMPUTER_CONTROL hard block); the UI just edits them. `null` on the
// agent detail response means "never set" → apply DEFAULT_RESTRICTIONS.
interface AgentRestrictions {
  webSearch?: boolean;
  computerUse?: boolean;
  sendEmail?: boolean;
  cloudWrite?: boolean;
  shell?: boolean;
  cloudEmbedding?: boolean;
  notes?: string;
}
const DEFAULT_RESTRICTIONS: Required<Omit<AgentRestrictions, 'notes'>> & { notes: string } = {
  webSearch: true,
  computerUse: false,
  sendEmail: false,
  cloudWrite: true,
  shell: true,
  cloudEmbedding: true,
  notes: '',
};
interface SkillListItem {
  id: string;
  name: string;
  origin: string;
  kind: string;
  reviewStatus: string;
  version: number;
}
interface IntegrationAccount {
  id: string;
  provider: string;
  email: string;
  status: string;
  scopes: string[];
}
interface IntegrationsResponse {
  accounts: IntegrationAccount[];
  configured: Record<string, boolean>;
}
interface CloudFileEntry {
  id: string;
  name: string;
  kind: 'FILE' | 'FOLDER';
  mimeType?: string;
  path: string;
  webUrl?: string;
}
interface RunSnapshotStep {
  stepKey: string;
  round?: number;
  status?: string;
  verdict?: string | null;
  approved?: boolean | null;
  output?: string | null;
}
// GET /api/runs?agentId=&limit= list rows (newest first).
interface RunListItem {
  id: string;
  status: string;
  triggeredBy?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  workflowId?: string | null;
  agent?: { name?: string; slug?: string } | null;
}
// GET /api/runs/:id detail (fuller than RunSnapshot — includes timing + verdicts).
interface RunDetail {
  status: string;
  triggeredBy?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  steps: RunSnapshotStep[];
}
interface Conversation {
  id: string;
  title?: string;
  createdAt?: string;
}
interface ChatMessage {
  id: string;
  role?: string;
  sender?: string;
  content: string;
  createdAt?: string;
  runId?: string;
}
interface RunStep {
  stepKey: string;
  round?: number;
  status: string;
  verdict?: string;
}

const TABS = [
  { key: 'overview', label: '概況', icon: Settings2 },
  { key: 'chat', label: '對話', icon: MessageSquare },
  { key: 'runs', label: '執行紀錄', icon: Activity },
] as const;
type TabKey = typeof TABS[number]['key'];

/** Legacy ?tab= keys from workflows editor / device admin still land on a live tab. */
const LEGACY_TAB_TO_CURRENT: Record<string, TabKey> = {
  overview: 'overview',
  skills: 'overview',
  devices: 'overview',
  files: 'overview',
  workflows: 'overview',
  training: 'overview',
  memory: 'overview',
  chat: 'chat',
  runs: 'runs',
};

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;
  // Honor ?tab=<key> so external links (e.g. the workflow editor's back
  // button) can land directly on a specific tab.
  const searchParams = useSearchParams();
  const initialTab = ((): TabKey => {
    const q = searchParams.get('tab');
    if (!q) return 'overview';
    return LEGACY_TAB_TO_CURRENT[q] ?? 'overview';
  })();
  const [tab, setTab] = useState<TabKey>(initialTab);

  const { data: agent, isLoading } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => API.get<AgentDetail>(`/api/agents/${agentId}?scope=all`),
    enabled: !!agentId,
  });

  return (
    <AppShell>
      <div className="mb-4">
        <Link href="/employees" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="h-3.5 w-3.5" /> 返回員工列表
        </Link>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      )}

      {!isLoading && !agent && <EmptyState title="找不到此員工" />}

      {!isLoading && agent && (
        <>
          <PageHeader
            title={agent.name}
            subtitle={agent.description || undefined}
            action={
              <div className="flex items-center gap-2">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-lg">
                  {agent.avatar ? agent.avatar : <Bot className="h-5 w-5 text-brand" />}
                </div>
                <StatusBadge status={agent.status} />
              </div>
            }
          />

          <div className="mb-6 flex gap-1 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                  tab === t.key ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg'
                )}
              >
                <t.icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <OverviewTab agent={agent} />}
          {tab === 'chat' && <ChatTab agentId={agent.id} />}
          {tab === 'runs' && <RunsTab agent={agent} />}
        </>
      )}
    </AppShell>
  );
}

// ---------- 裝置 Devices (bind / unbind; offline bindings preserved) ----------

function DevicesTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);
  const [bindDeviceId, setBindDeviceId] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useAwp(['run.*', 'agent.status'], (frame) => {
    if (frame.kind !== 'event') return;
    void qc.invalidateQueries({ queryKey: ['agent-devices', agent.id] });
    void qc.invalidateQueries({ queryKey: ['devices'] });
  });

  const bindingsQ = useQuery({
    queryKey: ['agent-devices', agent.id],
    queryFn: () => API.get<AgentDeviceBinding[]>(`/api/agents/${agent.id}/devices`),
    // FDE-only endpoint; MEMBER sees empty with message.
    enabled: isFde,
    refetchInterval: 12_000,
  });

  const allDevicesQ = useQuery({
    queryKey: ['devices'],
    queryFn: () => API.get<SafeDevice[]>('/api/devices'),
    enabled: isFde,
    staleTime: 15_000,
  });

  const bindMut = useMutation({
    mutationFn: (deviceId: string) =>
      API.post(`/api/agents/${agent.id}/devices`, { deviceId }),
    onSuccess: () => {
      setFlash('已綁定裝置');
      setErr(null);
      setBindDeviceId('');
      void qc.invalidateQueries({ queryKey: ['agent-devices', agent.id] });
    },
    onError: (e) => {
      setFlash(null);
      setErr(deviceErrorMessage(e));
    },
  });

  const unbindMut = useMutation({
    mutationFn: (deviceId: string) => API.del(`/api/agents/${agent.id}/devices/${deviceId}`),
    onSuccess: () => {
      setFlash('已解除綁定');
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['agent-devices', agent.id] });
    },
    onError: (e) => {
      setFlash(null);
      setErr(deviceErrorMessage(e));
    },
  });

  if (!isFde) {
    return (
      <EmptyState
        title="僅 FDE 可管理裝置綁定"
        hint="操作者無法啟用或變更裝置綁定；請由 FDE 在管理中心處理，或提交提案。"
      />
    );
  }

  const bindings = bindingsQ.data ?? [];
  const boundIds = new Set(bindings.map((b) => b.deviceId));
  const bindable = (allDevicesQ.data ?? []).filter(
    (d) => d.status === 'ACTIVE' && !boundIds.has(d.id),
  );

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-medium">已綁定裝置</h3>
            <p className="mt-1 text-xs text-muted">
              電腦操控與 LINE 桌面步驟只能打到「已綁定 + 線上 + 能力合格」的裝置。離線綁定會保留顯示，不會自動替換。
            </p>
          </div>
          <Link href="/admin/devices" className="btn-ghost text-xs">
            管理全部裝置
          </Link>
        </div>

        {flash && <p className="text-xs text-emerald-400" role="status">{flash}</p>}
        {err && (
          <p className="text-xs text-rose-400" role="alert">
            {err}
          </p>
        )}

        {bindingsQ.isLoading && (
          <div className="flex justify-center py-8" role="status">
            <Spinner />
          </div>
        )}
        {bindingsQ.isError && (
          <p className="text-sm text-rose-400">載入失敗：{deviceErrorMessage(bindingsQ.error)}</p>
        )}
        {!bindingsQ.isLoading && bindings.length === 0 && (
          <EmptyState title="尚未綁定裝置" hint="下方選擇 ACTIVE 裝置進行綁定" />
        )}

        <ul className="space-y-2">
          {bindings.map((b) => {
            const d = b.device;
            const online = d.online === true;
            const caps = parseCapabilities(d.capabilities);
            return (
              <li
                key={b.deviceId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    <StatusBadge status={String(d.status)} />
                    <span
                      className={cn(
                        'badge',
                        online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-500/15 text-zinc-400',
                      )}
                    >
                      {online ? (
                        <>
                          <Wifi className="mr-1 h-3 w-3" /> 線上
                        </>
                      ) : (
                        <>
                          <WifiOff className="mr-1 h-3 w-3" /> 離線（綁定保留）
                        </>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {platformLabel(d.platform)} · {deviceStatusLabel(String(d.status))} · 心跳{' '}
                    {deviceRelativeTime(d.lastSeenAt)}
                    {d.tokenPrefix ? ` · token ${d.tokenPrefix}…` : ''}
                  </div>
                  {caps?.features && (
                    <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted">
                      {caps.features.computerUse && <span className="badge bg-black/10 dark:bg-white/10">Computer Use</span>}
                      {caps.features.codexApp && <span className="badge bg-black/10 dark:bg-white/10">Codex App</span>}
                      {caps.features.codexCli && <span className="badge bg-black/10 dark:bg-white/10">Codex CLI</span>}
                      {caps.features.lineDesktop && <span className="badge bg-black/10 dark:bg-white/10">LINE Desktop</span>}
                      {caps.features.screenshot && <span className="badge bg-black/10 dark:bg-white/10">截圖</span>}
                      {caps.features.screenRecording && <span className="badge bg-black/10 dark:bg-white/10">錄製</span>}
                      {caps.features.accessibility && <span className="badge bg-black/10 dark:bg-white/10">輔助使用</span>}
                    </div>
                  )}
                  {!online && (
                    <p className="mt-1 text-[11px] text-amber-300">
                      離線裝置仍保留綁定，工作流步驟若指定此裝置將無法執行，需明確改選線上裝置。
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-ghost text-rose-400"
                  disabled={unbindMut.isPending}
                  onClick={() => {
                    if (!window.confirm(`解除與此員工綁定「${d.name}」？`)) return;
                    unbindMut.mutate(b.deviceId);
                  }}
                >
                  <Unlink className="h-4 w-4" /> 解除綁定
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card space-y-3 p-5">
        <h3 className="font-medium">綁定新裝置</h3>
        <div className="flex flex-wrap gap-2">
          <select
            className="input max-w-md"
            value={bindDeviceId}
            onChange={(e) => setBindDeviceId(e.target.value)}
            aria-label="選擇要綁定的裝置"
          >
            <option value="">— 選擇 ACTIVE 裝置 —</option>
            {bindable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {platformLabel(d.platform)}
                {d.online === true ? ' · 線上' : ' · 離線'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-primary"
            disabled={!bindDeviceId || bindMut.isPending}
            onClick={() => bindMut.mutate(bindDeviceId)}
          >
            <Link2 className="h-4 w-4" /> 綁定
          </button>
        </div>
        {allDevicesQ.isError && (
          <p className="text-xs text-rose-400">無法載入裝置清單：{deviceErrorMessage(allDevicesQ.error)}</p>
        )}
        {!allDevicesQ.isLoading && bindable.length === 0 && (
          <p className="text-xs text-muted">
            沒有可綁定的 ACTIVE 裝置。請先到{' '}
            <Link href="/admin/devices" className="text-brand hover:underline">
              裝置管理
            </Link>{' '}
            註冊並完成 enrollment。
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- 概況 Overview ----------

function OverviewTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [department, setDepartment] = useState(agent.department ?? '');
  const [rolePrompt, setRolePrompt] = useState(agent.rolePrompt);
  const [engineExecute, setEngineExecute] = useState(agent.engineExecute);
  const [engineVerify, setEngineVerify] = useState<string | null>(agent.engineVerify ?? null);
  const [maxRounds, setMaxRounds] = useState(agent.maxRounds);
  // Restrictions: merge whatever the agent has over the platform defaults so
  // that a null/partial `restrictions` still yields a fully-defined form.
  const initialRestrictions = { ...DEFAULT_RESTRICTIONS, ...(agent.restrictions ?? {}) };
  const [webSearch, setWebSearch] = useState(initialRestrictions.webSearch);
  const [computerUse, setComputerUse] = useState(initialRestrictions.computerUse);
  const [sendEmail, setSendEmail] = useState(initialRestrictions.sendEmail);
  const [cloudWrite, setCloudWrite] = useState(initialRestrictions.cloudWrite);
  const [shell, setShell] = useState(initialRestrictions.shell);
  const [cloudEmbedding, setCloudEmbedding] = useState(initialRestrictions.cloudEmbedding);
  const [notes, setNotes] = useState(initialRestrictions.notes ?? '');

  const patchMutation = useMutation({
    mutationFn: (
      body: Partial<
        Pick<AgentDetail, 'name' | 'description' | 'department' | 'rolePrompt' | 'engineExecute' | 'engineVerify' | 'maxRounds' | 'restrictions'>
      >
    ) => API.patch(`/api/agents/${agent.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const dirty =
    name !== agent.name ||
    description !== agent.description ||
    department !== (agent.department ?? '') ||
    rolePrompt !== agent.rolePrompt ||
    engineExecute !== agent.engineExecute ||
    engineVerify !== (agent.engineVerify ?? null) ||
    maxRounds !== agent.maxRounds ||
    webSearch !== initialRestrictions.webSearch ||
    computerUse !== initialRestrictions.computerUse ||
    sendEmail !== initialRestrictions.sendEmail ||
    cloudWrite !== initialRestrictions.cloudWrite ||
    shell !== initialRestrictions.shell ||
    cloudEmbedding !== initialRestrictions.cloudEmbedding ||
    notes !== (initialRestrictions.notes ?? '');

  return (
    <div className="max-w-3xl space-y-6">
      <div className="card space-y-4 p-6">
        <Field label="名稱">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-1 text-xs text-muted">顯示於員工列表與組織圖上的名字，例如「財務小幫手」「業務跟單員」。</p>
        </Field>
        <Field label="描述">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          <p className="mt-1 text-xs text-muted">一句話說明這位員工的職責，例如「AR/AP 帳款監控與提醒」，會顯示在員工卡片的副標。</p>
        </Field>
        <Field label="部門 Department">
          <input
            className="input"
            list="department-options"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="例如：財務 / 業務 / 研發"
          />
          <datalist id="department-options">
            <option value="財務" />
            <option value="業務" />
            <option value="研發" />
            <option value="人資" />
            <option value="行政" />
          </datalist>
          <p className="mt-1 text-xs text-muted">用於 MyAgent 資料夾分類與組織圖分組，同部門的員工會被歸在一起，例如「財務」「業務」。</p>
        </Field>
        <Field label="角色設定 Role Prompt">
          <textarea
            className="input min-h-[160px] resize-y"
            value={rolePrompt}
            onChange={(e) => setRolePrompt(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            這位員工的人格與行為準則，會注入每一次執行；寫得越具體，輸出越穩定。例：「你是嚴謹的財務助理，只依據已同步的雲端 Excel
            資料回答，一律使用繁體中文，金額需標明幣別。」
          </p>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="執行引擎 Engine">
            <select className="input" value={engineExecute} onChange={(e) => setEngineExecute(e.target.value)}>
              <option value="CLAUDE_CODE">CLAUDE_CODE</option>
              <option value="CODEX">CODEX</option>
              <option value="GROK">GROK（最快）</option>
            </select>
          </Field>
          <Field label="驗證引擎 Verify Engine">
            <select
              className="input"
              value={engineVerify ?? ''}
              onChange={(e) => setEngineVerify(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">自動（跨模型）</option>
              <option value="CLAUDE_CODE">CLAUDE_CODE</option>
              <option value="CODEX">CODEX</option>
              <option value="GROK">GROK（最快）</option>
            </select>
          </Field>
          <Field label="最大回合數 Max Rounds">
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={maxRounds}
              onChange={(e) => setMaxRounds(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs text-muted">
          <p>主要執行任務的 CLI：CLAUDE_CODE 最穩定、GROK 最快、CODEX 適合程式類任務。</p>
          <p>交叉驗證執行結果的第二顆模型；「自動」= 系統選擇與執行引擎不同的模型，GROK 驗證速度最快。</p>
          <p>執行↔驗證的重試上限；超過即停止並回報。對話不受此限。</p>
        </div>

        {patchMutation.error instanceof Error && <p className="text-sm text-rose-400">{patchMutation.error.message}</p>}

        <div className="flex justify-end">
          <button
            className="btn-primary"
            disabled={!dirty || patchMutation.isPending}
            onClick={() =>
              patchMutation.mutate({
                name,
                description,
                department: department.trim() || undefined,
                rolePrompt,
                engineExecute,
                engineVerify,
                maxRounds,
                restrictions: {
                  webSearch,
                  computerUse,
                  sendEmail,
                  cloudWrite,
                  shell,
                  cloudEmbedding,
                  notes: notes.trim() || undefined,
                },
              })
            }
          >
            {patchMutation.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Save className="h-4 w-4" />}
            儲存變更
          </button>
        </div>
      </div>

      <div className="card space-y-4 p-6">
        <div className="flex items-center gap-2 font-medium">
          <Settings2 className="h-4 w-4 text-brand" /> 限制設定
        </div>
        <p className="text-xs text-muted">
          這些開關會在引擎層強制生效（提示規則 + CLI 旗標 + COMPUTER_CONTROL 硬性阻擋），限制這位員工在執行任務時能做與不能做的事。
        </p>
        <div className="divide-y divide-border">
          <RestrictionToggle
            checked={webSearch}
            onChange={setWebSearch}
            title="網路搜尋與瀏覽網頁"
            description="允許此員工在執行任務時搜尋網路、抓取網頁內容（例如查詢即時新聞、公開資料）。關閉後將於引擎層停用 WebSearch/WebFetch 工具。"
          />
          <RestrictionToggle
            checked={computerUse}
            onChange={setComputerUse}
            title="電腦操控 Computer Use"
            description="允許此員工透過桌面版 App 操控這台電腦（開啟應用程式、錄製回放技能）。關閉後，任何 COMPUTER_CONTROL 步驟都會被系統直接拒絕執行。預設關閉。"
          />
          <RestrictionToggle
            checked={sendEmail}
            onChange={setSendEmail}
            title="寄送電子郵件"
            description="允許此員工代表你寄出 Email。關閉後僅能讀取郵件內容。預設關閉。"
          />
          <RestrictionToggle
            checked={cloudWrite}
            onChange={setCloudWrite}
            title="寫入雲端檔案"
            description="允許此員工在你的雲端硬碟建立或修改檔案（例如上傳產出的報價單、報告）。關閉後僅能讀取已指派的檔案。"
          />
          <RestrictionToggle
            checked={shell}
            onChange={setShell}
            title="執行 Shell 指令"
            description="允許此員工在工作目錄內執行終端機指令（產生文件、處理資料時通常需要）。"
          />
          <RestrictionToggle
            checked={cloudEmbedding}
            onChange={setCloudEmbedding}
            title="雲端 Embedding（語意記憶索引）"
            description="允許把 memory/wiki 摘要送到雲端 embedding API（OpenRouter Gemini）建立 Qdrant 語意索引。關閉後仍會寫入本地 log.md，但跳過向量化與語意召回。密鑰／個資紅線過濾一律生效。"
          />
        </div>
        <Field label="自訂禁止事項">
          <textarea
            className="input min-h-[90px] resize-y"
            placeholder={'每行一條，例如：\n不得對外提供未經核准的報價\n禁止讀取人事薪資相關檔案'}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">這些條列會併入角色提示，作為這位員工的紅線；每行一條，越具體越好。</p>
        </Field>
        <p className="text-xs text-muted">限制設定會與上方欄位一併透過「儲存變更」送出。</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 font-medium">
          <Wrench className="h-4 w-4 text-brand" /> 技能掛載
        </div>
        <SkillsTab agent={agent} />
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 font-medium">
          <Cloud className="h-4 w-4 text-brand" /> 雲端檔案
        </div>
        <FileTargetsTab agent={agent} />
      </div>

      <WorkflowsOverviewCard agent={agent} />
      <MemoryCard agentId={agent.id} />
    </div>
  );
}

function RestrictionToggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-3">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs leading-relaxed text-muted">{description}</p>
      </div>
    </label>
  );
}

// ---------- 技能 Skills ----------

function SkillsTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);

  const removeMutation = useMutation({
    mutationFn: (skillId: string) => API.del(`/api/agents/${agent.id}/skills/${skillId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', agent.id] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => setPicking(true)}>
          <Plus className="h-4 w-4" /> 掛載技能
        </button>
      </div>

      {agent.skills.length === 0 ? (
        <EmptyState title="尚未掛載任何技能" hint="點選「掛載技能」以新增" />
      ) : (
        <div className="card divide-y divide-border">
          {agent.skills.map((s) => (
            <div key={s.skillId} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3">
                <Wrench className="h-4 w-4 text-muted" />
                <div>
                  <div className="text-sm font-medium">{s.skill?.name ?? s.skillId}</div>
                  <div className="text-xs text-muted">{s.skill?.kind ?? ''}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={s.skill?.reviewStatus ?? 'UNKNOWN'} />
                <button
                  className="btn-ghost p-1.5 text-rose-400"
                  disabled={removeMutation.isPending}
                  onClick={() => removeMutation.mutate(s.skillId)}
                  title="移除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {picking && <AttachSkillModal agent={agent} onClose={() => setPicking(false)} />}
    </div>
  );
}

function AttachSkillModal({ agent, onClose }: { agent: AgentDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: skills, isLoading } = useQuery({
    queryKey: ['skills-all'],
    queryFn: () => API.get<SkillListItem[]>('/api/skills'),
  });

  const attachMutation = useMutation({
    mutationFn: (skillId: string) => API.post(`/api/agents/${agent.id}/skills`, { skillId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', agent.id] }),
  });

  const attachedIds = new Set(agent.skills.map((s) => s.skillId));
  const candidates = (skills ?? []).filter((s) => s.reviewStatus === 'CONFIRMED' && !attachedIds.has(s.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card flex max-h-[80vh] w-full max-w-lg flex-col gap-3 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">掛載技能</h2>
          <button className="btn-ghost p-1.5" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading && (
          <div className="flex justify-center py-8">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {!isLoading && candidates.length === 0 && <EmptyState title="沒有可掛載的技能" hint="只有審核狀態為 CONFIRMED 的技能可掛載" />}

        {!isLoading && candidates.length > 0 && (
          <div className="divide-y divide-border">
            {candidates.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted">
                    {s.kind} · v{s.version} · {s.origin}
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  disabled={attachMutation.isPending}
                  onClick={() => attachMutation.mutate(s.id)}
                >
                  <Plus className="h-4 w-4" /> 掛載
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 雲端檔案 File targets ----------

const SAMPLE_FILE_KINDS: { value: 'arap' | 'revenue' | 'finance'; label: string }[] = [
  { value: 'arap', label: '應收應付' },
  { value: 'revenue', label: '營收報告' },
  { value: 'finance', label: '財務分析' },
];

function FileTargetsTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<string>('');
  const [folderStack, setFolderStack] = useState<{ id: string | null; name: string }[]>([{ id: null, name: '根目錄' }]);
  const [staged, setStaged] = useState<CloudFileEntry[]>([]);
  const [sampleKind, setSampleKind] = useState<'arap' | 'revenue' | 'finance'>('arap');

  const { data: integrations } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => API.get<IntegrationsResponse>('/api/integrations'),
  });

  const currentFolder = folderStack[folderStack.length - 1];

  // Backend wraps the listing: GET /api/integrations/:id/files -> { entries: CloudFileEntry[] }
  const { data: filesResp, isLoading: filesLoading } = useQuery({
    queryKey: ['integration-files', accountId, currentFolder?.id ?? ''],
    queryFn: () =>
      API.get<{ entries: CloudFileEntry[] }>(
        `/api/integrations/${accountId}/files${currentFolder?.id ? `?folderId=${encodeURIComponent(currentFolder.id)}` : ''}`
      ),
    enabled: !!accountId,
  });
  const files = filesResp?.entries;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const registered: { cloudFileRefId: string; purpose?: string }[] = [];
      for (const f of staged) {
        const ref = await API.post<{ id: string }>(`/api/integrations/${accountId}/files/register`, {
          externalId: f.id,
          name: f.name,
          path: f.path,
          mimeType: f.mimeType,
          kind: f.kind,
        });
        registered.push({ cloudFileRefId: ref.id });
      }
      const existing = agent.fileTargets.map((t) => ({ cloudFileRefId: t.cloudFileRefId, purpose: t.purpose ?? undefined }));
      const merged = [...existing, ...registered];
      return API.put(`/api/agents/${agent.id}/file-targets`, { targets: merged });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
      setStaged([]);
    },
  });

  const removeTargetMutation = useMutation({
    mutationFn: (cloudFileRefId: string) => {
      const remaining = agent.fileTargets
        .filter((t) => t.cloudFileRefId !== cloudFileRefId)
        .map((t) => ({ cloudFileRefId: t.cloudFileRefId, purpose: t.purpose ?? undefined }));
      return API.put(`/api/agents/${agent.id}/file-targets`, { targets: remaining });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', agent.id] }),
  });

  // Creates a ready-made AR/AP (應收/應付) template file in the chosen cloud
  // account, then attaches it to this agent's file targets.
  const arapMutation = useMutation({
    mutationFn: async () => {
      const ref = await API.post<{ id: string; name: string; path?: string; webUrl?: string | null }>(
        `/api/integrations/${accountId}/arap-template`
      );
      const existing = agent.fileTargets.map((t) => ({ cloudFileRefId: t.cloudFileRefId, purpose: t.purpose ?? undefined }));
      await API.put(`/api/agents/${agent.id}/file-targets`, {
        targets: [...existing, { cloudFileRefId: ref.id, purpose: 'AR/AP 範本' }],
      });
      return ref;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
    },
  });

  // Creates a sample file of the chosen kind (應收應付 / 營收報告 / 財務分析) in the
  // chosen cloud account, then attaches it to this agent's file targets.
  const sampleFileMutation = useMutation({
    mutationFn: async () => {
      const label = SAMPLE_FILE_KINDS.find((k) => k.value === sampleKind)?.label ?? sampleKind;
      const ref = await API.post<{ id: string; name: string; path?: string; webUrl?: string | null }>(
        `/api/integrations/${accountId}/sample-file`,
        { kind: sampleKind }
      );
      const existing = agent.fileTargets.map((t) => ({ cloudFileRefId: t.cloudFileRefId, purpose: t.purpose ?? undefined }));
      await API.put(`/api/agents/${agent.id}/file-targets`, {
        targets: [...existing, { cloudFileRefId: ref.id, purpose: `範例檔案：${label}` }],
      });
      return ref;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
    },
  });

  function toggleStaged(entry: CloudFileEntry) {
    setStaged((prev) => {
      const exists = prev.find((f) => f.id === entry.id);
      if (exists) return prev.filter((f) => f.id !== entry.id);
      return [...prev, entry];
    });
  }

  function openFolder(entry: CloudFileEntry) {
    setFolderStack((prev) => [...prev, { id: entry.id, name: entry.name }]);
  }

  function jumpTo(idx: number) {
    setFolderStack((prev) => prev.slice(0, idx + 1));
  }

  const accounts = integrations?.accounts ?? [];

  return (
    <div className="space-y-6">
      <div className="card space-y-3 p-5">
        <div className="text-sm font-medium">目前的雲端檔案目標</div>
        {agent.fileTargets.length === 0 ? (
          <p className="text-sm text-muted">尚未設定任何雲端檔案目標</p>
        ) : (
          <div className="divide-y divide-border">
            {agent.fileTargets.map((t) => (
              <div key={t.cloudFileRefId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{t.cloudFileRef?.name ?? t.cloudFileRefId}</div>
                  <div className="truncate text-xs text-muted">{t.cloudFileRef?.path ?? ''}</div>
                  {t.purpose && <div className="mt-0.5 text-xs text-brand">用途：{t.purpose}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {t.cloudFileRef?.webUrl && (
                    <a
                      className="btn-ghost p-1.5"
                      href={t.cloudFileRef.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="前往檔案"
                    >
                      <ExternalLink className="h-4 w-4" /> 前往檔案
                    </a>
                  )}
                  <button
                    className="btn-ghost p-1.5 text-rose-400"
                    disabled={removeTargetMutation.isPending}
                    onClick={() => removeTargetMutation.mutate(t.cloudFileRefId)}
                    title="移除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card space-y-4 p-5">
        <div className="text-sm font-medium">從雲端帳戶選取檔案</div>

        {accounts.length === 0 && (
          <EmptyState title="尚未連結雲端帳戶" hint="請至「設定」頁面連結 Microsoft / Google 帳戶" />
        )}

        {accounts.length > 0 && (
          <>
            <Field label="雲端帳戶">
              <select
                className="input"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setFolderStack([{ id: null, name: '根目錄' }]);
                  setStaged([]);
                }}
              >
                <option value="">請選擇...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.provider} · {a.email}
                  </option>
                ))}
              </select>
            </Field>

            {accountId && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-brand/30 p-3">
                <button className="btn-ghost" disabled={arapMutation.isPending} onClick={() => arapMutation.mutate()}>
                  {arapMutation.isPending ? <Spinner className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
                  在此帳號建立 AR/AP 範本
                </button>
                {arapMutation.isError && (
                  <span className="text-xs text-rose-400">{(arapMutation.error as Error).message}</span>
                )}
                {arapMutation.isSuccess && arapMutation.data && (
                  <span className="text-xs text-emerald-400">
                    已建立並加入檔案目標：
                    {arapMutation.data.webUrl ? (
                      <a className="underline" href={arapMutation.data.webUrl} target="_blank" rel="noreferrer">
                        {arapMutation.data.name}
                      </a>
                    ) : (
                      arapMutation.data.name
                    )}
                  </span>
                )}
              </div>
            )}

            {accountId && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-brand/30 p-3">
                <select className="input w-auto" value={sampleKind} onChange={(e) => setSampleKind(e.target.value as typeof sampleKind)}>
                  {SAMPLE_FILE_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <button className="btn-ghost" disabled={sampleFileMutation.isPending} onClick={() => sampleFileMutation.mutate()}>
                  {sampleFileMutation.isPending ? <Spinner className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
                  建立範例檔案
                </button>
                {sampleFileMutation.isError && (
                  <span className="text-xs text-rose-400">{(sampleFileMutation.error as Error).message}</span>
                )}
                {sampleFileMutation.isSuccess && sampleFileMutation.data && (
                  <span className="text-xs text-emerald-400">
                    已建立並加入檔案目標：
                    {sampleFileMutation.data.webUrl ? (
                      <a className="underline" href={sampleFileMutation.data.webUrl} target="_blank" rel="noreferrer">
                        {sampleFileMutation.data.name}
                      </a>
                    ) : (
                      sampleFileMutation.data.name
                    )}
                  </span>
                )}
              </div>
            )}

            {accountId && (
              <>
                <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
                  {folderStack.map((f, idx) => (
                    <span key={idx} className="flex items-center gap-1">
                      {idx > 0 && <ChevronRight className="h-3 w-3" />}
                      <button
                        className={cn('hover:text-fg', idx === folderStack.length - 1 && 'font-medium text-fg')}
                        onClick={() => jumpTo(idx)}
                      >
                        {f.name}
                      </button>
                    </span>
                  ))}
                </div>

                {filesLoading && (
                  <div className="flex justify-center py-8">
                    <Spinner className="h-5 w-5" />
                  </div>
                )}

                {!filesLoading && (files ?? []).length === 0 && <EmptyState title="此資料夾為空" />}

                {!filesLoading && (files ?? []).length > 0 && (
                  <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                    {(files ?? []).map((f) => {
                      const isFolder = f.kind === 'FOLDER';
                      const isStaged = !!staged.find((s) => s.id === f.id);
                      return (
                        <div
                          key={f.id}
                          className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-black/5 dark:hover:bg-white/5"
                        >
                          <button
                            className="flex flex-1 items-center gap-2 text-left"
                            onClick={() => (isFolder ? openFolder(f) : toggleStaged(f))}
                          >
                            {isFolder ? <Folder className="h-4 w-4 text-brand" /> : <FileIcon className="h-4 w-4 text-muted" />}
                            <span className="truncate text-sm">{f.name}</span>
                          </button>
                          {!isFolder && (
                            <div className="flex shrink-0 items-center gap-1">
                              {f.webUrl && (
                                <a
                                  className="btn-ghost p-1.5"
                                  href={f.webUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="前往檔案"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </a>
                              )}
                              <button
                                className={cn('btn-ghost p-1.5', isStaged && 'text-brand')}
                                onClick={() => toggleStaged(f)}
                                title={isStaged ? '取消選取' : '選取'}
                              >
                                {isStaged ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {staged.length > 0 && (
          <div className="space-y-2 rounded-lg border border-brand/30 bg-brand/5 p-3">
            <div className="text-xs font-medium text-muted">已選取 {staged.length} 個檔案</div>
            <div className="flex flex-wrap gap-1.5">
              {staged.map((f) => (
                <span key={f.id} className="badge bg-brand/15 text-brand">
                  {f.name}
                </span>
              ))}
            </div>
            {saveMutation.error instanceof Error && <p className="text-sm text-rose-400">{saveMutation.error.message}</p>}
            <div className="flex justify-end">
              <button className="btn-primary" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending && <Spinner className="border-white/40 border-t-white" />} 加入為檔案目標
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 工作流（概況唯讀卡，編輯走 /workflows） ----------

function WorkflowsOverviewCard({ agent }: { agent: AgentDetail }) {
  const list = agent.workflows ?? [];
  return (
    <div className="card space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Workflow className="h-4 w-4 text-brand" /> 工作流
        </div>
        <Link href="/workflows" className="text-xs text-brand hover:underline">
          前往工作流
        </Link>
      </div>
      <p className="text-xs text-muted">此處唯讀。新增、測試、啟停請到工作流頁。</p>
      {list.length === 0 ? (
        <p className="text-sm text-muted">尚未建立工作流</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="truncate text-sm font-medium">{w.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={w.enabled ? 'ENABLED' : 'DISABLED'} />
                <Link href={`/workflows/${w.id}`} className="text-xs text-brand hover:underline">
                  查看
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- 執行紀錄 Runs ----------

/** Translate a triggeredBy source string (e.g. "chat:abc") into zh-Hant. */
function triggeredByZh(raw?: string | null): string {
  if (!raw) return '—';
  // Direct MCP/REST invocations carry the authenticated user's ULID instead of
  // a named source prefix. Showing that opaque value made every run row look
  // as if it had the same run id, even though the real run ids were distinct.
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(raw)) return '使用者手動執行';
  const [prefix] = raw.split(':');
  switch (prefix) {
    case 'chat':
      return '對話';
    case 'test':
      return '測試執行';
    case 'trigger':
      return '關鍵字觸發';
    case 'schedule':
      return '排程';
    case 'user':
      return '手動執行';
    case 'line':
      return 'LINE 觸發';
    default:
      return raw;
  }
}

/** Compact zh-Hant relative time ("剛剛" / "5 分鐘前" / "3 小時前" / "2 天前"). */
function relativeTimeZh(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '剛剛';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '剛剛';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-Hant');
}

/** Human-friendly duration between two ISO timestamps ("1 分 12 秒" / "8 秒"). */
function durationZh(start?: string | null, end?: string | null): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min} 分 ${rem} 秒` : `${min} 分`;
}

/** Best final output from run steps — prefer the last approved step, else the last with output. */
function pickRunOutput(steps: RunSnapshotStep[]): string | null {
  const withOutput = steps.filter((s) => (s.output ?? '').trim());
  if (withOutput.length === 0) return null;
  const approved = [...withOutput].reverse().find((s) => s.approved === true);
  return (approved ?? withOutput[withOutput.length - 1]).output!.trim();
}

function RunRow({ run }: { run: RunListItem }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: detail, isLoading } = useQuery({
    queryKey: ['run-detail', run.id],
    queryFn: () => API.get<RunDetail>(`/api/runs/${run.id}`),
    enabled: expanded,
  });

  const finalOutput = detail ? pickRunOutput(detail.steps ?? []) : null;

  return (
    <div className="divide-y divide-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/5"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted transition-transform', expanded && 'rotate-90')} />
        <StatusBadge status={run.status} />
        <span className="text-sm text-muted">{triggeredByZh(run.triggeredBy)}</span>
        <span className="font-mono text-xs text-muted" title={run.id}>
          Run {run.id.length > 22 ? `${run.id.slice(0, 12)}…${run.id.slice(-6)}` : run.id}
        </span>
        <span className="ml-auto text-xs text-muted" title={run.startedAt ? new Date(run.startedAt).toLocaleString('zh-Hant') : undefined}>
          {relativeTimeZh(run.startedAt)}
        </span>
        <span className="text-xs text-muted">耗時 {durationZh(run.startedAt, run.finishedAt)}</span>
      </button>

      {expanded && (
        <div className="space-y-3 bg-panel px-4 py-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner className="h-3.5 w-3.5" /> 載入執行細節...
            </div>
          )}
          {!isLoading && detail && (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
                <span>觸發來源：{triggeredByZh(detail.triggeredBy ?? run.triggeredBy)}</span>
                <span title={detail.startedAt ? new Date(detail.startedAt).toLocaleString('zh-Hant') : undefined}>
                  開始：{relativeTimeZh(detail.startedAt ?? run.startedAt)}
                </span>
                <span title={detail.finishedAt ? new Date(detail.finishedAt).toLocaleString('zh-Hant') : undefined}>
                  結束：{relativeTimeZh(detail.finishedAt ?? run.finishedAt)}
                </span>
                <span>耗時：{durationZh(detail.startedAt ?? run.startedAt, detail.finishedAt ?? run.finishedAt)}</span>
              </div>

              {(detail.steps ?? []).length > 0 && (
                <div className="space-y-1.5">
                  {(detail.steps ?? []).map((s, idx) => (
                    <RunStepRow key={`${s.stepKey}-${s.round ?? idx}`} step={s} />
                  ))}
                </div>
              )}

              {finalOutput ? (
                <div className="space-y-1.5 border-t border-border pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">執行結果 OUTPUT</span>
                    <button
                      type="button"
                      className="btn-ghost px-2 py-1 text-xs"
                      onClick={() => {
                        navigator.clipboard?.writeText(finalOutput).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        });
                      }}
                    >
                      {copied ? '已複製 ✓' : '複製'}
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-black/20 p-3 text-xs leading-relaxed">
                    {finalOutput}
                  </div>
                </div>
              ) : (
                <div className="border-t border-border pt-2 text-xs text-muted">（此次執行沒有文字產出）</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RunStepRow({ step }: { step: RunSnapshotStep }) {
  const [open, setOpen] = useState(false);
  const hasVerdict = !!(step.verdict ?? '').trim();
  return (
    <div className="rounded-md border border-border bg-black/5 dark:bg-white/5">
      <button
        type="button"
        className={cn('flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs', hasVerdict && 'cursor-pointer')}
        onClick={() => hasVerdict && setOpen((v) => !v)}
      >
        {step.approved === true ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        ) : step.approved === false ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="font-medium">{step.stepKey}</span>
        {typeof step.round === 'number' && <span className="text-muted">第 {step.round} 輪</span>}
        {step.approved === true && <span className="text-emerald-400">✓</span>}
        {step.approved === false && <span className="text-rose-400">✗</span>}
        {step.status && <span className="text-muted">· {step.status}</span>}
        {hasVerdict && <ChevronRight className={cn('ml-auto h-3.5 w-3.5 text-muted transition-transform', open && 'rotate-90')} />}
      </button>
      {open && hasVerdict && (
        <div className="whitespace-pre-wrap border-t border-border px-2.5 py-2 text-xs leading-relaxed text-muted">{step.verdict}</div>
      )}
    </div>
  );
}

function RunsTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();

  const { data: runs, isLoading } = useQuery({
    queryKey: ['agent-runs', agent.id],
    queryFn: () => API.get<RunListItem[]>(`/api/runs?agentId=${agent.id}&limit=50`),
  });

  // Refresh the list (and any expanded detail) whenever a run.* event fires
  // for this agent — new runs appear, and finished runs pick up their result.
  useAwp(['run.*'], (frame) => {
    const payload = (frame.payload ?? {}) as { runId?: string; agentId?: string };
    if (payload.agentId && payload.agentId !== agent.id) return;
    qc.invalidateQueries({ queryKey: ['agent-runs', agent.id] });
    if (payload.runId) qc.invalidateQueries({ queryKey: ['run-detail', payload.runId] });
  });

  const list = runs ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      {isLoading && (
        <div className="flex justify-center py-8">
          <Spinner className="h-5 w-5" />
        </div>
      )}

      {!isLoading && list.length === 0 && (
        <EmptyState title="尚無執行紀錄" hint="可在工作流頁按「測試」立即產生一筆。" />
      )}

      {!isLoading && list.length > 0 && (
        <div className="card divide-y divide-border">
          {list.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 記憶 Memory（概況卡：最近 10 筆） ----------

interface MemoryFileEntry {
  path: string;
  size: number;
  mtime: string;
}

function MemoryCard({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const { data: filesData, isLoading: filesLoading } = useQuery({
    queryKey: ['memory-files', agentId],
    queryFn: () => API.get<{ files: MemoryFileEntry[] }>(`/api/agents/${agentId}/memory/files`),
  });
  const files = (filesData?.files ?? [])
    .slice()
    .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime())
    .slice(0, 10);

  const { data: fileData, isLoading: fileLoading } = useQuery({
    queryKey: ['memory-file', agentId, selectedPath],
    queryFn: () =>
      API.get<{ path: string; content: string }>(
        `/api/agents/${agentId}/memory/file?path=${encodeURIComponent(selectedPath!)}`,
      ),
    enabled: !!selectedPath,
  });

  const reindexMutation = useMutation({
    mutationFn: () =>
      API.post<{ indexed: number; skipped: number; failed: number }>(
        `/api/agents/${agentId}/memory/reindex`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory-files', agentId] });
      if (selectedPath) qc.invalidateQueries({ queryKey: ['memory-file', agentId, selectedPath] });
    },
  });

  return (
    <div className="card space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <BookOpen className="h-4 w-4 text-brand" /> 記憶
        </div>
        <button
          type="button"
          className="btn-ghost text-xs"
          disabled={reindexMutation.isPending}
          onClick={() => reindexMutation.mutate()}
        >
          {reindexMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          重新索引
        </button>
      </div>
      <p className="text-xs text-muted">最近 10 筆 wiki 檔。點選檔名檢視內容（唯讀）。</p>
      {reindexMutation.isSuccess && (
        <p className="text-xs text-muted">
          索引完成：indexed={reindexMutation.data.indexed}，skipped={reindexMutation.data.skipped}，failed=
          {reindexMutation.data.failed}
        </p>
      )}
      {reindexMutation.error instanceof Error && (
        <p className="text-sm text-rose-400">{reindexMutation.error.message}</p>
      )}
      {filesLoading && (
        <div className="flex justify-center py-6">
          <Spinner className="h-5 w-5" />
        </div>
      )}
      {!filesLoading && files.length === 0 && (
        <p className="text-sm text-muted">尚無 wiki 檔案</p>
      )}
      {!filesLoading && files.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setSelectedPath(f.path)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40',
                  selectedPath === f.path && 'bg-brand/10 text-brand',
                )}
              >
                <FileIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                <span className="shrink-0 text-xs text-muted">{f.size} B</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedPath && fileLoading && (
        <div className="flex justify-center py-4">
          <Spinner className="h-4 w-4" />
        </div>
      )}
      {selectedPath && !fileLoading && fileData && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs leading-relaxed">
          {fileData.content}
        </pre>
      )}
    </div>
  );
}

// ---------- 對話 Chat ----------

function ChatTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sentRunIds, setSentRunIds] = useState<Record<string, string>>({});
  const [runSteps, setRunSteps] = useState<Record<string, RunStep[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: conversations, isLoading: convosLoading } = useQuery({
    queryKey: ['conversations', agentId],
    queryFn: () => API.get<Conversation[]>(`/api/agents/${agentId}/conversations`),
  });

  useEffect(() => {
    if (!activeConvId && conversations && conversations.length > 0) setActiveConvId(conversations[0].id);
  }, [conversations, activeConvId]);

  const createConvMutation = useMutation({
    mutationFn: () => API.post<{ id: string }>(`/api/agents/${agentId}/conversations`, {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['conversations', agentId] });
      setActiveConvId(data.id);
    },
  });

  const { data: messages } = useQuery({
    queryKey: ['messages', activeConvId],
    queryFn: () => API.get<ChatMessage[]>(`/api/conversations/${activeConvId}/messages`),
    enabled: !!activeConvId,
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) => API.post<{ messageId: string; runId: string }>(`/api/conversations/${activeConvId}/messages`, { content }),
    onSuccess: (data) => {
      setSentRunIds((prev) => ({ ...prev, [data.messageId]: data.runId }));
      setDraft('');
      qc.invalidateQueries({ queryKey: ['messages', activeConvId] });
    },
  });

  function handleFrame(frame: AwpFrame) {
    const topic = frame.topic ?? '';
    const payload = frame.payload ?? {};
    const isRunEvent = topic.startsWith('run.') || payload?.type === 'run.step';
    if (isRunEvent && payload?.runId) {
      const { runId, stepKey, round, status, verdict } = payload;
      setRunSteps((prev) => {
        const list = prev[runId] ? [...prev[runId]] : [];
        const idx = list.findIndex((s) => s.stepKey === stepKey && s.round === round);
        const next: RunStep = { stepKey, round, status, verdict };
        if (idx >= 0) list[idx] = next;
        else list.push(next);
        return { ...prev, [runId]: list };
      });
      // When the run finishes the AGENT reply has been persisted — refetch the
      // message list so the reply bubble appears.
      if (topic === 'run.finished') qc.invalidateQueries({ queryKey: ['messages', activeConvId] });
    }
    // The backend publishes chat replies on the topic `chat.message` with a
    // conversationId in the payload (NOT `chat.<id>`), so match on that.
    const isChatEvent = topic === 'chat.message' && (!activeConvId || payload?.conversationId === activeConvId);
    if (isChatEvent) {
      qc.invalidateQueries({ queryKey: ['messages', activeConvId] });
    }
  }

  const topics = useMemo(() => ['run.*', 'chat.*'], []);
  useAwp(topics, handleFrame);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, runSteps]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !activeConvId) return;
    sendMutation.mutate(draft.trim());
  }

  return (
    <div className="flex h-[70vh] gap-4">
      <div className="w-56 shrink-0 space-y-2">
        <button className="btn-ghost w-full justify-center" disabled={createConvMutation.isPending} onClick={() => createConvMutation.mutate()}>
          {createConvMutation.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} 新對話
        </button>
        {convosLoading && (
          <div className="flex justify-center py-4">
            <Spinner className="h-4 w-4" />
          </div>
        )}
        <div className="space-y-1 overflow-y-auto">
          {(conversations ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveConvId(c.id)}
              className={cn(
                'block w-full truncate rounded-lg px-3 py-2 text-left text-sm',
                activeConvId === c.id ? 'bg-brand/10 text-brand font-medium' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5'
              )}
            >
              {c.title || `對話 ${c.id.slice(0, 8)}`}
            </button>
          ))}
        </div>
      </div>

      <div className="card flex flex-1 flex-col overflow-hidden">
        {!activeConvId ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState title="尚無對話" hint="點選「新對話」開始與這位員工互動" />
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
              {(messages ?? []).length === 0 && <p className="text-center text-sm text-muted">尚無訊息，開始對話吧</p>}
              {(messages ?? []).map((m) => {
                const role = (m.role ?? m.sender ?? 'user').toString().toUpperCase();
                const isUser = role.includes('USER');
                const runId = m.runId ?? sentRunIds[m.id];
                return (
                  <div key={m.id} className={cn('flex flex-col gap-1.5', isUser ? 'items-end' : 'items-start')}>
                    <div
                      className={cn(
                        'max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm',
                        isUser ? 'bg-brand text-white' : 'bg-black/5 dark:bg-white/10'
                      )}
                    >
                      {m.content}
                    </div>
                    {isUser && runId && <RunTimeline steps={runSteps[runId] ?? []} />}
                  </div>
                );
              })}
            </div>

            <form onSubmit={submit} className="flex items-center gap-2 border-t border-border p-3">
              <input
                className="input flex-1"
                placeholder="輸入訊息給這位員工..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button className="btn-primary" disabled={!draft.trim() || sendMutation.isPending}>
                {sendMutation.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function stepIcon(status: string) {
  const s = status?.toUpperCase?.() ?? '';
  if (s === 'SUCCEEDED' || s === 'PASSED' || s === 'APPROVED') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (s === 'FAILED' || s === 'REJECTED') return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />;
}

function RunTimeline({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) {
    return (
      <div className="flex max-w-[80%] items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 等待執行中...
      </div>
    );
  }
  return (
    <div className="max-w-[80%] space-y-1.5 rounded-xl border border-border bg-panel px-3 py-2.5">
      {steps.map((s, idx) => (
        <div key={`${s.stepKey}-${s.round ?? idx}`} className="flex items-center gap-2 text-xs">
          {stepIcon(s.status)}
          <span className="font-medium">{s.stepKey}</span>
          {typeof s.round === 'number' && <span className="text-muted">第 {s.round} 輪</span>}
          <StatusBadge status={s.status} />
          {s.verdict && <span className="text-muted">· {s.verdict}</span>}
        </div>
      ))}
    </div>
  );
}
