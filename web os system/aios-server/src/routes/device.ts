/**
 * Device-agent REST (enroll + authenticated device endpoints).
 * Auth: Authorization Bearer device token only — never query-string tokens.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok, errors, sendError } from '../lib/http.js';
import {
  enrollWithCode,
  authenticateDeviceToken,
  deviceTokenFromAuthHeader,
  updateDeviceCapabilities,
  toSafeDevice,
  touchDeviceLastSeen,
  type Device,
} from '../lib/device.js';
import {
  getTaskForDeviceOrThrow,
  listOpenTasksForDevice,
  ackDeviceTask,
  renewDeviceTaskLease,
  reportDeviceTaskProgress,
  completeDeviceTask,
  cancelDeviceTask,
  createAndDispatchTask,
  confirmDeviceTaskCheckpoint,
  rejectDeviceTaskCheckpoint,
} from '../lib/devicetask.js';
import {
  checkDeviceEligibility,
  type EligibilityRequirement,
} from '../lib/deviceeligibility.js';
import {
  isLineSendTool,
  LINE_DESKTOP_MANIFEST,
  LINE_DESKTOP_MCP_KEY,
} from '../lib/devicemcp.js';
import { isRunApproved } from '../lib/approval.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import {
  uploadDeviceArtifact,
  getArtifactMeta,
  readArtifactBytes,
  MAX_ARTIFACT_TTL_MS,
} from '../lib/deviceartifact.js';
import { isDeviceOnline, publishToDevice } from '../ws/hub.js';
import { prisma } from '../lib/db.js';
import {
  publishDeviceTaskLifecycle,
  toSafeDeviceTaskDto,
} from '../lib/devicetaskevents.js';
import type { DeviceTaskStatus } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    device?: Device;
  }
}

async function requireDevice(req: FastifyRequest): Promise<void> {
  // Explicitly reject query tokens (fail-closed).
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('token') || url.searchParams.has('deviceToken')) {
    throw errors.unauthorized('Device token must not be passed via query string');
  }
  const raw = deviceTokenFromAuthHeader(req.headers.authorization);
  const device = await authenticateDeviceToken(raw);
  req.device = device;
  void touchDeviceLastSeen(device.id);
}

const enrollBody = z
  .object({
    code: z.string().min(16),
    platform: z.enum(['MACOS', 'WINDOWS', 'LINUX']).optional(),
    osVersion: z.string().max(128).optional(),
    appVersion: z.string().max(128).optional(),
  })
  .strict();

const ackBody = z
  .object({
    leaseMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict()
  .optional();

const renewBody = z
  .object({
    leaseId: z.string().min(1),
    leaseMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

const progressBody = z
  .object({
    leaseId: z.string().min(1),
    progress: z.unknown(),
    status: z.enum(['RUNNING', 'AWAITING_CONFIRM']).optional(),
    confirmationArtifactId: z.string().min(1).optional(),
  })
  .strict();

const resultBody = z
  .object({
    /** Required after ACK — omit is fail-closed. */
    leaseId: z.string().min(1),
    status: z.enum(['SUCCEEDED', 'FAILED']),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .strict();

const cancelBody = z
  .object({
    reason: z.string().max(2000).optional(),
    leaseId: z.string().min(1).optional(),
  })
  .strict()
  .optional();

/** FDE-only: create a durable task. Payload is re-validated by lib allowlist (not arbitrary shell). */
const createTaskBody = z
  .object({
    deviceId: z.string().min(1),
    kind: z.enum([
      'COMPUTER_CONTROL',
      'MCP_TOOL',
      'SCREENSHOT',
      'CAPABILITY_PROBE',
      'LINE_DESKTOP',
      'MCP_INSTALL',
    ]),
    /** Typed allowlist enforced in createDeviceTask / validateDeviceTaskPayload. */
    payload: z.record(z.unknown()).default({}),
    agentId: z.string().min(1).optional(),
    runId: z.string().optional(),
    stepKey: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    deadlineAt: z.string().datetime().optional(),
  })
  .strict();

