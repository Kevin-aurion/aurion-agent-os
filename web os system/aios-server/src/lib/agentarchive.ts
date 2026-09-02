// Account-scoped Agent archival for MCP callers. A caller may archive only an
// Agent it owns and must provide an exact-name confirmation plus a stable key.
import { createHash } from 'node:crypto';
import type { ChangeProposal, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { errors } from './http.js';

export const AgentArchiveProposalSchema = z
  .object({
    confirmAgentName: z.string().min(1).max(240),
    requestKey: z.string().min(8).max(160),
  })
  .strict();

export type AgentArchiveProposalInput = z.infer<typeof AgentArchiveProposalSchema>;

function requestKeyHash(requestKey: string): string {
  return createHash('sha256').update(requestKey, 'utf8').digest('hex');
}

/**
 * Create an idempotent PENDING archive proposal for an account-owned Agent.
 * The exact name confirmation prevents an ambiguous model choice from silently
 * retiring the wrong employee. Foreign ids remain indistinguishable from a
 * missing id (404), including when the caller has an OWNER account.
 */
export async function createAgentArchiveProposal(args: {
  agentId: string;
  proposedBy: string;
  input: unknown;
}): Promise<{ proposal: ChangeProposal; deduplicated: boolean }> {
  const input = AgentArchiveProposalSchema.parse(args.input);
  const keyHash = requestKeyHash(input.requestKey);
  return prisma.$transaction(async (tx) => {
    // A transaction-scoped lock closes the concurrent retry race without a
    // schema-level uniqueness constraint. A hash collision only serializes an
    // unrelated request; it cannot cross account or change authorization.
    const lockKey = `agent-archive:${args.proposedBy}:${args.agentId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const agent = await tx.agent.findFirst({
      where: {
        id: args.agentId,
        createdBy: args.proposedBy,
        systemManaged: false,
        deletedAt: null,
      },
      select: { id: true, name: true, status: true },
    });
    if (!agent) throw errors.notFound('Agent not found');
    if (agent.status === 'ARCHIVED') throw errors.conflict('Agent is already archived');
    if (input.confirmAgentName !== agent.name) {
      throw errors.badRequest('Agent name confirmation does not match the selected Agent');
    }

    const pending = await tx.changeProposal.findMany({
      where: {
        agentId: agent.id,
        proposedBy: args.proposedBy,
        targetType: 'AGENT',
        targetId: agent.id,
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const duplicate = pending.find((row) => {
      const saved = row.proposedChange;
      return (
        saved &&
        typeof saved === 'object' &&
        !Array.isArray(saved) &&
        (saved as Record<string, unknown>).action === 'archive_agent'
      );
    });
    if (duplicate) return { proposal: duplicate, deduplicated: true };

    const proposedChange = {
      action: 'archive_agent',
      requestKeyHash: keyHash,
    } satisfies Record<string, string>;
    const proposal = await tx.changeProposal.create({
      data: {
        id: ulid(),
        agentId: agent.id,
        source: 'OPERATOR',
        proposedBy: args.proposedBy,
        targetType: 'AGENT',
        targetId: agent.id,
        proposedChange: proposedChange as Prisma.InputJsonValue,
        severity: 'high',
        status: 'PENDING',
      },
    });
    return { proposal, deduplicated: false };
  });
}

/** Archive one account-owned Agent immediately after exact-name confirmation. */
export async function archiveOwnedAgent(args: {
  agentId: string;
  userId: string;
  input: unknown;
}): Promise<{
  agentId: string;
  status: 'ARCHIVED';
  disabledWorkflowCount: number;
  disabledScheduleCount: number;
}> {
  const input = AgentArchiveProposalSchema.parse(args.input);
  const result = await prisma.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: {
        id: args.agentId,
        createdBy: args.userId,
        systemManaged: false,
        deletedAt: null,
      },
      select: { id: true, name: true, status: true },
    });
    if (!agent) throw errors.notFound('Agent not found');
    if (agent.status === 'ARCHIVED') throw errors.conflict('Agent is already archived');
    if (input.confirmAgentName !== agent.name) {
      throw errors.badRequest('Agent name confirmation does not match the selected Agent');
    }

    const workflows = await tx.workflow.findMany({
      where: { agentId: agent.id, deletedAt: null },
      select: { id: true },
    });
    const workflowIds = workflows.map((workflow) => workflow.id);
    const enabledSchedules = workflowIds.length
      ? await tx.schedule.findMany({
          where: { workflowId: { in: workflowIds }, enabled: true },
          select: { id: true },
        })
      : [];
    const disabledSchedules = enabledSchedules.length
      ? await tx.schedule.updateMany({
          where: { id: { in: enabledSchedules.map((schedule) => schedule.id) } },
          data: { enabled: false, nextFireAt: null },
        })
      : { count: 0 };
    const disabledWorkflows = await tx.workflow.updateMany({
      where: { agentId: agent.id, deletedAt: null, enabled: true },
      data: { enabled: false },
    });
    await tx.agent.update({
      where: { id: agent.id },
      data: { status: 'ARCHIVED' },
    });
    return {
      agentId: agent.id,
      disabledScheduleIds: enabledSchedules.map((schedule) => schedule.id),
      disabledWorkflowCount: disabledWorkflows.count,
      disabledScheduleCount: disabledSchedules.count,
    };
  });

  const scheduler = await import('../scheduler/index.js').catch(() => null);
  for (const scheduleId of result.disabledScheduleIds) {
    await scheduler?.removeSchedule?.(scheduleId).catch(() => {});
  }
  return {
    agentId: result.agentId,
    status: 'ARCHIVED',
    disabledWorkflowCount: result.disabledWorkflowCount,
    disabledScheduleCount: result.disabledScheduleCount,
  };
}
