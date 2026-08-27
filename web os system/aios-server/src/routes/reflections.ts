// FDE-only reflection center: evidence, recommendations, and explicit decisions.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { requireTrainer } from '../lib/guard.js';
import { errors, ok, sendError } from '../lib/http.js';
import { stopWriteGuard } from '../lib/stopwrite.js';
import {
  dismissReflectionSuggestion,
  ensureReflectionAgent,
  proposeReflectionSuggestion,
  REFLECTION_CRON,
  REFLECTION_TIMES,
} from '../lib/reflection.js';
import { enqueueReflectionNow } from '../scheduler/index.js';

const idParams = z.object({ id: z.string().min(1) });

export async function reflectionRoutes(app: FastifyInstance) {
  app.get('/api/reflections', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      const [agent, cycles] = await Promise.all([
        ensureReflectionAgent(),
        prisma.reflectionCycle.findMany({
          orderBy: { windowEnd: 'desc' },
          take: 30,
          include: { _count: { select: { feedback: true, suggestions: true } } },
        }),
      ]);
      return reply.send(ok({
        schedule: { cron: REFLECTION_CRON, times: REFLECTION_TIMES, timezone: config.tz },
        agent,
        cycles: cycles.map(({ _count, ...cycle }) => ({
          ...cycle,
          feedbackCount: _count.feedback,
          suggestionCount: _count.suggestions,
        })),
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/reflections/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = idParams.parse(req.params);
      const cycle = await prisma.reflectionCycle.findUnique({
        where: { id },
        include: {
          feedback: { orderBy: { messageAt: 'desc' } },
          suggestions: { orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] },
        },
      });
      if (!cycle) throw errors.notFound('Reflection cycle not found');

      const userIds = [...new Set(cycle.feedback.map((item) => item.userId))];
      const agentIds = [...new Set([
        ...cycle.feedback.map((item) => item.agentId),
        ...cycle.suggestions.map((item) => item.agentId),
      ])];
      const skillIds = [...new Set(cycle.suggestions.flatMap((item) => item.skillId ? [item.skillId] : []))];
      const [users, agents, skills] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } }),
        prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, slug: true } }),
        prisma.skill.findMany({ where: { id: { in: skillIds } }, select: { id: true, name: true, slug: true } }),
      ]);
      const userById = new Map(users.map((item) => [item.id, item]));
      const agentById = new Map(agents.map((item) => [item.id, item]));
      const skillById = new Map(skills.map((item) => [item.id, item]));

      return reply.send(ok({
        ...cycle,
        feedback: cycle.feedback.map((item) => ({
          ...item,
          user: userById.get(item.userId) ?? null,
          agent: agentById.get(item.agentId) ?? null,
        })),
        suggestions: cycle.suggestions.map((item) => ({
          ...item,
          agent: agentById.get(item.agentId) ?? null,
          skill: item.skillId ? skillById.get(item.skillId) ?? null : null,
        })),
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/reflections/run', { preHandler: [requireTrainer, stopWriteGuard('reflection')] }, async (req, reply) => {
    try {
      let jobId: string;
      try {
        jobId = await enqueueReflectionNow(`fde:${req.user!.sub}`);
      } catch (e) {
        throw errors.notConfigured(e instanceof Error ? e.message : 'Scheduler is unavailable');
      }
      return reply.code(202).send(ok({ jobId, status: 'QUEUED' }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/reflection-suggestions/:id/propose', { preHandler: [requireTrainer, stopWriteGuard('reflection')] }, async (req, reply) => {
    try {
      const { id } = idParams.parse(req.params);
      return reply.send(ok(await proposeReflectionSuggestion(id, req.user!.sub)));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/reflection-suggestions/:id/dismiss', { preHandler: [requireTrainer, stopWriteGuard('reflection')] }, async (req, reply) => {
    try {
      const { id } = idParams.parse(req.params);
      return reply.send(ok(await dismissReflectionSuggestion(id, req.user!.sub)));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
