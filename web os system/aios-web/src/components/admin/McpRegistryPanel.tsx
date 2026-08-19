'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Plug,
  Plus,
  Power,
  PowerOff,
  ServerCog,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { API, ApiError } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { EmptyState, Spinner, StatusBadge } from '@/components/ui';

// ── Types (mirror backend SafeDto) ───────────────────────────────────────────

type McpTransport = 'STDIO' | 'LOOPBACK_HTTP' | 'REMOTE_HTTP';
type McpTrustTier = 'UNTRUSTED' | 'TRUSTED' | 'INTERNAL';

interface McpServerDto {
  id: string;
  serverId: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  commandArgs: string[];
  cwd: string | null;
  url: string | null;
  protocolVersion: string;
  enabled: boolean;
  trustTier: McpTrustTier;
  /** Reference only (e.g. env:FOO / keychain:bar) — never a resolved secret. */
  credentialRef: string | null;
  allowedAgentIds: string[];
  toolAllowlist: string[];
  resourceAllowlist: string[];
  readWriteClass: string;
  requiredRestrictions: string[];
  riskTier: string;
  approvalRequired: boolean;
  timeoutMs: number;
  healthStatus: string;
  lastVersion: string | null;
  lastHealthAt: string | null;
}

interface McpHealthResult {
  status: 'healthy' | 'error';
  version?: string;
  tools?: string[];
  message?: string;
}

interface McpServerInput {
  serverId: string;
  name: string;
  transport: McpTransport;
  command?: string | null;
  url?: string | null;
  trustTier?: McpTrustTier;
  credentialRef?: string | null;
  toolAllowlist?: string[];
  allowedAgentIds?: string[];
  approvalRequired?: boolean;
  timeoutMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return '剛剛';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小時前`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} 天前`;
}

function displayOrDash(v: string | null | undefined): string {
  if (v == null || v === '') return '—';
  return v;
}

function parseCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function trustTierClass(tier: string): string {
  if (tier === 'UNTRUSTED') return 'bg-amber-500/15 text-amber-500 border-amber-500/30';
  if (tier === 'INTERNAL') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  return 'bg-blue-500/15 text-blue-400 border-blue-500/30'; // TRUSTED
}

function transportLabel(t: string): string {
  if (t === 'STDIO') return 'STDIO';
  if (t === 'LOOPBACK_HTTP') return 'Loopback HTTP';
  if (t === 'REMOTE_HTTP') return 'Remote HTTP';
  return t;
}

// ── Create form (FDE only) ───────────────────────────────────────────────────

const EMPTY_FORM = {
  serverId: '',
  name: '',
  transport: 'STDIO' as McpTransport,
  command: '',
  url: '',
  trustTier: 'UNTRUSTED' as McpTrustTier,
  credentialRef: '',
  toolAllowlist: '',
  allowedAgentIds: '',
  approvalRequired: false,
  timeoutMs: '',
};

function CreateServerForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: (body: McpServerInput) => API.post<McpServerDto>('/mcp/servers', body),
    onSuccess: () => {
      setFormError(null);
      setForm(EMPTY_FORM);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
      onCreated();
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const serverId = form.serverId.trim();
    const name = form.name.trim();
    if (!serverId || !name) {
      setFormError('serverId 與 name 為必填');
      return;
    }
    const body: McpServerInput = {
      serverId,
      name,
      transport: form.transport,
      trustTier: form.trustTier,
      approvalRequired: form.approvalRequired,
    };
    if (form.transport === 'STDIO') {
      const cmd = form.command.trim();
      body.command = cmd || null;
    }
    if (form.transport === 'LOOPBACK_HTTP' || form.transport === 'REMOTE_HTTP') {
      const u = form.url.trim();
      body.url = u || null;
    }
    const cred = form.credentialRef.trim();
    body.credentialRef = cred || null;
    const tools = parseCsvList(form.toolAllowlist);
    if (tools.length) body.toolAllowlist = tools;
    const agents = parseCsvList(form.allowedAgentIds);
    if (agents.length) body.allowedAgentIds = agents;
    const tms = form.timeoutMs.trim();
    if (tms) {
      const n = Number(tms);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        setFormError('timeoutMs 須為正整數');
        return;
      }
      body.timeoutMs = n;
    }
    createMut.mutate(body);
  }

  function set<K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted" />
        )}
        <Plus className="h-3.5 w-3.5 text-brand" />
        新增 MCP Server
      </button>

      {open && (
        <form onSubmit={submit} className="space-y-3 border-t border-border/50 px-4 py-4">
          <p className="text-[11px] leading-relaxed text-muted">
            遠端網路 MCP（REMOTE_HTTP / 非 loopback URL）預設會被後端拒絕，僅供未來 FDE 明確設定。
            後端 fail-closed 驗證；憑證僅存參照（
            <code className="text-fg">env:VAR</code> 或 <code className="text-fg">keychain:xxx</code>
            ），絕不存明文密鑰。
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">serverId *</span>
              <input
                value={form.serverId}
                onChange={(e) => set('serverId', e.target.value)}
                placeholder="unique-slug"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">name *</span>
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="顯示名稱"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">transport *</span>
              <select
                value={form.transport}
                onChange={(e) => set('transport', e.target.value as McpTransport)}
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs"
              >
                <option value="STDIO">STDIO</option>
                <option value="LOOPBACK_HTTP">LOOPBACK_HTTP</option>
                <option value="REMOTE_HTTP">REMOTE_HTTP（預設拒）</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">trustTier</span>
              <select
                value={form.trustTier}
                onChange={(e) => set('trustTier', e.target.value as McpTrustTier)}
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs"
              >
                <option value="UNTRUSTED">UNTRUSTED</option>
                <option value="TRUSTED">TRUSTED</option>
                <option value="INTERNAL">INTERNAL</option>
              </select>
            </label>

            {form.transport === 'STDIO' && (
              <label className="block space-y-1 sm:col-span-2">
                <span className="text-[11px] text-muted">command（STDIO）</span>
                <input
                  value={form.command}
                  onChange={(e) => set('command', e.target.value)}
                  placeholder="/usr/local/bin/my-mcp-server"
                  className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
                />
              </label>
            )}

            {(form.transport === 'LOOPBACK_HTTP' || form.transport === 'REMOTE_HTTP') && (
              <label className="block space-y-1 sm:col-span-2">
                <span className="text-[11px] text-muted">
                  url（僅允許 127.0.0.1 / localhost loopback）
                </span>
                <input
                  value={form.url}
                  onChange={(e) => set('url', e.target.value)}
                  placeholder="http://127.0.0.1:3101/mcp"
                  className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
                />
              </label>
            )}

            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11px] text-muted">
                credentialRef（可空 · 格式 env:VAR 或 keychain:xxx）
              </span>
              <input
                value={form.credentialRef}
                onChange={(e) => set('credentialRef', e.target.value)}
                placeholder="env:MCP_TOKEN"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
                autoComplete="off"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] text-muted">toolAllowlist（逗號分隔）</span>
              <input
                value={form.toolAllowlist}
                onChange={(e) => set('toolAllowlist', e.target.value)}
                placeholder="tool_a, tool_b"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">allowedAgentIds（逗號分隔）</span>
              <input
                value={form.allowedAgentIds}
                onChange={(e) => set('allowedAgentIds', e.target.value)}
                placeholder="agent-id-1, agent-id-2"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] text-muted">timeoutMs（可空＝後端預設）</span>
              <input
                type="number"
                min={1}
                step={1}
                value={form.timeoutMs}
                onChange={(e) => set('timeoutMs', e.target.value)}
                placeholder="預設"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
              />
            </label>
            <label className="flex items-center gap-2 pt-5 text-xs">
              <input
                type="checkbox"
                checked={form.approvalRequired}
                onChange={(e) => set('approvalRequired', e.target.checked)}
                className="rounded border-border"
              />
              approvalRequired（需 HITL 核准）
            </label>
          </div>

          {formError && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-400">
              {formError}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={createMut.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand/15 px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/25 disabled:opacity-50"
            >
              {createMut.isPending ? <Spinner className="h-3 w-3" /> : <Plus className="h-3.5 w-3.5" />}
              建立
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setFormError(null);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5"
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Server row ───────────────────────────────────────────────────────────────

function ServerRow({ server, isFde }: { server: McpServerDto; isFde: boolean }) {
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [healthDetail, setHealthDetail] = useState<McpHealthResult | null>(null);

  const healthMut = useMutation({
    mutationFn: () => API.get<McpHealthResult>(`/mcp/servers/${server.id}/health`),
    onSuccess: (data) => {
      setActionError(null);
      setHealthDetail(data);
      void qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
    },
    onError: (e) => {
      setHealthDetail(null);
      setActionError(errorMessage(e));
    },
  });

  const enableMut = useMutation({
    mutationFn: () => API.post(`/mcp/servers/${server.id}/enable`),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const disableMut = useMutation({
    mutationFn: () => API.post(`/mcp/servers/${server.id}/disable`),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const deleteMut = useMutation({
    mutationFn: () => API.del(`/mcp/servers/${server.id}`),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const busy =
    healthMut.isPending || enableMut.isPending || disableMut.isPending || deleteMut.isPending;

  return (
    <div className="border-b border-border/60 last:border-0">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <ServerCog className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="font-medium">{server.name}</span>
            <code className="text-[11px] text-muted">{server.serverId}</code>
            <span
              className={cn(
                'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium',
                'bg-black/5 text-muted dark:bg-white/10',
              )}
            >
              {transportLabel(server.transport)}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium',
                trustTierClass(server.trustTier),
              )}
            >
              <ShieldCheck className="h-3 w-3" />
              {server.trustTier}
            </span>
            {server.enabled ? (
              <span className="inline-flex rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                啟用
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                停用
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <Activity className="h-3 w-3" />
              health: <StatusBadge status={server.healthStatus || 'UNKNOWN'} />
            </span>
            <span>
              version: <code className="text-fg">{displayOrDash(server.lastVersion)}</code>
            </span>
            <span>上次檢查: {relativeTime(server.lastHealthAt)}</span>
            {server.credentialRef != null && (
              <span>
                credentialRef:{' '}
                <code className="text-fg">{displayOrDash(server.credentialRef)}</code>
              </span>
            )}
            {server.approvalRequired && (
              <span className="text-amber-500">需核准</span>
            )}
            {server.toolAllowlist?.length > 0 && (
              <span>tools: {server.toolAllowlist.length}</span>
            )}
          </div>

          {(server.command || server.url) && (
            <div className="text-[11px] text-muted">
              {server.transport === 'STDIO' && server.command && (
                <code className="break-all">{server.command}</code>
              )}
              {server.url && <code className="break-all">{server.url}</code>}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={() => healthMut.mutate()}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
          >
            {healthMut.isPending ? <Spinner className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
            檢查健康 Health
          </button>

          {isFde && (
            <>
              {server.enabled ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => disableMut.mutate()}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                >
                  {disableMut.isPending ? (
                    <Spinner className="h-3 w-3" />
                  ) : (
                    <PowerOff className="h-3 w-3" />
                  )}
                  停用
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => enableMut.mutate()}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {enableMut.isPending ? (
                    <Spinner className="h-3 w-3" />
                  ) : (
                    <Power className="h-3 w-3" />
                  )}
                  啟用
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      `確定刪除 MCP Server「${server.name}」(${server.serverId})？此操作無法復原。`,
                    )
                  ) {
                    return;
                  }
                  deleteMut.mutate();
                }}
                className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 px-2.5 py-1.5 text-xs font-medium text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
              >
                {deleteMut.isPending ? <Spinner className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                刪除
              </button>
            </>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mx-4 mb-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-400">
          {actionError}
        </div>
      )}

      {healthDetail && (
        <div
          className={cn(
            'mx-4 mb-3 rounded-md border px-3 py-2 text-xs',
            healthDetail.status === 'error'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
          )}
        >
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <span>Health: {healthDetail.status}</span>
            {healthDetail.version != null && healthDetail.version !== '' && (
              <code className="font-normal opacity-90">v{healthDetail.version}</code>
            )}
          </div>
          {healthDetail.message != null && healthDetail.message !== '' && (
            <p className="mt-1 opacity-90">{healthDetail.message}</p>
          )}
          {healthDetail.tools && healthDetail.tools.length > 0 && (
            <p className="mt-1 font-normal opacity-80">
              tools ({healthDetail.tools.length}): {healthDetail.tools.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel root ───────────────────────────────────────────────────────────────

export function McpRegistryPanel() {
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);

  const serversQuery = useQuery({
    queryKey: ['mcp', 'servers'],
    queryFn: () => API.get<McpServerDto[]>('/mcp/servers'),
    refetchInterval: 30000,
  });

  return (
    <div className="mt-8 card">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-brand" />
          <div>
            <h2 className="text-sm font-semibold">MCP 能力閘道 · Registry &amp; Health</h2>
            <p className="text-[11px] text-muted">
              受治理的 MCP 伺服器；僅 stdio 與 loopback，遠端預設停用；憑證只存參照
            </p>
          </div>
        </div>
        {serversQuery.isFetching && <Spinner className="h-4 w-4" />}
      </div>

      {isFde && <CreateServerForm onCreated={() => undefined} />}

      {serversQuery.isLoading ? (
        <div className="flex h-28 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : serversQuery.isError ? (
        <div className="p-6">
          <EmptyState title="無法載入 MCP Server 清單" hint={errorMessage(serversQuery.error)} />
        </div>
      ) : !(serversQuery.data?.length) ? (
        <div className="p-6">
          <EmptyState
            title="尚無 MCP Server"
            hint={isFde ? '可展開上方表單新增受治理的 MCP 伺服器' : '請聯絡 FDE 註冊 MCP 伺服器'}
          />
        </div>
      ) : (
        <div>
          {serversQuery.data.map((s) => (
            <ServerRow key={s.id} server={s} isFde={isFde} />
          ))}
        </div>
      )}
    </div>
  );
}
