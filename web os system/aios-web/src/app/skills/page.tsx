'use client';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Upload,
  Sparkles,
  FileText,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Eye,
  Database,
  PenLine,
  PhoneCall,
  AlertTriangle,
  Wrench,
} from 'lucide-react';
import { API } from '@/lib/api';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Field, PageHeader, Spinner, StatusBadge } from '@/components/ui';

// ---------- types ----------

type SkillOrigin = 'UPLOADED' | 'BUILTIN' | 'CLI_GENERATED';
type ExecutionEnv = 'CLI' | 'DESKTOP_APP' | 'DIRECT';

interface Skill {
  id: string;
  name: string;
  origin: SkillOrigin;
  kind: string;
  reviewStatus: string;
  version: number | string;
  executionEnv?: ExecutionEnv | string;
}

interface Understanding {
  summary?: string;
  capabilities?: string[];
  data_read?: string[];
  data_written?: string[];
  external_calls?: string[];
  irreversible_actions?: string[];
  risks?: string[];
}

interface SkillDetail extends Skill {
  contentMd?: string;
  understanding?: Understanding;
}

const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  UPLOADED: '上傳',
  BUILTIN: '內建',
  CLI_GENERATED: 'CLI 生成',
};
const ORIGIN_COLOR: Record<SkillOrigin, string> = {
  UPLOADED: 'bg-blue-500/15 text-blue-400',
  BUILTIN: 'bg-zinc-500/15 text-zinc-400',
  CLI_GENERATED: 'bg-violet-500/15 text-violet-400',
};

const EXECUTION_ENVS: { value: ExecutionEnv; label: string }[] = [
  { value: 'CLI', label: 'CLI（透過 Claude/Codex CLI 執行）' },
  { value: 'DESKTOP_APP', label: '桌面版 App（電腦操控/錄放）' },
  { value: 'DIRECT', label: '直接執行技能' },
];
const EXECUTION_ENV_LABEL: Record<string, string> = {
  CLI: 'CLI',
  DESKTOP_APP: '桌面版 App',
  DIRECT: '直接執行',
};
const EXECUTION_ENV_COLOR: Record<string, string> = {
  CLI: 'bg-sky-500/15 text-sky-400',
  DESKTOP_APP: 'bg-orange-500/15 text-orange-400',
  DIRECT: 'bg-emerald-500/15 text-emerald-400',
};
const EXECUTION_ENV_NOTE =
  '錄製/回放（電腦操控）技能只能用桌面版 App 執行，Codex CLI 不支援 Computer Use。';

// ---------- page ----------

