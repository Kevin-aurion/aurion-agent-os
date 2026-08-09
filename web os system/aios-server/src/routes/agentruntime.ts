// Least-privilege Agent runtime for the public Remote MCP. Every query is
// forced to the signed-in account, including OWNER accounts: OAuth callers do
// not inherit the FDE cross-customer view.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { requireAuth } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { errors, ok, sendError } from '../lib/http.js';
import { createScheduleProposal } from '../lib/scheduleproposal.js';
import { runWorkflow } from '../workflow/runner.js';
import { runAgent } from '../engine/index.js';

const invocationBodySchema = z
  .object({
    workflowId: z.string().min(1).optional(),
    input: z.record(z.unknown()).default({}),
    idempotencyKey: z.string().min(1).max(160).optional(),
  })
  .strict();

const scheduleBodySchema = z
  .object({
    action: z.enum(['UPSERT', 'PAUSE', 'RESUME', 'DELETE']),
    workflowId: z.string().min(1),
    cron: z.string().min(1).max(160).optional(),
    timezone: z.string().min(1).max(120).optional(),
    input: z.record(z.unknown()).optional(),
    requestKey: z.string().min(1).max(160).optional(),
  })
  .strict();

const pendingRuntimeRuns = new Set<string>();

function runtimeRunId(userId: string, agentId: string, workflowId: string | undefined, key: string): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${agentId}\0${workflowId ?? ''}\0${key}`)
    .digest('hex');
  return `mcp_${digest.slice(0, 48)}`;
}

function assertJsonSize(value: unknown, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > 64 * 1024) throw errors.badRequest(`${label} exceeds 64 KiB`);
}

async function requireOwnedCallableAgent(agentId: string, userId: string) {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      createdBy: userId,
      status: 'ACTIVE',
      systemManaged: false,
      deletedAt: null,
    },
  });
  if (!agent) throw errors.notFound('Callable Agent not found');
  return agent;
}

function serializeWorkflow(workflow: {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: unknown;
  trigger: unknown;
  _count: { steps: number };
  schedules: Array<{
    id: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    lastFiredAt: Date | null;
    nextFireAt: Date | null;
  }>;
}) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    enabled: workflow.enabled,
    inputSchema: workflow.inputSchema,
    stepCount: workflow._count.steps,
    triggerType:
      workflow.trigger && typeof workflow.trigger === 'object' && !Array.isArray(workflow.trigger)
        ? ((workflow.trigger as Record<string, unknown>).type ?? 'manual')
        : 'manual',
    schedule: workflow.schedules[0] ?? null,
  };
}

export async function agentRuntimeRoutes(app: FastifyInstance) {
  app.get('/api/agent-runtime/agents', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const agents = await prisma.agent.findMany({
        where: {
          createdBy: req.user!.sub,
          status: 'ACTIVE',
          systemManaged: false,
          deletedAt: null,
        },
        include: {
          skills: {
            where: { skill: { is: { deletedAt: null, reviewStatus: 'CONFIRMED' } } },
            select: { skillId: true },
          },
          workflows: {
            where: { deletedAt: null, enabled: true },
            include: {
              _count: { select: { steps: true } },
              schedules: { orderBy: { id: 'asc' }, take: 1 },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });
      return reply.send(
        ok(
          agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            department: agent.department,
            riskTier: agent.riskTier,
            approvalRequired: agent.riskTier === 'high',
            confirmedSkillCount: agent.skills.length,
            workflows: agent.workflows.map(serializeWorkflow),
            updatedAt: agent.updatedAt,
          })),
        ),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/agent-runtime/agents/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const agent = await requireOwnedCallableAgent(id, req.user!.sub);
      const [skills, workflows] = await Promise.all([
        prisma.agentSkill.findMany({
          where: {
            agentId: agent.id,
            skill: { is: { deletedAt: null, reviewStatus: 'CONFIRMED' } },
          },
          select: {
            skill: {
              select: {
                id: true,
                name: true,
                kind: true,
                origin: true,
                executionEnv: true,
                understanding: true,
              },
            },
          },
        }),
        prisma.workflow.findMany({
          where: { agentId: agent.id, deletedAt: null, enabled: true },
          include: {
            _count: { select: { steps: true } },
            schedules: { orderBy: { id: 'asc' }, take: 1 },
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      return reply.send(
        ok({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          department: agent.department,
          identityCard: agent.identityCard,
          riskTier: agent.riskTier,
          approvalRequired: agent.riskTier === 'high',
          skills: skills.map(({ skill }) => skill),
          workflows: workflows.map(serializeWorkflow),
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/agent-runtime/agents/:id/invoke', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const body = invocationBodySchema.parse(req.body ?? {});
      assertJsonSize(body.input, 'Agent input');
      const agent = await requireOwnedCallableAgent(id, req.user!.sub);

      if (body.workflowId) {
        const workflow = await prisma.workflow.findFirst({
          where: {
            id: body.workflowId,
            agentId: agent.id,
            enabled: true,
            deletedAt: null,
            steps: { some: {} },
          },
          select: { id: true },
        });
        if (!workflow) throw errors.notFound('Enabled Agent workflow not found');
      }

      const runId = body.idempotencyKey
        ? runtimeRunId(req.user!.sub, agent.id, body.workflowId, body.idempotencyKey)
        : ulid();
      const existing = await prisma.run.findUnique({
        where: { id: runId },
        select: { id: true, agentId: true, status: true },
      });
      if (existing) {
        if (existing.agentId !== agent.id) throw errors.conflict('Idempotency key collision');
        return reply.send(ok({ runId, status: existing.status, deduplicated: true }));
      }
      if (pendingRuntimeRuns.has(runId)) {
        return reply.code(202).send(ok({ runId, status: 'QUEUED', deduplicated: true }));
      }

      pendingRuntimeRuns.add(runId);
      const execution = body.workflowId
        ? runWorkflow(body.workflowId, body.input, req.user!.sub, runId)
        : runAgent({
            runId,
            agentId: agent.id,
            input: body.input,
            triggeredBy: req.user!.sub,
          });
      void execution
        .catch((error) => {
          app.log.error({ err: error, agentId: agent.id, runId }, 'MCP Agent invocation failed');
        })
        .finally(() => pendingRuntimeRuns.delete(runId));

      await audit(req.user!.sub, 'agent.runtime.invoke', 'Agent', agent.id, {
        runId,
        workflowId: body.workflowId ?? null,
      });
      return reply.code(202).send(ok({ runId, status: 'QUEUED', deduplicated: false }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/agent-runtime/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const run = await prisma.run.findFirst({
        where: {
          id,
          agent: { is: { createdBy: req.user!.sub, systemManaged: false, deletedAt: null } },
        },
        select: {
          id: true,
          agentId: true,
          workflowId: true,
          status: true,
          input: true,
          output: true,
          stoppedAt: true,
          startedAt: true,
          finishedAt: true,
          steps: {
            orderBy: [{ startedAt: 'asc' }, { round: 'asc' }],
            select: {
              stepKey: true,
              round: true,
              status: true,
              output: true,
              approved: true,
              error: true,
              startedAt: true,
              endedAt: true,
            },
          },
        },
      });
      if (!run) throw errors.notFound('Agent run not found');
      return reply.send(ok(run));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/agent-runtime/agents/:id/schedules', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const agent = await requireOwnedCallableAgent(id, req.user!.sub);
      const workflows = await prisma.workflow.findMany({
        where: { agentId: agent.id, deletedAt: null, enabled: true },
        include: {
          _count: { select: { steps: true } },
          schedules: { orderBy: { id: 'asc' }, take: 1 },
        },
        orderBy: { createdAt: 'asc' },
      });
      return reply.send(ok(workflows.map(serializeWorkflow)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/agent-runtime/agents/:id/schedule-proposals', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const body = scheduleBodySchema.parse(req.body);
      const agent = await requireOwnedCallableAgent(id, req.user!.sub);
      const result = await createScheduleProposal({
        agentId: agent.id,
        workflowId: body.workflowId,
        proposedBy: req.user!.sub,
        change: body,
      });
      await audit(req.user!.sub, 'schedule.proposal.created', 'ChangeProposal', result.proposal.id, {
        agentId: agent.id,
        workflowId: body.workflowId,
        action: body.action,
        deduplicated: result.deduplicated,
      });
      return reply.code(result.deduplicated ? 200 : 202).send(
        ok({
          proposalId: result.proposal.id,
          status: result.proposal.status,
          deduplicated: result.deduplicated,
          note: 'The schedule is not active until an FDE approves this proposal.',
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
