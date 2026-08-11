// Change proposal REST: operators create; FDE lists / approves / rejects.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import {
  createProposal,
  listPendingProposals,
  approveProposal,
  rejectProposal,
} from '../lib/changeproposal.js';
import { requireVisibleAgent } from '../lib/agentaccess.js';
import { createScheduleProposal } from '../lib/scheduleproposal.js';

const createBodySchema = z.object({
  targetType: z.enum(['AGENT', 'SKILL', 'RESTRICTION', 'IDENTITY_CARD', 'SCHEDULE']),
  targetId: z.string().min(1).optional(),
  proposedChange: z.unknown(),
  severity: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  runId: z.string().min(1).optional(),
});

export async function proposalRoutes(app: FastifyInstance) {
  // Operator (any authenticated user, including MEMBER) may propose changes.
  app.post('/api/agents/:id/proposals', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id: agentId } = req.params as { id: string };
      const body = createBodySchema.parse(req.body);
      await requireVisibleAgent(agentId, req.user!);

      if (body.targetType === 'SCHEDULE') {
        if (!body.targetId) throw errors.badRequest('SCHEDULE proposal requires targetId (workflowId)');
        const result = await createScheduleProposal({
          agentId,
          workflowId: body.targetId,
          proposedBy: req.user!.sub,
          change: body.proposedChange,
        });
        return reply.send(ok(result.proposal));
      }

      const proposal = await createProposal({
        agentId,
        runId: body.runId,
        source: 'OPERATOR',
        proposedBy: req.user!.sub,
        targetType: body.targetType,
        targetId: body.targetId,
        proposedChange: body.proposedChange ?? {},
        severity: body.severity,
        confidence: body.confidence,
      });
      return reply.send(ok(proposal));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // FDE inbox: pending proposals only.
  app.get('/api/proposals', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      const pending = await listPendingProposals();
      return reply.send(ok(pending));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/proposals/:id/approve', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const result = await approveProposal(id, req.user!.sub);
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/proposals/:id/reject', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const proposal = await rejectProposal(id, req.user!.sub);
      return reply.send(ok(proposal));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