export default function SkillsPage() {
  const qc = useQueryClient();

  const { data: skills, isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: () => API.get<Skill[]>('/api/skills'),
  });

  useAwp(['skill.review_ready'], () => {
    qc.invalidateQueries({ queryKey: ['skills'] });
  });

  const pending = (skills ?? []).filter((s) => s.reviewStatus === 'AWAITING_USER_CONFIRM');

  return (
    <AppShell>
      <PageHeader title="技能 Skills" subtitle="上傳、建立與複核代理可使用的技能" />

      {pending.length > 0 && (
        <section className="mb-8 space-y-4">
          <div className="flex items-center gap-2 text-amber-400">
            <ShieldAlert className="h-4 w-4" />
            <h2 className="text-sm font-semibold">待你複核 · Double-check ({pending.length})</h2>
          </div>
          <p className="-mt-2 text-sm text-muted">
            系統已閱讀並理解以下技能的內容，請仔細確認它會做什麼、讀寫哪些資料、是否有不可逆操作，再決定是否啟用。
          </p>
          <div className="space-y-4">
            {pending.map((s) => (
              <ReviewCard key={s.id} skillId={s.id} name={s.name} />
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">所有技能 ({skills?.length ?? 0})</h2>
            </div>
            {isLoading ? (
              <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>
            ) : !skills || skills.length === 0 ? (
              <EmptyState title="尚無技能" hint="從右側上傳、建立或貼上 SKILL.md 來新增第一個技能" />
            ) : (
              <div className="divide-y divide-border">
                {skills.map((s) => (
                  <SkillRow key={s.id} skill={s} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <UploadPanel />
          <BuildPanel />
          <PastePanel />
        </div>
      </div>
    </AppShell>
  );
}

// ---------- skill row ----------

function SkillRow({ skill }: { skill: Skill }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="truncate text-sm font-medium">{skill.name}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
          <span>{skill.kind}</span>
          <span>·</span>
          <span>v{skill.version}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={cn('badge', ORIGIN_COLOR[skill.origin] ?? 'bg-black/10 dark:bg-white/10 text-muted')}>
          {ORIGIN_LABEL[skill.origin] ?? skill.origin}
        </span>
        {skill.executionEnv && (
          <span className={cn('badge', EXECUTION_ENV_COLOR[skill.executionEnv] ?? 'bg-black/10 dark:bg-white/10 text-muted')}>
            {EXECUTION_ENV_LABEL[skill.executionEnv] ?? skill.executionEnv}
          </span>
        )}
        <StatusBadge status={skill.reviewStatus} />
      </div>
    </div>
  );
}

// ---------- review card ----------

function ReviewCard({ skillId, name }: { skillId: string; name: string }) {
  const qc = useQueryClient();

  const { data: detail, isLoading } = useQuery({
    queryKey: ['skill', skillId],
    queryFn: () => API.get<SkillDetail>(`/api/skills/${skillId}`),
  });

  const confirmMut = useMutation({
    mutationFn: () => API.post(`/api/skills/${skillId}/confirm`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skillId] });
    },
  });
  const rejectMut = useMutation({
    mutationFn: () => API.post(`/api/skills/${skillId}/reject`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skillId] });
    },
  });

  const u = detail?.understanding;
  const busy = confirmMut.isPending || rejectMut.isPending;

  return (
    <div className="card border-amber-500/30 bg-amber-500/[0.04] p-5">
      <div className="mb-3 flex items-center gap-2">
        <Eye className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold">{name}</h3>
        <StatusBadge status="AWAITING_USER_CONFIRM" />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>
      ) : !u ? (
        <p className="text-sm text-muted">系統尚未產生理解說明。</p>
      ) : (
        <div className="space-y-4">
          {u.summary && (
            <div>
              <div className="label mb-1">系統理解摘要</div>
              <p className="text-sm leading-relaxed">{u.summary}</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UnderstandingList icon={ShieldCheck} label="具備能力" items={u.capabilities} tone="neutral" />
            <UnderstandingList icon={Database} label="讀取資料" items={u.data_read} tone="neutral" />
            <UnderstandingList icon={PenLine} label="寫入資料" items={u.data_written} tone="neutral" />
            <UnderstandingList icon={PhoneCall} label="外部呼叫" items={u.external_calls} tone="neutral" />
            <UnderstandingList icon={AlertTriangle} label="不可逆操作" items={u.irreversible_actions} tone="danger" />
            <UnderstandingList icon={ShieldAlert} label="風險" items={u.risks} tone="warning" />
          </div>
        </div>
      )}

      {(confirmMut.isError || rejectMut.isError) && (
        <p className="mt-3 text-sm text-rose-400">
          {(confirmMut.error as Error)?.message || (rejectMut.error as Error)?.message}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          className="btn-primary"
          disabled={busy || isLoading}
          onClick={() => confirmMut.mutate()}
        >
          {confirmMut.isPending ? <Spinner className="border-white/40 border-t-white" /> : <CheckCircle2 className="h-4 w-4" />}
          確認 · 我已閱讀並了解
        </button>
        <button
          className="btn-ghost text-rose-400"
          disabled={busy || isLoading}
          onClick={() => rejectMut.mutate()}
        >
          {rejectMut.isPending ? <Spinner /> : <XCircle className="h-4 w-4" />}
          拒絕
        </button>
      </div>
    </div>
  );
}

function UnderstandingList({
  icon: Icon,
  label,
  items,
  tone,
}: {
  icon: typeof ShieldCheck;
  label: string;
  items?: string[];
  tone: 'neutral' | 'warning' | 'danger';
}) {
  const toneClass =
    tone === 'danger' ? 'text-rose-400' : tone === 'warning' ? 'text-amber-400' : 'text-muted';
  return (
    <div className="rounded-lg border border-border bg-panel/60 p-3">
      <div className={cn('mb-1.5 flex items-center gap-1.5 text-xs font-medium', toneClass)}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      {!items || items.length === 0 ? (
        <p className="text-xs text-muted">—</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((it, i) => (
            <li key={i} className="text-xs leading-relaxed text-fg/90">
              {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- upload panel ----------

function UploadPanel() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [executionEnv, setExecutionEnv] = useState<ExecutionEnv>('CLI');

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('executionEnv', executionEnv);
      return API.upload('/api/skills/upload', fd);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setFileName('');
      if (inputRef.current) inputRef.current.value = '';
    },
  });

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Upload className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold">上傳技能</h3>
      </div>
      <p className="mb-3 text-xs text-muted">上傳 SKILL.md 或技能檔案，系統會自動分析並產生理解說明供你複核。</p>
      <div className="mb-3 space-y-1">
        <Field label="執行環境 Execution Env">
          <select className="input" value={executionEnv} onChange={(e) => setExecutionEnv(e.target.value as ExecutionEnv)}>
            {EXECUTION_ENVS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-[11px] text-muted">{EXECUTION_ENV_NOTE}</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand/10 file:px-3 file:py-2 file:text-xs file:font-medium file:text-brand hover:file:bg-brand/20"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setFileName(f.name);
            uploadMut.mutate(f);
          }
        }}
      />
      {uploadMut.isPending && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" /> 上傳中 {fileName}…
        </div>
      )}
      {uploadMut.isError && <p className="mt-2 text-xs text-rose-400">{(uploadMut.error as Error).message}</p>}
      {uploadMut.isSuccess && <p className="mt-2 text-xs text-emerald-400">上傳成功，已加入待複核列表。</p>}
    </div>
  );
}

// ---------- build panel ----------

function BuildPanel() {
  const qc = useQueryClient();
  const [requirement, setRequirement] = useState('');
  const [engine, setEngine] = useState('codex');
  const [executionEnv, setExecutionEnv] = useState<ExecutionEnv>('CLI');

  const buildMut = useMutation({
    mutationFn: () => API.post('/api/skills/build', { requirement, engine, executionEnv }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setRequirement('');
    },
  });

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold">建立技能 (Codex / Claude Code)</h3>
      </div>
      <div className="space-y-3">
        <Field label="需求描述">
          <textarea
            className="input min-h-[80px] resize-none"
            placeholder="描述這個技能需要做什麼…"
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
          />
        </Field>
        <Field label="生成引擎">
          <select className="input" value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="codex">Codex</option>
            <option value="claude_code">Claude Code</option>
            <option value="GROK">GROK（最快）</option>
          </select>
        </Field>
        <div className="space-y-1">
          <Field label="執行環境 Execution Env">
            <select className="input" value={executionEnv} onChange={(e) => setExecutionEnv(e.target.value as ExecutionEnv)}>
              {EXECUTION_ENVS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11px] text-muted">{EXECUTION_ENV_NOTE}</p>
        </div>
        {buildMut.isError && <p className="text-xs text-rose-400">{(buildMut.error as Error).message}</p>}
        {buildMut.isSuccess && <p className="text-xs text-emerald-400">已送出生成請求，完成後會出現在待複核列表。</p>}
        <button
          className="btn-primary w-full justify-center"
          disabled={buildMut.isPending || !requirement.trim()}
          onClick={() => buildMut.mutate()}
        >
          {buildMut.isPending && <Spinner className="border-white/40 border-t-white" />}
          產生技能
        </button>
      </div>
    </div>
  );
}

// ---------- paste SKILL.md panel ----------

function PastePanel() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [contentMd, setContentMd] = useState('');
  const [executionEnv, setExecutionEnv] = useState<ExecutionEnv>('CLI');

  const createMut = useMutation({
    mutationFn: () => API.post('/api/skills', { name, kind, contentMd, executionEnv }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setName('');
      setKind('');
      setContentMd('');
    },
  });

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <FileText className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold">貼上 SKILL.md</h3>
      </div>
      <div className="space-y-3">
        <Field label="名稱">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="技能名稱" />
        </Field>
        <Field label="類型">
          <input
            className="input"
            list="skill-kind-options"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            placeholder="例如 SOP / TOOL / PLAYBOOK"
          />
          <datalist id="skill-kind-options">
            <option value="SOP" />
            <option value="TOOL" />
            <option value="PLAYBOOK" />
            <option value="PROMPT" />
          </datalist>
        </Field>
        <Field label="SKILL.md 內容">
          <textarea
            className="input min-h-[120px] resize-none font-mono text-xs"
            value={contentMd}
            onChange={(e) => setContentMd(e.target.value)}
            placeholder={'# 技能名稱\n\n說明這個技能的用途與使用方式…'}
          />
        </Field>
        <div className="space-y-1">
          <Field label="執行環境 Execution Env">
            <select className="input" value={executionEnv} onChange={(e) => setExecutionEnv(e.target.value as ExecutionEnv)}>
              {EXECUTION_ENVS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11px] text-muted">{EXECUTION_ENV_NOTE}</p>
        </div>
        {createMut.isError && <p className="text-xs text-rose-400">{(createMut.error as Error).message}</p>}
        {createMut.isSuccess && <p className="text-xs text-emerald-400">已新增，等待系統分析後即可複核。</p>}
        <button
          className="btn-primary w-full justify-center"
          disabled={createMut.isPending || !name.trim() || !kind.trim() || !contentMd.trim()}
          onClick={() => createMut.mutate()}
        >
          {createMut.isPending && <Spinner className="border-white/40 border-t-white" />}
          建立技能
        </button>
      </div>
    </div>
  );
}
