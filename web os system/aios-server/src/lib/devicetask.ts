/**
 * Durable DeviceTask lifecycle.
 * PostgreSQL is the sole source of truth; WebSocket only wakes devices with taskId.
 * Terminal writes are atomic first-writer-wins (conditional updateMany).
 * After ACK, progress/result require a matching unexpired lease (fail-closed).
 */
import { ulid } from 'ulid';
import { Prisma } from '@prisma/client';
import type { DeviceTask, DeviceTaskKind, DeviceTaskStatus } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { audit } from './audit.js';
import { KINDS_REQUIRING_AGENT, validateDeviceTaskPayload } from './devicetaskpayload.js';

/** Default lease length after ACK / renew. */
export const DEFAULT_LEASE_MS = 60_000;

/** Default hard deadline from creation. */
export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

const TERMINAL: ReadonlySet<DeviceTaskStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
]);

const NON_TERMINAL: DeviceTaskStatus[] = [
  'PENDING',
  'DISPATCHED',
  'ACKED',
  'RUNNING',
  'AWAITING_CONFIRM',
];

const LEASED_STATUSES: DeviceTaskStatus[] = ['ACKED', 'RUNNING', 'AWAITING_CONFIRM'];

export function isTerminalStatus(s: DeviceTaskStatus): boolean {
  return TERMINAL.has(s);
}

function redactJson<T>(value: T): T {
  return deepRedactSecrets(value);
}

/** Stable JSON for terminal idempotency compare. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value ?? null));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeysDeep(obj[k]);
    }
    return out;
  }
  return value;
}

function sameTerminalPayload(
  task: DeviceTask,
  status: DeviceTaskStatus,
  result: unknown,
  error: unknown,
): boolean {
  if (task.status !== status) return false;
  if (stableJson(task.result) !== stableJson(result ?? null)) return false;
  if (stableJson(task.error) !== stableJson(error ?? null)) return false;
  return true;
}

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export async function createDeviceTask(opts: {
  deviceId: string;
  kind: DeviceTaskKind;
  payload: unknown;
  agentId?: string | null;
  runId?: string | null;
  stepKey?: string | null;
  idempotencyKey?: string | null;
  deadlineAt?: Date | null;
  actorUserId?: string | null;
  requestedByUserId?: string | null;
  confirmationRequired?: boolean;
}): Promise<DeviceTask> {
  const device = await prisma.device.findUnique({ where: { id: opts.deviceId } });
  if (!device) throw errors.notFound('Device not found');
  if (device.status !== 'ACTIVE') {
    throw errors.badRequest('Device must be ACTIVE to receive tasks');
  }

  const validatedPayload = validateDeviceTaskPayload(opts.kind, opts.payload);
  const payload = redactJson(validatedPayload) as Prisma.InputJsonValue;

  const agentId = opts.agentId?.trim() || null;
  if (KINDS_REQUIRING_AGENT.has(opts.kind) && !agentId) {
    throw errors.badRequest(`${opts.kind} requires agentId`);
  }

  if (agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, deletedAt: null },
    });
    if (!agent) throw errors.notFound('Agent not found');
    const binding = await prisma.agentDevice.findUnique({
      where: {
        agentId_deviceId: { agentId, deviceId: opts.deviceId },
      },
    });
    if (!binding) {
      throw errors.badRequest('Agent is not bound to this device (AgentDevice required)');
    }
  }

  const idempotencyKey = opts.idempotencyKey?.trim() || null;
  const deadlineAt = opts.deadlineAt ?? new Date(Date.now() + DEFAULT_DEADLINE_MS);

  if (idempotencyKey) {
    const existing = await prisma.deviceTask.findUnique({
      where: {
        deviceId_idempotencyKey: {
          deviceId: opts.deviceId,
          idempotencyKey,
        },
      },
    });
    if (existing) return existing;
  }

  try {
    const task = await prisma.deviceTask.create({
      data: {
        id: ulid(),
        deviceId: opts.deviceId,
        agentId,
        runId: opts.runId ?? null,
        stepKey: opts.stepKey ?? null,
        kind: opts.kind,
        status: 'PENDING',
        idempotencyKey,
        payload,
        deadlineAt,
        requestedByUserId: opts.requestedByUserId ?? opts.actorUserId ?? null,
        confirmationRequired: opts.confirmationRequired === true,
      },
    });
    await audit(opts.actorUserId ?? null, 'device.task.create', 'DeviceTask', task.id, {
      deviceId: task.deviceId,
      kind: task.kind,
      idempotencyKey: task.idempotencyKey,
    });
    return task;
  } catch (e: unknown) {
    if (
      idempotencyKey &&
      e &&
      typeof e === 'object' &&
      'code' in e &&
      (e as { code?: string }).code === 'P2002'
    ) {
      const existing = await prisma.deviceTask.findUnique({
        where: {
          deviceId_idempotencyKey: {
            deviceId: opts.deviceId,
            idempotencyKey,
          },
        },
      });
      if (existing) return existing;
    }
    throw e;
  }
}

export async function markTaskDispatched(taskId: string): Promise<DeviceTask> {
  await prisma.deviceTask.updateMany({
    where: { id: taskId, status: 'PENDING' },
    data: { status: 'DISPATCHED' },
  });
  return getTaskOrThrow(taskId);
}

/**
 * ACK only from PENDING/DISPATCHED. Active unexpired lease cannot be stolen.
 * Reconnect after lease expiry goes through reclaim → TIMEOUT (new task if needed).
 */
