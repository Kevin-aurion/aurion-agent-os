// Workflow CRUD + trigger endpoints. The heavy lifting for actually running
// a workflow lives in src/workflow/runner.ts (Layer-2) -> src/engine (Layer-3);
// this module only manages Workflow/WorkflowStep/Schedule rows and kicks runs off.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { config } from '../config.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { runWorkflow } from '../workflow/runner.js';
import { requireVisibleAgent, requireVisibleWorkflow } from '../lib/agentaccess.js';
import { prepareWorkflowInput } from '../workflow/input.js';

export const TriggerSchema = z
  .object({
    type: z.enum(['schedule', 'manual', 'keyword', 'webhook', 'event']),
    cron: z.string().optional(),
    keywords: z.array(z.string().min(1)).optional(), // for type 'keyword'
    topic: z.string().optional(),
    secret: z.string().optional(), // plaintext, only ever accepted in — never persisted
    secretHash: z.string().optional(),
    timezone: z.string().min(1).max(120).optional(),
    input: z.record(z.unknown()).optional(),
    scheduleEnabled: z.boolean().optional(),
  })
  .passthrough();

export const StepInputSchema = z.object({
  stepKey: z.string().min(1),
  type: z.enum(['DO', 'TOOL', 'AGENT', 'CONDITION', 'NOTIFY', 'COMPUTER_CONTROL']),
  config: z.record(z.unknown()).default({}),
  verifyRubric: z.string().nullable().optional(),
  onFail: z.record(z.unknown()).nullable().optional(),
});

/** For 'webhook' triggers, hash any plaintext `secret` on the way in and never persist it raw. */
export function normalizeTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  const t: Record<string, unknown> = { ...trigger };
  if (t.type === 'webhook' && typeof t.secret === 'string' && t.secret.trim()) {
    t.secretHash = sha256(t.secret.trim());
  }
  delete t.secret;
  return t;
}

/** Keep the Schedule row in sync with a workflow's trigger config, and tell the
 * live BullMQ scheduler so changes take effect without a restart. */
export async function syncSchedule(workflowId: string, trigger: Record<string, unknown>, enabled: boolean): Promise<void> {
  // Best-effort live-scheduler notifications; a down Redis must not break CRUD.
  const scheduler = await import('../scheduler/index.js').catch(() => null);

  const isSchedule = trigger.type === 'schedule' && typeof trigger.cron === 'string' && trigger.cron.trim() !== '';
  if (!isSchedule) {
    const stale = await prisma.schedule.findMany({ where: { workflowId }, select: { id: true } });
    await prisma.schedule.deleteMany({ where: { workflowId } });
    for (const s of stale) await scheduler?.removeSchedule?.(s.id).catch(() => {});
    return;
  }
  const cron = String(trigger.cron);
  const timezone =
    typeof trigger.timezone === 'string' && trigger.timezone.trim()
      ? trigger.timezone.trim()
      : config.tz;
  const scheduleEnabled = enabled && trigger.scheduleEnabled !== false;
  const existing = await prisma.schedule.findFirst({ where: { workflowId } });
  let scheduleId: string;
  if (existing) {
    await prisma.schedule.update({
      where: { id: existing.id },
      data: { cron, timezone, enabled: scheduleEnabled },
    });
    scheduleId = existing.id;
  } else {
    const created = await prisma.schedule.create({
      data: { id: ulid(), workflowId, cron, timezone, enabled: scheduleEnabled },
    });
    scheduleId = created.id;
  }
  await scheduler?.syncSchedule?.(scheduleId).catch(() => {});
}

export function serializeWorkflowSummary(w: {
  id: string;
  agentId: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: unknown;
  inputSchema: unknown;
  createdAt: Date;
  updatedAt: Date;
  _count?: { steps: number };
  schedules?: { id: string; cron: string; timezone: string; enabled: boolean; lastFiredAt: Date | null; nextFireAt: Date | null }[];
}) {
  return {
    id: w.id,
    agentId: w.agentId,
    name: w.name,
    description: w.description,
    enabled: w.enabled,
    trigger: w.trigger,
    inputSchema: w.inputSchema,
    stepCount: w._count?.steps ?? 0,
    schedule: w.schedules?.[0] ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Kick off runWorkflow without blocking the HTTP response on the whole run:
 * verify the workflow exists up front (so a bad id surfaces immediately as a
 * 404), pre-generate the run id, then fire runWorkflow with that runId
 * unawaited — the caller gets the runId back right away and can
 * subscribe/poll for the run's progress over WS.
 */
async function kickOffRun(
  app: FastifyInstance,
  workflowId: string,
  input: Record<string, unknown>,
  triggeredBy: string,
): Promise<string> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { steps: { select: { config: true }, orderBy: { position: 'asc' } } },
  });
  if (!workflow || workflow.deletedAt) throw errors.notFound(`Workflow not found: ${workflowId}`);

  const prepared = prepareWorkflowInput(input, workflow.inputSchema, workflow.steps);
  if (prepared.issues.length > 0) {
    throw errors.badRequest('Workflow input does not match its required schema', {
      workflowId: workflow.id,
      workflowName: workflow.name,
      issues: prepared.issues,
      expectedInputSchema: prepared.schema,
    });
  }

  const runId = ulid();
  runWorkflow(workflowId, prepared.input, triggeredBy, runId).catch((e) =>
    app.log.error({ err: e, workflowId, runId }, 'workflow run failed'),
  );
  return runId;
}

