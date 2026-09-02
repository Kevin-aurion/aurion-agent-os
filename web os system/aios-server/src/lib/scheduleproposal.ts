// Account-scoped schedule changes for MCP/runtime callers. The historical
// proposal-shaped endpoint is retained as a compatibility alias, but an owner
// request now applies the schedule directly and idempotently.
import cronParser from 'cron-parser';
import type { ChangeProposal, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { redactSecrets } from '../memory/redactor.js';
import { prisma } from './db.js';
import { errors } from './http.js';

const { parseExpression } = cronParser;

export const ScheduleProposalChangeSchema = z
  .object({
    action: z.enum(['UPSERT', 'PAUSE', 'RESUME', 'DELETE']),
    workflowId: z.string().min(1),
    cron: z.string().min(1).max(160).optional(),
    timezone: z.string().min(1).max(120).optional(),
    input: z.record(z.unknown()).optional(),
    requestKey: z.string().min(1).max(160).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'UPSERT' && !value.cron) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cron'], message: 'cron is required for UPSERT' });
    }
  });

export type ScheduleProposalChange = z.infer<typeof ScheduleProposalChangeSchema>;

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw errors.badRequest(`Invalid IANA timezone: ${timezone}`);
  }
}

function assertCron(cron: string, timezone: string): void {
  try {
    parseExpression(cron, { currentDate: new Date(), tz: timezone }).next();
  } catch {
    throw errors.badRequest(`Invalid cron expression for timezone ${timezone}`);
  }
}

/** Parse, size-limit and redact proposal content before it reaches the DB. */
export function normalizeScheduleProposalChange(raw: unknown): ScheduleProposalChange {
  const parsed = ScheduleProposalChangeSchema.parse(raw);
  const timezone = parsed.timezone?.trim() || config.tz;
  assertTimezone(timezone);
  if (parsed.cron) assertCron(parsed.cron.trim(), timezone);

  const serialized = JSON.stringify({
    ...parsed,
    ...(parsed.cron ? { cron: parsed.cron.trim() } : {}),
    timezone,
  });
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw errors.badRequest('Schedule proposal exceeds 64 KiB');
  }
  return JSON.parse(redactSecrets(serialized)) as ScheduleProposalChange;
}

export async function createScheduleProposal(args: {
  agentId: string;
  workflowId: string;
  proposedBy: string;
  change: unknown;
}): Promise<{ proposal: ChangeProposal; deduplicated: boolean }> {
  const change = normalizeScheduleProposalChange(args.change);
  if (change.workflowId !== args.workflowId) {
    throw errors.badRequest('Schedule proposal workflowId does not match the selected workflow');
  }

  const workflow = await prisma.workflow.findFirst({
    where: {
      id: args.workflowId,
      agentId: args.agentId,
      deletedAt: null,
      agent: { is: { deletedAt: null, status: 'ACTIVE', systemManaged: false } },
    },
    select: { id: true },
  });
  if (!workflow) throw errors.notFound('Active Agent workflow not found');

  if (change.requestKey) {
    const pending = await prisma.changeProposal.findMany({
      where: {
        agentId: args.agentId,
        targetType: 'SCHEDULE',
        targetId: args.workflowId,
        proposedBy: args.proposedBy,
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
        (saved as Record<string, unknown>).requestKey === change.requestKey
      );
    });
    if (duplicate) return { proposal: duplicate, deduplicated: true };
  }

  const proposal = await prisma.changeProposal.create({
    data: {
      id: ulid(),
      agentId: args.agentId,
      source: 'OPERATOR',
      proposedBy: args.proposedBy,
      targetType: 'SCHEDULE',
      targetId: args.workflowId,
      proposedChange: change as Prisma.InputJsonValue,
      severity: 'medium',
      status: 'PENDING',
    },
  });
  return { proposal, deduplicated: false };
}

