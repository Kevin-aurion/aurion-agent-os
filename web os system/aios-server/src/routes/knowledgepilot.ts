import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTrainer } from '../lib/guard.js';
import { ApiError, errors, ok, sendError } from '../lib/http.js';
import {
  KNOWLEDGE_PILOT_MAX_QUESTION,
  KnowledgePilotRunError,
  getKnowledgePilotStatus,
  listKnowledgePilotRuns,
  runKnowledgePilot,
} from '../lib/knowledgepilot.js';

const queryBody = z.object({
  question: z.string().trim().min(2).max(KNOWLEDGE_PILOT_MAX_QUESTION),
  limit: z.number().int().min(1).max(6).default(4),
}).strict();

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const requestWindows = new Map<string, number[]>();
function enforceRateLimit(actorId: string): void {
  const now = Date.now();
  const recent = (requestWindows.get(actorId) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= 12) {
    throw new ApiError(429, 'RATE_LIMITED', '每分鐘最多執行 12 次知識查詢，請稍後再試');
  }
  recent.push(now);
  requestWindows.set(actorId, recent);
}

function asHttpError(error: unknown): unknown {
  if (error instanceof z.ZodError) return errors.badRequest('查詢輸入格式不正確', error.issues);
  if (error instanceof KnowledgePilotRunError) {
    return new ApiError(503, 'KNOWLEDGE_PILOT_FAILED', error.message, {
      runId: error.record.id,
      trace: error.record.trace,
    });
  }
  return error;
}

export async function knowledgePilotRoutes(app: FastifyInstance) {
  app.get(
    '/api/runtime/knowledge-pilot',
    { preHandler: requireTrainer },
    async (_req, reply) => {
      try {
        return reply.send(ok(await getKnowledgePilotStatus()));
      } catch (error) {
        return sendError(reply, asHttpError(error));
      }
    },
  );

  app.get(
    '/api/runtime/knowledge-pilot/runs',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const query = historyQuery.parse(req.query);
        return reply.send(ok(await listKnowledgePilotRuns(query.limit)));
      } catch (error) {
        return sendError(reply, asHttpError(error));
      }
    },
  );

  app.post(
    '/api/runtime/knowledge-pilot/query',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = queryBody.parse(req.body);
        const actorId = req.user!.sub;
        enforceRateLimit(actorId);
        const record = await runKnowledgePilot({
          question: body.question,
          limit: body.limit,
          actorId,
        });
        return reply.send(ok(record));
      } catch (error) {
        return sendError(reply, asHttpError(error));
      }
    },
  );
}
