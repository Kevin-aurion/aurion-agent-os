/**
 * Device-local MCP installations (pinned manifests only).
 * Clients/FDE cannot choose arbitrary command, package, version, URL, or host.
 */
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import { createAndDispatchTask, isTerminalStatus } from './devicetask.js';
import { isDeviceOnline, publishToDevice } from '../ws/hub.js';
import type { DeviceMcpInstallation, DeviceMcpStatus, DeviceTask } from '@prisma/client';

export const LINE_DESKTOP_MCP_KEY = 'line-desktop-mcp';

/** Fixed LINE Desktop MCP manifest — never client-overridable. */
export const LINE_DESKTOP_MANIFEST = {
  mcpKey: LINE_DESKTOP_MCP_KEY,
  packageName: 'line-desktop-mcp',
  version: '1.1.2',
  sha256: '6f8dff26fe5e13ad886dd04e8e6d9bc788c709e92f85e46b25523c402f20bc7a',
  transport: 'device-local-stdio' as const,
  toolAllowlist: [
    'get_line_chatroom_history_default',
    'get_line_chatroom_history_long',
    'get_line_chatroom_history_short',
    'send_message_manual',
    'send_message_auto',
  ] as const,
  readTools: [
    'get_line_chatroom_history_default',
    'get_line_chatroom_history_long',
    'get_line_chatroom_history_short',
  ] as const,
  sendTools: ['send_message_manual', 'send_message_auto'] as const,
  riskTier: 'high' as const,
  approvalRequiredForSend: true,
};

export type LineTool = (typeof LINE_DESKTOP_MANIFEST.toolAllowlist)[number];

export function isLineSendTool(tool: string): boolean {
  return (LINE_DESKTOP_MANIFEST.sendTools as readonly string[]).includes(tool);
}

export function isLineReadTool(tool: string): boolean {
  return (LINE_DESKTOP_MANIFEST.readTools as readonly string[]).includes(tool);
}

export function isLineTool(tool: string): boolean {
  return (LINE_DESKTOP_MANIFEST.toolAllowlist as readonly string[]).includes(tool);
}

/** Parse device-mcp:line-desktop:<tool> (not central mcp:<serverId>:<tool>). */
export function parseDeviceLineTool(toolName: string): { tool: LineTool } | null {
  const m = /^device-mcp:line-desktop:([A-Za-z0-9._-]+)$/.exec(toolName);
  if (!m) return null;
  const tool = m[1]!;
  if (!isLineTool(tool)) return null;
  return { tool: tool as LineTool };
}

export function listDeviceMcpInstalls(deviceId: string): Promise<DeviceMcpInstallation[]> {
  return prisma.deviceMcpInstallation.findMany({
    where: { deviceId },
    orderBy: { createdAt: 'desc' },
  });
}

function installIdempotencyBase(deviceId: string): string {
  const m = LINE_DESKTOP_MANIFEST;
  return `mcp-install:${deviceId}:${m.mcpKey}:${m.version}`;
}

/**
 * FDE requests LINE Desktop MCP install on an online device.
 * - Reuses a non-terminal existing MCP_INSTALL task (same base idempotency).
 * - After FAILED/CANCELLED/TIMEOUT, creates a fresh attempt (new idempotency suffix).
 * - On wake/dispatch failure marks installation ERROR.
 */
