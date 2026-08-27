// FDE MCP server registry + health REST.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { ok, sendError, errors } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { openSession } from '../lib/mcpclient.js';
import {
  createServer,
  deleteServer,
  getServer,
  listServers,
  setEnabled,
  toSafeDto,
  toTransportConfig,
  updateHealthFields,
  updateServer,
} from '../lib/mcpregistry.js';
import { redactSecrets } from '../memory/redactor.js';
import { brokerDispatch } from '../lib/mcpbroker.js';
import { prisma } from '../lib/db.js';

const TransportEnum = z.enum(['STDIO', 'LOOPBACK_HTTP', 'REMOTE_HTTP']);
const TrustEnum = z.enum(['UNTRUSTED', 'TRUSTED', 'INTERNAL']);

const createBody = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  transport: TransportEnum,
  command: z.string().optional().nullable(),
  commandArgs: z.array(z.string()).optional(),
  cwd: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  protocolVersion: z.string().optional(),
  enabled: z.boolean().optional(),
  trustTier: TrustEnum.optional(),
  credentialRef: z.string().optional().nullable(),
  allowedAgentIds: z.array(z.string()).optional(),
  toolAllowlist: z.array(z.string()).optional(),
  resourceAllowlist: z.array(z.string()).optional(),
  readWriteClass: z.string().optional(),
  requiredRestrictions: z.array(z.string()).optional(),
  riskTier: z.string().optional(),
  approvalRequired: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const patchBody = createBody.partial();

const callBody = z.object({
  agentId: z.string().min(1),
  serverId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  runId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().positive().max(10 * 60_000).optional(),
});

export async function mcpRoutes(app: FastifyInstance) {
  app.post(
    '/mcp/call',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const body = callBody.parse(req.body);
        const agent = await prisma.agent.findFirst({
          where: { id: body.agentId, deletedAt: null },
          select: { createdBy: true },
        });
        if (!agent) throw errors.notFound('agent not found');
        const isFde = req.user!.role === 'OWNER' || req.user!.role === 'TRAINER';
        if (agent.createdBy !== req.user!.sub && !isFde) {
          // Avoid exposing another user's Agent existence.
          throw errors.notFound('agent not found');
        }
        const result = await brokerDispatch({
          ...body,
          userId: req.user!.sub,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/mcp/servers',
    { preHandler: requireAuth },
    async (_req, reply) => {
      try {
        return reply.send(ok(await listServers()));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/mcp/servers/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const entry = await getServer(id);
        if (!entry) throw errors.notFound('mcp server not found');
        return reply.send(ok(toSafeDto(entry)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/mcp/servers/:id/health',
    { preHandler: requireAuth },
    async (req, reply) => {
      // FAIL-SAFE health probe — always 200
      const { id } = req.params as { id: string };
      try {
        const entry = await getServer(id);
        if (!entry) {
          return reply.send(
            ok({ status: 'error', message: 'mcp server not found' }),
          );
        }
        let session: Awaited<ReturnType<typeof openSession>> | null = null;
        try {
          const cfg = toTransportConfig(entry);
          cfg.connectTimeoutMs = 5_000;
          cfg.callTimeoutMs = 5_000;
          session = await openSession(cfg);
          const tools = await session.listTools();
          const names = tools.map((t) => t.name);
          // Try to read version from a prior initialize is not stored; use tool count as signal.
          const version = entry.lastVersion ?? `tools:${names.length}`;
          await updateHealthFields(entry.id, {
            healthStatus: 'healthy',
            lastVersion: version,
            lastHealthAt: new Date(),
          });
          return reply.send(
            ok({ status: 'healthy', version, tools: names }),
          );
        } catch (e) {
          const message = redactSecrets(
            e instanceof Error ? e.message : String(e),
          ).slice(0, 200);
          try {
            await updateHealthFields(entry.id, {
              healthStatus: 'error',
              lastHealthAt: new Date(),
            });
          } catch {
            // ignore persist failure
          }
          return reply.send(ok({ status: 'error', message }));
        } finally {
          try {
            session?.close();
          } catch {
            // ignore
          }
        }
      } catch (e) {
        const message = redactSecrets(
          e instanceof Error ? e.message : String(e),
        ).slice(0, 200);
        return reply.send(ok({ status: 'error', message }));
      }
    },
  );

  app.post(
    '/mcp/servers',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = createBody.parse(req.body);
        const dto = await createServer(body, req.user!.sub);
        await audit(req.user!.sub, 'mcp_server.create', 'McpServerRegistry', dto.id, {
          serverId: dto.serverId,
          transport: dto.transport,
        });
        return reply.code(201).send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.patch(
    '/mcp/servers/:id',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = patchBody.parse(req.body);
        const dto = await updateServer(id, body, req.user!.sub);
        await audit(req.user!.sub, 'mcp_server.update', 'McpServerRegistry', dto.id, {
          serverId: dto.serverId,
        });
        return reply.send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/mcp/servers/:id/enable',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const dto = await setEnabled(id, true, req.user!.sub);
        await audit(req.user!.sub, 'mcp_server.enable', 'McpServerRegistry', dto.id, {
          serverId: dto.serverId,
        });
        return reply.send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/mcp/servers/:id/disable',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const dto = await setEnabled(id, false, req.user!.sub);
        await audit(req.user!.sub, 'mcp_server.disable', 'McpServerRegistry', dto.id, {
          serverId: dto.serverId,
        });
        return reply.send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.delete(
    '/mcp/servers/:id',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        await deleteServer(id, req.user!.sub);
        await audit(req.user!.sub, 'mcp_server.delete', 'McpServerRegistry', id, {});
        return reply.send(ok({ deleted: true }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );
}
