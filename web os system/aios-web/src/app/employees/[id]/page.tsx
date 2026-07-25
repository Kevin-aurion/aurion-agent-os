'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  ExternalLink,
  File as FileIcon,
  Folder,
  GraduationCap,
  List,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  Square,
  Tag,
  Trash2,
  Workflow,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { API, ApiError } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp, type AwpFrame } from '@/lib/awp';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Field, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { cn } from '@/lib/cn';

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
// Workflow.trigger JSON convention (backend, EXTEND / back-compat):
// {type:'schedule',cron,timezone?} | {type:'manual'} | {type:'keyword',keywords:string[]} | {type:'webhook'} | {type:'event',topic}
interface WorkflowTrigger {
  type: 'schedule' | 'manual' | 'keyword' | 'webhook' | 'event';
  cron?: string;
  timezone?: string;
  keywords?: string[];
  topic?: string;
  [key: string]: unknown;
}
interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  enabled: boolean;
  stepCount?: number;
}
// Live run tracking (from run.* WS events), keyed by runId at the tab level.
interface RunStepLive {
  stepKey: string;
  round?: number;
  type?: string;
  phase?: string;
  output?: string | null;
}
// GET /api/runs/:id response shape (poll-friendly), used to resume the
// inline workflow-test timeline after a tab switch unmounts local state.
interface RunSnapshotStep {
  stepKey: string;
  round?: number;
  status?: string;
  verdict?: string | null;
  approved?: boolean | null;
  output?: string | null;
}
interface RunSnapshot {
  status: string;
  steps: RunSnapshotStep[];
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
// Skill.understanding JSON shape (see src/skills/understand.ts on the backend).
interface SkillUnderstanding {
  summary: string;
  capabilities: string[];
  data_read: string[];
  data_written: string[];
  external_calls: string[];
  irreversible_actions: string[];
  risks: string[];
}
interface SkillDetail {
  id: string;
  name: string;
  reviewStatus: string;
  executionEnv: string;
  understanding?: SkillUnderstanding | null;
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
  { key: 'skills', label: '技能', icon: Wrench },
  { key: 'files', label: '雲端檔案', icon: Cloud },
  { key: 'workflows', label: '工作流', icon: Workflow },
  { key: 'runs', label: '執行紀錄', icon: Activity },
  { key: 'training', label: '訓練', icon: GraduationCap },
  { key: 'memory', label: '記憶', icon: BookOpen },
  { key: 'chat', label: '對話', icon: MessageSquare },
] as const;
type TabKey = typeof TABS[number]['key'];

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;
  // Honor ?tab=<key> so external links (e.g. the workflow editor's back
  // button) can land directly on a specific tab.
  const searchParams = useSearchParams();
  const initialTab = ((): TabKey => {
    const q = searchParams.get('tab');
    return TABS.some((t) => t.key === q) ? (q as TabKey) : 'overview';
  })();
  const [tab, setTab] = useState<TabKey>(initialTab);

  const { data: agent, isLoading } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => API.get<AgentDetail>(`/api/agents/${agentId}`),
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
          {tab === 'skills' && <SkillsTab agent={agent} />}
          {tab === 'files' && <FileTargetsTab agent={agent} />}
          {tab === 'workflows' && <WorkflowsTab agent={agent} />}
          {tab === 'runs' && <RunsTab agent={agent} />}
          {tab === 'training' && <TrainingTab agent={agent} />}
          {tab === 'memory' && <MemoryTab agentId={agent.id} />}
          {tab === 'chat' && <ChatTab agentId={agent.id} />}
        </>
      )}
    </AppShell>
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
    <div className="max-w-2xl space-y-6">
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

// ---------- 工作流 Workflows ----------

const CRON_PRESETS: { value: string; label: string }[] = [
  { value: '*/15 * * * *', label: '每15分鐘' },
  { value: '0 * * * *', label: '每小時' },
  { value: '0 9 * * *', label: '每天09:00' },
  { value: '0 9 * * 1', label: '每週一09:00' },
  { value: 'custom', label: '自訂' },
];

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** Human-friendly rendering of common cron patterns; falls back to the raw cron string. */
function cronToHuman(cron?: string): string {
  if (!cron) return '';
  const preset = CRON_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
      return `每天 ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow) && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
      return `每週${WEEKDAY_NAMES[Number(dow)]} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `每${min.slice(2)}分鐘`;
    }
  }
  return cron;
}

function TriggerBadge({ trigger }: { trigger: WorkflowTrigger }) {
  if (trigger?.type === 'schedule') {
    return (
      <span className="badge inline-flex items-center gap-1 bg-blue-500/15 text-blue-400">
        <Clock className="h-3 w-3" /> 定期 · {cronToHuman(trigger.cron)}
      </span>
    );
  }
  if (trigger?.type === 'keyword') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="badge inline-flex items-center gap-1 bg-amber-500/15 text-amber-400">
          <Tag className="h-3 w-3" /> 觸發
        </span>
        {(trigger.keywords ?? []).map((k) => (
          <span key={k} className="badge bg-amber-500/10 text-amber-500">
            {k}
          </span>
        ))}
      </span>
    );
  }
  return <span className="badge bg-black/10 text-muted dark:bg-white/10">手動</span>;
}

// Terminal run states — once reached, the sessionStorage-persisted
// "active run" entry for that workflow can be cleared.
const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const ACTIVE_RUN_STORAGE_PREFIX = 'aios.activeRun.';

