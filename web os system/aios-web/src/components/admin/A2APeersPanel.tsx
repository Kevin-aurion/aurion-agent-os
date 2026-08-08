'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Globe,
  Network,
  Plus,
  Power,
  PowerOff,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { API, ApiError } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { EmptyState, Spinner } from '@/components/ui';

// ── Types (mirror backend toPeerDto) ─────────────────────────────────────────

interface A2APeerDto {
  id: string;
  peerId: string;
  name: string;
  description: string;
  baseUrl: string;
  /** Remote delegation off until FDE enables (backend default false). */
  enabled: boolean;
  /** Reference only (e.g. env:FOO / keychain:bar) — never a resolved secret. */
  credentialRef: string | null;
  riskTier: string;
  maxPayloadBytes: number;
  timeoutMs: number;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface A2APeerInput {
  peerId: string;
  name: string;
  baseUrl: string;
  description?: string;
  riskTier?: 'low' | 'medium' | 'high';
  credentialRef?: string | null;
  maxPayloadBytes?: number;
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

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function riskTierClass(tier: string): string {
  if (tier === 'high') return 'bg-rose-500/15 text-rose-400 border-rose-500/30';
  if (tier === 'medium') return 'bg-amber-500/15 text-amber-500 border-amber-500/30';
  return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
}

// ── Create form (FDE only) ───────────────────────────────────────────────────

const EMPTY_FORM = {
  peerId: '',
  name: '',
  baseUrl: '',
  description: '',
  riskTier: 'high' as 'low' | 'medium' | 'high',
  credentialRef: '',
  maxPayloadBytes: '',
  timeoutMs: '',
};

function CreatePeerForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: (body: A2APeerInput) => API.post<A2APeerDto>('/a2a/peers', body),
    onSuccess: () => {
      setFormError(null);
      setForm(EMPTY_FORM);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['a2a', 'peers'] });
      onCreated();
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const peerId = form.peerId.trim();
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    if (!peerId || !name || !baseUrl) {
      setFormError('peerId、name、baseUrl 為必填');
      return;
    }
    if (!isHttpUrl(baseUrl)) {
      setFormError('baseUrl 須為有效的 http(s) URL');
      return;
    }
    const body: A2APeerInput = {
      peerId,
      name,
      baseUrl,
      riskTier: form.riskTier,
    };
    const desc = form.description.trim();
    if (desc) body.description = desc;
    const cred = form.credentialRef.trim();
    body.credentialRef = cred || null;
    const maxBytes = form.maxPayloadBytes.trim();
    if (maxBytes) {
      const n = Number(maxBytes);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        setFormError('maxPayloadBytes 須為正整數');
        return;
      }
      body.maxPayloadBytes = n;
    }
    const tms = form.timeoutMs.trim();
    if (tms) {
      const n = Number(tms);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        setFormError('timeoutMs 須為正整數');
        return;
      }
      body.timeoutMs = n;
    }
    // enabled intentionally omitted — peers are created disabled.
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
        註冊外部 Peer
      </button>

      {open && (
        <form onSubmit={submit} className="space-y-3 border-t border-border/50 px-4 py-4">
          <p className="text-[11px] leading-relaxed text-muted">
            新建 peer <strong className="text-fg">預設停用</strong>
            （遠端委派關閉）；FDE 需明確「啟用」後才可 submit task。憑證僅存參照（
            <code className="text-fg">env:VAR</code> 或 <code className="text-fg">keychain:xxx</code>
            ），絕不存明文密鑰。
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">peerId *</span>
              <input
                value={form.peerId}
                onChange={(e) => set('peerId', e.target.value)}
                placeholder="unique-peer-slug"
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
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11px] text-muted">baseUrl *（http / https）</span>
              <input
                value={form.baseUrl}
                onChange={(e) => set('baseUrl', e.target.value)}
                placeholder="https://peer.example.com/a2a"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
                required
              />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11px] text-muted">description（可空）</span>
              <input
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="簡短說明"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">riskTier</span>
              <select
                value={form.riskTier}
                onChange={(e) => set('riskTier', e.target.value as 'low' | 'medium' | 'high')}
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs"
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high（預設）</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">
                credentialRef（可空 · 參照，非明碼）
              </span>
              <input
                value={form.credentialRef}
                onChange={(e) => set('credentialRef', e.target.value)}
                placeholder="例如 env:PEER_TOKEN（參照，非明碼）"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
                autoComplete="off"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">maxPayloadBytes（可空＝後端預設）</span>
              <input
                type="number"
                min={1}
                step={1}
                value={form.maxPayloadBytes}
                onChange={(e) => set('maxPayloadBytes', e.target.value)}
                placeholder="65536"
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
                placeholder="30000"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs"
              />
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
              註冊（預設停用）
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

