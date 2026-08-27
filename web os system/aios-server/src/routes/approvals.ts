// HITL approval endpoints: list pending, approve (resume run), reject (cancel run).
import type { FastifyInstance } from 'fastify';
import { requireTrainer } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import { hub } from '../ws/hub.js';
import { audit } from '../lib/audit.js';
import { listPending, decideApproval } from '../lib/approval.js';

export async function approvalRoutes(app: FastifyInstance) {
  app.get('/api/approvals', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      const pending = await listPending();
      return reply.send(ok(pending));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/approvals/:id/approve', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const decidedBy = req.user!.sub;
      const approval = await decideApproval(id, true, decidedBy);

      const payload = (approval.payload ?? {}) as {
        agentId?: string;
        workflowId?: string;
        input?: Record<string, unknown>;
        triggeredBy?: string;
      };

      if (!payload.agentId || !payload.triggeredBy) {
        throw errors.badRequest('Approval payload missing agentId or triggeredBy');
      }

      await audit(decidedBy, 'approval.approved', 'ApprovalRequest', id, {
        runId: approval.runId,
        agentId: approval.agentId,
      });

      // Dynamic import to avoid circular dep with engine → routes.
      const { runAgent } = await import('../engine/index.js');
      const outcome = await runAgent({
        agentId: payload.agentId,
        workflowId: payload.workflowId,
        input: (payload.input ?? {}) as import('../engine/types.js').RunAgentInput,
        triggeredBy: payload.triggeredBy,
        runId: approval.runId,
        approvedApprovalId: id,
      });

      return reply.send(
        ok({
          approvalId: id,
          runId: outcome.runId,
          status: outcome.status,
          ok: outcome.ok,
          stoppedAt: outcome.stoppedAt ?? null,
          resultsCount: outcome.results.length,
        }),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/approvals/:id/reject', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const decidedBy = req.user!.sub;
      const approval = await decideApproval(id, false, decidedBy);

      await prisma.run.update({
        where: { id: approval.runId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });

      await audit(decidedBy, 'approval.rejected', 'ApprovalRequest', id, {
        runId: approval.runId,
        agentId: approval.agentId,
      });
      hub.publish('run.finished', {
        runId: approval.runId,
        agentId: approval.agentId,
        status: 'CANCELLED',
      });

      return reply.send(ok({ approvalId: id, runId: approval.runId, status: 'CANCELLED' }));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