export async function workflowRoutes(app: FastifyInstance) {
  // ── List / create (scoped to an agent) ────────────────────────────────────
  app.get('/api/agents/:agentId/workflows', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { agentId } = z.object({ agentId: z.string() }).parse(req.params);
      const { scope } = z.object({ scope: z.enum(['mine', 'all']).default('mine') }).parse(req.query);
      if (scope === 'all') {
        if (req.user!.scope || !['OWNER', 'TRAINER'].includes(req.user!.role)) {
          throw errors.forbidden('Only an unscoped FDE session may list workflows across accounts');
        }
        const agent = await prisma.agent.findFirst({
          where: { id: agentId, deletedAt: null, systemManaged: false },
          select: { id: true },
        });
        if (!agent) throw errors.notFound('Agent not found');
      } else {
        await requireVisibleAgent(agentId, req.user!);
      }
      const workflows = await prisma.workflow.findMany({
        where: { agentId, deletedAt: null },
        include: { _count: { select: { steps: true } }, schedules: true },
        orderBy: { createdAt: 'asc' },
      });
      return ok(workflows.map(serializeWorkflowSummary));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/agents/:agentId/workflows', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { agentId } = z.object({ agentId: z.string() }).parse(req.params);
      const body = z
        .object({
          name: z.string().min(1),
          description: z.string().default(''),
          enabled: z.boolean().default(true),
          trigger: TriggerSchema,
          inputSchema: z.record(z.unknown()).optional(),
        })
        .parse(req.body);

      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent || agent.deletedAt) throw errors.notFound(`Agent not found: ${agentId}`);

      const trigger = normalizeTrigger(body.trigger);
      const created = await prisma.workflow.create({
        data: {
          id: ulid(),
          agentId,
          name: body.name,
          description: body.description,
          enabled: body.enabled,
          trigger: trigger as object,
          inputSchema: body.inputSchema as object | undefined,
        },
      });
      await syncSchedule(created.id, trigger, body.enabled);
      await audit(req.user!.sub, 'workflow.create', 'Workflow', created.id, { agentId, name: body.name });

      const full = await prisma.workflow.findUnique({
        where: { id: created.id },
        include: { _count: { select: { steps: true } }, schedules: true },
      });
      return ok(serializeWorkflowSummary(full!));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Compose from natural language (async draft; never blocks HTTP) ─────────
  app.post('/api/agents/:agentId/workflows/compose', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { agentId } = z.object({ agentId: z.string() }).parse(req.params);
      const body = z
        .object({
          requirement: z.string().min(1),
          engine: z.enum(['CLAUDE_CODE', 'CODEX', 'GROK']).default('CLAUDE_CODE'),
        })
        .parse(req.body);

      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent || agent.deletedAt) throw errors.notFound(`Agent not found: ${agentId}`);

      // Dynamic import avoids a static cycle: compose.ts imports helpers from this module.
      const { composeWorkflowForAgent } = await import('../workflow/compose.js');
      const { workflowId } = await composeWorkflowForAgent({
        agentId,
        requirement: body.requirement,
        engine: body.engine,
        createdBy: req.user!.sub,
      });
      await audit(req.user!.sub, 'workflow.compose', 'Workflow', workflowId, {
        agentId,
        engine: body.engine,
      });

      const full = await prisma.workflow.findUnique({
        where: { id: workflowId },
        include: { _count: { select: { steps: true } }, schedules: true },
      });
      return ok({ ...serializeWorkflowSummary(full!), composing: true });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Single workflow (+ ordered steps) ─────────────────────────────────────
  app.get('/api/workflows/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      await requireVisibleWorkflow(id, req.user!);
      const workflow = await prisma.workflow.findUnique({
        where: { id },
        include: { steps: { orderBy: { position: 'asc' } }, schedules: true },
      });
      if (!workflow || workflow.deletedAt) throw errors.notFound(`Workflow not found: ${id}`);
      return ok(workflow);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.patch('/api/workflows/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z
        .object({
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          enabled: z.boolean().optional(),
          trigger: TriggerSchema.optional(),
          inputSchema: z.record(z.unknown()).optional(),
        })
        .parse(req.body);

      const existing = await prisma.workflow.findUnique({ where: { id } });
      if (!existing || existing.deletedAt) throw errors.notFound(`Workflow not found: ${id}`);

      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.description !== undefined) data.description = body.description;
      if (body.enabled !== undefined) data.enabled = body.enabled;
      if (body.inputSchema !== undefined) data.inputSchema = body.inputSchema;

      let trigger: Record<string, unknown> | undefined;
      if (body.trigger !== undefined) {
        trigger = normalizeTrigger(body.trigger);
        data.trigger = trigger as object;
      }

      const updated = await prisma.workflow.update({ where: { id }, data });
      await syncSchedule(id, trigger ?? (updated.trigger as Record<string, unknown>), updated.enabled);
      await audit(req.user!.sub, 'workflow.update', 'Workflow', id, body);

      const full = await prisma.workflow.findUnique({
        where: { id },
        include: { steps: { orderBy: { position: 'asc' } }, schedules: true },
      });
      return ok(full);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete('/api/workflows/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const existing = await prisma.workflow.findUnique({ where: { id } });
      if (!existing || existing.deletedAt) throw errors.notFound(`Workflow not found: ${id}`);

      await prisma.workflow.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
      await prisma.schedule.deleteMany({ where: { workflowId: id } });
      await audit(req.user!.sub, 'workflow.delete', 'Workflow', id);
      return ok({ id, deleted: true });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Steps (full replace) ───────────────────────────────────────────────────
  app.put('/api/workflows/:id/steps', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ steps: z.array(StepInputSchema) }).parse(req.body);

      const workflow = await prisma.workflow.findUnique({ where: { id } });
      if (!workflow || workflow.deletedAt) throw errors.notFound(`Workflow not found: ${id}`);

      const keys = body.steps.map((s) => s.stepKey);
      if (new Set(keys).size !== keys.length) {
        throw errors.badRequest('Duplicate stepKey values are not allowed', { keys });
      }

      await prisma.$transaction([
        prisma.workflowStep.deleteMany({ where: { workflowId: id } }),
        prisma.workflowStep.createMany({
          data: body.steps.map((s, idx) => ({
            id: ulid(),
            workflowId: id,
            position: idx,
            stepKey: s.stepKey,
            type: s.type,
            config: s.config as object,
            verifyRubric: s.verifyRubric ?? null,
            onFail: s.onFail == null ? Prisma.JsonNull : (s.onFail as object),
          })),
        }),
      ]);

      await audit(req.user!.sub, 'workflow.steps.replace', 'Workflow', id, { count: body.steps.length });

      const steps = await prisma.workflowStep.findMany({ where: { workflowId: id }, orderBy: { position: 'asc' } });
      return ok(steps);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Manual trigger ─────────────────────────────────────────────────────────
  app.post('/api/workflows/:id/run', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ input: z.record(z.unknown()).optional() }).parse(req.body ?? {});
      await requireVisibleWorkflow(id, req.user!);
      const triggeredBy = `user:${req.user!.sub}`;

      const runId = await kickOffRun(app, id, body.input ?? {}, triggeredBy);
      await audit(req.user!.sub, 'workflow.run', 'Workflow', id, { runId, trigger: 'manual' });
      return ok({ runId });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Test trigger (same as manual run, but with a friendlier default message) ─
  app.post('/api/workflows/:id/test', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ message: z.string().optional() }).parse(req.body ?? {});
      await requireVisibleWorkflow(id, req.user!);
      const triggeredBy = `test:${req.user!.sub}`;

      const runId = await kickOffRun(
        app,
        id,
        { message: body.message ?? '（測試執行）', test: true },
        triggeredBy,
      );
      await audit(req.user!.sub, 'workflow.test', 'Workflow', id, { runId, trigger: 'test' });
      return ok({ runId });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Webhook trigger (unauthenticated; guarded by shared secret) ────────────
  app.post('/api/hooks/:id', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const provided = req.headers['x-aios-secret'];
      const secretHeader = Array.isArray(provided) ? provided[0] ?? '' : provided ?? '';
      if (!secretHeader) throw errors.unauthorized('Missing x-aios-secret header');

      const workflow = await prisma.workflow.findUnique({ where: { id } });
      if (!workflow || workflow.deletedAt) throw errors.notFound('Workflow not found');
      if (!workflow.enabled) throw errors.forbidden('Workflow is disabled');

      const trigger = (workflow.trigger ?? {}) as Record<string, unknown>;
      if (trigger.type !== 'webhook') throw errors.forbidden('Workflow is not configured for webhook triggers');

      const expectedHash = typeof trigger.secretHash === 'string' ? trigger.secretHash : null;
      const providedHash = sha256(secretHeader);
      // Fallback to a server-wide webhook secret (AIOS_WEBHOOK_SECRET) only
      // when the workflow itself has no per-workflow secret configured.
      const fallbackSecret = process.env.AIOS_WEBHOOK_SECRET ?? '';

      const matchesWorkflow = expectedHash != null && timingSafeEqualStr(providedHash, expectedHash);
      const matchesFallback = expectedHash == null && fallbackSecret !== '' && timingSafeEqualStr(secretHeader, fallbackSecret);
      if (!matchesWorkflow && !matchesFallback) throw errors.unauthorized('Invalid webhook secret');

      const input = (req.body ?? {}) as Record<string, unknown>;
      const runId = await kickOffRun(app, id, input, `webhook:${id}`);
      await audit(null, 'workflow.run', 'Workflow', id, { runId, trigger: 'webhook' });
      return ok({ runId });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
