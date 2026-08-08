// Agent identity-card endpoints (governance). Separate from agents.ts WIP.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import {
  parseIdentityCard,
  checkIdentityCard,
  emptyIdentityCard,
  type IdentityCard,
} from '../lib/identitycard.js';
import { requireVisibleAgent } from '../lib/agentaccess.js';

export async function identityRoutes(app: FastifyInstance) {
  // Read identity card (empty structure if unset).
  app.get('/api/agents/:id/identity-card', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const agent = await requireVisibleAgent(id, req.user!);

      if (agent.identityCard == null) {
        return ok(emptyIdentityCard());
      }
      const { card } = parseIdentityCard(agent.identityCard);
      return ok(card);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Upsert identity card (trainer+). Body normalized via parseIdentityCard.
  app.put('/api/agents/:id/identity-card', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const existing = await prisma.agent.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw errors.notFound('Agent not found');

      const { card, errors: parseErrors } = parseIdentityCard(req.body);
      const check = checkIdentityCard(card);

      await prisma.agent.update({
        where: { id },
        data: { identityCard: card as object },
      });

      await audit(req.user!.sub, 'agent.identity_card_updated', 'Agent', id, {
        complete: check.complete,
        parseErrors: parseErrors.length ? parseErrors : undefined,
      });

      return ok({ card: card as IdentityCard, check });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