export async function requestLineDesktopInstall(opts: {
  deviceId: string;
  actorUserId: string;
}): Promise<{ installation: DeviceMcpInstallation; taskId: string }> {
  const device = await prisma.device.findUnique({ where: { id: opts.deviceId } });
  if (!device) throw errors.notFound('Device not found');
  if (device.status !== 'ACTIVE') throw errors.badRequest('Device must be ACTIVE');
  if (!isDeviceOnline(opts.deviceId)) {
    throw errors.badRequest('Device must be online to request MCP install');
  }

  const m = LINE_DESKTOP_MANIFEST;
  let installation = await prisma.deviceMcpInstallation.upsert({
    where: {
      deviceId_mcpKey: { deviceId: opts.deviceId, mcpKey: m.mcpKey },
    },
    create: {
      id: ulid(),
      deviceId: opts.deviceId,
      mcpKey: m.mcpKey,
      packageName: m.packageName,
      version: m.version,
      sha256: m.sha256,
      status: 'REQUESTED',
      toolAllowlist: [...m.toolAllowlist],
      riskTier: m.riskTier,
      approvalRequired: m.approvalRequiredForSend,
      installedBy: opts.actorUserId,
      lastError: null,
    },
    update: {
      packageName: m.packageName,
      version: m.version,
      sha256: m.sha256,
      status: 'REQUESTED',
      toolAllowlist: [...m.toolAllowlist],
      riskTier: m.riskTier,
      approvalRequired: m.approvalRequiredForSend,
      installedBy: opts.actorUserId,
      lastError: null,
    },
  });

  const baseKey = installIdempotencyBase(opts.deviceId);
  // Find any non-terminal install task for this device+mcp (reuse).
  const open = await prisma.deviceTask.findFirst({
    where: {
      deviceId: opts.deviceId,
      kind: 'MCP_INSTALL',
      status: { in: ['PENDING', 'DISPATCHED', 'ACKED', 'RUNNING', 'AWAITING_CONFIRM'] },
      idempotencyKey: { startsWith: baseKey },
    },
    orderBy: { createdAt: 'desc' },
  });

  let task: DeviceTask;
  if (open && !isTerminalStatus(open.status)) {
    task = open;
  } else {
    // Fresh attempt after terminal failure — unique idempotency key.
    const attempt = ulid().slice(-10).toLowerCase();
    try {
      task = await createAndDispatchTask({
        deviceId: opts.deviceId,
        kind: 'MCP_INSTALL',
        payload: {
          mcpKey: m.mcpKey,
          packageName: m.packageName,
          version: m.version,
          sha256: m.sha256,
          toolAllowlist: [...m.toolAllowlist],
          transport: m.transport,
        },
        idempotencyKey: `${baseKey}:${attempt}`,
        actorUserId: opts.actorUserId,
        requestedByUserId: opts.actorUserId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      installation = await markInstallError(installation.id, `task create failed: ${msg}`);
      throw e;
    }
  }

  const woke = publishToDevice(opts.deviceId, 'device.task', { taskId: task.id });
  if (!woke) {
    const { cancelDeviceTask } = await import('./devicetask.js');
    await cancelDeviceTask({
      taskId: task.id,
      actorUserId: opts.actorUserId,
      reason: 'DEVICE_OFFLINE at wake',
    });
    installation = await markInstallError(installation.id, 'DEVICE_OFFLINE: install task wake failed');
    throw errors.badRequest('DEVICE_OFFLINE: install task wake failed');
  }

  await audit(opts.actorUserId, 'device.mcp.install_request', 'DeviceMcpInstallation', installation.id, {
    deviceId: opts.deviceId,
    mcpKey: m.mcpKey,
    version: m.version,
    taskId: task.id,
  });

  return { installation, taskId: task.id };
}

async function markInstallError(id: string, lastError: string): Promise<DeviceMcpInstallation> {
  return prisma.deviceMcpInstallation.update({
    where: { id },
    data: {
      status: 'ERROR',
      lastError: redactSecrets(lastError).slice(0, 2000),
      lastHealthAt: new Date(),
    },
  });
}

export async function disableDeviceMcp(opts: {
  deviceId: string;
  mcpKey: string;
  actorUserId: string;
}): Promise<DeviceMcpInstallation> {
  const row = await prisma.deviceMcpInstallation.findUnique({
    where: {
      deviceId_mcpKey: { deviceId: opts.deviceId, mcpKey: opts.mcpKey },
    },
  });
  if (!row) throw errors.notFound('MCP installation not found');
  const updated = await prisma.deviceMcpInstallation.update({
    where: { id: row.id },
    data: { status: 'DISABLED' },
  });
  await audit(opts.actorUserId, 'device.mcp.disable', 'DeviceMcpInstallation', row.id, {
    deviceId: opts.deviceId,
    mcpKey: opts.mcpKey,
  });
  return updated;
}

/**
 * Reconcile installation status from device capability mcpServers[] entry.
 * READY only when name/version/sha256/tools exact match allowlist.
 */
export async function reconcileDeviceMcpFromCapabilities(
  deviceId: string,
  capabilities: unknown,
): Promise<void> {
  try {
    if (!capabilities || typeof capabilities !== 'object') return;
    const caps = capabilities as {
      mcpServers?: Array<{
        name?: string;
        version?: string;
        sha256?: string;
        tools?: string[];
      }>;
    };
    const servers = Array.isArray(caps.mcpServers) ? caps.mcpServers : [];
    const line = servers.find(
      (s) => s?.name === LINE_DESKTOP_MANIFEST.packageName || s?.name === LINE_DESKTOP_MCP_KEY,
    );

    const existing = await prisma.deviceMcpInstallation.findUnique({
      where: {
        deviceId_mcpKey: { deviceId, mcpKey: LINE_DESKTOP_MCP_KEY },
      },
    });
    if (!existing || existing.status === 'DISABLED') return;

    const m = LINE_DESKTOP_MANIFEST;
    if (!line) {
      await prisma.deviceMcpInstallation.update({
        where: { id: existing.id },
        data: {
          status: 'ERROR',
          lastError: redactSecrets('capability missing line-desktop-mcp'),
          lastHealthAt: new Date(),
        },
      });
      return;
    }

    const versionOk = line.version === m.version;
    const shaOk =
      typeof line.sha256 === 'string' &&
      line.sha256.toLowerCase() === m.sha256.toLowerCase();
    const tools = Array.isArray(line.tools) ? line.tools : [];
    const allow = new Set(m.toolAllowlist);
    const toolsOk =
      tools.length > 0 &&
      tools.every((t) => allow.has(t as LineTool)) &&
      m.toolAllowlist.every((t) => tools.includes(t));

    if (versionOk && shaOk && toolsOk) {
      await prisma.deviceMcpInstallation.update({
        where: { id: existing.id },
        data: {
          status: 'READY',
          lastError: null,
          lastHealthAt: new Date(),
          version: m.version,
          sha256: m.sha256,
          packageName: m.packageName,
          toolAllowlist: [...m.toolAllowlist],
        },
      });
    } else {
      const reason = deepRedactSecrets({
        message: 'LINE MCP capability mismatch',
        versionOk,
        shaOk,
        toolsOk,
        reportedVersion: line.version,
        reportedSha: line.sha256,
        reportedTools: tools,
      });
      await prisma.deviceMcpInstallation.update({
        where: { id: existing.id },
        data: {
          status: 'ERROR',
          lastError: redactSecrets(JSON.stringify(reason)).slice(0, 2000),
          lastHealthAt: new Date(),
        },
      });
    }
  } catch {
    // fail-safe: never break capability update path
  }
}

export async function getReadyLineInstall(deviceId: string): Promise<DeviceMcpInstallation | null> {
  return prisma.deviceMcpInstallation.findFirst({
    where: {
      deviceId,
      mcpKey: LINE_DESKTOP_MCP_KEY,
      status: 'READY',
      version: LINE_DESKTOP_MANIFEST.version,
      sha256: LINE_DESKTOP_MANIFEST.sha256,
    },
  });
}

export type { DeviceMcpInstallation, DeviceMcpStatus };