// ── Peer row ─────────────────────────────────────────────────────────────────

function PeerRow({ peer, isFde }: { peer: A2APeerDto; isFde: boolean }) {
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      API.patch<A2APeerDto>(`/a2a/peers/${peer.peerId}/enabled`, { enabled }),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['a2a', 'peers'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const deleteMut = useMutation({
    mutationFn: () => API.del(`/a2a/peers/${peer.peerId}`),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['a2a', 'peers'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const busy = toggleMut.isPending || deleteMut.isPending;

  return (
    <div className="border-b border-border/60 last:border-0">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Network className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="font-medium">{peer.name}</span>
            <code className="text-[11px] text-muted">{peer.peerId}</code>
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium',
                riskTierClass(peer.riskTier),
              )}
            >
              <ShieldAlert className="h-3 w-3" />
              {peer.riskTier}
            </span>
            {peer.enabled ? (
              <span className="inline-flex rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                已啟用
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                已停用
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <Globe className="h-3 w-3" />
              <code className="break-all text-fg">{peer.baseUrl}</code>
            </span>
            <span>
              credentialRef:{' '}
              <code className="text-fg">{displayOrDash(peer.credentialRef)}</code>
            </span>
            <span>
              payload ≤ {peer.maxPayloadBytes} B · timeout {peer.timeoutMs} ms
            </span>
            <span>
              核准: {displayOrDash(peer.approvedBy)} · {relativeTime(peer.approvedAt)}
            </span>
          </div>

          {peer.description ? (
            <p className="text-[11px] text-muted">{peer.description}</p>
          ) : null}
        </div>

        {isFde && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {peer.enabled ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => toggleMut.mutate(false)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
              >
                {toggleMut.isPending ? (
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
                onClick={() => {
                  if (
                    !window.confirm(
                      `確定啟用外部 Peer「${peer.name}」(${peer.peerId})？\n\n啟用後將開放對此 peer 的遠端委派（A2A task submit）。僅在信任該對端時繼續。`,
                    )
                  ) {
                    return;
                  }
                  toggleMut.mutate(true);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {toggleMut.isPending ? (
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
                    `確定刪除外部 Peer「${peer.name}」(${peer.peerId})？此操作無法復原。`,
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
          </div>
        )}
      </div>

      {actionError && (
        <div className="mx-4 mb-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-400">
          {actionError}
        </div>
      )}
    </div>
  );
}

// ── Panel root ───────────────────────────────────────────────────────────────

export function A2APeersPanel() {
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);

  const peersQuery = useQuery({
    queryKey: ['a2a', 'peers'],
    queryFn: () => API.get<A2APeerDto[]>('/a2a/peers'),
    refetchInterval: 30000,
  });

  return (
    <div className="mt-8 card">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-brand" />
          <div>
            <h2 className="text-sm font-semibold">外部 Agent Peers（A2A）</h2>
            <p className="text-[11px] text-muted">
              預設停用；僅 FDE 可註冊/啟用遠端委派
            </p>
          </div>
        </div>
        {peersQuery.isFetching && <Spinner className="h-4 w-4" />}
      </div>

      {!isFde && (
        <div className="border-b border-border/60 px-4 py-2 text-[11px] text-muted">
          僅 FDE（OWNER/TRAINER）可管理外部 peers
        </div>
      )}

      {isFde && <CreatePeerForm onCreated={() => undefined} />}

      {peersQuery.isLoading ? (
        <div className="flex h-28 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : peersQuery.isError ? (
        <div className="p-6">
          <EmptyState title="無法載入 A2A Peer 清單" hint={errorMessage(peersQuery.error)} />
        </div>
      ) : !(peersQuery.data?.length) ? (
        <div className="p-6">
          <EmptyState
            title="尚無外部 Peer"
            hint={
              isFde
                ? '可展開上方表單註冊 FDE 核准的外部 Agent（預設停用）'
                : '請聯絡 FDE 註冊外部 peers'
            }
          />
        </div>
      ) : (
        <div>
          {peersQuery.data.map((p) => (
            <PeerRow key={p.id} peer={p} isFde={isFde} />
          ))}
        </div>
      )}
    </div>
  );
}
