// Internal loopback Knowledge Gateway (Phase 6 / Ticket 21).
// NOT under /api/* — service identity + loopback only.
// Runtime must not talk to Qdrant; this is the only knowledge entry.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, errors, ok, sendError } from '../lib/http.js';
import { loadGatewayContext } from '../lib/modelgateway.js';
import {
  assertEnvironmentBinding,
  verifyServiceIdentity,
  type ServiceIdentity,
} from '../lib/serviceidentity.js';
import { assertKnowledgeAccess } from '../lib/knowledgecapability.js';
import { recallHitsStrict } from '../memory/index.js';
import { redactSecrets } from '../memory/redactor.js';

declare module 'fastify' {
  interface FastifyRequest {
    serviceIdentity?: ServiceIdentity;
  }
}

function asHttpError(e: unknown): unknown {
  if (e instanceof z.ZodError) {
    return errors.badRequest('Invalid request', e.issues);
  }
  return e;
}

function servicePreHandler(req: FastifyRequest): void {
  const remote =
    req.ip ??
    (req.socket && 'remoteAddress' in req.socket
      ? (req.socket.remoteAddress as string | undefined)
      : undefined);
  req.serviceIdentity = verifyServiceIdentity({
    authorization: req.headers.authorization,
    remoteAddress: remote,
  });
}

const searchBody = z
  .object({
    runId: z.string().min(1),
    deploymentId: z.string().min(1),
    agentId: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export async function knowledgeGatewayRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    '/internal/knowledge/search',
    { preHandler: async (req) => servicePreHandler(req) },
    async (req, reply) => {
      try {
        const body = searchBody.parse(req.body);
        const ctx = await loadGatewayContext({
          runId: body.runId,
          deploymentId: body.deploymentId,
          agentId: body.agentId,
        });

        assertEnvironmentBinding(
          req.serviceIdentity,
          ctx.deployment.environment,
        );

        assertKnowledgeAccess({
          requesterAgentId: body.agentId,
          targetAgentId: ctx.agent.id,
          scope: 'read',
        });

        const topK = body.topK ?? 4;
        let hits;
        try {
          hits = await recallHitsStrict(ctx.agent.id, body.query, topK);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new ApiError(
            503,
            'SERVICE_UNAVAILABLE',
            `Knowledge search unavailable (fail-closed): ${redactSecrets(msg)}`,
          );
        }

        return ok({
          runId: ctx.run.id,
          agentId: ctx.agent.id,
          hits: hits.map((h) => ({
            text: redactSecrets(h.text),
            path: h.path,
            score: h.score,
          })),
          classificationCeiling: 'INTERNAL' as const,
          scope: 'read' as const,
        });
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );
}
