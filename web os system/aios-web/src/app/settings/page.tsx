'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, Trash2, Send, Plus, HeartPulse, ShieldCheck, ShieldAlert, FileSpreadsheet, ExternalLink, FileBarChart2, FileText, Cable } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { PageHeader, EmptyState, StatusBadge, Field, Spinner } from '@/components/ui';
import { API, tokens } from '@/lib/api';
import { useAwp } from '@/lib/awp';

interface IntegrationAccount {
  id: string;
  provider: string;
  email: string;
  status: string;
  scopes: string[];
}
interface IntegrationsResp {
  accounts: IntegrationAccount[];
  configured: { microsoft: boolean; google: boolean; line: boolean };
}
interface ArapTemplateResult {
  id: string;
  name: string;
  path?: string;
  webUrl?: string | null;
}
interface ChannelBinding {
  id: string;
  channel?: string;
  kind: string;
  externalId: string;
  label: string;
}
interface PreflightResp {
  engines?: Record<string, { installed: boolean; version?: string }>;
  integrations?: { microsoft?: boolean; google?: boolean; line?: boolean };
  [k: string]: unknown;
}
interface HealthResp {
  db?: string | boolean;
  wsConnections?: number;
  [k: string]: unknown;
}
interface AgentOption {
  id: string;
  name: string;
  status: string;
}
interface McpInstallResult {
  installed: Array<{ serverId: string; name: string }>;
  note: string;
}

const PROVIDER_LABEL: Record<string, string> = { microsoft: 'Microsoft 365', google: 'Google', line: 'LINE' };
const PROVIDER_ENV: Record<string, string> = { microsoft: 'MS_CLIENT_ID', google: 'GOOGLE_CLIENT_ID', line: 'LINE_CHANNEL_ACCESS_TOKEN' };
const SAMPLE_FILE_KINDS: { kind: string; label: string; icon: typeof FileSpreadsheet }[] = [
  { kind: 'arap', label: '應收應付', icon: FileSpreadsheet },
  { kind: 'revenue', label: '營收報告', icon: FileBarChart2 },
  { kind: 'finance', label: '財務分析', icon: FileText },
];

function FileResultLink({ result }: { result: ArapTemplateResult }) {
  if (result.webUrl) {
    return (
      <a className="inline-flex items-center gap-1 text-emerald-400 underline" href={result.webUrl} target="_blank" rel="noreferrer">
        前往檔案 <ExternalLink className="h-3 w-3" />
      </a>
    );
  }
  return <span className="text-emerald-400">已建立：{result.name}</span>;
}

