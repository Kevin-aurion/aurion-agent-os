'use client';

/**
 * Device task / checkpoint evidence panel.
 * Uses only backend REST shapes: GET /api/device-tasks/:id, artifacts, confirm/reject.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { API } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import {
  type DeviceArtifactMeta,
  type DeviceTask,
  buildTaskTimeline,
  errorMessage,
  fetchDeviceArtifactBlob,
  relativeTime,
  taskStatusLabel,
  TASK_KIND_ZH,
} from '@/lib/devices';
import { cn } from '@/lib/cn';
import { EmptyState, Spinner, StatusBadge } from '@/components/ui';

export interface DeviceTaskPanelProps {
  taskId: string | null;
  onClose?: () => void;
  className?: string;
}

export function DeviceTaskPanel({ taskId, onClose, className }: DeviceTaskPanelProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [rejectReason, setRejectReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const taskQ = useQuery({
    queryKey: ['device-task', taskId],
    queryFn: () => API.get<DeviceTask>(`/api/device-tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (!s) return false;
      if (['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(String(s))) return false;
      return 3000;
    },
  });

  const task = taskQ.data;
  const timeline = useMemo(() => (task ? buildTaskTimeline(task) : []), [task]);

  const canDecide = useMemo(() => {
    if (!task || !user) return false;
    if (task.status !== 'AWAITING_CONFIRM') return false;
    if (isFdeRole(user.role)) return true;
    return task.requestedByUserId === user.id;
  }, [task, user]);

  const confirmMut = useMutation({
    mutationFn: () => API.post<DeviceTask>(`/api/device-tasks/${taskId}/confirm`),
    onSuccess: () => {
      setActionError(null);
      setActionOk('已確認檢查點，任務繼續執行');
      // Server is source of truth — invalidate, no local status patch.
      void qc.invalidateQueries({ queryKey: ['device-task', taskId] });
      void qc.invalidateQueries({ queryKey: ['device-tasks'] });
    },
    onError: (e) => {
      setActionOk(null);
      setActionError(errorMessage(e));
    },
  });

  const rejectMut = useMutation({
    mutationFn: () =>
      API.post<DeviceTask>(`/api/device-tasks/${taskId}/reject`, {
        reason: rejectReason.trim() || undefined,
      }),
    onSuccess: () => {
      setActionError(null);
      setActionOk('已拒絕檢查點，任務已取消');
      void qc.invalidateQueries({ queryKey: ['device-task', taskId] });
      void qc.invalidateQueries({ queryKey: ['device-tasks'] });
    },
    onError: (e) => {
      setActionOk(null);
      setActionError(errorMessage(e));
    },
  });

  if (!taskId) {
    return (
      <div className={cn('card p-6', className)}>
        <EmptyState title="尚未選擇任務" hint="輸入任務 ID，或從安裝／執行紀錄開啟詳情" />
      </div>
    );
  }

  return (
    <div className={cn('card flex flex-col', className)} role="region" aria-label="裝置任務詳情">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">任務檢查點與證據</h3>
          <p className="truncate font-mono text-[11px] text-muted">{taskId}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost p-2"
            onClick={() => void taskQ.refetch()}
            title="重新整理"
            aria-label="重新整理任務"
          >
            <RefreshCw className={cn('h-4 w-4', taskQ.isFetching && 'animate-spin')} />
          </button>
          {onClose && (
            <button type="button" className="btn-ghost p-2" onClick={onClose} aria-label="關閉">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-4 p-4">
        {taskQ.isLoading && (
          <div className="flex justify-center py-10" role="status">
            <Spinner className="h-6 w-6" />
          </div>
        )}
        {taskQ.isError && (
          <p className="text-sm text-rose-400" role="alert">
            無法載入任務：{errorMessage(taskQ.error)}
          </p>
        )}

        {task && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={String(task.status)} />
              <span className="text-muted">{taskStatusLabel(String(task.status))}</span>
              <span className="badge bg-black/10 dark:bg-white/10">
                {TASK_KIND_ZH[String(task.kind)] ?? task.kind}
              </span>
            </div>

            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted">Device ID</dt>
                <dd className="font-mono break-all">{task.deviceId}</dd>
              </div>
              <div>
                <dt className="text-muted">Task ID</dt>
                <dd className="font-mono break-all">{task.id}</dd>
              </div>
              {task.agentId && (
                <div>
                  <dt className="text-muted">Agent ID</dt>
                  <dd className="font-mono break-all">{task.agentId}</dd>
                </div>
              )}
              {task.runId && (
                <div>
                  <dt className="text-muted">Run ID</dt>
                  <dd className="font-mono break-all">{task.runId}</dd>
                </div>
              )}
              {task.stepKey && (
                <div>
                  <dt className="text-muted">Step</dt>
                  <dd className="font-mono">{task.stepKey}</dd>
                </div>
              )}
              {task.leaseExpiresAt && (
                <div>
                  <dt className="text-muted">Lease 到期</dt>
                  <dd>{new Date(task.leaseExpiresAt).toLocaleString('zh-Hant-TW')}</dd>
                </div>
              )}
            </dl>

            <section>
              <h4 className="mb-2 text-xs font-medium text-muted">狀態時間線</h4>
              <ol className="space-y-2 border-l border-border pl-4">
                {timeline.map((item) => (
                  <li key={item.key} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand" />
                    <div className="font-medium">{item.label}</div>
                    {item.at && (
                      <div className="text-xs text-muted">
                        {relativeTime(item.at)} · {new Date(item.at).toLocaleString('zh-Hant-TW')}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </section>

            {task.confirmationArtifactId && (
              <section>
                <h4 className="mb-2 text-xs font-medium text-muted">確認截圖 Artifact</h4>
                <ArtifactPreview artifactId={task.confirmationArtifactId} />
              </section>
            )}

            {task.progress != null && (
              <section>
                <h4 className="mb-1 text-xs font-medium text-muted">進度 Progress</h4>
                <pre className="max-h-32 overflow-auto rounded-lg bg-black/20 p-2 text-[11px]">
                  {typeof task.progress === 'string' ? task.progress : JSON.stringify(task.progress, null, 2)}
                </pre>
              </section>
            )}

            {task.error != null && (
              <section>
                <h4 className="mb-1 text-xs font-medium text-rose-400">錯誤</h4>
                <pre className="max-h-32 overflow-auto rounded-lg bg-rose-500/10 p-2 text-[11px] text-rose-200">
                  {typeof task.error === 'string' ? task.error : JSON.stringify(task.error, null, 2)}
                </pre>
              </section>
            )}

            {task.result != null && (
              <section>
                <h4 className="mb-1 text-xs font-medium text-muted">結果 Result</h4>
                <pre className="max-h-40 overflow-auto rounded-lg bg-black/20 p-2 text-[11px]">
                  {typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2)}
                </pre>
              </section>
            )}

            {canDecide && (
              <section className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-sm font-medium text-amber-200">此任務等待您確認檢查點</p>
                <p className="text-xs text-muted">請先檢視截圖證據，再核准繼續或拒絕取消。操作會寫入伺服器，無樂觀成功。</p>
                <FieldReject reason={rejectReason} onChange={setRejectReason} />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={confirmMut.isPending || rejectMut.isPending}
                    onClick={() => {
                      if (!window.confirm('確認此檢查點並讓裝置繼續執行？')) return;
                      setActionOk(null);
                      confirmMut.mutate();
                    }}
                  >
                    {confirmMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    確認繼續
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-rose-400"
                    disabled={confirmMut.isPending || rejectMut.isPending}
                    onClick={() => {
                      if (!window.confirm('拒絕檢查點並取消此任務？')) return;
                      setActionOk(null);
                      rejectMut.mutate();
                    }}
                  >
                    {rejectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    拒絕取消
                  </button>
                </div>
              </section>
            )}

            {task.status === 'AWAITING_CONFIRM' && !canDecide && (
              <p className="text-xs text-muted">
                任務等待確認，但目前登入者無權核准（僅請求者或 FDE）。
              </p>
            )}

            {actionOk && <p className="text-xs text-emerald-400" role="status">{actionOk}</p>}
            {actionError && (
              <p className="text-xs text-rose-400" role="alert">
                {actionError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FieldReject({ reason, onChange }: { reason: string; onChange: (v: string) => void }) {
  return (
    <label className="block space-y-1">
      <span className="label">拒絕原因（選填）</span>
      <input
        className="input"
        value={reason}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例如：截圖顯示錯誤視窗"
        maxLength={2000}
      />
    </label>
  );
}

function ArtifactPreview({ artifactId }: { artifactId: string }) {
  const metaQ = useQuery({
    queryKey: ['device-artifact', artifactId],
    queryFn: () => API.get<DeviceArtifactMeta>(`/api/device-artifacts/${artifactId}`),
  });

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);
  const [loadingBlob, setLoadingBlob] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    setBlobUrl(null);
    setBlobError(null);
    setLoadingBlob(true);
    (async () => {
      try {
        const blob = await fetchDeviceArtifactBlob(artifactId);
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch (e) {
        if (!revoked) setBlobError(errorMessage(e));
      } finally {
        if (!revoked) setLoadingBlob(false);
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifactId]);

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <ImageIcon className="h-3.5 w-3.5" />
        <span className="font-mono">{artifactId}</span>
        {metaQ.data && (
          <>
            <span>{metaQ.data.kind}</span>
            <span>{metaQ.data.mimeType}</span>
            <span>{Math.round(metaQ.data.sizeBytes / 1024)} KB</span>
            {metaQ.data.redacted && <span className="text-emerald-400">已遮罩</span>}
          </>
        )}
      </div>
      {metaQ.isError && (
        <p className="text-xs text-rose-400">中繼資料載入失敗：{errorMessage(metaQ.error)}</p>
      )}
      {loadingBlob && (
        <div className="flex items-center gap-2 py-6 text-xs text-muted" role="status">
          <Spinner /> 載入影像…
        </div>
      )}
      {blobError && <p className="text-xs text-rose-400">{blobError}</p>}
      {blobUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={blobUrl}
          alt={`任務截圖 artifact ${artifactId}`}
          className="max-h-96 w-full rounded-md border border-border object-contain bg-black/40"
        />
      )}
    </div>
  );
}
