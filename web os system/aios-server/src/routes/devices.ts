/**
 * FDE device management REST.
 * Trainer-only: list/create/get devices, enroll codes, revoke/rotate, bind/unbind agents.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, errors, sendError } from '../lib/http.js';
import {
  createDevice,
  listDevices,
  getSafeDevice,
  issueEnrollmentCode,
  revokeDevice,
  rotateDeviceToken,
  bindAgentDevice,
  unbindAgentDevice,
  listAgentDevices,
  toSafeDevice,
} from '../lib/device.js';
import { isDeviceOnline, disconnectDevice } from '../ws/hub.js';
import { prisma } from '../lib/db.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import {
  listEligibleDevices,
  parseRequirementQuery,
} from '../lib/deviceeligibility.js';
import {
  listDeviceMcpInstalls,
  requestLineDesktopInstall,
  disableDeviceMcp,
  LINE_DESKTOP_MCP_KEY,
} from '../lib/devicemcp.js';

const createBody = z.object({
  name: z.string().min(1).max(200),
  platform: z.enum(['MACOS', 'WINDOWS', 'LINUX']),
});

const enrollCodeBody = z
  .object({
    ttlMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  })
  .strict()
  .optional();

const bindBody = z.object({
  deviceId: z.string().min(1),
});

export async function devicesRoutes(app: FastifyInstance) {
  // ── Devices CRUD (FDE) ──────────────────────────────────────────────────

  app.get('/api/devices', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      const devices = await listDevices();
      return ok(
        devices.map((d) => ({
          ...d,
          online: isDeviceOnline(d.id),
        })),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/devices', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const body = createBody.parse(req.body ?? {});
      const device = await createDevice({
        ownerUserId: req.user!.sub,
        name: body.name,
        platform: body.platform,
      });
      return reply.code(201).send(ok({ ...device, online: false }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/devices/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const device = await getSafeDevice(id);
      const agentBindings = await prisma.agentDevice.findMany({
        where: { deviceId: id },
        select: { agentId: true, boundAt: true, boundBy: true },
      });
      return ok({
        ...device,
        online: isDeviceOnline(id),
        agentBindings,
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/devices/:id/enroll-code', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = enrollCodeBody.parse(req.body ?? {}) ?? {};
      const result = await issueEnrollmentCode({
        deviceId: id,
        createdBy: req.user!.sub,
        ttlMs: body.ttlMs,
      });
      // Plaintext code returned once.
      return ok({
        enrollmentId: result.enrollmentId,
        code: result.code,
        codePrefix: result.codePrefix,
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/devices/:id/revoke', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const device = await revokeDevice({ deviceId: id, actorUserId: req.user!.sub });
      // Immediately drop any live device socket (token already invalidated in DB).
      disconnectDevice(id, 4001, 'revoked');
      return ok({ ...device, online: false });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/devices/:id/rotate', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { device, token } = await rotateDeviceToken({
        deviceId: id,
        actorUserId: req.user!.sub,
      });
      // Old token is dead — drop existing WS so it cannot keep receiving events.
      disconnectDevice(id, 4002, 'token rotated');
      // New token plaintext returned once; online=false until reconnect with new token.
      return ok({ device: { ...device, online: false }, token });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Agent ↔ Device binding ──────────────────────────────────────────────

  app.get('/api/agents/:agentId/devices', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { agentId } = req.params as { agentId: string };
      const agent = await prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
      if (!agent) throw errors.notFound('Agent not found');
      const rows = await listAgentDevices(agentId);
      return ok(
        rows.map((r) => ({
          agentId: r.agentId,
          deviceId: r.deviceId,
          boundAt: r.boundAt,
          boundBy: r.boundBy,
          device: toSafeDevice(r.device, isDeviceOnline(r.deviceId)),
        })),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/agents/:agentId/devices', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { agentId } = req.params as { agentId: string };
      const body = bindBody.parse(req.body ?? {});
      const row = await bindAgentDevice({
        agentId,
        deviceId: body.deviceId,
        boundBy: req.user!.sub,
      });
      return reply.code(201).send(ok(row));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete(
    '/api/agents/:agentId/devices/:deviceId',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { agentId, deviceId } = req.params as { agentId: string; deviceId: string };
        await unbindAgentDevice({
          agentId,
          deviceId,
          actorUserId: req.user!.sub,
        });
        return ok({ unbound: true, agentId, deviceId });
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Also accept DELETE /api/agents/:agentId/devices with body { deviceId } for convenience
  // Spec says POST/DELETE /api/agents/:agentId/devices — DELETE with body:
  app.delete('/api/agents/:agentId/devices', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { agentId } = req.params as { agentId: string };
      const body = bindBody.parse(req.body ?? {});
      await unbindAgentDevice({
        agentId,
        deviceId: body.deviceId,
        actorUserId: req.user!.sub,
      });
      return ok({ unbound: true, agentId, deviceId: body.deviceId });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Eligible devices (auth — for step editor / workbench) ───────────────

  app.get(
    '/api/agents/:agentId/eligible-devices',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { agentId } = req.params as { agentId: string };
        const q = req.query as { requirement?: string };
        const agent = await prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
        if (!agent) throw errors.notFound('Agent not found');
        let requirement;
        try {
          requirement = parseRequirementQuery(q.requirement);
        } catch (e) {
          throw errors.badRequest(e instanceof Error ? e.message : String(e));
        }
        const result = await listEligibleDevices(agentId, requirement);
        return ok(result);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // ── Device-local MCP (FDE only; fixed LINE manifest) ────────────────────

  app.get('/api/devices/:id/mcp', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      await getSafeDevice(id);
      const installs = await listDeviceMcpInstalls(id);
      return ok(installs);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post(
    '/api/devices/:id/mcp/line-desktop/install',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        // Body intentionally ignored for package/version/command — fixed manifest only.
        const result = await requestLineDesktopInstall({
          deviceId: id,
          actorUserId: req.user!.sub,
        });
        return reply.code(201).send(ok(result));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/devices/:id/mcp/:mcpKey/disable',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id, mcpKey } = req.params as { id: string; mcpKey: string };
        const key = mcpKey === 'line-desktop' ? LINE_DESKTOP_MCP_KEY : mcpKey;
        const row = await disableDeviceMcp({
          deviceId: id,
          mcpKey: key,
          actorUserId: req.user!.sub,
        });
        return ok(row);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );
}
