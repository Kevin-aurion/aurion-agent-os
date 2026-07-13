// GET/list runs, get run detail with steps, and best-effort cancel.
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import { hub } from '../ws/hub.js';
import { audit } from '../lib/audit.js';

export async function runRoutes(app: FastifyInstance) {
  app.get('/api/runs', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const q = req.query as { agentId?: string; limit?: string };
      const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
      const runs = await prisma.run.findMany({
        where: q.agentId ? { agentId: q.agentId } : undefined,
        orderBy: { startedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          agentId: true,
          workflowId: true,
          status: true,
          triggeredBy: true,
          startedAt: true,
          finishedAt: true,
        },
      });
      return reply.send(ok(runs));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const run = await prisma.run.findUnique({
        where: { id },
        include: { steps: { orderBy: { startedAt: 'asc' } } },
      });
      if (!run) throw errors.notFound('Run not found');
      return reply.send(ok(run));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/runs/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const run = await prisma.run.findUnique({ where: { id } });
      if (!run) throw errors.notFound('Run not found');

      if (run.status !== 'RUNNING') {
        return reply.send(ok({ id: run.id, status: run.status }));
      }

      const updated = await prisma.run.update({
        where: { id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });

      await audit(req.user?.sub ?? null, 'run.cancel', 'Run', id);
      hub.publish('run.finished', { runId: id, agentId: run.agentId, status: 'CANCELLED' });

      return reply.send(ok({ id: updated.id, status: updated.status }));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
