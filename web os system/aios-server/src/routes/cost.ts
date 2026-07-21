// Per-agent cost spend + budget policy endpoints (L7 cost ledger).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { getSpend, getSpendByStep } from '../engine/cost.js';

const costPolicySchema = z.object({
  dailyBudgetUsd: z.number().nonnegative().optional(),
  monthlyBudgetUsd: z.number().nonnegative().optional(),
  hardStop: z.boolean().optional(),
});

export async function costRoutes(app: FastifyInstance) {
  // Current spend + policy for an agent.
  app.get('/api/agents/:id/cost', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const agent = await prisma.agent.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, costPolicy: true },
      });
      if (!agent) throw errors.notFound('Agent not found');
      const spend = await getSpend(agent.id);
      const byStep = await getSpendByStep(agent.id);
      return ok({
        todayUsd: spend.todayUsd,
        monthUsd: spend.monthUsd,
        policy: agent.costPolicy ?? null,
        byStep,
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Update cost policy (daily/monthly budgets, hardStop flag).
  app.put('/api/agents/:id/cost-policy', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = costPolicySchema.parse(req.body);
      const existing = await prisma.agent.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw errors.notFound('Agent not found');

      const prev =
        existing.costPolicy && typeof existing.costPolicy === 'object' && !Array.isArray(existing.costPolicy)
          ? (existing.costPolicy as Record<string, unknown>)
          : {};
      const next = {
        ...prev,
        ...body,
      };

      const agent = await prisma.agent.update({
        where: { id },
        data: { costPolicy: next },
      });
      await audit(req.user!.sub, 'agent.cost_policy_updated', 'Agent', id, body);
      return ok({ id: agent.id, costPolicy: agent.costPolicy });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
