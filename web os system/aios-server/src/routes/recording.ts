// Record & Replay REST: start / status / stop + import recording → skill.
// Draft capture is requireAuth (MEMBER may record → inert RECORDED draft).
// Never auto-confirms; FDE confirm / confirm_skill proposal makes it effective.
// Session ownership + artifact paths live in RecordingService (server-held).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import { recordingService } from '../lib/recording.js';

const toSkillBodySchema = z.object({
  hint: z.string().trim().max(4000).optional(),
  /** Opaque server-issued id only; local artifact paths are never accepted. */
  sessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
}).strip();

const startBodySchema = z.object({
  agentId: z.string().min(1).max(100),
}).strip();

export async function recordingRoutes(app: FastifyInstance) {
  app.post('/api/recording/start', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const parsed = startBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw errors.badRequest('請先選擇要訓練的 Agent', parsed.error.issues);
      }
      const userId = req.user!.sub;
      const agent = await prisma.agent.findFirst({
        where: { id: parsed.data.agentId, deletedAt: null },
        select: { id: true },
      });
      if (!agent) throw errors.notFound('Agent not found');
      const result = await recordingService.start(userId, agent.id);
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/recording/status', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const userId = req.user!.sub;
      const result = await recordingService.status(userId);
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/recording/stop', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const userId = req.user!.sub;
      const active = await recordingService.currentActiveSessionFor(userId);
      if (!active) {
        throw errors.conflict('目前沒有由你開始的錄製');
      }
      const result = await recordingService.stop(userId, active.id);
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/agents/:id/recording/to-skill', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id: agentId } = req.params as { id: string };
      const parsed = toSkillBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw errors.badRequest('錄製技能資料格式不正確', parsed.error.issues);
      }
      const body = parsed.data;
      const userId = req.user!.sub;
      const agent = await prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
      if (!agent) throw errors.notFound('Agent not found');

      let sessionId = body.sessionId;
      if (!sessionId) {
        const session = await recordingService.latestStoppedSessionFor(userId);
        if (!session) {
          throw errors.badRequest('找不到由你完成的錄製，請重新開始並結束錄製');
        }
        sessionId = session.id;
      }

      const result = await recordingService.compileToDraft(
        userId,
        sessionId,
        agentId,
        body.hint,
      );
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
