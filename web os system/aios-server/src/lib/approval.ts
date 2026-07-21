// HITL pre-execution approval helpers for high-risk agents.
// Gate: riskTier === 'high' && !alreadyApproved → halt at AWAITING_REVIEW.
import { ulid } from 'ulid';
import type { ApprovalRequest } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';

/** Pure: high-risk agents need approval unless this run was already approved. */
export function requiresApproval(
  riskTier: string | null | undefined,
  alreadyApproved: boolean,
): boolean {
  return riskTier === 'high' && !alreadyApproved;
}

export async function createApproval(args: {
  runId: string;
  agentId: string;
  reason: string;
  payload: unknown;
}): Promise<{ id: string; resumeToken: string }> {
  const id = ulid();
  const resumeToken = ulid();
  await prisma.approvalRequest.create({
    data: {
      id,
      runId: args.runId,
      agentId: args.agentId,
      reason: args.reason,
      payload: (args.payload ?? {}) as object,
      status: 'PENDING',
      resumeToken,
    },
  });
  return { id, resumeToken };
}

export type PendingApproval = ApprovalRequest & {
  agent: { id: string; name: string; slug: string; riskTier: string } | null;
};

/** List PENDING approval requests with basic agent info. */
export async function listPending(): Promise<PendingApproval[]> {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (pending.length === 0) return [];

  const agentIds = [...new Set(pending.map((p) => p.agentId))];
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true, slug: true, riskTier: true },
  });
  const byId = new Map(agents.map((a) => [a.id, a]));

  return pending.map((p) => ({
    ...p,
    agent: byId.get(p.agentId) ?? null,
  }));
}

/** Approve or reject a PENDING request. Throws if missing or already decided. */
export async function decideApproval(
  id: string,
  approve: boolean,
  decidedBy: string,
): Promise<ApprovalRequest> {
  const existing = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!existing) throw errors.notFound('Approval request not found');
  if (existing.status !== 'PENDING') {
    throw errors.conflict(`Approval already decided: ${existing.status}`);
  }

  return prisma.approvalRequest.update({
    where: { id },
    data: {
      status: approve ? 'APPROVED' : 'REJECTED',
      decidedBy,
      decidedAt: new Date(),
    },
  });
}
