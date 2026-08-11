// Oral / conversational skill training endpoints (agent-scoped).
// Draft capture is requireAuth (MEMBER may create inert drafts + propose).
// Only FDE confirm/approve makes skills effective — never auto-confirm here.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { draftSkillFromMessage, listAgentFlows } from '../lib/skilltraining.js';

const trainMessageSchema = z.object({
  message: z.string().min(1),
  /** Optional draft id — must already be linked to this agent (fail-closed). */
  skillId: z.string().min(1).optional(),
});

export async function trainingRoutes(app: FastifyInstance) {
  // Deterministic plain-language inventory of mounted skills + workflows.
  app.get('/api/agents/:id/flows', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const flows = await listAgentFlows(id);
      return ok(flows);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Natural-language skill draft/update → understand gate (never auto-confirm).
  // Authenticated operators (incl. MEMBER) may draft; FDE alone confirms.
  app.post('/api/agents/:id/train/message', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const parsed = trainMessageSchema.safeParse(req.body);
      if (!parsed.success) throw errors.badRequest('message is required');
      const body = parsed.data;
      const result = await draftSkillFromMessage({
        agentId: id,
        message: body.message,
        skillId: body.skillId,
        createdBy: req.user!.sub,
      });
      await audit(req.user!.sub, 'agent.train_message', 'Skill', result.skillId, {
        agentId: id,
        reviewStatus: result.reviewStatus,
        skillId: result.skillId,
      });
      return ok(result);
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
