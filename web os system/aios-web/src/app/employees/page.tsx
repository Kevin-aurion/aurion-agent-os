'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Building2, Plus, Wrench, Workflow, X } from 'lucide-react';
import { API } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Field, PageHeader, Spinner, StatusBadge } from '@/components/ui';

interface AgentListItem {
  id: string;
  name: string;
  description: string;
  department?: string | null;
  avatar?: string | null;
  status: string;
  skillCount: number;
  workflowCount: number;
}

const ENGINES = ['CLAUDE_CODE', 'CODEX', 'GROK'] as const;
const ENGINE_LABELS: Record<(typeof ENGINES)[number], string> = {
  CLAUDE_CODE: 'CLAUDE_CODE',
  CODEX: 'CODEX',
  GROK: 'GROK（最快）',
};
const ENGINE_VERIFY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '自動（跨模型）' },
  { value: 'CLAUDE_CODE', label: 'CLAUDE_CODE' },
  { value: 'CODEX', label: 'CODEX' },
  { value: 'GROK', label: 'GROK（最快）' },
];

export default function EmployeesPage() {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => API.get<AgentListItem[]>('/api/agents?scope=all'),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      description: string;
      rolePrompt: string;
      engineExecute: string;
      engineVerify?: string | null;
      maxRounds: number;
      avatar?: string;
      department?: string;
    }) => API.post<{ id: string }>('/api/agents', body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      setCreating(false);
      router.push(`/employees/${data.id}`);
    },
  });

  return (
    <AppShell>
      <PageHeader
        title="員工 Agents"
        subtitle="管理 AI 員工的技能、雲端檔案與工作流"
        action={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 建立員工
          </button>
        }
      />

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      )}

      {!isLoading && (!agents || agents.length === 0) && (
        <EmptyState title="尚未建立任何員工" hint="點選右上角「建立員工」以新增第一位 AI 員工" />
      )}

      {!isLoading && agents && agents.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Link
              key={a.id}
              href={`/employees/${a.id}`}
              className="card flex flex-col gap-3 p-5 transition-colors hover:border-brand/50"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10 text-xl">
                  {a.avatar ? a.avatar : <Bot className="h-5 w-5 text-brand" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <StatusBadge status={a.status} />
                    <span className="badge bg-black/10 text-muted dark:bg-white/10">
                      <Building2 className="mr-1 inline h-3 w-3" />
                      {a.department || '未分類'}
                    </span>
                  </div>
                </div>
              </div>
              <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted">{a.description || '尚無描述'}</p>
              <div className="mt-auto flex items-center gap-4 border-t border-border pt-3 text-xs text-muted">
                <span className="flex items-center gap-1">
                  <Wrench className="h-3.5 w-3.5" /> {a.skillCount} 技能
                </span>
                <span className="flex items-center gap-1">
                  <Workflow className="h-3.5 w-3.5" /> {a.workflowCount} 工作流
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <CreateAgentModal
          busy={createMutation.isPending}
          error={createMutation.error instanceof Error ? createMutation.error.message : null}
          onClose={() => setCreating(false)}
          onSubmit={(body) => createMutation.mutate(body)}
        />
      )}
    </AppShell>
  );
}

function CreateAgentModal({
  onClose,
  onSubmit,
  busy,
  error,
}: {
  onClose: () => void;
  onSubmit: (body: {
    name: string;
    description: string;
    rolePrompt: string;
    engineExecute: string;
    engineVerify?: string | null;
    maxRounds: number;
    avatar?: string;
    department?: string;
  }) => void;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  const [engineExecute, setEngineExecute] = useState<string>(ENGINES[0]);
  const [engineVerify, setEngineVerify] = useState<string>('');
  const [maxRounds, setMaxRounds] = useState(8);
  const [avatar, setAvatar] = useState('');
  const [department, setDepartment] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      name,
      description,
      rolePrompt,
      engineExecute,
      engineVerify: engineVerify || null,
      maxRounds,
      avatar: avatar || undefined,
      department: department.trim() || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="card flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">建立員工</h2>
          <button type="button" className="btn-ghost p-1.5" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <Field label="名稱">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="頭像 (emoji，選填)">
          <input className="input" value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="🤖" maxLength={4} />
        </Field>
        <Field label="描述">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="這位員工的職責..." />
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
        </Field>
        <Field label="角色設定 Role Prompt">
          <textarea
            className="input min-h-[120px] resize-y"
            value={rolePrompt}
            onChange={(e) => setRolePrompt(e.target.value)}
            placeholder="描述這位 AI 員工的角色、目標與行為方式..."
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="執行引擎 Engine">
            <select className="input" value={engineExecute} onChange={(e) => setEngineExecute(e.target.value)}>
              {ENGINES.map((eng) => (
                <option key={eng} value={eng}>
                  {ENGINE_LABELS[eng]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="驗證引擎 Verify Engine（選填）">
            <select className="input" value={engineVerify} onChange={(e) => setEngineVerify(e.target.value)}>
              {ENGINE_VERIFY_OPTIONS.map((o) => (
                <option key={o.value || 'auto'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
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

        {error && <p className="text-sm text-rose-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="border-white/40 border-t-white" />} 建立
          </button>
        </div>
      </form>
    </div>
  );
}