export async function ackDeviceTask(opts: {
  taskId: string;
  deviceId: string;
  leaseMs?: number;
}): Promise<DeviceTask> {
  let task = await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
  task = await reclaimIfExpired(task);

  if (isTerminalStatus(task.status)) {
    throw errors.conflict(`Task already terminal: ${task.status}`);
  }

  if (
    task.leaseId &&
    task.leaseExpiresAt &&
    task.leaseExpiresAt.getTime() > Date.now() &&
    LEASED_STATUSES.includes(task.status)
  ) {
    throw errors.conflict('Task already has an active lease; wait for expiry/reclaim');
  }

  if (task.status !== 'PENDING' && task.status !== 'DISPATCHED') {
    throw errors.conflict(`ACK only allowed from PENDING/DISPATCHED, got ${task.status}`);
  }

  const leaseId = ulid();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const leaseExpiresAt = new Date(Date.now() + leaseMs);

  const claim = await prisma.deviceTask.updateMany({
    where: {
      id: task.id,
      deviceId: opts.deviceId,
      status: { in: ['PENDING', 'DISPATCHED'] },
    },
    data: {
      status: 'ACKED',
      leaseId,
      leaseExpiresAt,
    },
  });

  if (claim.count !== 1) {
    const fresh = await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
    if (isTerminalStatus(fresh.status)) {
      throw errors.conflict(`Task already terminal: ${fresh.status}`);
    }
    throw errors.conflict('ACK lost race or task not in PENDING/DISPATCHED');
  }

  return getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
}

async function requireValidLease(
  task: DeviceTask,
  leaseId: string | null | undefined,
): Promise<DeviceTask> {
  const after = await reclaimIfExpired(task);
  if (isTerminalStatus(after.status)) {
    throw errors.conflict(`Task already terminal: ${after.status}`);
  }
  if (!after.leaseId || !after.leaseExpiresAt) {
    throw errors.forbidden('Task has no active lease; ACK required');
  }
  if (!leaseId || after.leaseId !== leaseId) {
    throw errors.forbidden('Invalid lease');
  }
  if (after.leaseExpiresAt.getTime() <= Date.now()) {
    const timed = await reclaimIfExpired(after);
    if (isTerminalStatus(timed.status)) {
      throw errors.conflict(`Task already terminal: ${timed.status}`);
    }
    throw errors.forbidden('Lease expired');
  }
  return after;
}

