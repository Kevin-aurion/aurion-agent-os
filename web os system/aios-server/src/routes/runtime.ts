// FDE REST for Runtime artifact validation, deployment activate/rollback/list/deactivate.
// Runtime ≠ Engine. All routes require requireTrainer (MEMBER / scoped OAuth → 403).
// Phase 6: dead-letter list / exactly-once replay / discard.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTrainer } from '../lib/guard.js';
import { errors, ok, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { redactSecrets } from '../memory/redactor.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import {
  activateDeployment,
  deactivateDeployment,
  getRuntimeArtifactDetail,
  listDeployments,
  listRuntimeArtifacts,
  rollbackDeployment,
  validateArtifactForRuntime,
} from '../lib/runtimedeployment.js';
import {
  dispatchScheduledWorkflow,
  resumePilotRun,
} from '../lib/runtimeexecution.js';

function asHttpError(e: unknown): unknown {
  if (e instanceof z.ZodError) {
    return errors.badRequest('Invalid request', e.issues);
  }
  return e;
}

const activateBody = z.object({
  artifactId: z.string().min(1),
  environment: z.enum(['SANDBOX', 'STAGING', 'PRODUCTION']),
  channel: z.enum(['CANARY', 'STABLE']),
});

const listQuery = z.object({
  skillId: z.string().min(1).optional(),
  environment: z.enum(['SANDBOX', 'STAGING', 'PRODUCTION']).optional(),
  channel: z.enum(['CANARY', 'STABLE']).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const artifactsListQuery = z.object({
  skillId: z.string().min(1).optional(),
  status: z.enum(['COMPILED', 'VALIDATED', 'REJECTED', 'SUPERSEDED']).optional(),
  runtimeKind: z.enum(['NATIVE', 'LANGFLOW']).optional(),
});

const pilotDispatchBody = z.object({
  workflowId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  input: z.record(z.unknown()).optional(),
});

const pilotResumeBody = z.object({
  approvalRequestId: z.string().min(1),
});

export async function runtimeRoutes(app: FastifyInstance) {
  app.get(
    '/api/runtime/artifacts',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const q = artifactsListQuery.parse(req.query);
        const result = await listRuntimeArtifacts({
          skillId: q.skillId,
          status: q.status,
          runtimeKind: q.runtimeKind,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.get(
    '/api/runtime/artifacts/:id',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const result = await getRuntimeArtifactDetail(id);
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/artifacts/:id/validate',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const result = await validateArtifactForRuntime({
          artifactId: id,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/deployments',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = activateBody.parse(req.body);
        const result = await activateDeployment({
          artifactId: body.artifactId,
          environment: body.environment,
          channel: body.channel,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/deployments/:id/rollback',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const result = await rollbackDeployment({
          deploymentId: id,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/deployments/:id/deactivate',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const result = await deactivateDeployment({
          deploymentId: id,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.get(
    '/api/runtime/deployments',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const q = listQuery.parse(req.query);
        const result = await listDeployments({
          skillId: q.skillId,
          environment: q.environment,
          channel: q.channel,
          active: q.active,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  // Ticket 18 — Production pilot dispatch + HITL resume
  app.post(
    '/api/runtime/pilot/dispatch',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = pilotDispatchBody.parse(req.body);
        const baseInput =
          body.input && typeof body.input === 'object' && !Array.isArray(body.input)
            ? { ...body.input }
            : {};
        if (body.messageId) {
          baseInput.messageId = body.messageId;
        }
        const result = await dispatchScheduledWorkflow(
          body.workflowId,
          baseInput,
          req.user!.sub,
        );
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/runs/:id/resume',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = pilotResumeBody.parse(req.body);
        const result = await resumePilotRun({
          runId: id,
          approvalRequestId: body.approvalRequestId,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok(result));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  // ── Phase 6: Dead-letter queue (FDE only) ───────────────────────────────
  const dlqListQuery = z.object({
    status: z.enum(['PENDING', 'REPLAYED', 'DISCARDED']).optional(),
  });

  app.get(
    '/api/runtime/dead-letters',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const q = dlqListQuery.parse(req.query);
        const rows = await prisma.runtimeDeadLetter.findMany({
          where: q.status ? { status: q.status } : undefined,
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
        return reply.send(ok({ items: rows, total: rows.length }));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/dead-letters/:id/replay',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const actorId = req.user!.sub;

        const existing = await prisma.runtimeDeadLetter.findUnique({
          where: { id },
        });
        if (!existing) throw errors.notFound('dead letter not found');

        // Exactly-once claim: only PENDING → REPLAYED with count===1 proceeds.
        const claimed = await prisma.runtimeDeadLetter.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'REPLAYED',
            replayedBy: actorId,
            replayedAt: new Date(),
          },
        });
        if (claimed.count !== 1) {
          throw errors.conflict('dead letter already replayed or discarded');
        }

        const payload =
          existing.payload &&
          typeof existing.payload === 'object' &&
          !Array.isArray(existing.payload)
            ? ({ ...(existing.payload as Record<string, unknown>) } as Record<
                string,
                unknown
              >)
            : {};

        const rawMid = payload.messageId ?? payload.message_id;
        const origMid =
          typeof rawMid === 'string' && rawMid.trim() ? rawMid.trim() : null;
        const replayMessageId = origMid
          ? `${origMid}:replay:${id}`
          : `dlq:${id}`;
        payload.messageId = replayMessageId;

        const dispatchResult = await dispatchScheduledWorkflow(
          existing.workflowId,
          deepRedactSecrets(payload) as Record<string, unknown>,
          actorId,
        );

        const replayedRunId = dispatchResult.runId ?? null;
        try {
          await prisma.runtimeDeadLetter.update({
            where: { id },
            data: { replayedRunId },
          });
        } catch (e) {
          console.warn(
            '[runtime] dlq replayedRunId update failed:',
            e instanceof Error ? e.message : e,
          );
        }

        try {
          await audit(actorId, 'runtime.dlq.replay', 'RuntimeDeadLetter', id, {
            replayedRunId,
            code: existing.code,
            workflowId: existing.workflowId,
          });
        } catch (e) {
          console.warn(
            '[runtime] dlq replay audit failed:',
            e instanceof Error ? e.message : e,
          );
        }

        return reply.send(
          ok({
            id,
            status: 'REPLAYED',
            replayedRunId,
            dispatch: dispatchResult,
          }),
        );
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/runtime/dead-letters/:id/discard',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const actorId = req.user!.sub;

        const existing = await prisma.runtimeDeadLetter.findUnique({
          where: { id },
        });
        if (!existing) throw errors.notFound('dead letter not found');

        const claimed = await prisma.runtimeDeadLetter.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'DISCARDED',
            replayedBy: actorId,
            replayedAt: new Date(),
          },
        });
        if (claimed.count !== 1) {
          throw errors.conflict('dead letter already replayed or discarded');
        }

        try {
          await audit(actorId, 'runtime.dlq.discard', 'RuntimeDeadLetter', id, {
            code: existing.code,
            reason: redactSecrets(existing.reason),
          });
        } catch (e) {
          console.warn(
            '[runtime] dlq discard audit failed:',
            e instanceof Error ? e.message : e,
          );
        }

        return reply.send(ok({ id, status: 'DISCARDED' }));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );
}
