// Internal loopback Model Gateway routes (Ticket 16 + Phase 6 identity).
// NOT under /api/* — service identity + loopback only (no requireAuth/requireTrainer).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors, ok, sendError } from '../lib/http.js';
import {
  gatewayExecute,
  gatewayVerify,
} from '../lib/modelgateway.js';
import {
  verifyServiceIdentity,
  type ServiceIdentity,
} from '../lib/serviceidentity.js';

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

const executeBody = z
  .object({
    runId: z.string().min(1),
    deploymentId: z.string().min(1),
    agentId: z.string().min(1),
    prompt: z.string().min(1),
    stepKey: z.string().min(1).max(200).optional(),
  })
  .strict();

const verifyBody = z
  .object({
    runId: z.string().min(1),
    deploymentId: z.string().min(1),
    agentId: z.string().min(1),
    artifact: z.string().min(1),
    rubric: z.string().optional(),
    sourceOfTruth: z.string().optional(),
    threadId: z.string().nullable().optional(),
  })
  .strict();

export async function modelGatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/internal/model/execute',
    { preHandler: async (req) => servicePreHandler(req) },
    async (req, reply) => {
      try {
        const body = executeBody.parse(req.body);
        return ok(
          await gatewayExecute({
            ...body,
            identity: req.serviceIdentity,
          }),
        );
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/internal/model/verify',
    { preHandler: async (req) => servicePreHandler(req) },
    async (req, reply) => {
      try {
        const body = verifyBody.parse(req.body);
        return ok(
          await gatewayVerify({
            ...body,
            identity: req.serviceIdentity,
          }),
        );
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.get(
    '/internal/model/health',
    { preHandler: async (req) => servicePreHandler(req) },
    async (req, reply) => {
      try {
        void req;
        return ok({ ok: true, at: new Date().toISOString() });
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );
}