/** Apply an account owner's schedule change directly, without a review queue. */
export async function applyOwnedScheduleChange(args: {
  agentId: string;
  workflowId: string;
  userId: string;
  change: unknown;
}): Promise<{
  action: ScheduleProposalChange['action'];
  workflowId: string;
  scheduleId: string | null;
  enabled: boolean;
}> {
  const change = normalizeScheduleProposalChange(args.change);
  if (change.workflowId !== args.workflowId) {
    throw errors.badRequest('Schedule workflowId does not match the selected workflow');
  }

  const result = await prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.findFirst({
      where: {
        id: args.workflowId,
        agentId: args.agentId,
        deletedAt: null,
        agent: {
          is: {
            createdBy: args.userId,
            deletedAt: null,
            status: 'ACTIVE',
            systemManaged: false,
          },
        },
      },
    });
    if (!workflow) throw errors.notFound('Active Agent workflow not found');

    const current = triggerRecord(workflow.trigger);
    let next: Record<string, unknown>;
    if (change.action === 'UPSERT') {
      if (!workflow.enabled) throw errors.conflict('Cannot schedule a disabled workflow');
      next = {
        ...current,
        type: 'schedule',
        cron: change.cron!,
        timezone: change.timezone || config.tz,
        scheduleEnabled: true,
        ...(change.input !== undefined ? { input: change.input } : {}),
      };
    } else {
      if (current.type !== 'schedule' || typeof current.cron !== 'string' || !current.cron.trim()) {
        throw errors.conflict('Workflow does not currently have a schedule');
      }
      if (change.action === 'RESUME' && !workflow.enabled) {
        throw errors.conflict('Cannot resume a disabled workflow');
      }
      if (change.action === 'DELETE') {
        next = { ...current, type: 'manual' };
        delete next.cron;
        delete next.timezone;
        delete next.input;
        delete next.scheduleEnabled;
      } else {
        next = { ...current, scheduleEnabled: change.action === 'RESUME' };
      }
    }

    await tx.workflow.update({
      where: { id: workflow.id },
      data: { trigger: next as Prisma.InputJsonValue },
    });

    const schedules = await tx.schedule.findMany({
      where: { workflowId: workflow.id },
      orderBy: { id: 'asc' },
    });
    const removedScheduleIds = schedules.slice(1).map((row) => row.id);
    if (removedScheduleIds.length > 0) {
      await tx.schedule.deleteMany({ where: { id: { in: removedScheduleIds } } });
    }

    let scheduleId: string | null = null;
    let enabled = false;
    if (change.action === 'DELETE') {
      const allIds = schedules.map((row) => row.id);
      if (allIds.length > 0) await tx.schedule.deleteMany({ where: { id: { in: allIds } } });
      removedScheduleIds.splice(0, removedScheduleIds.length, ...allIds);
    } else {
      const cron = String(next.cron);
      const timezone = typeof next.timezone === 'string' ? next.timezone : config.tz;
      enabled = workflow.enabled && next.scheduleEnabled !== false;
      const primary = schedules[0];
      if (primary) {
        await tx.schedule.update({
          where: { id: primary.id },
          data: { cron, timezone, enabled },
        });
        scheduleId = primary.id;
      } else {
        scheduleId = ulid();
        await tx.schedule.create({
          data: { id: scheduleId, workflowId: workflow.id, cron, timezone, enabled },
        });
      }
    }
    return { workflowId: workflow.id, scheduleId, removedScheduleIds, enabled };
  });

  const scheduler = await import('../scheduler/index.js').catch(() => null);
  for (const scheduleId of result.removedScheduleIds) {
    await scheduler?.removeSchedule?.(scheduleId).catch(() => {});
  }
  if (result.scheduleId) {
    await scheduler?.syncSchedule?.(result.scheduleId).catch(() => {});
  }

  return {
    action: change.action,
    workflowId: result.workflowId,
    scheduleId: result.scheduleId,
    enabled: result.enabled,
  };
}

function triggerRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Apply a persisted SCHEDULE proposal atomically with its approval decision. */
export async function applyApprovedScheduleProposal(
  existing: ChangeProposal,
  decidedBy: string,
): Promise<{ proposal: ChangeProposal; action: ScheduleProposalChange['action'] }> {
  if (existing.targetType !== 'SCHEDULE' || !existing.targetId) {
    throw errors.badRequest('SCHEDULE proposal requires a workflow targetId');
  }
  const change = normalizeScheduleProposalChange(existing.proposedChange);
  if (change.workflowId !== existing.targetId) {
    throw errors.badRequest('SCHEDULE proposal workflowId does not match targetId');
  }

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.changeProposal.updateMany({
      where: { id: existing.id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        decidedBy,
        decidedAt: new Date(),
        resultingVersionId: null,
      },
    });
    if (claimed.count !== 1) throw errors.conflict('Proposal already decided');

    const workflow = await tx.workflow.findFirst({
      where: {
        id: existing.targetId!,
        agentId: existing.agentId,
        deletedAt: null,
        agent: { is: { deletedAt: null, status: 'ACTIVE', systemManaged: false } },
      },
    });
    if (!workflow) throw errors.notFound('Active Agent workflow not found');

    const current = triggerRecord(workflow.trigger);
    let next: Record<string, unknown>;
    if (change.action === 'UPSERT') {
      if (!workflow.enabled) throw errors.conflict('Cannot schedule a disabled workflow');
      next = {
        ...current,
        type: 'schedule',
        cron: change.cron!,
        timezone: change.timezone || config.tz,
        scheduleEnabled: true,
        ...(change.input !== undefined ? { input: change.input } : {}),
      };
    } else {
      if (current.type !== 'schedule' || typeof current.cron !== 'string' || !current.cron.trim()) {
        throw errors.conflict('Workflow does not currently have a schedule');
      }
      if (change.action === 'RESUME' && !workflow.enabled) {
        throw errors.conflict('Cannot resume a disabled workflow');
      }
      if (change.action === 'DELETE') {
        next = { ...current, type: 'manual' };
        delete next.cron;
        delete next.timezone;
        delete next.input;
        delete next.scheduleEnabled;
      } else {
        next = { ...current, scheduleEnabled: change.action === 'RESUME' };
      }
    }

    await tx.workflow.update({
      where: { id: workflow.id },
      data: { trigger: next as Prisma.InputJsonValue },
    });

    const schedules = await tx.schedule.findMany({
      where: { workflowId: workflow.id },
      orderBy: { id: 'asc' },
    });
    const removedScheduleIds = schedules.slice(1).map((row) => row.id);
    if (removedScheduleIds.length > 0) {
      await tx.schedule.deleteMany({ where: { id: { in: removedScheduleIds } } });
    }

    let scheduleId: string | null = null;
    if (change.action === 'DELETE') {
      const allIds = schedules.map((row) => row.id);
      if (allIds.length > 0) await tx.schedule.deleteMany({ where: { id: { in: allIds } } });
      removedScheduleIds.splice(0, removedScheduleIds.length, ...allIds);
    } else {
      const cron = String(next.cron);
      const timezone = typeof next.timezone === 'string' ? next.timezone : config.tz;
      const enabled = workflow.enabled && next.scheduleEnabled !== false;
      const primary = schedules[0];
      if (primary) {
        await tx.schedule.update({
          where: { id: primary.id },
          data: { cron, timezone, enabled },
        });
        scheduleId = primary.id;
      } else {
        scheduleId = ulid();
        await tx.schedule.create({
          data: { id: scheduleId, workflowId: workflow.id, cron, timezone, enabled },
        });
      }
    }

    const proposal = await tx.changeProposal.findUniqueOrThrow({ where: { id: existing.id } });
    return { proposal, scheduleId, removedScheduleIds };
  });

  // BullMQ is an attached delivery mechanism. The DB decision above remains
  // durable; boot-time scheduler reconciliation retries if Redis is down now.
  const scheduler = await import('../scheduler/index.js').catch(() => null);
  for (const scheduleId of result.removedScheduleIds) {
    await scheduler?.removeSchedule?.(scheduleId).catch(() => {});
  }
  if (result.scheduleId) {
    await scheduler?.syncSchedule?.(result.scheduleId).catch(() => {});
  }

  return { proposal: result.proposal, action: change.action };
}