export async function renewDeviceTaskLease(opts: {
  taskId: string;
  deviceId: string;
  leaseId: string;
  leaseMs?: number;
}): Promise<DeviceTask> {
  const task = await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
  const fresh = await requireValidLease(task, opts.leaseId);

  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const leaseExpiresAt = new Date(Date.now() + leaseMs);
  const nextStatus: DeviceTaskStatus = fresh.status === 'ACKED' ? 'RUNNING' : fresh.status;

  const claim = await prisma.deviceTask.updateMany({
    where: {
      id: fresh.id,
      deviceId: opts.deviceId,
      leaseId: opts.leaseId,
      status: { in: LEASED_STATUSES },
    },
    data: {
      leaseExpiresAt,
      status: nextStatus,
    },
  });
  if (claim.count !== 1) {
    throw errors.conflict('Lease renew lost race');
  }
  return getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
}

export async function reportDeviceTaskProgress(opts: {
  taskId: string;
  deviceId: string;
  leaseId: string;
  progress: unknown;
  status?: 'RUNNING' | 'AWAITING_CONFIRM';
  /** Required when status=AWAITING_CONFIRM — screenshot artifact for human gate. */
  confirmationArtifactId?: string | null;
}): Promise<DeviceTask> {
  const task = await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
  const fresh = await requireValidLease(task, opts.leaseId);

  const progress = redactJson(opts.progress ?? {}) as Prisma.InputJsonValue;
  const nextStatus = opts.status ?? 'RUNNING';

  let confirmationArtifactId: string | null | undefined;
  if (nextStatus === 'AWAITING_CONFIRM') {
    const artId = opts.confirmationArtifactId?.trim();
    if (!artId) {
      throw errors.badRequest('confirmationArtifactId required for AWAITING_CONFIRM');
    }
    const art = await prisma.deviceArtifact.findFirst({
      where: {
        id: artId,
        taskId: fresh.id,
        deviceId: opts.deviceId,
        kind: 'SCREENSHOT',
      },
    });
    if (!art) {
      throw errors.badRequest('confirmationArtifactId must be a SCREENSHOT of this task/device');
    }
    if (art.expiresAt.getTime() <= Date.now()) {
      throw errors.badRequest('confirmation artifact expired');
    }
    confirmationArtifactId = artId;
  }

  const claim = await prisma.deviceTask.updateMany({
    where: {
      id: fresh.id,
      deviceId: opts.deviceId,
      leaseId: opts.leaseId,
      status: { in: LEASED_STATUSES },
    },
    data: {
      progress,
      status: nextStatus,
      ...(confirmationArtifactId
        ? { confirmationArtifactId, confirmationRequired: true }
        : {}),
    },
  });
  if (claim.count !== 1) {
    throw errors.conflict('Progress update lost race or invalid lease');
  }
  return getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);
}

/**
 * User/FDE confirms an AWAITING_CONFIRM checkpoint → RUNNING.
 * Atomic: status + leaseId + leaseExpiresAt>now + confirmationArtifactId must match.
 * Fail-closed on wrong user, missing/expired artifact, expired lease, races.
 */
