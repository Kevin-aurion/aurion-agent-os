'use client';

/**
 * FDE device management: enrollment lifecycle, capabilities, LINE MCP, task evidence.
 * Secrets (enrollment code / rotate token) shown once in-memory only — never localStorage.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  MonitorSmartphone,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  ShieldOff,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { DeviceTaskPanel } from '@/components/devices/DeviceTaskPanel';
import { EmptyState, Field, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { API } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp } from '@/lib/awp';
import { cn } from '@/lib/cn';
import {
  type DeviceDetail,
  type DeviceMcpInstallation,
  type DeviceTaskStatus,
  type EnrollCodeResult,
  type LineInstallResult,
  type RotateTokenResult,
  type SafeDevice,
  type SafeDeviceTaskListItem,
  DEVICE_TASK_AWP_WILDCARD,
  deviceStatusLabel,
  deviceTasksQuery,
  errorMessage,
  isDeviceTaskLifecyclePayload,
  mcpStatusLabel,
  parseCapabilities,
  platformLabel,
  relativeTime,
  taskStatusLabel,
  TASK_KIND_ZH,
  TASK_STATUS_ZH,
} from '@/lib/devices';

interface AgentOption {
  id: string;
  name: string;
  status: string;
}

type SecretModal =
  | { kind: 'enroll'; deviceName: string; data: EnrollCodeResult }
  | { kind: 'token'; deviceName: string; token: string; prefix?: string | null };

export default function AdminDevicesPage() {
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskIdInput, setTaskIdInput] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskFilterDeviceId, setTaskFilterDeviceId] = useState('');
  const [taskFilterAgentId, setTaskFilterAgentId] = useState('');
  const [taskFilterStatus, setTaskFilterStatus] = useState<'' | DeviceTaskStatus>('');
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [secretModal, setSecretModal] = useState<SecretModal | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPlatform, setCreatePlatform] = useState<'MACOS' | 'WINDOWS' | 'LINUX'>('MACOS');

  const invalidateDevices = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['devices'] });
    if (selectedId) {
      void qc.invalidateQueries({ queryKey: ['device', selectedId] });
      void qc.invalidateQueries({ queryKey: ['device-mcp', selectedId] });
    }
  }, [qc, selectedId]);

  const invalidateDeviceTasks = useCallback(
    (opts?: { taskId?: string; deviceId?: string }) => {
      void qc.invalidateQueries({ queryKey: ['device-tasks'] });
      if (opts?.taskId) {
        void qc.invalidateQueries({ queryKey: ['device-task', opts.taskId] });
      }
      if (opts?.deviceId) {
        void qc.invalidateQueries({ queryKey: ['device', opts.deviceId] });
        void qc.invalidateQueries({ queryKey: ['device-mcp', opts.deviceId] });
      }
      invalidateDevices();
    },
    [qc, invalidateDevices],
  );

  // Explicit device.task.* lifecycle (user hub) + run presence. No optimistic completion.
  useAwp([DEVICE_TASK_AWP_WILDCARD, 'run.*', 'agent.status'], (frame) => {
    if (frame.kind !== 'event') return;
    const topic = frame.topic ?? '';

    if (topic.startsWith('device.task.')) {
      const p = frame.payload;
      if (isDeviceTaskLifecyclePayload(p)) {
        invalidateDeviceTasks({ taskId: p.taskId, deviceId: p.deviceId });
        return;
      }
      // Unknown shape — still refresh list fail-safe, never invent status.
      void qc.invalidateQueries({ queryKey: ['device-tasks'] });
      return;
    }

    if (topic.startsWith('run.') || topic === 'agent.status') {
      const p = (frame.payload ?? {}) as { deviceId?: string; taskId?: string };
      if (p.taskId || p.deviceId) {
        invalidateDeviceTasks({ taskId: p.taskId, deviceId: p.deviceId });
      } else {
        invalidateDevices();
      }
    }
  });

  const devicesQ = useQuery({
    queryKey: ['devices'],
    queryFn: () => API.get<SafeDevice[]>('/api/devices'),
    enabled: isFde,
    refetchInterval: 12_000,
  });

  const agentsQ = useQuery({
    queryKey: ['agents', 'device-page'],
    queryFn: () => API.get<AgentOption[]>('/api/agents'),
    enabled: isFde,
    staleTime: 60_000,
  });

  const agentName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentsQ.data ?? []) map.set(a.id, a.name);
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [agentsQ.data]);

  const detailQ = useQuery({
    queryKey: ['device', selectedId],
    queryFn: () => API.get<DeviceDetail>(`/api/devices/${selectedId}`),
    enabled: isFde && !!selectedId,
    refetchInterval: 12_000,
  });

  const mcpQ = useQuery({
    queryKey: ['device-mcp', selectedId],
    queryFn: () => API.get<DeviceMcpInstallation[]>(`/api/devices/${selectedId}/mcp`),
    enabled: isFde && !!selectedId,
    refetchInterval: (q) => {
      const rows = q.state.data ?? [];
      const busy = rows.some((r) => r.status === 'REQUESTED' || r.status === 'INSTALLING');
      return busy ? 4000 : 20_000;
    },
  });

  const tasksQ = useQuery({
    queryKey: [
      'device-tasks',
      taskFilterDeviceId || null,
      taskFilterAgentId || null,
      taskFilterStatus || null,
      50,
    ],
    queryFn: () =>
      API.get<SafeDeviceTaskListItem[]>(
        deviceTasksQuery({
          deviceId: taskFilterDeviceId || undefined,
          agentId: taskFilterAgentId || undefined,
          status: taskFilterStatus || undefined,
          limit: 50,
        }),
      ),
    enabled: isFde,
    refetchInterval: 15_000,
  });

  function setMsg(ok: string | null, err: string | null) {
    setFlash(ok);
    setActionError(err);
  }

  const deviceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of devicesQ.data ?? []) map.set(d.id, d.name);
    return (id: string) => map.get(id) ?? id.slice(0, 10);
  }, [devicesQ.data]);

  const createMut = useMutation({
    mutationFn: (body: { name: string; platform: 'MACOS' | 'WINDOWS' | 'LINUX' }) =>
      API.post<SafeDevice>('/api/devices', body),
    onSuccess: (d) => {
      setMsg(`已建立裝置「${d.name}」`, null);
      setCreateOpen(false);
      setCreateName('');
      setSelectedId(d.id);
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => setMsg(null, errorMessage(e)),
  });

  const enrollMut = useMutation({
    mutationFn: (deviceId: string) =>
      API.post<EnrollCodeResult>(`/api/devices/${deviceId}/enroll-code`, {}),
    onSuccess: (data, deviceId) => {
      const name = devicesQ.data?.find((d) => d.id === deviceId)?.name ?? deviceId;
      // One-shot in React state only — never localStorage / console.
      setSecretModal({ kind: 'enroll', deviceName: name, data });
      setMsg('註冊碼已產生（僅顯示一次）', null);
    },
    onError: (e) => setMsg(null, errorMessage(e)),
  });

  const rotateMut = useMutation({
    mutationFn: (deviceId: string) =>
      API.post<RotateTokenResult>(`/api/devices/${deviceId}/rotate`),
    onSuccess: (data, deviceId) => {
      const name = devicesQ.data?.find((d) => d.id === deviceId)?.name ?? deviceId;
      setSecretModal({ kind: 'token', deviceName: name, token: data.token, prefix: data.device.tokenPrefix });
      setMsg('Token 已輪替（明文僅顯示一次，裝置需重新連線）', null);
      invalidateDevices();
    },
    onError: (e) => setMsg(null, errorMessage(e)),
  });

  const revokeMut = useMutation({
    mutationFn: (deviceId: string) => API.post<SafeDevice>(`/api/devices/${deviceId}/revoke`),
    onSuccess: (d) => {
      setMsg(`已撤銷裝置「${d.name}」`, null);
      invalidateDevices();
    },
    onError: (e) => setMsg(null, errorMessage(e)),
  });

  const installLineMut = useMutation({
    mutationFn: (deviceId: string) =>
      API.post<LineInstallResult>(`/api/devices/${deviceId}/mcp/line-desktop/install`),
    onSuccess: (r) => {
      // Do not claim READY — show install task and poll MCP status from server.
      setMsg(`已送出 LINE MCP 安裝請求（任務 ${r.taskId.slice(0, 10)}…）`, null);
      setActiveTaskId(r.taskId);
      void qc.invalidateQueries({ queryKey: ['device-mcp', selectedId] });
      void qc.invalidateQueries({ queryKey: ['device-task', r.taskId] });
      void qc.invalidateQueries({ queryKey: ['device-tasks'] });
    },
    onError: (e) => setMsg(null, errorMessage(e)),
  });

  const disableMcpMut = useMutation({
    mutationFn: ({ deviceId, mcpKey }: { deviceId: string; mcpKey: string }) =>
      API.post<DeviceMcpInstallation>(`/api/devices/${deviceId}/mcp/${encodeURIComponent(mcpKey)}/disable`),
    onSuccess: () => {
      setMsg('已停用 MCP 安裝', null);
      void qc.invalidateQueries({ queryKey: ['device-mcp', selectedId] });
    },
    onError: (e) => setMsg(null, errorMessage(e)),
  });

  const devices = devicesQ.data ?? [];
  const selected = detailQ.data ?? devices.find((d) => d.id === selectedId) ?? null;

  if (!isFde) {
    return (
      <AppShell>
        <EmptyState title="僅 FDE 可管理裝置" hint="MEMBER 請使用工作台" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="裝置 Devices"
        subtitle="註冊與管理執行裝置；電腦操控與 LINE 桌面 MCP 必須指定線上合格裝置"
        action={
          <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> 新增裝置
          </button>
        }
      />

      {(flash || actionError) && (
        <div
          className={cn(
            'mb-4 flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm',
            flash ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300',
          )}
          role={actionError ? 'alert' : 'status'}
        >
          <span>{flash ?? actionError}</span>
          <button type="button" className="btn-ghost p-1" onClick={() => setMsg(null, null)} aria-label="關閉訊息">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Recent tasks (primary) + optional direct ID lookup */}
      <section className="card mb-6 space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">最近裝置任務</h2>
          <button
            type="button"
            className="btn-ghost p-1.5"
            onClick={() => void tasksQ.refetch()}
            aria-label="重新整理任務清單"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', tasksQ.isFetching && 'animate-spin')} />
          </button>
        </div>
        <p className="text-xs text-muted">
          GET /api/device-tasks?deviceId=&amp;agentId=&amp;status=&amp;limit=50（metadata only）。狀態以伺服器為準，訂閱{' '}
          <span className="font-mono">device.task.*</span> 生命週期事件重抓，無樂觀完成。
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            className="input w-auto min-w-[10rem]"
            value={taskFilterDeviceId}
            onChange={(e) => setTaskFilterDeviceId(e.target.value)}
            aria-label="依裝置篩選"
          >
            <option value="">裝置：全部</option>
            {selectedId && (
              <option value={selectedId}>目前選取：{deviceNameById(selectedId)}</option>
            )}
            {(devicesQ.data ?? [])
              .filter((d) => d.id !== selectedId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
          <select
            className="input w-auto min-w-[10rem]"
            value={taskFilterAgentId}
            onChange={(e) => setTaskFilterAgentId(e.target.value)}
            aria-label="依員工篩選"
          >
            <option value="">員工：全部</option>
            {(agentsQ.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="input w-auto min-w-[9rem]"
            value={taskFilterStatus}
            onChange={(e) => setTaskFilterStatus(e.target.value as '' | DeviceTaskStatus)}
            aria-label="依狀態篩選"
          >
            <option value="">狀態：全部</option>
            {Object.entries(TASK_STATUS_ZH).map(([k, v]) => (
              <option key={k} value={k}>
                {v} ({k})
              </option>
            ))}
          </select>
          {taskFilterDeviceId && (
            <button type="button" className="btn-ghost text-xs" onClick={() => setTaskFilterDeviceId('')}>
              清除裝置篩選
            </button>
          )}
        </div>

        {tasksQ.isLoading && (
          <div className="flex justify-center py-6" role="status">
            <Spinner />
          </div>
        )}
        {tasksQ.isError && (
          <p className="text-sm text-rose-400" role="alert">
            任務清單載入失敗：{errorMessage(tasksQ.error)}
          </p>
        )}
        {!tasksQ.isLoading && !tasksQ.isError && (tasksQ.data ?? []).length === 0 && (
          <p className="text-sm text-muted">尚無符合條件的任務</p>
        )}
        {!tasksQ.isLoading && (tasksQ.data ?? []).length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-border bg-black/10 text-muted dark:bg-white/5">
                <tr>
                  <th className="px-3 py-2 font-medium">建立</th>
                  <th className="px-3 py-2 font-medium">狀態</th>
                  <th className="px-3 py-2 font-medium">類型</th>
                  <th className="px-3 py-2 font-medium">裝置</th>
                  <th className="px-3 py-2 font-medium">員工 / Run</th>
                  <th className="px-3 py-2 font-medium">Task ID</th>
                </tr>
              </thead>
              <tbody>
                {(tasksQ.data ?? []).map((t) => {
                  const active = activeTaskId === t.id;
                  return (
                    <tr
                      key={t.id}
                      className={cn(
                        'cursor-pointer border-b border-border/60 transition-colors hover:bg-brand/5',
                        active && 'bg-brand/10',
                      )}
                      onClick={() => setActiveTaskId(t.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveTaskId(t.id);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`開啟任務 ${t.id}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-muted">{relativeTime(t.createdAt)}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={String(t.status)} />
                        <span className="ml-1 text-muted">{taskStatusLabel(String(t.status))}</span>
                        {t.confirmationRequired && t.status === 'AWAITING_CONFIRM' && (
                          <span className="ml-1 text-amber-300">檢查點</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{TASK_KIND_ZH[String(t.kind)] ?? t.kind}</td>
                      <td className="px-3 py-2">
                        <span className="block truncate max-w-[8rem]" title={t.deviceId}>
                          {deviceNameById(t.deviceId)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {t.agentId ? agentName(t.agentId) : '—'}
                        {t.stepKey ? ` · ${t.stepKey}` : ''}
                        {t.runId ? (
                          <span className="block font-mono text-[10px] truncate max-w-[10rem]" title={t.runId}>
                            run {t.runId.slice(0, 12)}…
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px]">
                        <span className="truncate max-w-[8rem] inline-block" title={t.id}>
                          {t.id.slice(0, 14)}…
                        </span>
                        {t.hasLease && <span className="ml-1 text-muted">lease</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none text-muted hover:text-fg">進階：以 Task ID 直接開啟</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              className="input max-w-md font-mono text-xs"
              placeholder="Device Task ID"
              value={taskIdInput}
              onChange={(e) => setTaskIdInput(e.target.value.trim())}
              aria-label="裝置任務 ID"
            />
            <button
              type="button"
              className="btn-ghost"
              disabled={!taskIdInput}
              onClick={() => setActiveTaskId(taskIdInput)}
            >
              <Search className="h-4 w-4" /> 開啟詳情
            </button>
          </div>
          <p className="mt-1">GET /api/device-tasks/:taskId（完整列）；確認／拒絕僅在 AWAITING_CONFIRM 且有權時可用。</p>
        </details>
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* List */}
        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted">裝置清單</h2>
            <button
              type="button"
              className="btn-ghost p-1.5"
              onClick={() => void devicesQ.refetch()}
              aria-label="重新整理裝置清單"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', devicesQ.isFetching && 'animate-spin')} />
            </button>
          </div>

          {devicesQ.isLoading && (
            <div className="flex justify-center py-12" role="status">
              <Spinner className="h-6 w-6" />
            </div>
          )}
          {devicesQ.isError && (
            <p className="text-sm text-rose-400" role="alert">
              載入失敗：{errorMessage(devicesQ.error)}
            </p>
          )}
          {!devicesQ.isLoading && !devicesQ.isError && devices.length === 0 && (
            <EmptyState title="尚無裝置" hint="點「新增裝置」建立列，再產生一次性註冊碼給 macOS App 註冊" />
          )}

          <ul className="space-y-2" aria-label="裝置列表">
            {devices.map((d) => {
              const online = d.online === true;
              const active = selectedId === d.id;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    className={cn(
                      'w-full rounded-xl border px-3 py-3 text-left transition-colors',
                      active
                        ? 'border-brand/50 bg-brand/10'
                        : 'border-border bg-panel hover:bg-black/5 dark:hover:bg-white/5',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Laptop className="h-4 w-4 shrink-0 text-muted" />
                          <span className="truncate font-medium">{d.name}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <span>{platformLabel(d.platform)}</span>
                          <StatusBadge status={String(d.status)} />
                          <span className="text-muted">{deviceStatusLabel(String(d.status))}</span>
                        </div>
                      </div>
                      <span
                        className={cn(
                          'badge shrink-0',
                          online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-500/15 text-zinc-400',
                        )}
                      >
                        {online ? (
                          <>
                            <Wifi className="mr-1 h-3 w-3" /> 線上
                          </>
                        ) : (
                          <>
                            <WifiOff className="mr-1 h-3 w-3" /> 離線
                          </>
                        )}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">
                      心跳 {relativeTime(d.lastSeenAt)}
                      {d.tokenPrefix ? ` · token ${d.tokenPrefix}…` : ' · 未核發 token'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Detail */}
        <div className="space-y-4 lg:col-span-3">
          {!selectedId && (
            <EmptyState title="選擇左側裝置" hint="檢視能力、綁定員工、註冊碼、LINE MCP 與任務" />
          )}
          {selectedId && detailQ.isLoading && !selected && (
            <div className="flex justify-center py-16">
              <Spinner className="h-6 w-6" />
            </div>
          )}
          {selectedId && detailQ.isError && (
            <p className="text-sm text-rose-400">無法載入裝置：{errorMessage(detailQ.error)}</p>
          )}
          {selected && (
            <DeviceDetailCard
              device={selected}
              mcpInstalls={mcpQ.data ?? []}
              mcpLoading={mcpQ.isLoading}
              agentName={agentName}
              busy={{
                enroll: enrollMut.isPending,
                rotate: rotateMut.isPending,
                revoke: revokeMut.isPending,
                install: installLineMut.isPending,
                disable: disableMcpMut.isPending,
              }}
              onEnroll={() => {
                if (!window.confirm(`為「${selected.name}」產生一次性註冊碼？舊碼仍可能在效期內有效。`)) return;
                enrollMut.mutate(selected.id);
              }}
              onRotate={() => {
                if (
                  !window.confirm(
                    `輪替「${selected.name}」的裝置 token？舊 token 立即失效，裝置需以新 token 重新連線。`,
                  )
                )
                  return;
                rotateMut.mutate(selected.id);
              }}
              onRevoke={() => {
                if (
                  !window.confirm(
                    `確定撤銷裝置「${selected.name}」？此為安全操作，裝置將立即斷線且無法再認證。`,
                  )
                )
                  return;
                revokeMut.mutate(selected.id);
              }}
              onInstallLine={() => {
                if (selected.online !== true) {
                  setMsg(null, '裝置必須在線才能安裝 LINE MCP');
                  return;
                }
                if (!window.confirm(`對「${selected.name}」送出固定版本 LINE Desktop MCP 安裝任務？`)) return;
                installLineMut.mutate(selected.id);
              }}
              onDisableMcp={(mcpKey) => {
                if (!window.confirm(`停用 ${mcpKey}？`)) return;
                disableMcpMut.mutate({ deviceId: selected.id, mcpKey });
              }}
            />
          )}

          {activeTaskId && (
            <DeviceTaskPanel taskId={activeTaskId} onClose={() => setActiveTaskId(null)} />
          )}
        </div>
      </div>

      {/* Create modal */}
      {createOpen && (
        <Modal title="新增執行裝置" onClose={() => !createMut.isPending && setCreateOpen(false)}>
          <div className="space-y-3">
            <Field label="名稱">
              <input
                className="input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="例如：Kevin 的 MacBook"
                autoFocus
              />
            </Field>
            <Field label="平台">
              <select
                className="input"
                value={createPlatform}
                onChange={(e) => setCreatePlatform(e.target.value as typeof createPlatform)}
              >
                <option value="MACOS">macOS</option>
                <option value="WINDOWS">Windows（契約；本倉庫無 runtime）</option>
                <option value="LINUX">Linux</option>
              </select>
            </Field>
            <p className="text-xs text-muted">建立後請產生一次性註冊碼，於裝置端 App 輸入完成註冊。</p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setCreateOpen(false)} disabled={createMut.isPending}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!createName.trim() || createMut.isPending}
                onClick={() => createMut.mutate({ name: createName.trim(), platform: createPlatform })}
              >
                {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                建立
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* One-shot secret modal */}
      {secretModal && (
        <SecretOnceModal
          modal={secretModal}
          onClose={() => setSecretModal(null)}
        />
      )}
    </AppShell>
  );
}

// ── Detail card ─────────────────────────────────────────────────────────────

function DeviceDetailCard({
  device,
  mcpInstalls,
  mcpLoading,
  agentName,
  busy,
  onEnroll,
  onRotate,
  onRevoke,
  onInstallLine,
  onDisableMcp,
}: {
  device: DeviceDetail | SafeDevice;
  mcpInstalls: DeviceMcpInstallation[];
  mcpLoading: boolean;
  agentName: (id: string) => string;
  busy: { enroll: boolean; rotate: boolean; revoke: boolean; install: boolean; disable: boolean };
  onEnroll: () => void;
  onRotate: () => void;
  onRevoke: () => void;
  onInstallLine: () => void;
  onDisableMcp: (mcpKey: string) => void;
}) {
  const online = device.online === true;
  const caps = parseCapabilities(device.capabilities);
  const features = caps?.features;
  const bindings = 'agentBindings' in device ? device.agentBindings ?? [] : [];
  const revoked = device.status === 'REVOKED';

  const lineInstall = mcpInstalls.find(
    (m) => m.mcpKey === 'line-desktop-mcp' || m.packageName === 'line-desktop-mcp',
  );

  return (
    <div className="card space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <MonitorSmartphone className="h-5 w-5 text-brand" />
            {device.name}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-muted">{device.id}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge status={String(device.status)} />
          <span className={cn('badge', online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-500/15 text-zinc-400')}>
            {online ? '線上' : '離線'}
          </span>
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Info label="平台" value={platformLabel(device.platform)} />
        <Info label="狀態" value={deviceStatusLabel(String(device.status))} />
        <Info label="心跳" value={relativeTime(device.lastSeenAt)} />
        <Info label="Token 前綴" value={device.tokenPrefix ? `${device.tokenPrefix}…` : '—'} mono />
        <Info label="OS 版本" value={device.osVersion ?? caps?.osVersion ?? '—'} />
        <Info label="App 版本" value={device.appVersion ?? caps?.appVersion ?? '—'} />
        <Info
          label="註冊時間"
          value={device.enrolledAt ? new Date(device.enrolledAt).toLocaleString('zh-Hant-TW') : '尚未註冊'}
        />
        <Info
          label="建立時間"
          value={device.createdAt ? new Date(device.createdAt).toLocaleString('zh-Hant-TW') : '—'}
        />
      </dl>

      {/* Capabilities */}
      <section>
        <h3 className="mb-2 text-xs font-medium text-muted">能力 Capabilities</h3>
        {!features ? (
          <p className="text-xs text-muted">裝置尚未回報能力文件</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <CapChip on={!!features.computerUse} label="Computer Use" />
            <CapChip on={!!features.codexApp} label="Codex App" />
            <CapChip on={!!features.codexCli} label="Codex CLI" />
            <CapChip on={!!features.lineDesktop} label="LINE Desktop" />
            <CapChip on={!!features.screenshot} label="截圖 Screenshot" />
            <CapChip on={!!features.screenRecording} label="螢幕錄製" />
            <CapChip on={!!features.accessibility} label="輔助使用 Accessibility" />
          </div>
        )}
        {features && (
          <p className="mt-1.5 text-[11px] text-muted">
            Codex App / CLI / LINE Desktop 為獨立能力旗標，不可由 computerUse 推斷。
          </p>
        )}
        {caps?.mcpServers && caps.mcpServers.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {caps.mcpServers.map((s) => (
              <li key={`${s.name}-${s.version}`} className="font-mono">
                回報 MCP：{s.name}@{s.version}
                {s.tools?.length ? ` · tools: ${s.tools.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* LINE MCP */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted">LINE Desktop MCP</h3>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={revoked || busy.install || device.status !== 'ACTIVE'}
              onClick={onInstallLine}
              title={online ? '安裝固定版本 line-desktop-mcp' : '需線上'}
            >
              {busy.install ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              安裝／重試
            </button>
            {lineInstall && lineInstall.status !== 'DISABLED' && (
              <button
                type="button"
                className="btn-ghost text-xs text-rose-400"
                disabled={busy.disable}
                onClick={() => onDisableMcp(lineInstall.mcpKey)}
              >
                <PowerOff className="h-3.5 w-3.5" /> 停用
              </button>
            )}
          </div>
        </div>
        {mcpLoading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" /> 載入 MCP 安裝狀態…
          </div>
        )}
        {!mcpLoading && !lineInstall && (
          <p className="text-xs text-muted">尚未請求安裝。版本由伺服器固定清單鎖定，客戶端不可覆寫。</p>
        )}
        {lineInstall && (
          <div className="rounded-lg border border-border bg-black/10 p-3 text-sm dark:bg-white/5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{lineInstall.packageName}</span>
              <span className="font-mono text-xs text-muted">v{lineInstall.version}</span>
              <StatusBadge status={String(lineInstall.status)} />
              <span className="text-xs text-muted">{mcpStatusLabel(String(lineInstall.status))}</span>
            </div>
            <p className="mt-1 break-all font-mono text-[10px] text-muted">sha256:{lineInstall.sha256}</p>
            {lineInstall.toolAllowlist?.length > 0 && (
              <p className="mt-1 text-xs text-muted">工具：{lineInstall.toolAllowlist.join(', ')}</p>
            )}
            {lineInstall.lastError && (
              <p className="mt-1 text-xs text-rose-400">{lineInstall.lastError}</p>
            )}
            {(lineInstall.status === 'REQUESTED' || lineInstall.status === 'INSTALLING') && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                安裝進行中 — 不以樂觀成功顯示就緒；狀態由裝置回報後更新。
              </p>
            )}
          </div>
        )}
      </section>

      {/* Bindings */}
      <section>
        <h3 className="mb-2 text-xs font-medium text-muted">綁定員工 Agents</h3>
        {bindings.length === 0 ? (
          <p className="text-xs text-muted">尚未綁定任何員工。請至員工詳情 → 裝置分頁綁定。</p>
        ) : (
          <ul className="space-y-1">
            {bindings.map((b) => (
              <li key={b.agentId} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <a className="text-brand hover:underline" href={`/employees/${b.agentId}?tab=devices`}>
                  {agentName(b.agentId)}
                </a>
                <span className="text-[11px] text-muted">綁定於 {relativeTime(b.boundAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <button type="button" className="btn-primary" disabled={revoked || busy.enroll} onClick={onEnroll}>
          {busy.enroll ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          產生註冊碼
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={revoked || device.status === 'PENDING_ENROLLMENT' || busy.rotate}
          onClick={onRotate}
        >
          {busy.rotate ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          輪替 Token
        </button>
        <button
          type="button"
          className="btn-ghost text-rose-400"
          disabled={revoked || busy.revoke}
          onClick={onRevoke}
        >
          {busy.revoke ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
          撤銷裝置
        </button>
      </div>
    </div>
  );
}

function CapChip({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        'badge border',
        on ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-border bg-black/5 text-muted dark:bg-white/5',
      )}
    >
      {on ? <Check className="mr-1 h-3 w-3" /> : <X className="mr-1 h-3 w-3 opacity-50" />}
      {label}
    </span>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('mt-0.5', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card w-full max-w-md p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button type="button" className="btn-ghost p-1.5" onClick={onClose} aria-label="關閉">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SecretOnceModal({ modal, onClose }: { modal: SecretModal; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const secret = modal.kind === 'enroll' ? modal.data.code : modal.token;

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <Modal
      title={modal.kind === 'enroll' ? '一次性註冊碼' : '新裝置 Token'}
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="text-sm text-amber-200">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          此密文<strong>只顯示一次</strong>，關閉後無法再查。請立即複製到裝置端；不會寫入 localStorage 或日誌。
        </p>
        <p className="text-xs text-muted">裝置：{modal.deviceName}</p>
        {modal.kind === 'enroll' && (
          <p className="text-xs text-muted">
            效期至 {new Date(modal.data.expiresAt).toLocaleString('zh-Hant-TW')} · 前綴 {modal.data.codePrefix}…
          </p>
        )}
        {modal.kind === 'token' && modal.prefix && (
          <p className="text-xs text-muted">前綴 {modal.prefix}…（之後清單只顯示前綴）</p>
        )}
        <div className="rounded-lg border border-border bg-black/30 p-3 font-mono text-xs break-all select-all">
          {secret}
        </div>
        <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
          {modal.kind === 'enroll' ? (
            <>
              <li>在裝置端 AIOS / macOS Device Agent 開啟註冊流程</li>
              <li>貼上上方註冊碼完成 enroll</li>
              <li>確認裝置狀態變為 ACTIVE 且出現線上</li>
            </>
          ) : (
            <>
              <li>將新 token 寫入裝置安全儲存（Keychain）</li>
              <li>重啟裝置連線；舊連線已中斷</li>
              <li>確認線上後再派送任務</li>
            </>
          )}
        </ol>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={copy}>
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            {copied ? '已複製' : '複製'}
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            我已安全保存，關閉
          </button>
        </div>
      </div>
    </Modal>
  );
}
