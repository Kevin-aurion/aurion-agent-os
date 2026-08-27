// FDE-gated A2A peer registry + opt-in remote task gateway + agent card projection.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTrainer } from '../lib/guard.js';
import { ok, sendError, errors } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { stopWriteGuard } from '../lib/stopwrite.js';
import { projectAgentCard } from '../lib/agentcard.js';
import {
  cancelTask,
  deletePeer,
  fetchPeerCard,
  getTaskStatus,
  listPeers,
  registerPeer,
  setPeerEnabled,
  submitTask,
  getPeer,
} from '../lib/a2a.js';

// Entire A2A surface is FDE-only (OWNER/TRAINER). Fail-closed: MEMBER ⇒ 403
// before any peer network dispatch or card projection.

const registerBody = z.object({
  peerId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  baseUrl: z.string().url(),
  credentialRef: z.string().optional().nullable(),
  riskTier: z.enum(['low', 'medium', 'high']).optional(),
  maxPayloadBytes: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

const enabledBody = z.object({
  enabled: z.boolean(),
});

const submitBody = z.object({
  peerId: z.string().min(1),
  agentId: z.string().optional(),
  payload: z.unknown(),
});

export async function a2aRoutes(app: FastifyInstance) {
  app.get(
    '/a2a/peers',
    { preHandler: requireTrainer },
    async (_req, reply) => {
      try {
        return reply.send(ok(await listPeers()));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/a2a/peers/:peerId/card',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { peerId } = req.params as { peerId: string };
        const card = await fetchPeerCard(peerId);
        return reply.send(ok(card));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/a2a/peers',
    { preHandler: [requireTrainer, stopWriteGuard('a2a')] },
    async (req, reply) => {
      try {
        const body = registerBody.parse(req.body);
        const dto = await registerPeer(body, req.user!.sub);
        await audit(req.user!.sub, 'a2a.peer.register', 'A2APeer', dto.id, {
          peerId: dto.peerId,
        });
        return reply.code(201).send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.patch(
    '/a2a/peers/:peerId/enabled',
    { preHandler: [requireTrainer, stopWriteGuard('a2a')] },
    async (req, reply) => {
      try {
        const { peerId } = req.params as { peerId: string };
        const body = enabledBody.parse(req.body);
        const dto = await setPeerEnabled(peerId, body.enabled, req.user!.sub);
        await audit(req.user!.sub, 'a2a.peer.enabled', 'A2APeer', dto.id, {
          peerId: dto.peerId,
          enabled: dto.enabled,
        });
        return reply.send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.delete(
    '/a2a/peers/:peerId',
    { preHandler: [requireTrainer, stopWriteGuard('a2a')] },
    async (req, reply) => {
      try {
        const { peerId } = req.params as { peerId: string };
        const existing = await getPeer(peerId);
        if (!existing) throw errors.notFound('a2a peer not found');
        await deletePeer(peerId);
        await audit(req.user!.sub, 'a2a.peer.delete', 'A2APeer', existing.id, {
          peerId: existing.peerId,
        });
        return reply.send(ok({ deleted: true }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/a2a/agents/:agentId/card',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { agentId } = req.params as { agentId: string };
        const card = await projectAgentCard(agentId);
        return reply.send(ok(card));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/a2a/tasks',
    { preHandler: [requireTrainer, stopWriteGuard('a2a')] },
    async (req, reply) => {
      try {
        const body = submitBody.parse(req.body);
        const dto = await submitTask({
          peerId: body.peerId,
          agentId: body.agentId,
          payload: body.payload,
          submittedBy: req.user!.sub,
        });
        return reply.code(201).send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/a2a/tasks/:taskId',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const dto = await getTaskStatus(taskId);
        return reply.send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/a2a/tasks/:taskId/cancel',
    { preHandler: [requireTrainer, stopWriteGuard('a2a')] },
    async (req, reply) => {
      try {
        const { taskId } = req.params as { taskId: string };
        const dto = await cancelTask(taskId, req.user!.sub);
        return reply.send(ok(dto));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );
}
