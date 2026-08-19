/**
 * Device platform types + helpers for FDE device UI.
 * Never persist enrollment codes or device tokens (memory only for one-shot display).
 */
import { tokens, ApiError, refreshAccess } from './api';

// ── Domain types (mirror backend SafeDevice / DeviceTask public shapes) ─────

export type DevicePlatform = 'MACOS' | 'WINDOWS' | 'LINUX';
export type DeviceStatus = 'PENDING_ENROLLMENT' | 'ACTIVE' | 'REVOKED' | 'DISABLED';

export type DeviceTaskStatus =
  | 'PENDING'
  | 'DISPATCHED'
  | 'ACKED'
  | 'RUNNING'
  | 'AWAITING_CONFIRM'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';

export type DeviceTaskKind =
  | 'COMPUTER_CONTROL'
  | 'MCP_TOOL'
  | 'SCREENSHOT'
  | 'CAPABILITY_PROBE'
  | 'LINE_DESKTOP'
  | 'MCP_INSTALL';

export type DeviceMcpStatus = 'REQUESTED' | 'INSTALLING' | 'READY' | 'ERROR' | 'DISABLED';

export type EligibilityRequirement = 'computer_use' | 'line_desktop' | 'screenshot';

export interface DeviceFeatures {
  computerUse: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  screenshot: boolean;
  /** Codex App / Computer Use host present — not implied by computerUse alone. */
  codexApp?: boolean;
  /** Codex CLI available on device. */
  codexCli?: boolean;
  /** LINE Desktop app present for line-desktop-mcp. */
  lineDesktop?: boolean;
}

export interface DeviceMcpServerCap {
  name: string;
  version: string;
  sha256?: string;
  tools: string[];
}

export interface DeviceCapabilitiesDoc {
  platform?: DevicePlatform | string;
  osVersion?: string;
  appVersion?: string;
  features?: DeviceFeatures;
  mcpServers?: DeviceMcpServerCap[];
  updatedAt?: string;
}

/** Safe device from GET /api/devices (tokenHash stripped). */
export interface SafeDevice {
  id: string;
  ownerUserId: string;
  name: string;
  platform: DevicePlatform | string;
  status: DeviceStatus | string;
  tokenHash?: undefined;
  tokenPrefix?: string | null;
  capabilities?: DeviceCapabilitiesDoc | null;
  lastSeenAt?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
  enrolledAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Server-computed from live device WS + heartbeat. Never invent. */
  online?: boolean;
}

export interface DeviceDetail extends SafeDevice {
  agentBindings?: Array<{
    agentId: string;
    boundAt: string;
    boundBy?: string | null;
  }>;
}

export interface AgentDeviceBinding {
  agentId: string;
  deviceId: string;
  boundAt: string;
  boundBy?: string | null;
  device: SafeDevice;
}

export interface SafeEligibleDevice {
  id: string;
  name: string;
  platform: string;
  status: string;
  lastSeenAt: string | null;
  osVersion: string | null;
  appVersion: string | null;
  features?: DeviceFeatures;
  online: true;
}

export interface EligibleDevicesResponse {
  requirement: string;
  devices: SafeEligibleDevice[];
}

