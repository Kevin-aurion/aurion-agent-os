// Record & Replay REST: start / status / stop + import recording → skill.
// start/stop require TRAINER|OWNER; status requires any authenticated user.
// Never auto-confirms imported skills (understand → AWAITING_USER_CONFIRM).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import {
  startRecording,
  recordingStatus,
  stopRecording,
  buildSkillFromRecording,
} from '../lib/recording.js';

const toSkillBodySchema = z.object({
  hint: z.string().optional(),
  metadataPath: z.string().optional(),
  eventsPath: z.string().optional(),
});

export async function recordingRoutes(app: FastifyInstance) {
  app.post('/api/recording/start', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      const result = await startRecording();
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/recording/status', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const status = await recordingStatus();
      return reply.send(ok(status));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/recording/stop', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      const result = await stopRecording();
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/agents/:id/recording/to-skill', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id: agentId } = req.params as { id: string };
      const body = toSkillBodySchema.parse(req.body ?? {});
      const agent = await prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
      if (!agent) throw errors.notFound('Agent not found');

      const result = await buildSkillFromRecording({
        agentId,
        createdBy: req.user!.sub,
        hint: body.hint,
        metadataPath: body.metadataPath,
        eventsPath: body.eventsPath,
      });
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
