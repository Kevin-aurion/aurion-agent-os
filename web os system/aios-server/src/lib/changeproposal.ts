// Change proposal queue: operator suggestions + system violation/semantic signals.
// FDE (TRAINER/OWNER) is the only path that materializes changes (ADR 0003).
import { ulid } from 'ulid';
import type { ChangeProposal, Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { contentHash, createSkillVersion } from './skillversion.js';
import { parseIdentityCard } from './identitycard.js';
import { confirmAwaitingSkill } from './skillgate.js';
import { redactSecrets } from '../memory/redactor.js';
import { applyApprovedScheduleProposal } from './scheduleproposal.js';
import { hub } from '../ws/hub.js';

export type CreateProposalArgs = {
  agentId: string;
  runId?: string;
  source: 'OPERATOR' | 'VIOLATION' | 'SEMANTIC' | 'TRAJECTORY' | 'REFLECTION';
  proposedBy: string;
  targetType: 'AGENT' | 'SKILL' | 'RESTRICTION' | 'IDENTITY_CARD' | 'SCHEDULE';
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

// ── Violation signal (ADR 0004 hard-block track) ─────────────────────────────
// Observable intercept points only (in-process): computerUse hard-reject,
// cloudWrite tool throw, BudgetExceededError. Shell/webSearch are enforced
// inside Claude CLI via --disallowedTools (not visible here); sandbox write
// denials are OS EPERM seen only by the CLI — we do NOT fabricate those signals.

/** In-memory dedupe for same process: one PENDING proposal per runId+kind. */
const violationSeen = new Set<string>();

export type RecordViolationArgs = {
  agentId: string;
  runId?: string;
  kind: string;
  detail: unknown;
  severity?: string;
};

/**
 * Fail-safe: record a hard-block as a VIOLATION proposal for the FDE inbox.
 * Never throws — create failures are logged only so execution is undisturbed.
 * Dedupes by runId + kind (memory Set + PENDING DB check) to avoid spam.
 */
export async function recordViolation(args: RecordViolationArgs): Promise<void> {
  try {
    const kind = args.kind;
    const dedupeKey = args.runId ? `${args.runId}::${kind}` : null;
    if (dedupeKey && violationSeen.has(dedupeKey)) return;

    if (args.runId) {
      const pending = await prisma.changeProposal.findMany({
        where: {
          agentId: args.agentId,
          runId: args.runId,
          source: 'VIOLATION',
          status: 'PENDING',
        },
      });
      const already = pending.some((p) => {
        const c = p.proposedChange;
        if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
        return (c as { violation?: unknown }).violation === kind;
      });
      if (already) {
        if (dedupeKey) violationSeen.add(dedupeKey);
        return;
      }
    }

    await createProposal({
      agentId: args.agentId,
      runId: args.runId,
      source: 'VIOLATION',
      proposedBy: 'system',
      targetType: 'RESTRICTION',
      proposedChange: { violation: kind, detail: args.detail },
      severity: args.severity ?? 'high',
    });
    if (dedupeKey) violationSeen.add(dedupeKey);
  } catch (e) {
    // Fail-safe: never affect the execution path that triggered the hard block.
    console.error(
      '[changeproposal] recordViolation failed (ignored):',
      e instanceof Error ? e.message : e,
    );
  }
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

function parseSkillChange(raw: unknown): { action?: string; contentMd?: string; guidance?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  return {
    action: typeof o.action === 'string' ? o.action : undefined,
    contentMd: typeof o.contentMd === 'string' ? o.contentMd : undefined,
    guidance: typeof o.guidance === 'string' ? o.guidance : undefined,
  };
}

function approvedGuidance(raw: string | undefined): string {
  const guidance = redactSecrets(raw ?? '').trim();
  if (!guidance) throw errors.badRequest('Reflection proposal requires non-empty guidance');
  if (guidance.length > 8_000) throw errors.badRequest('Reflection guidance exceeds 8,000 characters');
  return guidance;
}

/**
 * Approve a PENDING proposal and apply the target mutation.
 * SKILL:
 *  - action=confirm_skill → server-side confirm of linked AWAITING draft (no client content trust)
 *  - contentMd → new SkillVersion (existing content-change path)
 * RESTRICTION → merge into Agent.restrictions;
 * IDENTITY_CARD → normalize via parseIdentityCard then write Agent.identityCard.
 * Non-PENDING → throw (no double decide).
 *
 * Atomic enough: mutation then claim with updateMany where status=PENDING; if claim
 * fails (race), throw so caller does not treat as success. confirm_skill runs in a
 * single transaction so skill is not CONFIRMED without APPROVED proposal (and vice versa).
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

  // ── SKILL confirm_skill: atomic confirm + mark APPROVED ─────────────────
  if (existing.targetType === 'SKILL') {
    const skillId = existing.targetId;
    if (!skillId) throw errors.badRequest('SKILL proposal requires targetId (skillId)');
    const change = parseSkillChange(existing.proposedChange);

    if (change.action === 'confirm_skill') {
      // Do not trust client contentMd/name — only targetId + agent link + DB status.
      const result = await prisma.$transaction(async (tx) => {
        const still = await tx.changeProposal.findUnique({ where: { id } });
        if (!still || still.status !== 'PENDING') {
          throw errors.conflict(`Proposal already decided: ${still?.status ?? 'missing'}`);
        }

        await confirmAwaitingSkill(skillId, decidedBy, {
          requireLinkedAgentId: existing.agentId,
          client: tx,
        });

        const claimed = await tx.changeProposal.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            decidedBy,
            decidedAt: new Date(),
            resultingVersionId: null,
          },
        });
        if (claimed.count !== 1) {
          throw errors.conflict('Proposal already decided');
        }
        const proposal = await tx.changeProposal.findUniqueOrThrow({ where: { id } });
        return { proposal };
      });

      await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
        agentId: existing.agentId,
        targetType: existing.targetType,
        targetId: existing.targetId,
        resultingVersionId: null,
        source: existing.source,
        action: 'confirm_skill',
      });

      return result;
    }

    // Reflection guidance is applied only here, after an FDE explicitly approves
    // the ChangeProposal. Claim + version + live content update are one transaction.
    if (change.action === 'append_guidance') {
      const guidance = approvedGuidance(change.guidance);
      const result = await prisma.$transaction(async (tx) => {
        const claimed = await tx.changeProposal.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', decidedBy, decidedAt: new Date() },
        });
        if (claimed.count !== 1) throw errors.conflict('Proposal already decided');

        const skill = await tx.skill.findFirst({
          where: { id: skillId, deletedAt: null, reviewStatus: 'CONFIRMED' },
        });
        if (!skill) throw errors.notFound('Confirmed Skill not found');
        const nextContent = [
          skill.contentMd.trimEnd(),
          '---',
          '## FDE 核准的反思優化指引',
          guidance,
        ].filter(Boolean).join('\n\n');
        const hash = contentHash(nextContent);
        let version = await tx.skillVersion.findFirst({
          where: { skillId, contentHash: hash },
          orderBy: { version: 'asc' },
        });
        if (!version) {
          const latest = await tx.skillVersion.aggregate({
            where: { skillId },
            _max: { version: true },
          });
          version = await tx.skillVersion.create({
            data: {
              id: ulid(),
              skillId,
              version: (latest._max.version ?? 0) + 1,
              contentHash: hash,
              contentMd: nextContent,
              channel: 'canary',
              createdBy: decidedBy,
            },
          });
        }
        if (skill.stableVersionId && skill.stableVersionId !== version.id) {
          await tx.skillVersion.updateMany({
            where: { id: skill.stableVersionId, skillId },
            data: { channel: 'archived' },
          });
        }
        await tx.skillVersion.update({ where: { id: version.id }, data: { channel: 'stable' } });
        await tx.skill.update({
          where: { id: skillId },
          data: {
            contentMd: nextContent,
            version: { increment: 1 },
            stableVersionId: version.id,
            canaryVersionId: version.id,
            confirmedBy: decidedBy,
            confirmedAt: new Date(),
          },
        });
        const proposal = await tx.changeProposal.update({
          where: { id },
          data: { resultingVersionId: version.id },
        });
        return { proposal, resultingVersionId: version.id };
      });

      await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
        agentId: existing.agentId,
        targetType: existing.targetType,
        targetId: existing.targetId,
        resultingVersionId: result.resultingVersionId,
        source: existing.source,
        action: 'append_guidance',
      });
      return result;
    }

    // Content-change path (preserve existing behavior).
    if (typeof change.contentMd !== 'string') {
      throw errors.badRequest(
        'SKILL proposal requires proposedChange.action=confirm_skill or proposedChange.contentMd',
      );
    }

    const ver = await createSkillVersion(skillId, change.contentMd, decidedBy);
    const claimed = await prisma.changeProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        decidedBy,
        decidedAt: new Date(),
        resultingVersionId: ver.id,
      },
    });
    if (claimed.count !== 1) {
      throw errors.conflict('Proposal already decided');
    }
    const proposal = await prisma.changeProposal.findUniqueOrThrow({ where: { id } });
    await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
      agentId: existing.agentId,
      targetType: existing.targetType,
      targetId: existing.targetId,
      resultingVersionId: ver.id,
      source: existing.source,
    });
    return { proposal, resultingVersionId: ver.id };
  }

  // ── AGENT reflection guidance ─────────────────────────────────────────────
  if (existing.targetType === 'AGENT') {
    if (existing.targetId !== existing.agentId) {
      throw errors.badRequest('AGENT proposal targetId must match agentId');
    }
    const change = parseSkillChange(existing.proposedChange);
    if (change.action === 'archive_agent') {
      const result = await prisma.$transaction(async (tx) => {
        const claimed = await tx.changeProposal.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            decidedBy,
            decidedAt: new Date(),
            resultingVersionId: null,
          },
        });
        if (claimed.count !== 1) throw errors.conflict('Proposal already decided');

        const agent = await tx.agent.findFirst({
          where: { id: existing.agentId, deletedAt: null, systemManaged: false },
          select: { id: true, status: true },
        });
        if (!agent) throw errors.notFound('Archivable Agent not found');
        if (agent.status === 'ARCHIVED') throw errors.conflict('Agent is already archived');

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
        const proposal = await tx.changeProposal.findUniqueOrThrow({ where: { id } });
        return {
          proposal,
          disabledScheduleIds: enabledSchedules.map((schedule) => schedule.id),
          disabledWorkflowCount: disabledWorkflows.count,
          disabledScheduleCount: disabledSchedules.count,
        };
      });

      // BullMQ is an attached delivery mechanism. The DB change above is the
      // authority; removing existing scheduler jobs is best-effort because the
      // disabled Workflow remains a second fail-closed execution gate.
      const scheduler = await import('../scheduler/index.js').catch(() => null);
      for (const scheduleId of result.disabledScheduleIds) {
        await scheduler?.removeSchedule?.(scheduleId).catch(() => {});
      }

      await audit(decidedBy, 'agent.archived', 'Agent', existing.agentId, {
        proposalId: id,
        disabledWorkflowCount: result.disabledWorkflowCount,
        disabledScheduleCount: result.disabledScheduleCount,
      });
      await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
        agentId: existing.agentId,
        targetType: existing.targetType,
        targetId: existing.targetId,
        resultingVersionId: null,
        source: existing.source,
        action: 'archive_agent',
      });
      hub.publish('agent.status', {
        id: existing.agentId,
        status: 'ARCHIVED',
        event: 'archived',
      });
      return { proposal: result.proposal };
    }
    if (change.action !== 'append_role_guidance') {
      throw errors.badRequest(
        'AGENT proposal requires proposedChange.action=append_role_guidance or archive_agent',
      );
    }
    const guidance = approvedGuidance(change.guidance);
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.changeProposal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedBy, decidedAt: new Date() },
      });
      if (claimed.count !== 1) throw errors.conflict('Proposal already decided');
      const agent = await tx.agent.findFirst({
        where: { id: existing.agentId, deletedAt: null, systemManaged: false },
      });
      if (!agent) throw errors.notFound('Editable Agent not found');
      const nextPrompt = [
        agent.rolePrompt.trimEnd(),
        '---',
        '## FDE 核准的反思優化指引',
        guidance,
      ].filter(Boolean).join('\n\n');
      await tx.agent.update({ where: { id: agent.id }, data: { rolePrompt: nextPrompt } });
      return tx.changeProposal.findUniqueOrThrow({ where: { id } });
    });
    await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
      agentId: existing.agentId,
      targetType: existing.targetType,
      targetId: existing.targetId,
      resultingVersionId: null,
      source: existing.source,
      action: 'append_role_guidance',
    });
    return { proposal: result };
  }

  // ── SCHEDULE: only an FDE approval materializes the Workflow/Schedule ──
  if (existing.targetType === 'SCHEDULE') {
    const result = await applyApprovedScheduleProposal(existing, decidedBy);
    await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
      agentId: existing.agentId,
      targetType: existing.targetType,
      targetId: existing.targetId,
      resultingVersionId: null,
      source: existing.source,
      action: result.action,
    });
    return { proposal: result.proposal };
  }

  // ── RESTRICTION / IDENTITY_CARD ───────────────────────────────────────────
  if (existing.targetType === 'RESTRICTION') {
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

  const claimed = await prisma.changeProposal.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      decidedBy,
      decidedAt: new Date(),
      resultingVersionId: null,
    },
  });
  if (claimed.count !== 1) {
    throw errors.conflict('Proposal already decided');
  }
  const proposal = await prisma.changeProposal.findUniqueOrThrow({ where: { id } });

  await audit(decidedBy, 'proposal.approved', 'ChangeProposal', id, {
    agentId: existing.agentId,
    targetType: existing.targetType,
    targetId: existing.targetId,
    resultingVersionId: null,
    source: existing.source,
  });

  return { proposal };
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

  const claimed = await prisma.changeProposal.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      decidedBy,
      decidedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    throw errors.conflict('Proposal already decided');
  }
  const proposal = await prisma.changeProposal.findUniqueOrThrow({ where: { id } });

  await audit(decidedBy, 'proposal.rejected', 'ChangeProposal', id, {
    agentId: existing.agentId,
    targetType: existing.targetType,
    targetId: existing.targetId,
    source: existing.source,
  });

  return proposal;
}