export interface DeviceMcpInstallation {
  id: string;
  deviceId: string;
  mcpKey: string;
  packageName: string;
  version: string;
  sha256: string;
  status: DeviceMcpStatus | string;
  toolAllowlist: string[];
  riskTier: string;
  approvalRequired: boolean;
  installedBy?: string | null;
  lastHealthAt?: string | null;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EnrollCodeResult {
  enrollmentId: string;
  code: string;
  codePrefix: string;
  expiresAt: string;
}

export interface RotateTokenResult {
  device: SafeDevice;
  token: string;
}

export interface LineInstallResult {
  installation: DeviceMcpInstallation;
  taskId: string;
}

/**
 * Trainer list row from GET /api/device-tasks (toSafeDeviceTaskDto).
 * Metadata only — no payload/result/error/progress bulk.
 */
export interface SafeDeviceTaskListItem {
  id: string;
  deviceId: string;
  agentId: string | null;
  runId: string | null;
  stepKey: string | null;
  kind: DeviceTaskKind | string;
  status: DeviceTaskStatus | string;
  idempotencyKey: string | null;
  /** List DTO exposes presence of lease, not the lease secret/id. */
  hasLease: boolean;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
  confirmationRequired: boolean;
  confirmationArtifactId: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  requestedByUserId: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/device-tasks/:taskId returns the full Prisma row (may include
 * redacted payload/result/error/progress). List endpoint uses SafeDeviceTaskListItem.
 */
export interface DeviceTask {
  id: string;
  deviceId: string;
  agentId?: string | null;
  runId?: string | null;
  stepKey?: string | null;
  kind: DeviceTaskKind | string;
  status: DeviceTaskStatus | string;
  idempotencyKey?: string | null;
  payload?: unknown;
  result?: unknown;
  error?: unknown;
  leaseId?: string | null;
  /** List DTO may only provide hasLease. */
  hasLease?: boolean;
  leaseExpiresAt?: string | null;
  deadlineAt?: string | null;
  progress?: unknown;
  requestedByUserId?: string | null;
  confirmationRequired?: boolean;
  confirmationArtifactId?: string | null;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  terminalAt?: string | null;
}

/** User-hub lifecycle payload from publishDeviceTaskLifecycle (ids + status only). */
export interface DeviceTaskLifecyclePayload {
  taskId: string;
  deviceId: string;
  status: string;
  runId: string | null;
  agentId: string | null;
}

/** Topics published to user AWP hub for DeviceTask transitions. */
export const DEVICE_TASK_AWP_TOPICS = [
  'device.task.create',
  'device.task.ack',
  'device.task.progress',
  'device.task.result',
  'device.task.cancel',
  'device.task.confirm',
  'device.task.reject',
] as const;

/** Wildcard sub for hub matches() (suffix *). */
export const DEVICE_TASK_AWP_WILDCARD = 'device.task.*';

export interface DeviceArtifactMeta {
  id: string;
  taskId: string;
  deviceId: string;
  seq: number;
  kind: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  redacted: boolean;
  clientDeclaredRedacted: boolean;
  redactionMode?: string;
  expiresAt: string;
  meta?: unknown;
  createdAt: string;
}

// ── Labels (Traditional Chinese) ─────────────────────────────────────────────

export const PLATFORM_ZH: Record<string, string> = {
  MACOS: 'macOS',
  WINDOWS: 'Windows',
  LINUX: 'Linux',
};

export const DEVICE_STATUS_ZH: Record<string, string> = {
  PENDING_ENROLLMENT: '待註冊',
  ACTIVE: '使用中',
  REVOKED: '已撤銷',
  DISABLED: '已停用',
};

export const TASK_STATUS_ZH: Record<string, string> = {
  PENDING: '待派送',
  DISPATCHED: '已派送',
  ACKED: '已確認接收',
  RUNNING: '執行中',
  AWAITING_CONFIRM: '待人工確認',
  SUCCEEDED: '成功',
  FAILED: '失敗',
  TIMEOUT: '逾時',
  CANCELLED: '已取消',
};

export const MCP_STATUS_ZH: Record<string, string> = {
  REQUESTED: '已請求',
  INSTALLING: '安裝中',
  READY: '就緒',
  ERROR: '錯誤',
  DISABLED: '已停用',
};

export const TASK_KIND_ZH: Record<string, string> = {
  COMPUTER_CONTROL: '電腦操控',
  MCP_TOOL: 'MCP 工具',
  SCREENSHOT: '螢幕截圖',
  CAPABILITY_PROBE: '能力探測',
  LINE_DESKTOP: 'LINE 桌面',
  MCP_INSTALL: 'MCP 安裝',
};

export function platformLabel(p: string | undefined | null): string {
  if (!p) return '—';
  return PLATFORM_ZH[p] ?? p;
}

export function deviceStatusLabel(s: string | undefined | null): string {
  if (!s) return '—';
  return DEVICE_STATUS_ZH[s] ?? s;
}

export function taskStatusLabel(s: string | undefined | null): string {
  if (!s) return '—';
  return TASK_STATUS_ZH[s] ?? s;
}

export function mcpStatusLabel(s: string | undefined | null): string {
  if (!s) return '—';
  return MCP_STATUS_ZH[s] ?? s;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 0) return '剛剛';
  if (diffSec < 5) return '剛剛';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小時前`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return new Date(iso).toLocaleString('zh-Hant-TW');
}

export function parseCapabilities(raw: unknown): DeviceCapabilitiesDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as DeviceCapabilitiesDoc;
  // Normalize omitted extended flags (backend defaults false for eligibility).
  if (doc.features) {
    doc.features = {
      ...doc.features,
      codexApp: !!doc.features.codexApp,
      codexCli: !!doc.features.codexCli,
      lineDesktop: !!doc.features.lineDesktop,
    };
  }
  return doc;
}

/** Build GET /api/device-tasks query string from filters. */
export function deviceTasksQuery(opts: {
  deviceId?: string;
  agentId?: string;
  status?: string;
  limit?: number;
}): string {
  const sp = new URLSearchParams();
  if (opts.deviceId) sp.set('deviceId', opts.deviceId);
  if (opts.agentId) sp.set('agentId', opts.agentId);
  if (opts.status) sp.set('status', opts.status);
  sp.set('limit', String(opts.limit ?? 50));
  const q = sp.toString();
  return q ? `/api/device-tasks?${q}` : '/api/device-tasks?limit=50';
}

export function isDeviceTaskLifecyclePayload(p: unknown): p is DeviceTaskLifecyclePayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.taskId === 'string' && typeof o.deviceId === 'string' && typeof o.status === 'string';
}

export function isDeviceMcpLineTool(toolName: string): boolean {
  return /^device-mcp:line-desktop:[A-Za-z0-9._-]+$/.test(toolName.trim());
}

export function requirementForStep(opts: {
  type: string;
  toolName?: string;
}): EligibilityRequirement | null {
  if (opts.type === 'COMPUTER_CONTROL') return 'computer_use';
  if (opts.type === 'TOOL' && opts.toolName && isDeviceMcpLineTool(opts.toolName)) {
    return 'line_desktop';
  }
  return null;
}

/**
 * Fail-closed pre-save check: never persist device-bound COMPUTER_CONTROL /
 * device LINE steps without workflow agent context (agentId).
 * Returns per-step field errors; empty object means OK.
 */
export function deviceBoundStepsAgentErrors(
  steps: Array<{ localId: string; type: string; toolName?: string; deviceId?: string }>,
  agentId?: string | null,
): Record<string, string> {
  const hasAgent = typeof agentId === 'string' && agentId.trim().length > 0;
  if (hasAgent) return {};
  const errors: Record<string, string> = {};
  for (const s of steps) {
    const req = requirementForStep({ type: s.type, toolName: s.toolName });
    if (!req) continue;
    // Step requires a device (has or needs deviceId) but workflow has no agentId.
    errors[s.localId] =
      '裝置綁定步驟（COMPUTER_CONTROL／device LINE）需要工作流已綁定員工（agentId）。請先綁定員工後再選擇裝置並儲存；系統不會在無員工上下文時寫入 deviceId。';
  }
  return errors;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Fetch binary artifact via FDE download route.
 * Does not log Authorization headers or body content.
 */
export async function fetchDeviceArtifactBlob(artifactId: string, retry = true): Promise<Blob> {
  const path = `/api/device-artifacts/${encodeURIComponent(artifactId)}/download`;
  const headers = new Headers();
  const accessForRequest = tokens.access;
  if (accessForRequest) headers.set('authorization', `Bearer ${accessForRequest}`);

  const res = await fetch(path, { headers });
  if (res.status === 401 && retry && (await refreshAccess(accessForRequest))) {
    return fetchDeviceArtifactBlob(artifactId, false);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError('ARTIFACT_DOWNLOAD', text || `下載失敗 (${res.status})`);
  }
  return res.blob();
}

/** Build a simple status timeline from task fields (no invented events). */
export function buildTaskTimeline(task: DeviceTask): Array<{ key: string; label: string; at?: string | null }> {
  const items: Array<{ key: string; label: string; at?: string | null }> = [];
  items.push({ key: 'created', label: '建立任務', at: task.createdAt ?? null });
  if (task.status !== 'PENDING') {
    items.push({ key: 'dispatched', label: '已派送 / 進行中', at: task.updatedAt ?? null });
  }
  if (task.confirmedAt) {
    items.push({ key: 'confirmed', label: '檢查點已確認', at: task.confirmedAt });
  }
  if (task.status === 'AWAITING_CONFIRM') {
    items.push({ key: 'awaiting', label: '等待人工確認檢查點', at: task.updatedAt ?? null });
  }
  if (task.terminalAt || ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(String(task.status))) {
    items.push({
      key: 'terminal',
      label: `終態：${taskStatusLabel(String(task.status))}`,
      at: task.terminalAt ?? task.updatedAt ?? null,
    });
  }
  return items;
}