export async function confirmDeviceTaskCheckpoint(opts: {
  taskId: string;
  actorUserId: string;
  actorRole: string;
}): Promise<DeviceTask> {
  const task = await getTaskOrThrow(opts.taskId);
  if (task.status !== 'AWAITING_CONFIRM') {
    throw errors.conflict(`Task not awaiting confirm: ${task.status}`);
  }

  const isFde = opts.actorRole === 'OWNER' || opts.actorRole === 'TRAINER';
  const isOwner = task.requestedByUserId === opts.actorUserId;
  if (!isFde && !isOwner) {
    throw errors.forbidden('Only the requesting user or FDE may confirm');
  }

  // Reclaim first so expired lease becomes TIMEOUT before we try confirm.
  const fresh = await reclaimIfExpired(task);
  if (fresh.status !== 'AWAITING_CONFIRM') {
    throw errors.conflict(`Task not awaiting confirm: ${fresh.status}`);
  }
  if (!fresh.leaseId || !fresh.leaseExpiresAt) {
    throw errors.forbidden('No active lease; cannot confirm');
  }
  if (fresh.leaseExpiresAt.getTime() <= Date.now()) {
    throw errors.forbidden('Lease expired; cannot confirm');
  }
  if (!fresh.confirmationArtifactId) {
    throw errors.badRequest('confirmationArtifactId missing');
  }
  const art = await prisma.deviceArtifact.findFirst({
    where: {
      id: fresh.confirmationArtifactId,
      taskId: fresh.id,
      deviceId: fresh.deviceId,
      kind: 'SCREENSHOT',
    },
  });
  if (!art) {
    throw errors.badRequest('confirmation screenshot missing or not owned by this task/device');
  }
  if (art.expiresAt.getTime() <= Date.now()) {
    throw errors.badRequest('confirmation screenshot expired');
  }

  const now = new Date();
  const claim = await prisma.deviceTask.updateMany({
    where: {
      id: fresh.id,
      status: 'AWAITING_CONFIRM',
      leaseId: fresh.leaseId,
      leaseExpiresAt: { gt: now },
      confirmationArtifactId: fresh.confirmationArtifactId,
    },
    data: {
      status: 'RUNNING',
      confirmedAt: now,
      confirmedBy: opts.actorUserId,
    },
  });
  if (claim.count !== 1) {
    // Lost race or lease expired between checks — never leave ambiguous state.
    const after = await getTaskOrThrow(fresh.id);
    if (after.status === 'RUNNING' && after.confirmedBy === opts.actorUserId) {
      return after;
    }
    throw errors.conflict('Confirm lost race or lease no longer valid');
  }

  const updated = await getTaskOrThrow(fresh.id);
  await audit(opts.actorUserId, 'device.task.confirm', 'DeviceTask', fresh.id, {
    deviceId: fresh.deviceId,
    confirmationArtifactId: fresh.confirmationArtifactId,
  });
  return updated;
}

/**
 * Reject checkpoint → CANCELLED.
 * Only allowed when status is exactly AWAITING_CONFIRM (not arbitrary RUNNING/leased tasks).
 */
export async function rejectDeviceTaskCheckpoint(opts: {
  taskId: string;
  actorUserId: string;
  actorRole: string;
  reason?: string;
}): Promise<DeviceTask> {
  const task = await getTaskOrThrow(opts.taskId);
  if (task.status !== 'AWAITING_CONFIRM') {
    if (task.status === 'CANCELLED') return task;
    throw errors.conflict(
      `Reject only allowed in AWAITING_CONFIRM, got ${task.status}`,
    );
  }

  const isFde = opts.actorRole === 'OWNER' || opts.actorRole === 'TRAINER';
  const isOwner = task.requestedByUserId === opts.actorUserId;
  if (!isFde && !isOwner) {
    throw errors.forbidden('Only the requesting user or FDE may reject');
  }

  const error = redactJson({
    reason: opts.reason ?? 'confirmation rejected',
  }) as Prisma.InputJsonValue;
  const terminalAt = new Date();
  const claim = await prisma.deviceTask.updateMany({
    where: {
      id: task.id,
      status: 'AWAITING_CONFIRM',
    },
    data: {
      status: 'CANCELLED',
      error,
      terminalAt,
      leaseId: null,
      leaseExpiresAt: null,
    },
  });
  if (claim.count !== 1) {
    const fresh = await getTaskOrThrow(task.id);
    if (fresh.status === 'CANCELLED') return fresh;
    throw errors.conflict(`Reject lost race, status=${fresh.status}`);
  }

  const updated = await getTaskOrThrow(task.id);
  await audit(opts.actorUserId, 'device.task.reject', 'DeviceTask', task.id, {
    deviceId: task.deviceId,
    reason: opts.reason,
  });
  return updated;
}

/** Poll until terminal (or timeout). Does not treat DISPATCHED as success. */
export async function waitForDeviceTaskTerminal(
  taskId: string,
  timeoutMs: number,
  pollMs = 1000,
): Promise<DeviceTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let task = await getTaskOrThrow(taskId);
    task = await reclaimIfExpired(task);
    if (isTerminalStatus(task.status)) return task;
    // AWAITING_CONFIRM is non-terminal — keep waiting for user confirm + device finish.
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const last = await reclaimIfExpired(await getTaskOrThrow(taskId));
  if (isTerminalStatus(last.status)) return last;
  // Force timeout if still open.
  return forceTimeout(taskId, 'waitForDeviceTaskTerminal deadline');
}