export default function SettingsPage() {
  const qc = useQueryClient();

  useAwp(['integration.status'], () => {
    qc.invalidateQueries({ queryKey: ['integrations'] });
  });

  const integrationsQ = useQuery({
    queryKey: ['integrations'],
    queryFn: () => API.get<IntegrationsResp>('/api/integrations'),
  });
  const bindingsQ = useQuery({
    queryKey: ['channels', 'bindings'],
    queryFn: () => API.get<ChannelBinding[]>('/api/channels/bindings'),
  });
  const preflightQ = useQuery({
    queryKey: ['preflight'],
    queryFn: () => API.get<PreflightResp>('/api/preflight'),
  });
  const healthQ = useQuery({
    queryKey: ['health'],
    queryFn: () => API.get<HealthResp>('/api/health'),
  });
  const agentsQ = useQuery({
    queryKey: ['agents', 'settings-mcp'],
    queryFn: () => API.get<AgentOption[]>('/api/agents'),
  });

  const disconnectMut = useMutation({
    mutationFn: (accountId: string) => API.del(`/api/integrations/${accountId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
  });

  const [arapResults, setArapResults] = useState<Record<string, ArapTemplateResult>>({});
  const arapMut = useMutation({
    mutationFn: (accountId: string) => API.post<ArapTemplateResult>(`/api/integrations/${accountId}/arap-template`),
    onSuccess: (data, accountId) => {
      setArapResults((prev) => ({ ...prev, [accountId]: data }));
    },
  });

  const [sampleResults, setSampleResults] = useState<Record<string, ArapTemplateResult>>({});
  const sampleFileMut = useMutation({
    mutationFn: ({ accountId, kind }: { accountId: string; kind: string }) =>
      API.post<ArapTemplateResult>(`/api/integrations/${accountId}/sample-file`, { kind }),
    onSuccess: (data, vars) => {
      setSampleResults((prev) => ({ ...prev, [`${vars.accountId}:${vars.kind}`]: data }));
    },
  });

  const [mcpAgentByAccount, setMcpAgentByAccount] = useState<Record<string, string>>({});
  const [mcpResults, setMcpResults] = useState<Record<string, McpInstallResult>>({});
  const mcpInstallMut = useMutation({
    mutationFn: ({ accountId, agentId }: { accountId: string; agentId: string }) =>
      API.post<McpInstallResult>('/api/google-workspace/mcp/install', {
        accountId,
        agentIds: [agentId],
      }),
    onSuccess: (data, vars) => {
      setMcpResults((previous) => ({ ...previous, [vars.accountId]: data }));
      qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
    },
  });

  const [newKind, setNewKind] = useState('USER');
  const [newExternalId, setNewExternalId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const addBindingMut = useMutation({
    mutationFn: () => API.post<ChannelBinding>('/api/channels/bindings', { kind: newKind, externalId: newExternalId, label: newLabel }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels', 'bindings'] });
      setNewExternalId('');
      setNewLabel('');
    },
  });
  const deleteBindingMut = useMutation({
    mutationFn: (id: string) => API.del(`/api/channels/bindings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels', 'bindings'] }),
  });
  const [pushText, setPushText] = useState<Record<string, string>>({});
  const pushMut = useMutation({
    mutationFn: ({ bindingId, text }: { bindingId: string; text: string }) => API.post('/api/channels/line/push', { bindingId, text }),
  });

  function connect(provider: 'microsoft' | 'google') {
    // Full-page navigation can't send an auth header, so pass the access token
    // as a query param (the /start endpoint validates it, same as the WS route).
    // Go straight to the backend (8700) so the provider's 302 isn't proxied.
    const t = tokens.access;
    window.location.href = `http://${location.hostname}:8700/api/integrations/${provider}/start?token=${encodeURIComponent(t ?? '')}`;
  }

  const configured = integrationsQ.data?.configured;
  const accounts = integrationsQ.data?.accounts ?? [];
  const bindings = bindingsQ.data ?? [];

  return (
    <AppShell>
      <PageHeader title="設定 Settings" subtitle="帳號連動、頻道綁定與系統健康狀態" />

      {/* 帳號連動 */}
      <section className="card mb-6 p-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4" /> 帳號連動 Integrations</h2>
        {integrationsQ.isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-3">
              {(['microsoft', 'google'] as const).map((p) => (
                <div key={p} className="flex items-center gap-2">
                  <button
                    className="btn-primary"
                    disabled={!configured?.[p]}
                    onClick={() => connect(p)}
                    title={configured?.[p] ? undefined : `尚未設定 ${PROVIDER_ENV[p]}`}
                  >
                    連動 {PROVIDER_LABEL[p]}
                  </button>
                  {!configured?.[p] && (
                    <span className="text-xs text-muted">
                      未設定，請於 web os system/.env 填入 <code className="rounded bg-black/10 px-1 dark:bg-white/10">{PROVIDER_ENV[p]}</code>
                    </span>
                  )}
                </div>
              ))}
              <div className="flex items-center gap-2">
                <span className={configured?.line ? 'badge bg-emerald-500/15 text-emerald-400' : 'badge bg-black/10 text-muted dark:bg-white/10'}>
                  LINE {configured?.line ? '已設定' : '未設定'}
                </span>
                {!configured?.line && (
                  <span className="text-xs text-muted">
                    請於 web os system/.env 填入 <code className="rounded bg-black/10 px-1 dark:bg-white/10">{PROVIDER_ENV.line}</code>
                  </span>
                )}
              </div>
            </div>

            {accounts.length === 0 ? (
              <EmptyState title="尚未連動任何帳號" hint="點擊上方按鈕開始 OAuth 連動流程" />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-black/5 text-left text-xs text-muted dark:bg-white/5">
                    <tr>
                      <th className="px-3 py-2">提供者</th>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">狀態</th>
                      <th className="px-3 py-2">權限範圍</th>
                      <th className="px-3 py-2">AR/AP 範本</th>
                      <th className="px-3 py-2">範例檔案</th>
                      <th className="px-3 py-2">Agent 的 Google MCP</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id} className="border-t border-border">
                        <td className="px-3 py-2">{PROVIDER_LABEL[a.provider] ?? a.provider}</td>
                        <td className="px-3 py-2">{a.email}</td>
                        <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                        <td className="px-3 py-2 text-xs text-muted">{a.scopes?.join(', ')}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col items-start gap-1">
                            <button
                              className="btn-ghost whitespace-nowrap"
                              disabled={arapMut.isPending && arapMut.variables === a.id}
                              onClick={() => arapMut.mutate(a.id)}
                            >
                              {arapMut.isPending && arapMut.variables === a.id ? (
                                <Spinner className="h-3.5 w-3.5" />
                              ) : (
                                <FileSpreadsheet className="h-3.5 w-3.5" />
                              )}
                              建立 AR/AP 範本
                            </button>
                            {arapResults[a.id] && (
                              <span className="text-xs">
                                <FileResultLink result={arapResults[a.id]!} />
                              </span>
                            )}
                            {arapMut.isError && arapMut.variables === a.id && (
                              <span className="text-xs text-rose-400">{(arapMut.error as Error).message}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col items-start gap-1.5">
                            {SAMPLE_FILE_KINDS.map(({ kind, label, icon: Icon }) => {
                              const key = `${a.id}:${kind}`;
                              const pending = sampleFileMut.isPending && sampleFileMut.variables?.accountId === a.id && sampleFileMut.variables?.kind === kind;
                              const errored = sampleFileMut.isError && sampleFileMut.variables?.accountId === a.id && sampleFileMut.variables?.kind === kind;
                              return (
                                <div key={kind} className="flex flex-wrap items-center gap-2">
                                  <button
                                    className="btn-ghost whitespace-nowrap"
                                    disabled={pending}
                                    onClick={() => sampleFileMut.mutate({ accountId: a.id, kind })}
                                  >
                                    {pending ? <Spinner className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                                    {label}
                                  </button>
                                  {sampleResults[key] && (
                                    <span className="text-xs">
                                      <FileResultLink result={sampleResults[key]!} />
                                    </span>
                                  )}
                                  {errored && <span className="text-xs text-rose-400">{(sampleFileMut.error as Error).message}</span>}
                                </div>
                              );
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {a.provider === 'GOOGLE' ? (
                            <div className="flex min-w-56 flex-col items-start gap-2">
                              <select
                                className="input w-full"
                                value={mcpAgentByAccount[a.id] ?? ''}
                                onChange={(event) =>
                                  setMcpAgentByAccount((previous) => ({
                                    ...previous,
                                    [a.id]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">選擇要授權的 Agent</option>
                                {(agentsQ.data ?? []).map((agent) => (
                                  <option key={agent.id} value={agent.id}>
                                    {agent.name}（{agent.status}）
                                  </option>
                                ))}
                              </select>
                              <button
                                className="btn-ghost whitespace-nowrap"
                                disabled={
                                  !mcpAgentByAccount[a.id] ||
                                  (mcpInstallMut.isPending && mcpInstallMut.variables?.accountId === a.id)
                                }
                                onClick={() => {
                                  const agentId = mcpAgentByAccount[a.id];
                                  if (agentId) mcpInstallMut.mutate({ accountId: a.id, agentId });
                                }}
                              >
                                {mcpInstallMut.isPending && mcpInstallMut.variables?.accountId === a.id ? (
                                  <Spinner className="h-3.5 w-3.5" />
                                ) : (
                                  <Cable className="h-3.5 w-3.5" />
                                )}
                                安裝最小權限工具
                              </button>
                              {mcpResults[a.id] && (
                                <span className="text-xs text-emerald-400">
                                  已安裝 {mcpResults[a.id]!.installed.length} 個分權入口；寫入與寄信仍需核准。
                                </span>
                              )}
                              {mcpInstallMut.isError && mcpInstallMut.variables?.accountId === a.id && (
                                <span className="text-xs text-rose-400">{(mcpInstallMut.error as Error).message}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted">目前僅支援 Google Workspace</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            className="btn-ghost whitespace-nowrap text-rose-400"
                            disabled={disconnectMut.isPending}
                            onClick={() => disconnectMut.mutate(a.id)}
                          >
                            解除連動
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      {/* LINE 綁定 */}
      <section className="card mb-6 p-6">
        <h2 className="mb-4 text-sm font-semibold">LINE 綁定 Bindings</h2>

        <form
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newExternalId || !newLabel) return;
            addBindingMut.mutate();
          }}
        >
          <Field label="類型">
            <select className="input" value={newKind} onChange={(e) => setNewKind(e.target.value)}>
              <option value="USER">USER</option>
              <option value="GROUP">GROUP</option>
              <option value="ROOM">ROOM</option>
            </select>
          </Field>
          <Field label="External ID">
            <input className="input" value={newExternalId} onChange={(e) => setNewExternalId(e.target.value)} placeholder="U1234..." />
          </Field>
          <Field label="標籤">
            <input className="input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="例如：客服群組" />
          </Field>
          <button className="btn-primary" disabled={addBindingMut.isPending}>
            <Plus className="h-4 w-4" /> 新增綁定
          </button>
        </form>

        {bindingsQ.isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : bindings.length === 0 ? (
          <EmptyState title="尚未新增任何 LINE 綁定" />
        ) : (
          <div className="space-y-2">
            {bindings.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                <span className="badge bg-black/10 text-muted dark:bg-white/10">{b.kind}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{b.label}</div>
                  <div className="truncate text-xs text-muted">{b.externalId}</div>
                </div>
                <input
                  className="input w-56"
                  placeholder="測試訊息內容"
                  value={pushText[b.id] ?? ''}
                  onChange={(e) => setPushText((s) => ({ ...s, [b.id]: e.target.value }))}
                />
                <button
                  className="btn-ghost"
                  disabled={pushMut.isPending || !pushText[b.id]}
                  onClick={() => pushMut.mutate({ bindingId: b.id, text: pushText[b.id] ?? '' })}
                >
                  <Send className="h-4 w-4" /> 測試推送
                </button>
                <button className="btn-ghost text-rose-400" disabled={deleteBindingMut.isPending} onClick={() => deleteBindingMut.mutate(b.id)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 系統健康 */}
      <section className="card p-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold"><HeartPulse className="h-4 w-4" /> 系統健康 System Health</h2>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 label">引擎 Engines</div>
            {preflightQ.isLoading ? (
              <Spinner />
            ) : preflightQ.isError ? (
              <p className="text-sm text-rose-400">無法取得 preflight 狀態</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(preflightQ.data?.engines ?? {}).map(([name, info]) => (
                  <div key={name} className="flex items-center gap-2 text-sm">
                    {info.installed ? <ShieldCheck className="h-4 w-4 text-emerald-400" /> : <ShieldAlert className="h-4 w-4 text-rose-400" />}
                    <span className="font-medium">{name}</span>
                    <span className="text-xs text-muted">{info.installed ? info.version ?? '已安裝' : '未安裝'}</span>
                  </div>
                ))}
                {!preflightQ.data?.engines && <p className="text-sm text-muted">無引擎資訊</p>}
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 label">系統狀態 Health</div>
            {healthQ.isLoading ? (
              <Spinner />
            ) : healthQ.isError ? (
              <p className="text-sm text-rose-400">無法取得 health 狀態</p>
            ) : (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted">資料庫 DB</span><span>{String(healthQ.data?.db ?? '—')}</span></div>
                <div className="flex justify-between"><span className="text-muted">WebSocket 連線數</span><span>{healthQ.data?.wsConnections ?? '—'}</span></div>
              </div>
            )}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
