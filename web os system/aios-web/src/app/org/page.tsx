'use client';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Building2, Crown, ShieldCheck, Wrench, Workflow } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { API } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface OrgUser {
  id: string;
  displayName: string;
  email: string;
  role: 'OWNER' | 'TRAINER' | 'MEMBER';
}

interface OrgAgent {
  id: string;
  name: string;
  description: string;
  status: string;
  skillCount: number;
  workflowCount: number;
  department: string;
}

interface OrgDepartment {
  name: string;
  agents: OrgAgent[];
}

interface OrgResp {
  owner: { id: string; displayName: string; email: string } | null;
  trainers: OrgUser[];
  members: OrgUser[];
  departments: OrgDepartment[];
}

function AgentCard({ agent }: { agent: OrgAgent }) {
  return (
    <Link
      href={`/employees/${agent.id}`}
      className="block rounded-lg border border-border bg-panel p-3 transition-colors hover:border-brand/50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{agent.name}</span>
        <StatusBadge status={agent.status} />
      </div>
      <p className="mt-1 line-clamp-2 min-h-[2rem] text-xs text-muted">{agent.description || '尚無描述'}</p>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <Wrench className="h-3 w-3" /> {agent.skillCount} 技能
        </span>
        <span className="flex items-center gap-1">
          <Workflow className="h-3 w-3" /> {agent.workflowCount} 工作流
        </span>
      </div>
    </Link>
  );
}

const ROLE_OPTIONS: { value: 'TRAINER' | 'MEMBER'; label: string }[] = [
  { value: 'TRAINER', label: 'TRAINER' },
  { value: 'MEMBER', label: 'MEMBER' },
];

function PermissionsSection() {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['users'], queryFn: () => API.get<OrgUser[]>('/api/users') });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'TRAINER' | 'MEMBER' }) => API.patch(`/api/users/${id}/role`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <section className="card mt-8 p-6">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4" /> 權限管理 Permissions
      </h2>
      <p className="mb-4 text-xs text-muted">訓練權限：OWNER / TRAINER 可訓練與修改員工，MEMBER 僅能使用。</p>

      {usersQ.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : usersQ.isError ? (
        <p className="text-sm text-rose-400">無法載入使用者清單</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-black/5 text-left text-xs text-muted dark:bg-white/5">
              <tr>
                <th className="px-3 py-2">使用者</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">角色</th>
              </tr>
            </thead>
            <tbody>
              {(usersQ.data ?? []).map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-3 py-2">{u.displayName}</td>
                  <td className="px-3 py-2 text-muted">{u.email}</td>
                  <td className="px-3 py-2">
                    {u.role === 'OWNER' ? (
                      <span className="badge bg-brand/15 text-brand" title="OWNER 角色不可變更">
                        OWNER
                      </span>
                    ) : (
                      <select
                        className="input w-auto"
                        value={u.role}
                        disabled={roleMut.isPending && roleMut.variables?.id === u.id}
                        onChange={(e) => roleMut.mutate({ id: u.id, role: e.target.value as 'TRAINER' | 'MEMBER' })}
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function OrgPage() {
  const { user } = useAuth();
  const orgQ = useQuery({ queryKey: ['org'], queryFn: () => API.get<OrgResp>('/api/org') });

  const departments = orgQ.data?.departments ?? [];

  return (
    <AppShell>
      <PageHeader title="組織 Org" subtitle="組織架構、部門分佈與權限管理" />

      {orgQ.isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      )}

      {orgQ.isError && <EmptyState title="無法載入組織架構" hint="請確認後端服務是否正常運作" />}

      {orgQ.data && (
        <div className="space-y-6">
          <section className="card overflow-x-auto p-6">
            <div className="flex min-w-fit flex-col items-center">
              {/* owner */}
              {orgQ.data.owner ? (
                <div className="flex w-64 flex-col items-center gap-1 rounded-xl border border-brand/40 bg-brand/5 p-4 text-center">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-brand/15 text-brand">
                    <Crown className="h-5 w-5" />
                  </div>
                  <div className="font-medium">{orgQ.data.owner.displayName}</div>
                  <div className="truncate text-xs text-muted">{orgQ.data.owner.email}</div>
                  <span className="badge bg-brand/15 text-brand">OWNER</span>
                </div>
              ) : (
                <div className="w-64 rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">尚無老闆/管理者</div>
              )}

              <div className="h-6 w-px bg-border" />

              {/* secretary / orchestrator (static) */}
              <div className="flex w-56 flex-col items-center gap-1 rounded-xl border border-border bg-panel p-4 text-center">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-black/10 dark:bg-white/10">
                  <Bot className="h-5 w-5 text-muted" />
                </div>
                <div className="font-medium">秘書 AIOS 總控</div>
                <div className="text-xs text-muted">統籌調度所有員工與工作流</div>
              </div>

              <div className="h-6 w-px bg-border" />

              {/* departments row */}
              {departments.length === 0 ? (
                <p className="py-4 text-sm text-muted">尚無部門或員工</p>
              ) : (
                <div className="flex justify-center gap-10 border-t border-border pt-6">
                  {departments.map((dept) => (
                    <div key={dept.name} className="relative flex w-64 flex-col items-center gap-3 px-1">
                      <span className="absolute -top-6 left-1/2 h-6 w-px -translate-x-1/2 bg-border" />
                      <div className="flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 text-xs font-medium dark:bg-white/5">
                        <Building2 className="h-3.5 w-3.5" /> {dept.name}
                      </div>
                      <div className="w-full space-y-2">
                        {dept.agents.map((a) => (
                          <AgentCard key={a.id} agent={a} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {user?.role === 'OWNER' && <PermissionsSection />}
        </div>
      )}
    </AppShell>
  );
}