/**
 * Atomic first-writer-wins terminal result.
 * Requires matching unexpired lease; PENDING/DISPATCHED cannot complete directly.
 *
 * confirmationRequired + SUCCEEDED: DB where requires confirmedAt non-null
 * (not merely a precheck) so races cannot skip FDE confirmation.
 * FAILED is always allowed without confirmation so devices do not deadlock.
 */
export async function completeDeviceTask(opts: {
  taskId: string;
  deviceId: string;
  leaseId: string;
  status: 'SUCCEEDED' | 'FAILED';
  result?: unknown;
  error?: unknown;
}): Promise<DeviceTask> {
  let task = await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);

  const wantResult = opts.result === undefined ? null : redactJson(opts.result);
  const wantError = opts.error === undefined ? null : redactJson(opts.error);

  if (isTerminalStatus(task.status)) {
    if (sameTerminalPayload(task, opts.status, wantResult, wantError)) {
      return task;
    }
    throw errors.conflict(`Task already terminal: ${task.status}`);
  }

  task = await reclaimIfExpired(task);
  if (isTerminalStatus(task.status)) {
    throw errors.conflict(`Task already terminal: ${task.status}`);
  }

  if (task.status === 'PENDING' || task.status === 'DISPATCHED') {
    throw errors.forbidden('Task must be ACKed before result; no lease');
  }

  await requireValidLease(task, opts.leaseId);

  const terminalAt = new Date();
  // SUCCEEDED on confirmationRequired tasks: confirmedAt must already be set
  // inside the same conditional update (closes TOCTOU with FDE confirm).
  const where: Prisma.DeviceTaskWhereInput = {
    id: task.id,
    deviceId: opts.deviceId,
    leaseId: opts.leaseId,
    status: { in: LEASED_STATUSES },
  };
  if (opts.status === 'SUCCEEDED') {
    where.OR = [
      { confirmationRequired: false },
      { confirmedAt: { not: null } },
    ];
  }

  const claim = await prisma.deviceTask.updateMany({
    where,
    data: {
      status: opts.status,
      result: jsonOrNull(wantResult),
      error: jsonOrNull(wantError),
      terminalAt,
      leaseId: null,
      leaseExpiresAt: null,
    },
  });

  if (claim.count === 1) {
    return getTaskOrThrow(task.id);
  }

  const fresh = await getTaskOrThrow(task.id);
  if (sameTerminalPayload(fresh, opts.status, wantResult, wantError)) {
    return fresh;
  }
  if (isTerminalStatus(fresh.status)) {
    throw errors.conflict(`Task already terminal: ${fresh.status}`);
  }
  if (
    opts.status === 'SUCCEEDED' &&
    fresh.confirmationRequired &&
    !fresh.confirmedAt
  ) {
    throw errors.forbidden(
      'confirmationRequired task cannot SUCCEEDED until FDE confirmation (confirmedAt required)',
    );
  }
  throw errors.conflict('Terminal write lost race');
}

