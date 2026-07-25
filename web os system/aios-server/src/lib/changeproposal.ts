// Change proposal queue: operator suggestions + system violation/semantic signals.
// FDE (TRAINER/OWNER) is the only path that materializes changes (ADR 0003).
import { ulid } from 'ulid';
import type { ChangeProposal, Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { createSkillVersion } from './skillversion.js';
import { parseIdentityCard } from './identitycard.js';

export type CreateProposalArgs = {
  agentId: string;
  runId?: string;
  source: 'OPERATOR' | 'VIOLATION' | 'SEMANTIC';
  proposedBy: string;
  targetType: 'SKILL' | 'RESTRICTION' | 'IDENTITY_CARD';
  targetId?: string;
  proposedChange: unknown;
  severity?: string;
  confidence?: number;
};

export type PendingProposal = ChangeProposal & {
  agent: { id: string; name: string; slug: string } | null;
};

/** Create a PENDING change proposal. */
export async function createProposal(args: CreateProposalArgs): Promise<ChangeProposal> {
  const id = ulid();
  return prisma.changeProposal.create({
    data: {
      id,
      agentId: args.agentId,
      runId: args.runId ?? null,
      source: args.source,
      proposedBy: args.proposedBy,
      targetType: args.targetType,
      targetId: args.targetId ?? null,
      proposedChange: (args.proposedChange ?? {}) as Prisma.InputJsonValue,
      severity: args.severity ?? 'medium',
      confidence: args.confidence ?? null,
      status: 'PENDING',
    },
  });
}

/** List PENDING proposals with basic agent info (FDE inbox). */
export async function listPendingProposals(): Promise<PendingProposal[]> {
  const pending = await prisma.changeProposal.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (pending.length === 0) return [];

  const agentIds = [...new Set(pending.map((p) => p.agentId))];
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true, slug: true },
  });
  const byId = new Map(agents.map((a) => [a.id, a]));

  return pending.map((p) => ({
    ...p,
    agent: byId.get(p.agentId) ?? null,
  }));
}

/**
 * Approve a PENDING proposal and apply the target mutation.
 * SKILL → new SkillVersion; RESTRICTION → merge into Agent.restrictions;
 * IDENTITY_CARD → normalize via parseIdentityCard then write Agent.identityCard.
 * Non-PENDING → throw (no double decide).
 */
export async function approveProposal(
  id: string,
  decidedBy: string,
): Promise<{ proposal: ChangeProposal; resultingVersionId?: string }> {
  const existing = await prisma.changeProposal.findUnique({ where: { id } });
  if (!existing) throw errors.notFound('Change proposal not found');
  if (existing.status !== 'PENDING') {
    throw errors.conflict(`Proposal already decided: ${existing.status}`);
  }

  let resultingVersionId: string | undefined;

  if (existing.targetType === 'SKILL') {
    const skillId = existing.targetId;
    if (!skillId) throw errors.badRequest('SKILL proposal requires targetId (skillId)');
    const change = (existing.proposedChange ?? {}) as { contentMd?: unknown };
    if (typeof change.contentMd !== 'string') {
      throw errors.badRequest('SKILL proposal proposedChange.contentMd must be a string');
    }
    const ver = await createSkillVersion(skillId, change.contentMd, decidedBy);
    resultingVersionId = ver.id;
  } else if (existing.targetType === 'RESTRICTION') {
    const agent = await prisma.agent.findFirst({ where: { id: existing.agentId, deletedAt: null } });
    if (!agent) throw errors.notFound('Agent not found');
    const prev =
      agent.restrictions && typeof agent.restrictions === 'object' && !Array.isArray(agent.restrictions)
        ? (agent.restrictions as Record<string, unknown>)
        : {};
    const patch =
      existing.proposedChange &&
      typeof existing.proposedChange === 'object' &&
      !Array.isArray(existing.proposedChange)
        ? (existing.proposedChange as Record<string, unknown>)
        : {};
    const merged = { ...prev, ...patch };
    await prisma.agent.update({
      where: { id: existing.agentId },
      data: { restrictions: merged as Prisma.InputJsonValue },
    });
  } else if (existing.targetType === 'IDENTITY_CARD') {
    const agent = await prisma.agent.findFirst({ where: { id: existing.agentId, deletedAt: null } });
    if (!agent) throw errors.notFound('Agent not found');
    const { card } = parseIdentityCard(existing.proposedChange);
    await prisma.agent.update({
      where: { id: existing.agentId },
      data: { identityCard: card as unknown as Prisma.InputJsonValue },
    });
  } else {
    throw errors.badRequest(`Unknown targetType: ${existing.targetType}`);
  }

  const proposal = await prisma.changeProposal.update({
    where: { id },
    data: {
      status: 'APPROVED',
      decidedBy,
      decidedAt: new Date(),
      resultingVersionId: resultingVersionId ?? null,
    },
  });

  await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
    agentId: existing.agentId,
    targetType: existing.targetType,
    targetId: existing.targetId,
    resultingVersionId: resultingVersionId ?? null,
    source: existing.source,
  });

  return { proposal, resultingVersionId };
}

/**
 * Reject a PENDING proposal. Status-only: never mutates the target.
 * Non-PENDING → throw.
 */
export async function rejectProposal(id: string, decidedBy: string): Promise<ChangeProposal> {
  const existing = await prisma.changeProposal.findUnique({ where: { id } });
  if (!existing) throw errors.notFound('Change proposal not found');
  if (existing.status !== 'PENDING') {
    throw errors.conflict(`Proposal already decided: ${existing.status}`);
  }

  const proposal = await prisma.changeProposal.update({
    where: { id },
    data: {
      status: 'REJECTED',
      decidedBy,
      decidedAt: new Date(),
    },
  });

  await audit(decidedBy, 'proposal.rejected', 'ChangeProposal', id, {
    agentId: existing.agentId,
    targetType: existing.targetType,
    targetId: existing.targetId,
    source: existing.source,
  });

  return proposal;
}