interface StoredActiveRun {
  runId: string;
  startedAt: number;
}

/**
 * Persists the currently-tracked test/run per workflow so the inline
 * timeline survives the WorkflowsTab component unmounting (e.g. the user
 * switches to another employee-detail tab and back).
 */
function readStoredActiveRun(workflowId: string): StoredActiveRun | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${ACTIVE_RUN_STORAGE_PREFIX}${workflowId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredActiveRun;
    if (!parsed?.runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredActiveRun(workflowId: string, runId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${ACTIVE_RUN_STORAGE_PREFIX}${workflowId}`,
      JSON.stringify({ runId, startedAt: Date.now() } satisfies StoredActiveRun)
    );
  } catch {
    // sessionStorage unavailable (e.g. private mode quota) — non-fatal.
  }
}

function clearStoredActiveRun(workflowId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(`${ACTIVE_RUN_STORAGE_PREFIX}${workflowId}`);
  } catch {
    // ignore
  }
}

function phaseIcon(phase?: string) {
  if (phase === 'approved') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (phase === 'rejected') return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />;
}

/** Live run timeline rendered inline under a workflow card while `runId` is tracked. */
function LiveRunTimeline({ runId, status, steps }: { runId: string; status?: string; steps: RunStepLive[] }) {
  const [copied, setCopied] = useState(false);
  const isTerminal = TERMINAL_RUN_STATUSES.has(status ?? '');
  // The run's result = the last step that produced output (prefer approved).
  const finalOutput = (() => {
    if (!isTerminal) return null;
    const withOutput = steps.filter((s) => (s.output ?? '').trim());
    if (withOutput.length === 0) return null;
    const approved = [...withOutput].reverse().find((s) => s.phase === 'approved');
    return (approved ?? withOutput[withOutput.length - 1]).output!.trim();
  })();

  return (
    <div className="space-y-2 rounded-lg border border-border bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Run: {runId.slice(0, 10)}…</span>
        <StatusBadge status={status ?? 'RUNNING'} />
      </div>
      {steps.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 等待執行中...
        </div>
      ) : (
        <div className="space-y-1.5">
          {steps.map((s, idx) => (
            <div key={`${s.stepKey}-${s.round ?? idx}`} className="flex items-center gap-2 text-xs">
              {phaseIcon(s.phase)}
              <span className="font-medium">{s.stepKey}</span>
              {typeof s.round === 'number' && <span className="text-muted">第 {s.round} 輪</span>}
              {s.phase && <span className="text-muted">· {s.phase}</span>}
            </div>
          ))}
        </div>
      )}
      {finalOutput && (
        <div className="space-y-1.5 border-t border-border pt-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted">執行結果</span>
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
      )}
      {isTerminal && !finalOutput && (
        <div className="border-t border-border pt-2 text-xs text-muted">（此次執行沒有文字產出）</div>
      )}
    </div>
  );
}

function WorkflowCard({
  w,
  runId,
  runStatus,
  runSteps,
  onTest,
  onRun,
  onToggleEnabled,
  toggling,
}: {
  w: WorkflowListItem;
  runId?: string;
  runStatus?: string;
  runSteps: RunStepLive[];
  onTest: (message?: string) => void;
  onRun: () => void;
  onToggleEnabled: () => void;
  toggling: boolean;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [message, setMessage] = useState('');

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <Workflow className="h-4 w-4 shrink-0 text-muted" />
            <span className="truncate font-medium">{w.name}</span>
          </div>
          {w.description && <p className="text-sm text-muted">{w.description}</p>}
          <div>
            <TriggerBadge trigger={w.trigger} />
          </div>
        </div>
        <button
          type="button"
          className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0 transition-colors', w.enabled ? 'bg-brand' : 'bg-border')}
          onClick={onToggleEnabled}
          disabled={toggling}
          title={w.enabled ? '已啟用（點擊停用）' : '已停用（點擊啟用）'}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              w.enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost" onClick={() => setTestOpen((v) => !v)}>
          <Play className="h-4 w-4" /> 測試
        </button>
        <button type="button" className="btn-ghost" onClick={onRun}>
          <Play className="h-4 w-4" /> 執行
        </button>
        <Link href={`/workflows/${w.id}`} className="btn-ghost">
          編輯
        </Link>
      </div>

      {testOpen && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-brand/30 p-2.5">
          <input
            className="input flex-1"
            placeholder="測試訊息（選填）"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onTest(message.trim() || undefined);
              setTestOpen(false);
              setMessage('');
            }}
          >
            送出測試
          </button>
        </div>
      )}

      {runId && <LiveRunTimeline runId={runId} status={runStatus} steps={runSteps} />}
    </div>
  );
}

function WorkflowsTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'schedule' | 'manual' | 'keyword'>('manual');
  const [cronPreset, setCronPreset] = useState(CRON_PRESETS[2]!.value);
  const [customCron, setCustomCron] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [verifyRubric, setVerifyRubric] = useState('');

  // runId currently being tracked per workflow, plus live step/status state
  // fed by a single shared `run.*` subscription (avoids one WS connection
  // per card). Mirrored into sessionStorage (see aios.activeRun.<workflowId>)
  // so the inline test-run timeline survives this component unmounting when
  // the user switches to another employee-detail tab and back.
  const [runByWorkflow, setRunByWorkflow] = useState<Record<string, string>>({});
  const [runStatusById, setRunStatusById] = useState<Record<string, string>>({});
  const [runStepsById, setRunStepsById] = useState<Record<string, RunStepLive[]>>({});

  const { data: workflows, isLoading } = useQuery({
    queryKey: ['agent-workflows', agent.id],
    queryFn: () => API.get<WorkflowListItem[]>(`/api/agents/${agent.id}/workflows`),
  });

  /** Applies a GET /api/runs/:id snapshot into the live-timeline state, and
   * clears the sessionStorage entry once the run has reached a terminal
   * state and been rendered at least once (i.e. right after this fetch). */
  function applyRunSnapshot(workflowId: string, runId: string, data: RunSnapshot) {
    setRunStatusById((prev) => ({ ...prev, [runId]: data.status }));
    setRunStepsById((prev) => ({
      ...prev,
      [runId]: (data.steps ?? []).map((s) => ({
        stepKey: s.stepKey,
        round: s.round,
        phase: s.approved === true ? 'approved' : s.approved === false ? 'rejected' : undefined,
        output: s.output ?? null,
      })),
    }));
    if (TERMINAL_RUN_STATUSES.has(data.status)) {
      clearStoredActiveRun(workflowId);
    }
  }

  // On mount, resume any test/run that was in-flight before this tab was
  // unmounted: restore the tracked runId from sessionStorage and fetch its
  // current snapshot so the timeline reappears immediately.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!workflows || hydratedRef.current) return;
    hydratedRef.current = true;
    workflows.forEach((w) => {
      const stored = readStoredActiveRun(w.id);
      if (!stored) return;
      setRunByWorkflow((prev) => ({ ...prev, [w.id]: stored.runId }));
      setRunStatusById((prev) => ({ ...prev, [stored.runId]: prev[stored.runId] ?? 'RUNNING' }));
      API.get<RunSnapshot>(`/api/runs/${stored.runId}`)
        .then((data) => applyRunSnapshot(w.id, stored.runId, data))
        .catch(() => clearStoredActiveRun(w.id));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);

  // Backup polling: while any tracked run hasn't reached a terminal state,
  // periodically re-fetch its snapshot so the timeline stays correct even if
  // a run.* WS frame was missed (e.g. right after the WS reconnects because
  // this tab was remounted).
  const runByWorkflowRef = useRef(runByWorkflow);
  runByWorkflowRef.current = runByWorkflow;
  const runStatusByIdRef = useRef(runStatusById);
  runStatusByIdRef.current = runStatusById;
  useEffect(() => {
    const interval = setInterval(() => {
      Object.entries(runByWorkflowRef.current).forEach(([workflowId, runId]) => {
        const status = runStatusByIdRef.current[runId];
        if (status && TERMINAL_RUN_STATUSES.has(status)) return;
        API.get<RunSnapshot>(`/api/runs/${runId}`)
          .then((data) => applyRunSnapshot(workflowId, runId, data))
          .catch(() => {});
      });
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAwp(['run.*'], (frame) => {
    const topic = frame.topic ?? '';
    const payload = (frame.payload ?? {}) as { runId?: string; stepKey?: string; round?: number; type?: string; phase?: string; status?: string };
    const rid = payload.runId;
    if (!rid) return;
    if (topic === 'run.started') {
      setRunStatusById((prev) => ({ ...prev, [rid]: 'RUNNING' }));
    } else if (topic === 'run.step') {
      setRunStepsById((prev) => {
        const list = prev[rid] ? [...prev[rid]] : [];
        const idx = list.findIndex((s) => s.stepKey === payload.stepKey && s.round === payload.round);
        const next: RunStepLive = { stepKey: payload.stepKey ?? '', round: payload.round, type: payload.type, phase: payload.phase };
        if (idx >= 0) list[idx] = next;
        else list.push(next);
        return { ...prev, [rid]: list };
      });
    } else if (topic === 'run.finished') {
      const finalStatus = payload.status ?? 'SUCCEEDED';
      setRunStatusById((prev) => ({ ...prev, [rid]: finalStatus }));
      qc.invalidateQueries({ queryKey: ['agent-workflows', agent.id] });
      const entry = Object.entries(runByWorkflow).find(([, r]) => r === rid);
      if (entry) {
        // Pull the final snapshot so the timeline can show the actual step
        // OUTPUT (the run result), not just the status — WS frames carry no
        // output payload.
        API.get<RunSnapshot>(`/api/runs/${rid}`)
          .then((data) => applyRunSnapshot(entry[0], rid, data))
          .catch(() => {});
        if (TERMINAL_RUN_STATUSES.has(finalStatus)) clearStoredActiveRun(entry[0]);
      }
    }
  });

  function trackRun(workflowId: string, runId: string) {
    setRunByWorkflow((prev) => ({ ...prev, [workflowId]: runId }));
    setRunStatusById((prev) => ({ ...prev, [runId]: 'RUNNING' }));
    setRunStepsById((prev) => ({ ...prev, [runId]: [] }));
    writeStoredActiveRun(workflowId, runId);
  }

  const testMutation = useMutation({
    mutationFn: ({ workflowId, message }: { workflowId: string; message?: string }) =>
      API.post<{ runId: string }>(`/api/workflows/${workflowId}/test`, message ? { message } : {}),
    onSuccess: (data, vars) => trackRun(vars.workflowId, data.runId),
  });

  const runMutation = useMutation({
    mutationFn: (workflowId: string) => API.post<{ runId: string }>(`/api/workflows/${workflowId}/run`, {}),
    onSuccess: (data, workflowId) => trackRun(workflowId, data.runId),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ workflowId, enabled }: { workflowId: string; enabled: boolean }) => API.patch(`/api/workflows/${workflowId}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-workflows', agent.id] }),
  });

  function resetCreateForm() {
    setName('');
    setDescription('');
    setMode('manual');
    setCronPreset(CRON_PRESETS[2]!.value);
    setCustomCron('');
    setKeywordsText('');
    setSelectedFileIds([]);
    setPrompt('');
    setVerifyRubric('');
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const trigger: WorkflowTrigger =
        mode === 'schedule'
          ? { type: 'schedule', cron: (cronPreset === 'custom' ? customCron : cronPreset).trim() }
          : mode === 'keyword'
            ? { type: 'keyword', keywords: keywordsText.split(',').map((k) => k.trim()).filter(Boolean) }
            : { type: 'manual' };

      const created = await API.post<{ id: string }>(`/api/agents/${agent.id}/workflows`, { name, description, trigger });

      const chosenNames = agent.fileTargets
        .filter((t) => selectedFileIds.includes(t.cloudFileRefId))
        .map((t) => t.cloudFileRef?.name ?? t.cloudFileRefId);
      const fileNote = chosenNames.length ? `\n\n附掛檔案：${chosenNames.join('、')}` : '';
      const finalPrompt = (prompt.trim() || '請依照這位員工的角色設定，完成這個工作流的任務。') + fileNote;

      await API.put(`/api/workflows/${created.id}/steps`, {
        steps: [{ stepKey: 'main', type: 'DO', config: { prompt: finalPrompt }, verifyRubric: verifyRubric.trim() || null }],
      });
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-workflows', agent.id] });
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
      setCreating(false);
      resetCreateForm();
    },
  });

  function toggleFileSelection(cloudFileRefId: string) {
    setSelectedFileIds((prev) => (prev.includes(cloudFileRefId) ? prev.filter((id) => id !== cloudFileRefId) : [...prev, cloudFileRefId]));
  }

  const list = workflows ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" /> {creating ? '取消新增' : '新增工作流'}
        </button>
      </div>

      {creating && (
        <div className="card space-y-4 p-5">
          <Field label="名稱">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="描述">
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>

          <div>
            <span className="label mb-1.5 block">執行模式</span>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" checked={mode === 'schedule'} onChange={() => setMode('schedule')} /> 定期
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} /> 手動
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" checked={mode === 'keyword'} onChange={() => setMode('keyword')} /> 關鍵字觸發
              </label>
            </div>
          </div>

          {mode === 'schedule' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="排程頻率">
                <select className="input" value={cronPreset} onChange={(e) => setCronPreset(e.target.value)}>
                  {CRON_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              {cronPreset === 'custom' && (
                <Field label="自訂 Cron 表達式">
                  <input className="input font-mono" placeholder="0 9 * * *" value={customCron} onChange={(e) => setCustomCron(e.target.value)} />
                </Field>
              )}
            </div>
          )}

          {mode === 'keyword' && (
            <Field label="關鍵字（以逗號分隔）">
              <input
                className="input"
                placeholder="例如：發票, 對帳"
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
              />
            </Field>
          )}

          <div>
            <span className="label mb-1.5 block">附掛檔案（執行時會自動讀取這位員工的檔案目標）</span>
            {agent.fileTargets.length === 0 ? (
              <p className="text-sm text-muted">此員工尚未設定任何雲端檔案目標</p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {agent.fileTargets.map((t) => (
                  <label key={t.cloudFileRefId} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedFileIds.includes(t.cloudFileRefId)}
                      onChange={() => toggleFileSelection(t.cloudFileRefId)}
                    />
                    <span className="truncate">{t.cloudFileRef?.name ?? t.cloudFileRefId}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <Field label="這個工作流要做什麼">
            <textarea
              className="input min-h-[100px] resize-y"
              placeholder="例如：讀取指定資料夾中的發票 PDF，擷取品項與金額，彙整成一份應收帳款清單 Excel，欄位包含單號、對象、金額、到期日，完成後上傳到雲端的 AIOS 資料夾"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">
              這段指示會連同員工的角色設定與附掛檔案一起送出執行；描述「要做什麼、產出什麼、放到哪」，留白時會改用員工的角色設定預設任務。
            </p>
          </Field>
          <Field label="驗證標準（選填）">
            <textarea
              className="input min-h-[70px] resize-y"
              placeholder="例如：輸出必須包含結案摘要與金額"
              value={verifyRubric}
              onChange={(e) => setVerifyRubric(e.target.value)}
            />
          </Field>

          {createMutation.error instanceof Error && <p className="text-sm text-rose-400">{createMutation.error.message}</p>}
          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => {
                setCreating(false);
                resetCreateForm();
              }}
            >
              取消
            </button>
            <button className="btn-primary" disabled={!name || createMutation.isPending} onClick={() => createMutation.mutate()}>
              {createMutation.isPending && <Spinner className="border-white/40 border-t-white" />} 建立
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center py-8">
          <Spinner className="h-5 w-5" />
        </div>
      )}

      {!isLoading && list.length === 0 && <EmptyState title="尚未建立工作流" />}

      {!isLoading && list.length > 0 && (
        <div className="space-y-3">
          {list.map((w) => {
            const runId = runByWorkflow[w.id];
            return (
              <WorkflowCard
                key={w.id}
                w={w}
                runId={runId}
                runStatus={runId ? runStatusById[runId] : undefined}
                runSteps={runId ? runStepsById[runId] ?? [] : []}
                onTest={(message) => testMutation.mutate({ workflowId: w.id, message })}
                onRun={() => runMutation.mutate(w.id)}
                onToggleEnabled={() => toggleMutation.mutate({ workflowId: w.id, enabled: !w.enabled })}
                toggling={toggleMutation.isPending}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- 執行紀錄 Runs ----------

/** Translate a triggeredBy source string (e.g. "chat:abc") into zh-Hant. */
function triggeredByZh(raw?: string | null): string {
  if (!raw) return '—';
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
        <EmptyState title="尚無執行紀錄" hint="可在「工作流」分頁按「測試」立即產生一筆。" />
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

// ---------- 訓練 Training（聊天式技能工廠） ----------

interface TrainMessageResult {
  skillId: string;
  contentMd: string;
  reviewStatus: string;
  understanding: SkillUnderstanding | null;
}

interface AgentFlows {
  skills: Array<{ id: string; name: string; summary: string; reviewStatus: string }>;
  workflows: Array<{ id: string; name: string; trigger: string }>;
}

interface RecordingStatus {
  recording?: boolean;
  isRecording?: boolean;
  active?: boolean;
  status?: string;
  [key: string]: unknown;
}

type ChatMsg =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'system'; text: string }
  | { id: string; kind: 'drafting' }
  | {
      id: string;
      kind: 'draft';
      skillId: string;
      name: string;
      reviewStatus: string;
      understanding: SkillUnderstanding | null;
      statusNote?: string;
    }
  | {
      id: string;
      kind: 'flows';
      skills: AgentFlows['skills'];
      workflows: AgentFlows['workflows'];
    }
  | { id: string; kind: 'error'; text: string };

function normalizeUnderstanding(raw: unknown): SkillUnderstanding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    capabilities: arr(o.capabilities),
    data_read: arr(o.data_read),
    data_written: arr(o.data_written),
    external_calls: arr(o.external_calls),
    irreversible_actions: arr(o.irreversible_actions),
    risks: arr(o.risks),
  };
}

function parseSkillNameFromMd(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?^name:\s*["']?(.+?)["']?\s*$/m);
  return m?.[1]?.trim() || '技能草稿';
}

function isRecordingActive(s: RecordingStatus | undefined): boolean {
  if (!s) return false;
  if (s.recording === true || s.isRecording === true || s.active === true) return true;
  if (typeof s.status === 'string' && /record|active|running/i.test(s.status)) return true;
  return false;
}

function VoiceInput({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      mediaRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    setError(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('此瀏覽器不支援麥克風錄音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) {
          setError('沒有錄到音訊');
          setBusy(false);
          setRecording(false);
          return;
        }
        setBusy(true);
        try {
          const form = new FormData();
          const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
          form.append('file', blob, `voice.${ext}`);
          const res = await API.upload<{ text: string }>('/api/voice/transcribe', form);
          const text = (res.text ?? '').trim();
          if (!text) setError('轉錄結果為空');
          else onTranscript(text);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
          setRecording(false);
        }
      };
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法開啟麥克風');
    }
  }

  function stop() {
    const rec = mediaRef.current;
    if (rec && rec.state !== 'inactive') {
      setBusy(true);
      rec.stop();
    }
    mediaRef.current = null;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={cn(
          'btn-ghost h-9 w-9 shrink-0 p-0',
          recording && 'bg-rose-500/15 text-rose-400',
        )}
        title={recording ? '停止錄音並轉錄' : '語音輸入（音訊會送往 OpenAI 轉錄）'}
        disabled={disabled || busy}
        onClick={() => (recording ? stop() : void start())}
      >
        {busy ? (
          <Spinner className="h-4 w-4" />
        ) : recording ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>
      <p className="max-w-[10rem] text-right text-[10px] leading-tight text-muted">
        音訊會送往 OpenAI 轉錄
      </p>
      {error && <p className="max-w-[12rem] text-right text-[10px] text-rose-400">{error}</p>}
    </div>
  );
}

function TrainingTab({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: 'welcome',
      kind: 'system',
      text: '用聊天描述要教這位員工的流程，或按「有哪些流程？」查看現況。也可開始錄製桌面操作。',
    },
  ]);
  const [draftSkillId, setDraftSkillId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [proposingId, setProposingId] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // Recording state: poll status ≥3s while active or after start.
  const [recordingWanted, setRecordingWanted] = useState(false);
  const [recBusy, setRecBusy] = useState(false);

  const recStatusQ = useQuery({
    queryKey: ['recording-status'],
    queryFn: () => API.get<RecordingStatus>('/api/recording/status'),
    refetchInterval: (q) => {
      const active = recordingWanted || isRecordingActive(q.state.data);
      return active ? 3000 : false;
    },
    retry: false,
  });
  const recordingOn = recordingWanted || isRecordingActive(recStatusQ.data);

  useAwp(['skill.review_ready'], (frame) => {
    const payload = (frame.payload ?? {}) as { skillId?: string };
    if (payload.skillId) {
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
      qc.invalidateQueries({ queryKey: ['building-skill', payload.skillId] });
    }
  });

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  function pushMsg(msg: ChatMsg) {
    setMessages((prev) => [...prev, msg]);
  }

  function isFlowsIntent(text: string): boolean {
    const t = text.trim();
    return /有哪些流程|目前有哪些流程|流程清單|list\s*flows/i.test(t);
  }

  async function loadFlows() {
    setSending(true);
    setActionError(null);
    pushMsg({ id: crypto.randomUUID(), kind: 'user', text: '有哪些流程？' });
    try {
      const flows = await API.get<AgentFlows>(`/api/agents/${agent.id}/flows`);
      pushMsg({
        id: crypto.randomUUID(),
        kind: 'flows',
        skills: flows.skills ?? [],
        workflows: flows.workflows ?? [],
      });
    } catch (e) {
      pushMsg({
        id: crypto.randomUUID(),
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSending(false);
    }
  }

  async function sendTrainMessage(raw: string) {
    const message = raw.trim();
    if (!message || sending) return;
    if (isFlowsIntent(message)) {
      setInput('');
      await loadFlows();
      return;
    }

    setSending(true);
    setActionError(null);
    setInput('');
    pushMsg({ id: crypto.randomUUID(), kind: 'user', text: message });
    const draftingId = crypto.randomUUID();
    pushMsg({ id: draftingId, kind: 'drafting' });

    try {
      const result = await API.post<TrainMessageResult>(`/api/agents/${agent.id}/train/message`, {
        message,
        skillId: draftSkillId ?? undefined,
      });
      const understanding = normalizeUnderstanding(result.understanding);
      let name = parseSkillNameFromMd(result.contentMd ?? '');
      try {
        const detail = await API.get<SkillDetail>(`/api/skills/${result.skillId}`);
        if (detail.name) name = detail.name;
      } catch {
        /* name from md is fine */
      }
      setDraftSkillId(result.skillId);
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== draftingId)
          .concat({
            id: crypto.randomUUID(),
            kind: 'draft',
            skillId: result.skillId,
            name,
            reviewStatus: result.reviewStatus,
            understanding,
          }),
      );
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
    } catch (e) {
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== draftingId)
          .concat({
            id: crypto.randomUUID(),
            kind: 'error',
            text: e instanceof Error ? e.message : String(e),
          }),
      );
    } finally {
      setSending(false);
    }
  }

  async function confirmSkill(skillId: string) {
    setConfirmingId(skillId);
    setActionError(null);
    try {
      await API.post(`/api/skills/${skillId}/confirm`);
      // Oral/recording training already links the skill; mount is best-effort if not linked.
      try {
        await API.post(`/api/agents/${agent.id}/skills`, { skillId });
      } catch (e) {
        // Already linked or not CONFIRMED-path only — ignore conflict-like failures.
        if (!(e instanceof ApiError)) throw e;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === 'draft' && m.skillId === skillId
            ? { ...m, reviewStatus: 'CONFIRMED', statusNote: '已確認並掛載' }
            : m,
        ),
      );
      setDraftSkillId(null);
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirmingId(null);
    }
  }

  async function proposeSkill(skillId: string, name: string) {
    setProposingId(skillId);
    setActionError(null);
    try {
      await API.post(`/api/agents/${agent.id}/proposals`, {
        targetType: 'SKILL',
        targetId: skillId,
        proposedChange: {
          action: 'confirm_skill',
          skillId,
          name,
          note: '操作者從訓練頁送出：請 FDE 確認並掛載此技能草稿',
        },
        severity: 'medium',
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === 'draft' && m.skillId === skillId
            ? { ...m, statusNote: '已送出提案，等待 FDE 審核' }
            : m,
        ),
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposingId(null);
    }
  }

  async function startRecording() {
    setRecBusy(true);
    setActionError(null);
    try {
      await API.post('/api/recording/start');
      setRecordingWanted(true);
      pushMsg({
        id: crypto.randomUUID(),
        kind: 'system',
        text: '已開始錄製。請在桌面完成一次操作後按「結束錄製」。單次上限 30 分鐘。',
      });
      void recStatusQ.refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecBusy(false);
    }
  }

  async function stopRecordingAndImport() {
    setRecBusy(true);
    setActionError(null);
    try {
      await API.post('/api/recording/stop');
      setRecordingWanted(false);
      pushMsg({ id: crypto.randomUUID(), kind: 'system', text: '錄製已停止，正在匯入為技能草稿…' });
      const draftingId = crypto.randomUUID();
      pushMsg({ id: draftingId, kind: 'drafting' });
      const result = await API.post<{
        skillId?: string;
        id?: string;
        name?: string;
        reviewStatus?: string;
        understanding?: unknown;
        contentMd?: string;
      }>(`/api/agents/${agent.id}/recording/to-skill`, {});
      const skillId = result.skillId ?? result.id;
      if (!skillId) throw new Error('recording/to-skill 未回傳 skillId');
      let name = result.name ?? parseSkillNameFromMd(result.contentMd ?? '');
      let understanding = normalizeUnderstanding(result.understanding);
      let reviewStatus = result.reviewStatus ?? 'AWAITING_USER_CONFIRM';
      try {
        const detail = await API.get<SkillDetail>(`/api/skills/${skillId}`);
        name = detail.name || name;
        understanding = detail.understanding ?? understanding;
        reviewStatus = detail.reviewStatus || reviewStatus;
      } catch {
        /* use payload */
      }
      setDraftSkillId(skillId);
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== draftingId)
          .concat({
            id: crypto.randomUUID(),
            kind: 'draft',
            skillId,
            name: name || '錄製技能草稿',
            reviewStatus,
            understanding,
          }),
      );
      qc.invalidateQueries({ queryKey: ['agent', agent.id] });
      void recStatusQ.refetch();
    } catch (e) {
      setRecordingWanted(false);
      pushMsg({
        id: crypto.randomUUID(),
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRecBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {/* Recording bar */}
      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">桌面操作錄製</div>
          <div className="flex items-center gap-2">
            {!recordingOn ? (
              <button
                type="button"
                className="btn-primary"
                disabled={recBusy || sending}
                onClick={() => void startRecording()}
              >
                {recBusy ? <Spinner className="border-white/40 border-t-white" /> : <Circle className="h-3.5 w-3.5 fill-rose-500 text-rose-500" />}
                開始錄製
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary bg-rose-600 hover:bg-rose-500"
                disabled={recBusy}
                onClick={() => void stopRecordingAndImport()}
              >
                {recBusy ? <Spinner className="border-white/40 border-t-white" /> : <Square className="h-3.5 w-3.5" />}
                結束錄製
              </button>
            )}
          </div>
        </div>
        {recordingOn && (
          <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
            </span>
            🔴 正在錄製中 — 單次上限 30 分鐘
          </div>
        )}
        <p className="text-xs text-muted">
          錄製完成後會委派 Codex 匯入為技能草稿，再走理解閘與確認流程（不會自動掛載）。
        </p>
      </div>

      {/* Chat transcript */}
      <div className="card flex max-h-[min(60vh,560px)] min-h-[320px] flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <GraduationCap className="h-4 w-4 text-brand" /> 聊天式技能工廠
          </div>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={sending}
            onClick={() => void loadFlows()}
          >
            <List className="h-3.5 w-3.5" /> 有哪些流程？
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m) => {
            if (m.kind === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand/20 px-3 py-2 text-sm">
                    {m.text}
                  </div>
                </div>
              );
            }
            if (m.kind === 'system') {
              return (
                <div key={m.id} className="text-center text-xs text-muted">
                  {m.text}
                </div>
              );
            }
            if (m.kind === 'drafting') {
              return (
                <div key={m.id} className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="h-4 w-4" /> 草擬中…
                </div>
              );
            }
            if (m.kind === 'error') {
              return (
                <div key={m.id} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                  {m.text}
                </div>
              );
            }
            if (m.kind === 'flows') {
              return (
                <div key={m.id} className="card space-y-3 border-border/80 bg-black/10 p-4">
                  <div className="text-sm font-medium">目前流程清單（免 LLM）</div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted">技能</div>
                    {m.skills.length === 0 ? (
                      <p className="text-sm text-muted">尚無掛載技能</p>
                    ) : (
                      <ul className="space-y-2">
                        {m.skills.map((s) => (
                          <li key={s.id} className="flex items-start justify-between gap-2 text-sm">
                            <div className="min-w-0">
                              <div className="font-medium">{s.name}</div>
                              {s.summary && <div className="text-xs text-muted">{s.summary}</div>}
                            </div>
                            <StatusBadge status={s.reviewStatus} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted">工作流</div>
                    {m.workflows.length === 0 ? (
                      <p className="text-sm text-muted">尚無工作流</p>
                    ) : (
                      <ul className="space-y-2">
                        {m.workflows.map((w) => (
                          <li key={w.id} className="flex items-center justify-between gap-2 text-sm">
                            <span className="font-medium">{w.name}</span>
                            <span className="badge bg-black/10 text-muted dark:bg-white/10">{w.trigger}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              );
            }
            // draft card
            const u = m.understanding;
            return (
              <div key={m.id} className="card space-y-3 border-brand/20 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">{m.name}</h3>
                  <StatusBadge status={m.reviewStatus} />
                </div>
                {u?.summary && <p className="text-sm">{u.summary}</p>}
                {u && (
                  <>
                    <UnderstandingList title="能力" items={u.capabilities} />
                    <UnderstandingList title="讀取資料" items={u.data_read} />
                    <UnderstandingList title="寫入/修改資料" items={u.data_written} />
                    <UnderstandingList title="外部呼叫" items={u.external_calls} />
                    {u.irreversible_actions.length > 0 && (
                      <UnderstandingList
                        title="不可逆動作"
                        items={u.irreversible_actions}
                        icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-400" />}
                      />
                    )}
                    {u.risks.length > 0 && (
                      <UnderstandingList
                        title="風險"
                        items={u.risks}
                        icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                      />
                    )}
                  </>
                )}
                {m.statusNote && <p className="text-sm text-emerald-400">{m.statusNote}</p>}
                {m.reviewStatus !== 'CONFIRMED' && !m.statusNote?.includes('提案') && (
                  <div className="flex justify-end gap-2 pt-1">
                    {isFde ? (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={confirmingId === m.skillId}
                        onClick={() => void confirmSkill(m.skillId)}
                      >
                        {confirmingId === m.skillId && (
                          <Spinner className="border-white/40 border-t-white" />
                        )}
                        ✅ 確認掛載
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={proposingId === m.skillId}
                        onClick={() => void proposeSkill(m.skillId, m.name)}
                      >
                        {proposingId === m.skillId && (
                          <Spinner className="border-white/40 border-t-white" />
                        )}
                        送出提案
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={listEndRef} />
        </div>

        {/* Composer */}
        <div className="border-t border-border px-3 py-3">
          {actionError && <p className="mb-2 text-sm text-rose-400">{actionError}</p>}
          <div className="flex items-end gap-2">
            <textarea
              className="input min-h-[44px] max-h-32 flex-1 resize-y"
              placeholder="描述要教的流程，或問「有哪些流程？」…"
              value={input}
              rows={2}
              disabled={sending}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendTrainMessage(input);
                }
              }}
            />
            <VoiceInput
              disabled={sending}
              onTranscript={(text) => {
                setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
              }}
            />
            <button
              type="button"
              className="btn-primary h-9 shrink-0"
              disabled={!input.trim() || sending}
              onClick={() => void sendTrainMessage(input)}
            >
              {sending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="h-4 w-4" />}
              送出
            </button>
          </div>
        </div>
      </div>

      {/* Mounted skills summary (kept for orientation) */}
      <div className="card space-y-3 p-5">
        <div className="text-sm font-medium">已掛載的技能</div>
        {agent.skills.length === 0 ? (
          <p className="text-sm text-muted">尚未掛載任何技能</p>
        ) : (
          <div className="divide-y divide-border">
            {agent.skills.map((s) => (
              <div key={s.skillId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-3">
                  <Wrench className="h-4 w-4 text-muted" />
                  <span className="text-sm font-medium">{s.skill?.name ?? s.skillId}</span>
                </div>
                <div className="flex items-center gap-2">
                  {s.skill?.executionEnv && (
                    <span className="badge bg-black/10 text-muted dark:bg-white/10">{s.skill.executionEnv}</span>
                  )}
                  <StatusBadge status={s.skill?.reviewStatus ?? 'UNKNOWN'} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UnderstandingList({ title, items, icon }: { title: string; items: string[]; icon?: React.ReactNode }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted">{title}</div>
      <ul className="space-y-1">
        {items.map((item, idx) => (
          <li key={idx} className="flex items-start gap-1.5 text-sm">
            {icon ?? <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted" />}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 記憶 Memory (L1 wiki + L3 semantic search) ----------

interface MemoryFileEntry {
  path: string;
  size: number;
  mtime: string;
}
interface MemorySearchHit {
  text: string;
  path: string;
  score: number;
  sourceType?: string;
}

function MemoryTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const { data: filesData, isLoading: filesLoading } = useQuery({
    queryKey: ['memory-files', agentId],
    queryFn: () => API.get<{ files: MemoryFileEntry[] }>(`/api/agents/${agentId}/memory/files`),
  });
  const files = filesData?.files ?? [];

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

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await API.post<{ query: string; hits: MemorySearchHit[] }>(
        `/api/agents/${agentId}/memory/search`,
        { query: q, topK: 6 },
      );
      setHits(res.hits);
    } catch (e) {
      setHits(null);
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <BookOpen className="h-4 w-4 text-brand" /> Wiki 檔案
          </div>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5 text-sm"
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
        <p className="text-xs text-muted">
          L1 真相來源：MyAgent/…/memory/wiki/。此頁唯讀；執行引擎可寫入 facts.md / log.md。語意索引（Qdrant）可重建。
        </p>
        {reindexMutation.isSuccess && (
          <p className="text-xs text-muted">
            索引完成：indexed={reindexMutation.data.indexed}，skipped={reindexMutation.data.skipped}，failed=
            {reindexMutation.data.failed}
            {reindexMutation.data.failed > 0 && '（若無 OPENROUTER_API_KEY，failed 屬預期）'}
          </p>
        )}
        {reindexMutation.error instanceof Error && (
          <p className="text-sm text-rose-400">{reindexMutation.error.message}</p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-h-[220px] rounded-lg border border-border">
            {filesLoading && (
              <div className="flex justify-center py-10">
                <Spinner className="h-5 w-5" />
              </div>
            )}
            {!filesLoading && files.length === 0 && (
              <EmptyState title="尚無 wiki 檔案" hint="執行一次 run 或重新 materialize 後會建立骨架。" />
            )}
            {!filesLoading && files.length > 0 && (
              <ul className="divide-y divide-border">
                {files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => setSelectedPath(f.path)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40',
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
          </div>

          <div className="min-h-[220px] rounded-lg border border-border p-3">
            {!selectedPath && <p className="py-8 text-center text-sm text-muted">點選左側檔案檢視內容（唯讀）</p>}
            {selectedPath && fileLoading && (
              <div className="flex justify-center py-10">
                <Spinner className="h-5 w-5" />
              </div>
            )}
            {selectedPath && !fileLoading && fileData && (
              <>
                <div className="mb-2 font-mono text-xs text-muted">{fileData.path}</div>
                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs leading-relaxed">
                  {fileData.content}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card space-y-3 p-5">
        <div className="flex items-center gap-2 font-medium">
          <Search className="h-4 w-4 text-brand" /> 語意搜尋
        </div>
        <p className="text-xs text-muted">
          POST /memory/search — 需要 OPENROUTER_API_KEY 與 Qdrant 中的向量。無金鑰時 hits 為空屬正常。
        </p>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="例如：報價單幣別、上次約定…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          />
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={searching || !query.trim()}
            onClick={() => void runSearch()}
          >
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            搜尋
          </button>
        </div>
        {searchError && <p className="text-sm text-rose-400">{searchError}</p>}
        {hits && hits.length === 0 && (
          <p className="text-sm text-muted">沒有命中片段（可能尚未索引，或缺少 embedding 金鑰）。</p>
        )}
        {hits && hits.length > 0 && (
          <ul className="space-y-3">
            {hits.map((h, i) => (
              <li key={`${h.path}-${i}`} className="rounded-lg border border-border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-mono text-fg">{h.path}</span>
                  <span>score {typeof h.score === 'number' ? h.score.toFixed(3) : h.score}</span>
                  {h.sourceType && <StatusBadge status={h.sourceType} />}
                </div>
                <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{h.text}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>
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