export async function cancelDeviceTask(opts: {
  taskId: string;
  deviceId?: string;
  actorUserId?: string | null;
  reason?: string;
  leaseId?: string | null;
}): Promise<DeviceTask> {
  let task = opts.deviceId
    ? await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId)
    : await getTaskOrThrow(opts.taskId);

  if (isTerminalStatus(task.status)) {
    if (task.status === 'CANCELLED') return task;
    throw errors.conflict(`Task already terminal: ${task.status}`);
  }

  task = await reclaimIfExpired(task);
  if (isTerminalStatus(task.status)) {
    if (task.status === 'CANCELLED') return task;
    throw errors.conflict(`Task already terminal: ${task.status}`);
  }

  if (opts.deviceId) {
    if (LEASED_STATUSES.includes(task.status) || task.leaseId) {
      await requireValidLease(task, opts.leaseId);
    }
  }

  const error = redactJson({ reason: opts.reason ?? 'cancelled' }) as Prisma.InputJsonValue;
  const terminalAt = new Date();

  const where: Prisma.DeviceTaskWhereInput = {
    id: task.id,
    status: { in: NON_TERMINAL },
  };
  if (opts.deviceId) where.deviceId = opts.deviceId;

  const claim = await prisma.deviceTask.updateMany({
    where,
    data: {
      status: 'CANCELLED',
      error,
      terminalAt,
      leaseId: null,
      leaseExpiresAt: null,
    },
  });

  if (claim.count === 1) {
    const updated = await getTaskOrThrow(task.id);
    await audit(opts.actorUserId ?? null, 'device.task.cancel', 'DeviceTask', task.id, {
      deviceId: task.deviceId,
      reason: opts.reason,
    });
    return updated;
  }

  const fresh = await getTaskOrThrow(task.id);
  if (fresh.status === 'CANCELLED') return fresh;
  if (isTerminalStatus(fresh.status)) {
    throw errors.conflict(`Task already terminal: ${fresh.status}`);
  }
  throw errors.conflict('Cancel lost race');
}

export async function forceTimeout(taskId: string, reason: string): Promise<DeviceTask> {
  const error = redactJson({ reason }) as Prisma.InputJsonValue;
  const terminalAt = new Date();
  await prisma.deviceTask.updateMany({
    where: {
      id: taskId,
      status: { in: NON_TERMINAL },
    },
    data: {
      status: 'TIMEOUT',
      error,
      terminalAt,
      leaseId: null,
      leaseExpiresAt: null,
    },
  });
  return getTaskOrThrow(taskId);
}

export async function reclaimIfExpired(task: DeviceTask): Promise<DeviceTask> {
  if (isTerminalStatus(task.status)) return task;

  const now = Date.now();
  if (task.deadlineAt && task.deadlineAt.getTime() <= now) {
    return forceTimeout(task.id, 'deadline exceeded');
  }
  if (
    task.leaseId &&
    task.leaseExpiresAt &&
    task.leaseExpiresAt.getTime() <= now &&
    LEASED_STATUSES.includes(task.status)
  ) {
    return forceTimeout(task.id, 'lease expired');
  }
  return task;
}

export async function reclaimExpiredTasks(limit = 100): Promise<number> {
  const now = new Date();
  const candidates = await prisma.deviceTask.findMany({
    where: {
      status: { in: NON_TERMINAL },
      OR: [
        { deadlineAt: { lte: now } },
        {
          AND: [
            { leaseExpiresAt: { lte: now } },
            { status: { in: LEASED_STATUSES } },
          ],
        },
      ],
    },
    take: limit,
  });
  let n = 0;
  for (const t of candidates) {
    const after = await reclaimIfExpired(t);
    if (after.status === 'TIMEOUT') n += 1;
  }
  return n;
}

export async function getTaskOrThrow(taskId: string): Promise<DeviceTask> {
  const task = await prisma.deviceTask.findUnique({ where: { id: taskId } });
  if (!task) throw errors.notFound('Task not found');
  return task;
}

export async function getTaskForDeviceOrThrow(
  taskId: string,
  deviceId: string,
): Promise<DeviceTask> {
  const task = await prisma.deviceTask.findFirst({
    where: { id: taskId, deviceId },
  });
  if (!task) throw errors.notFound('Task not found');
  return reclaimIfExpired(task);
}

export async function listOpenTasksForDevice(deviceId: string): Promise<DeviceTask[]> {
  const tasks = await prisma.deviceTask.findMany({
    where: {
      deviceId,
      status: { in: NON_TERMINAL },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  const out: DeviceTask[] = [];
  for (const t of tasks) {
    out.push(await reclaimIfExpired(t));
  }
  return out.filter((t) => !isTerminalStatus(t.status));
}

export async function createAndDispatchTask(
  opts: Parameters<typeof createDeviceTask>[0],
): Promise<DeviceTask> {
  const task = await createDeviceTask(opts);
  if (task.status === 'PENDING') {
    return markTaskDispatched(task.id);
  }
  return task;
}

export type { DeviceTask, DeviceTaskKind, DeviceTaskStatus };
