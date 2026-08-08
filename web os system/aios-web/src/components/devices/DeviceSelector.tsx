'use client';

/**
 * Capability-aware device picker for COMPUTER_CONTROL / device-mcp:line-desktop.
 * - Lists only online eligible devices from GET /api/agents/:id/eligible-devices
 * - Preserves an existing offline/ineligible binding as a disabled option with reason
 * - Never silently switches devices
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, MonitorSmartphone, WifiOff } from 'lucide-react';
import { API } from '@/lib/api';
import {
  type AgentDeviceBinding,
  type EligibilityRequirement,
  type EligibleDevicesResponse,
  type SafeEligibleDevice,
  platformLabel,
  relativeTime,
  errorMessage,
} from '@/lib/devices';
import { cn } from '@/lib/cn';
import { Spinner } from '@/components/ui';

export interface DeviceSelectorProps {
  agentId: string;
  requirement: EligibilityRequirement;
  /** Currently configured deviceId (may be offline). */
  value: string;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** When true, empty selection is invalid for save (caller enforces). */
  required?: boolean;
}

export function DeviceSelector({
  agentId,
  requirement,
  value,
  onChange,
  disabled,
  id,
  className,
  required = true,
}: DeviceSelectorProps) {
  const eligibleQ = useQuery({
    queryKey: ['eligible-devices', agentId, requirement],
    queryFn: () =>
      API.get<EligibleDevicesResponse>(
        `/api/agents/${agentId}/eligible-devices?requirement=${encodeURIComponent(requirement)}`,
      ),
    enabled: !!agentId && !!requirement,
    refetchInterval: 15_000,
  });

  // Bound devices (includes offline) — used only to label preserved selection.
  const bindingsQ = useQuery({
    queryKey: ['agent-devices', agentId],
    queryFn: () => API.get<AgentDeviceBinding[]>(`/api/agents/${agentId}/devices`),
    enabled: !!agentId && !!value,
    staleTime: 10_000,
  });

  const eligible = eligibleQ.data?.devices ?? [];
  const eligibleIds = useMemo(() => new Set(eligible.map((d) => d.id)), [eligible]);

  const selectedInEligible = value ? eligibleIds.has(value) : false;
  const preservedBinding = useMemo(() => {
    if (!value || selectedInEligible) return null;
    const row = (bindingsQ.data ?? []).find((b) => b.deviceId === value);
    return row ?? null;
  }, [value, selectedInEligible, bindingsQ.data]);

  const preservedReason = useMemo(() => {
    if (!value || selectedInEligible) return null;
    if (preservedBinding) {
      const d = preservedBinding.device;
      if (d.online === false || d.online === undefined) {
        if (d.status && d.status !== 'ACTIVE') {
          return `目前設定的裝置不可用：狀態 ${d.status}（離線／不合格）。請明確選擇其他線上裝置後再儲存。`;
        }
        return '目前設定的裝置離線或不合格。請明確選擇其他線上可用裝置後再儲存（系統不會自動切換）。';
      }
      if (d.status !== 'ACTIVE') {
        return `目前設定的裝置狀態為 ${d.status}，不符合執行條件。請明確選擇其他裝置。`;
      }
      return '目前設定的裝置目前不合格（能力／綁定／MCP 等）。請明確選擇其他線上可用裝置。';
    }
    if (bindingsQ.isLoading || bindingsQ.isFetching) return '正在檢查既有裝置綁定…';
    return '目前設定的裝置不在可用清單中（可能已解除綁定、離線或撤銷）。請明確選擇線上可用裝置。';
  }, [value, selectedInEligible, preservedBinding, bindingsQ.isLoading, bindingsQ.isFetching]);

  const needsReplacement = Boolean(value && !selectedInEligible);

  return (
    <div className={cn('space-y-2', className)}>
      <label className="block space-y-1" htmlFor={id}>
        <span className="label flex items-center gap-1.5">
          <MonitorSmartphone className="h-3.5 w-3.5" />
          執行裝置 Device
          {required && <span className="text-rose-400">*</span>}
        </span>
        {eligibleQ.isLoading && (
          <div className="flex items-center gap-2 py-2 text-xs text-muted" role="status">
            <Spinner className="h-3.5 w-3.5" /> 載入可用裝置…
          </div>
        )}
        {eligibleQ.isError && (
          <p className="text-xs text-rose-400" role="alert">
            無法載入可用裝置：{errorMessage(eligibleQ.error)}
          </p>
        )}
        {!eligibleQ.isLoading && !eligibleQ.isError && (
          <select
            id={id}
            className={cn('input', needsReplacement && 'border-amber-500/50')}
            value={needsReplacement ? `__preserve__:${value}` : value}
            disabled={disabled || eligibleQ.isLoading}
            aria-invalid={needsReplacement || (required && !value)}
            aria-describedby={needsReplacement ? `${id ?? 'device'}-warn` : undefined}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('__preserve__:')) {
                // Keep original; user must pick a real eligible option.
                return;
              }
              onChange(v);
            }}
          >
            <option value="">{required ? '— 請選擇線上可用裝置 —' : '— 未指定 —'}</option>
            {needsReplacement && (
              <option value={`__preserve__:${value}`} disabled>
                {preservedBinding
                  ? `⚠ ${preservedBinding.device.name}（${platformLabel(preservedBinding.device.platform)} · 不可用）`
                  : `⚠ 既有裝置 ${value.slice(0, 10)}…（不可用）`}
              </option>
            )}
            {eligible.map((d) => (
              <EligibleOption key={d.id} device={d} />
            ))}
          </select>
        )}
      </label>

      {!eligibleQ.isLoading && !eligibleQ.isError && eligible.length === 0 && !needsReplacement && (
        <p className="flex items-start gap-1.5 text-xs text-amber-400">
          <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          目前沒有符合條件的線上裝置。請先在「裝置」分頁綁定裝置，並確認裝置在線、具備所需能力
          {requirement === 'line_desktop' ? '（含 LINE MCP 就緒）' : '（電腦操控／截圖）'}。
        </p>
      )}

      {needsReplacement && preservedReason && (
        <p
          id={`${id ?? 'device'}-warn`}
          className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {preservedReason}
            {preservedBinding?.device.lastSeenAt && (
              <span className="mt-0.5 block text-muted">
                最後心跳：{relativeTime(preservedBinding.device.lastSeenAt)}
              </span>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

function EligibleOption({ device }: { device: SafeEligibleDevice }) {
  const feats: string[] = [];
  if (device.features?.computerUse) feats.push('Computer Use');
  if (device.features?.codexApp) feats.push('Codex App');
  if (device.features?.codexCli) feats.push('Codex CLI');
  if (device.features?.lineDesktop) feats.push('LINE Desktop');
  if (device.features?.screenshot) feats.push('截圖');
  if (device.features?.accessibility) feats.push('輔助使用');
  return (
    <option value={device.id}>
      {device.name} · {platformLabel(device.platform)} · 線上
      {feats.length ? ` · ${feats.join('/')}` : ''}
    </option>
  );
}

/** True when selector value is saveable (empty only if not required; never offline preserve). */
export function isDeviceSelectionValid(opts: {
  value: string;
  eligibleIds: Set<string>;
  required?: boolean;
}): boolean {
  const required = opts.required !== false;
  if (!opts.value.trim()) return !required;
  return opts.eligibleIds.has(opts.value);
}