export async function deviceRoutes(app: FastifyInstance) {
  // ── Enroll (no device token yet) ────────────────────────────────────────

  app.post('/api/device/enroll', async (req, reply) => {
    try {
      const body = enrollBody.parse(req.body ?? {});
      const result = await enrollWithCode({
        code: body.code,
        platform: body.platform,
        osVersion: body.osVersion,
        appVersion: body.appVersion,
      });
      // Token plaintext returned once.
      return ok({
        deviceId: result.deviceId,
        token: result.token,
        device: result.device,
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Device self ─────────────────────────────────────────────────────────

  app.get('/api/device/me', { preHandler: requireDevice }, async (req, reply) => {
    try {
      const d = req.device!;
      return ok({
        ...toSafeDevice(d, isDeviceOnline(d.id)),
        online: isDeviceOnline(d.id),
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.put('/api/device/capabilities', { preHandler: requireDevice }, async (req, reply) => {
    try {
      const device = await updateDeviceCapabilities(req.device!.id, req.body);
      return ok({ ...device, online: isDeviceOnline(device.id) });
    } catch (e) {
      if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'ZodError') {
        return sendError(reply, errors.badRequest('Invalid capabilities document', e));
      }
      return sendError(reply, e);
    }
  });

  // ── Tasks (device-scoped) ───────────────────────────────────────────────

  app.get('/api/device/tasks', { preHandler: requireDevice }, async (req, reply) => {
    try {
      const tasks = await listOpenTasksForDevice(req.device!.id);
      return ok(tasks);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/device/tasks/:taskId', { preHandler: requireDevice }, async (req, reply) => {
    try {
      const { taskId } = req.params as { taskId: string };
      const task = await getTaskForDeviceOrThrow(taskId, req.device!.id);
      return ok(task);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/device/tasks/:taskId/ack', { preHandler: requireDevice }, async (req, reply) => {
    try {
      const { taskId } = req.params as { taskId: string };
      const body = ackBody.parse(req.body ?? {}) ?? {};
      const task = await ackDeviceTask({
        taskId,
        deviceId: req.device!.id,
        leaseMs: body.leaseMs,
      });
      publishDeviceTaskLifecycle('device.task.ack', task);
      return ok(task);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post(
    '/api/device/tasks/:taskId/lease/renew',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const body = renewBody.parse(req.body ?? {});
        const task = await renewDeviceTaskLease({
          taskId,
          deviceId: req.device!.id,
          leaseId: body.leaseId,
          leaseMs: body.leaseMs,
        });
        return ok(task);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/device/tasks/:taskId/progress',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const body = progressBody.parse(req.body ?? {});
        const task = await reportDeviceTaskProgress({
          taskId,
          deviceId: req.device!.id,
          leaseId: body.leaseId,
          progress: body.progress,
          status: body.status,
          confirmationArtifactId: body.confirmationArtifactId,
        });
        publishDeviceTaskLifecycle('device.task.progress', task);
        return ok(task);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/device/tasks/:taskId/result',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const parsed = resultBody.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw errors.badRequest('leaseId is required for task result', parsed.error.flatten());
        }
        const body = parsed.data;
        const task = await completeDeviceTask({
          taskId,
          deviceId: req.device!.id,
          leaseId: body.leaseId,
          status: body.status,
          result: body.result,
          error: body.error,
        });
        publishDeviceTaskLifecycle('device.task.result', task);
        return ok(task);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/device/tasks/:taskId/cancel',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const body = cancelBody.parse(req.body ?? {}) ?? {};
        const task = await cancelDeviceTask({
          taskId,
          deviceId: req.device!.id,
          reason: body.reason,
          leaseId: body.leaseId,
        });
        publishToDevice(req.device!.id, 'device.task.cancel', { taskId });
        publishDeviceTaskLifecycle('device.task.cancel', task);
        return ok(task);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // ── Artifacts ───────────────────────────────────────────────────────────

  app.post(
    '/api/device/tasks/:taskId/artifacts',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const deviceId = req.device!.id;

        // Multipart preferred; also accept JSON base64 for small test fixtures.
        const contentType = String(req.headers['content-type'] ?? '');
        if (contentType.includes('multipart/form-data')) {
          const file = await req.file();
          if (!file) throw errors.badRequest('No file uploaded');
          const buf = await file.toBuffer();
          const fields = file.fields as Record<string, { value?: string } | undefined>;
          const seqRaw = fieldValue(fields, 'seq') ?? '0';
          const kindRaw = fieldValue(fields, 'kind') ?? 'OTHER';
          const declared =
            (fieldValue(fields, 'clientDeclaredRedacted') ?? 'false').toLowerCase() === 'true';
          const mimeType = file.mimetype || fieldValue(fields, 'mimeType') || 'application/octet-stream';
          let meta: unknown;
          const metaRaw = fieldValue(fields, 'meta');
          if (metaRaw) {
            try {
              meta = JSON.parse(metaRaw);
            } catch {
              throw errors.badRequest('meta must be JSON');
            }
          }
          const kind = parseArtifactKind(kindRaw);
          const ttlRaw = fieldValue(fields, 'ttlMs');
          const ttlMs = ttlRaw ? Number(ttlRaw) : undefined;
          if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs > MAX_ARTIFACT_TTL_MS)) {
            throw errors.badRequest(`ttlMs exceeds maximum of ${MAX_ARTIFACT_TTL_MS}ms (30 days)`);
          }
          const art = await uploadDeviceArtifact({
            taskId,
            deviceId,
            seq: Number(seqRaw),
            kind,
            mimeType,
            bytes: buf,
            clientDeclaredRedacted: declared,
            meta,
            ttlMs,
          });
          return reply.code(201).send(ok(publicArtifact(art)));
        }

        const jsonBody = z
          .object({
            seq: z.number().int().nonnegative(),
            kind: z.enum(['SCREENSHOT', 'LOG', 'BINARY', 'OTHER']).default('OTHER'),
            mimeType: z.string().min(1).max(200),
            /** Base64-encoded body (for tests / small payloads). */
            dataBase64: z.string().min(1),
            clientDeclaredRedacted: z.boolean(),
            meta: z.unknown().optional(),
            ttlMs: z.number().int().positive().max(MAX_ARTIFACT_TTL_MS).optional(),
          })
          .strict()
          .parse(req.body ?? {});

        const bytes = Buffer.from(jsonBody.dataBase64, 'base64');
        if (bytes.length === 0) throw errors.badRequest('empty dataBase64');
        const art = await uploadDeviceArtifact({
          taskId,
          deviceId,
          seq: jsonBody.seq,
          kind: jsonBody.kind,
          mimeType: jsonBody.mimeType,
          bytes,
          clientDeclaredRedacted: jsonBody.clientDeclaredRedacted,
          meta: jsonBody.meta,
          ttlMs: jsonBody.ttlMs,
        });
        return reply.code(201).send(ok(publicArtifact(art)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/api/device/artifacts/:artifactId',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { artifactId } = req.params as { artifactId: string };
        const art = await getArtifactMeta({ artifactId, deviceId: req.device!.id });
        return ok(publicArtifact(art));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/api/device/artifacts/:artifactId/download',
    { preHandler: requireDevice },
    async (req, reply) => {
      try {
        const { artifactId } = req.params as { artifactId: string };
        const art = await getArtifactMeta({ artifactId, deviceId: req.device!.id });
        const bytes = await readArtifactBytes(art);
        return reply
          .header('Content-Type', art.mimeType)
          .header('Content-Length', bytes.length)
          .header('X-Artifact-Sha256', art.sha256)
          .send(bytes);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // ── FDE: create task + optional trainer artifact meta read ──────────────

  app.post('/api/device-tasks', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const body = createTaskBody.parse(req.body ?? {});
      const device = await prisma.device.findUnique({ where: { id: body.deviceId } });
      if (!device) throw errors.notFound('Device not found');
      if (device.status !== 'ACTIVE') throw errors.badRequest('Device must be ACTIVE');

      // Execution tasks (FDE-created) require client idempotencyKey.
      // Management probe/install may remain server-managed/optional.
      // Runner calls createAndDispatchTask directly and always supply keys.
      const EXECUTION_KINDS = new Set([
        'COMPUTER_CONTROL',
        'SCREENSHOT',
        'LINE_DESKTOP',
        'MCP_TOOL',
      ]);
      if (EXECUTION_KINDS.has(body.kind) && !body.idempotencyKey?.trim()) {
        throw errors.badRequest(
          'idempotencyKey required for COMPUTER_CONTROL, SCREENSHOT, LINE_DESKTOP, MCP_TOOL',
        );
      }

      // CAPABILITY_PROBE / MCP_INSTALL: management — still require online.
      if (body.kind === 'CAPABILITY_PROBE' || body.kind === 'MCP_INSTALL') {
        if (!isDeviceOnline(body.deviceId)) {
          throw errors.badRequest('DEVICE_OFFLINE');
        }
        if (body.kind === 'MCP_INSTALL') {
          // Force fixed LINE manifest — ignore client command/url/version overrides.
          body.payload = {
            mcpKey: LINE_DESKTOP_MANIFEST.mcpKey,
            packageName: LINE_DESKTOP_MANIFEST.packageName,
            version: LINE_DESKTOP_MANIFEST.version,
            sha256: LINE_DESKTOP_MANIFEST.sha256,
            toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
            transport: LINE_DESKTOP_MANIFEST.transport,
          };
        }
      } else if (
        body.kind === 'COMPUTER_CONTROL' ||
        body.kind === 'LINE_DESKTOP' ||
        body.kind === 'MCP_TOOL' ||
        body.kind === 'SCREENSHOT'
      ) {
        if (!body.agentId) throw errors.badRequest('agentId required for this task kind');
        let requirement: EligibilityRequirement;
        if (body.kind === 'SCREENSHOT') {
          requirement = 'screenshot';
        } else if (body.kind === 'LINE_DESKTOP') {
          const operation =
            body.payload?.operation === 'send' || body.payload?.operation === 'read'
              ? body.payload.operation
              : undefined;
          const tool =
            typeof body.payload?.tool === 'string' ? body.payload.tool.trim() : '';
          requirement = tool ? { kind: 'line_tool', tool } : 'line_desktop';
          // Defense in depth: send risk from operation AND tool — never tool alone.
          // operation=send always requires HITL even if tool were omitted (payload
          // validation also rejects omit-on-send; route must not skip approval).
          const sendByOperation = operation === 'send';
          const sendByTool = tool ? isLineSendTool(tool) : false;
          if (sendByOperation || sendByTool) {
            if (!body.runId) {
              throw errors.badRequest('runId required for LINE send (operation=send or send tool)');
            }
            const approved = await isRunApproved(body.runId);
            if (!approved) {
              throw errors.forbidden('LINE send requires real APPROVED ApprovalRequest for runId');
            }
          }
        } else if (body.kind === 'MCP_TOOL') {
          // Exact mcp_tool mapping — never default to computer_use.
          const serverId =
            typeof body.payload?.serverId === 'string' ? body.payload.serverId.trim() : '';
          const tool = typeof body.payload?.tool === 'string' ? body.payload.tool.trim() : '';
          if (!serverId || !tool) {
            throw errors.badRequest('MCP_TOOL requires payload.serverId and payload.tool');
          }
          // Eligibility layer is canonical-only for LINE; reject aliases fail-closed.
          if (serverId !== LINE_DESKTOP_MCP_KEY) {
            throw errors.badRequest(
              `Unsupported mcpKey/serverId: ${serverId} (only ${LINE_DESKTOP_MCP_KEY})`,
            );
          }
          requirement = { kind: 'mcp_tool', mcpKey: serverId, tool };
          // LINE send tools via MCP_TOOL: same HITL gate as LINE_DESKTOP.
          if (isLineSendTool(tool)) {
            if (!body.runId) throw errors.badRequest('runId required for LINE send tools');
            const approved = await isRunApproved(body.runId);
            if (!approved) {
              throw errors.forbidden('LINE send requires real APPROVED ApprovalRequest for runId');
            }
          }
          // Read tools: device-local consent + eligibility only (no run approval).
        } else {
          // COMPUTER_CONTROL
          requirement = 'computer_use';
        }
        const elig = await checkDeviceEligibility({
          deviceId: body.deviceId,
          agentId: body.agentId,
          requirement,
        });
        if (!elig.eligible) {
          throw errors.badRequest(`DEVICE_NOT_ELIGIBLE: ${elig.reasonCode} — ${elig.reason}`);
        }
      }

      const confirmationRequired =
        body.kind === 'COMPUTER_CONTROL' || body.kind === 'SCREENSHOT';

      const task = await createAndDispatchTask({
        deviceId: body.deviceId,
        kind: body.kind,
        payload: body.payload,
        agentId: body.agentId,
        runId: body.runId,
        stepKey: body.stepKey,
        idempotencyKey: body.idempotencyKey,
        deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : undefined,
        actorUserId: req.user!.sub,
        requestedByUserId: req.user!.sub,
        confirmationRequired,
      });

      const woke = publishToDevice(body.deviceId, 'device.task', { taskId: task.id });
      if (!woke) {
        await cancelDeviceTask({
          taskId: task.id,
          actorUserId: req.user!.sub,
          reason: 'DEVICE_OFFLINE at wake',
        });
        throw errors.badRequest('DEVICE_OFFLINE');
      }

      publishDeviceTaskLifecycle('device.task.create', task);
      return reply.code(201).send(ok(task));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** FDE inspect recent tasks (newest first). Safe fields only. */
  app.get('/api/device-tasks', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const q = z
        .object({
          deviceId: z.string().min(1).optional(),
          agentId: z.string().min(1).optional(),
          status: z
            .enum([
              'PENDING',
              'DISPATCHED',
              'ACKED',
              'RUNNING',
              'AWAITING_CONFIRM',
              'SUCCEEDED',
              'FAILED',
              'TIMEOUT',
              'CANCELLED',
            ])
            .optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
        })
        .strict()
        .parse(req.query ?? {});

      const limit = q.limit ?? 50;
      const where: {
        deviceId?: string;
        agentId?: string;
        status?: DeviceTaskStatus;
      } = {};
      if (q.deviceId) where.deviceId = q.deviceId;
      if (q.agentId) where.agentId = q.agentId;
      if (q.status) where.status = q.status;

      const rows = await prisma.deviceTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          deviceId: true,
          agentId: true,
          runId: true,
          stepKey: true,
          kind: true,
          status: true,
          idempotencyKey: true,
          leaseId: true,
          leaseExpiresAt: true,
          deadlineAt: true,
          confirmationRequired: true,
          confirmationArtifactId: true,
          confirmedAt: true,
          confirmedBy: true,
          requestedByUserId: true,
          terminalAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return ok(rows.map((r) => toSafeDeviceTaskDto(r)));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Confirmation checkpoints (user or FDE) ──────────────────────────────

  app.post('/api/device-tasks/:taskId/confirm', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { taskId } = req.params as { taskId: string };
      const task = await confirmDeviceTaskCheckpoint({
        taskId,
        actorUserId: req.user!.sub,
        actorRole: req.user!.role,
      });
      publishToDevice(task.deviceId, 'device.task.confirmed', { taskId: task.id });
      publishDeviceTaskLifecycle('device.task.confirm', task);
      return ok(task);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/device-tasks/:taskId/reject', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { taskId } = req.params as { taskId: string };
      const body = z.object({ reason: z.string().max(2000).optional() }).strict().parse(req.body ?? {});
      const task = await rejectDeviceTaskCheckpoint({
        taskId,
        actorUserId: req.user!.sub,
        actorRole: req.user!.role,
        reason: body.reason,
      });
      publishToDevice(task.deviceId, 'device.task.cancel', { taskId: task.id });
      publishDeviceTaskLifecycle('device.task.reject', task);
      return ok(task);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get(
    '/api/device-tasks/:taskId',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const task = await prisma.deviceTask.findUnique({ where: { id: taskId } });
        if (!task) throw errors.notFound('Task not found');
        return ok(task);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/device-tasks/:taskId/cancel',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const body = cancelBody.parse(req.body ?? {}) ?? {};
        const task = await cancelDeviceTask({
          taskId,
          actorUserId: req.user!.sub,
          reason: body.reason,
        });
        publishToDevice(task.deviceId, 'device.task.cancel', { taskId });
        return ok(task);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // FDE may read artifact metadata (not download via device path without auth).
  app.get(
    '/api/device-artifacts/:artifactId',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { artifactId } = req.params as { artifactId: string };
        const art = await getArtifactMeta({ artifactId });
        return ok(publicArtifact(art));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/api/device-artifacts/:artifactId/download',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { artifactId } = req.params as { artifactId: string };
        const art = await getArtifactMeta({ artifactId });
        const bytes = await readArtifactBytes(art);
        return reply
          .header('Content-Type', art.mimeType)
          .header('Content-Length', bytes.length)
          .header('X-Artifact-Sha256', art.sha256)
          .send(bytes);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );
}

function fieldValue(
  fields: Record<string, { value?: string } | undefined>,
  key: string,
): string | undefined {
  const f = fields[key];
  if (!f) return undefined;
  if (typeof f === 'object' && f !== null && 'value' in f) {
    return f.value !== undefined ? String(f.value) : undefined;
  }
  return undefined;
}

function parseArtifactKind(raw: string): 'SCREENSHOT' | 'LOG' | 'BINARY' | 'OTHER' {
  const u = raw.toUpperCase();
  if (u === 'SCREENSHOT' || u === 'LOG' || u === 'BINARY' || u === 'OTHER') return u;
  return 'OTHER';
}

function publicArtifact(art: {
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
  expiresAt: Date;
  meta: unknown;
  createdAt: Date;
  storageRelPath?: string;
}) {
  const meta = (art.meta && typeof art.meta === 'object' ? art.meta : {}) as Record<string, unknown>;
  const redactionMode = meta.redactionMode === 'server' ? 'server' : meta.redactionMode === 'client-attested' ? 'client-attested' : undefined;
  // Never expose absolute host paths.
  return {
    id: art.id,
    taskId: art.taskId,
    deviceId: art.deviceId,
    seq: art.seq,
    kind: art.kind,
    sha256: art.sha256,
    sizeBytes: art.sizeBytes,
    mimeType: art.mimeType,
    /** true when content was server-redacted OR client-attested for opaque binaries (see redactionMode). */
    redacted: art.redacted,
    clientDeclaredRedacted: art.clientDeclaredRedacted,
    redactionMode,
    expiresAt: art.expiresAt,
    meta: art.meta,
    createdAt: art.createdAt,
  };
}
