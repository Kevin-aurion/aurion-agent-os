// Text → workflow steps: async draft worker + convenience creator.
// Mirrors the non-blocking skills/build pattern — HTTP returns immediately,
// the engine drafts steps in the background; the UI polls GET /api/workflows/:id.
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { draftWithEngine, looseParseJson, type DraftEngine } from '../engine/draft.js';
import { TriggerSchema, normalizeTrigger, syncSchedule } from '../routes/workflows.js';

const FALLBACK_INSTRUCTION = '請依照這位員工的角色設定，完成這個工作流的任務。';

const STEP_TYPES = ['DO', 'TOOL', 'AGENT', 'CONDITION', 'NOTIFY', 'COMPUTER_CONTROL'] as const;
type StepType = (typeof STEP_TYPES)[number];

/** Flat step shape produced by the engine (fields live on the step, not under config). */
const FlatStepSchema = z
  .object({
    stepKey: z.string().min(1),
    type: z.enum(STEP_TYPES),
    verifyRubric: z.string().nullable().optional(),
    onFail: z.record(z.unknown()).nullable().optional(),
    // Flat config fields (engine may also nest under `config` — we accept both)
    instruction: z.string().optional(),
    permissions: z.enum(['full', 'restricted']).optional(),
    skipVerify: z.boolean().optional(),
    tool: z.string().optional(),
    args: z.record(z.string()).optional(),
    agentSlug: z.string().optional(),
    brief: z.string().optional(),
    expr: z.string().optional(),
    onTrue: z.string().optional(),
    onFalse: z.string().optional(),
    message: z.string().optional(),
    channel: z.enum(['LINE']).optional(),
    bindingId: z.string().optional(),
    to: z.string().optional(),
    skillId: z.string().optional(),
    instructions: z.string().optional(),
    timeoutMs: z.number().optional(),
    deviceId: z.string().optional(),
    app: z.string().optional(),
    prompt: z.string().optional(), // alias for DO instruction
    config: z.record(z.unknown()).optional(),
  })
  .passthrough();

type NormalizedStep = {
  stepKey: string;
  type: StepType;
  config: Record<string, unknown>;
  verifyRubric: string | null;
  onFail: Record<string, unknown> | null;
};

function fallbackStep(requirement: string): NormalizedStep {
  const instruction = requirement.trim() || FALLBACK_INSTRUCTION;
  return {
    stepKey: 'main',
    type: 'DO',
    config: { instruction },
    verifyRubric: null,
    onFail: null,
  };
}

/** Pull a string field from flat step or nested config. */
function pickStr(flat: Record<string, unknown>, nested: Record<string, unknown>, key: string): string | undefined {
  const a = flat[key];
  if (typeof a === 'string' && a.trim()) return a.trim();
  const b = nested[key];
  if (typeof b === 'string' && b.trim()) return b.trim();
  return undefined;
}

/**
 * Normalize a flat (or partially nested) draft step into the DB shape
 * expected by compileStep in engine/runner.ts. Returns null if the step
 * type is unknown or a required config field is missing.
 */
function normalizeFlatStep(raw: unknown): NormalizedStep | null {
  const parsed = FlatStepSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const nested = (s.config ?? {}) as Record<string, unknown>;
  const flat = s as unknown as Record<string, unknown>;

  let config: Record<string, unknown> | null = null;
  switch (s.type) {
    case 'DO': {
      const instruction = pickStr(flat, nested, 'instruction') ?? pickStr(flat, nested, 'prompt');
      if (!instruction) return null;
      config = { instruction };
      const permissions = s.permissions ?? (nested.permissions as 'full' | 'restricted' | undefined);
      if (permissions === 'full' || permissions === 'restricted') config.permissions = permissions;
      if (s.skipVerify === true || nested.skipVerify === true) config.skipVerify = true;
      break;
    }
    case 'TOOL': {
      const tool = pickStr(flat, nested, 'tool');
      if (!tool) return null;
      const args =
        (s.args as Record<string, string> | undefined) ??
        (nested.args as Record<string, string> | undefined);
      config = args ? { tool, args } : { tool };
      const deviceId = pickStr(flat, nested, 'deviceId');
      if (deviceId) config.deviceId = deviceId;
      // device-mcp:* tools require deviceId (fail-closed at normalize if missing).
      if (tool.startsWith('device-mcp:') && !deviceId) return null;
      break;
    }
    case 'AGENT': {
      const agentSlug = pickStr(flat, nested, 'agentSlug');
      if (!agentSlug) return null;
      const brief = pickStr(flat, nested, 'brief');
      config = brief ? { agentSlug, brief } : { agentSlug };
      break;
    }
    case 'CONDITION': {
      const expr = pickStr(flat, nested, 'expr');
      if (!expr) return null;
      config = { expr };
      const onTrue = pickStr(flat, nested, 'onTrue');
      const onFalse = pickStr(flat, nested, 'onFalse');
      if (onTrue) config.onTrue = onTrue;
      if (onFalse) config.onFalse = onFalse;
      break;
    }
    case 'NOTIFY': {
      const message = pickStr(flat, nested, 'message');
      if (!message) return null;
      config = { message };
      const channel = s.channel ?? (nested.channel as 'LINE' | undefined);
      if (channel === 'LINE') config.channel = channel;
      const bindingId = pickStr(flat, nested, 'bindingId');
      const to = pickStr(flat, nested, 'to');
      if (bindingId) config.bindingId = bindingId;
      if (to) config.to = to;
      break;
    }
    case 'COMPUTER_CONTROL': {
      const skillId = pickStr(flat, nested, 'skillId');
      const deviceId = pickStr(flat, nested, 'deviceId');
      if (!skillId || !deviceId) return null; // deviceId required — no public broadcast path
      config = { skillId, deviceId };
      const instructions = pickStr(flat, nested, 'instructions');
      if (instructions) config.instructions = instructions;
      const app = pickStr(flat, nested, 'app');
      if (app) config.app = app;
      const timeoutMs =
        typeof s.timeoutMs === 'number'
          ? s.timeoutMs
          : typeof nested.timeoutMs === 'number'
            ? nested.timeoutMs
            : undefined;
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
      break;
    }
    default:
      return null;
  }

  return {
    stepKey: s.stepKey.trim(),
    type: s.type,
    config,
    verifyRubric: s.verifyRubric ?? null,
    onFail: s.onFail ?? null,
  };
}

function dedupeByStepKey(steps: NormalizedStep[]): NormalizedStep[] {
  const seen = new Set<string>();
  const out: NormalizedStep[] = [];
  for (const s of steps) {
    if (seen.has(s.stepKey)) continue;
    seen.add(s.stepKey);
    out.push(s);
  }
  return out;
}

async function writeSteps(workflowId: string, steps: NormalizedStep[]): Promise<void> {
  // Full replace — same transaction shape as PUT /api/workflows/:id/steps.
  await prisma.$transaction([
    prisma.workflowStep.deleteMany({ where: { workflowId } }),
    prisma.workflowStep.createMany({
      data: steps.map((s, idx) => ({
        id: ulid(),
        workflowId,
        position: idx,
        stepKey: s.stepKey,
        type: s.type,
        config: s.config as object,
        verifyRubric: s.verifyRubric ?? null,
        onFail: s.onFail == null ? Prisma.JsonNull : (s.onFail as object),
      })),
    }),
  ]);
}

function buildComposePrompt(agentContext: string, requirement: string): string {
  return [
    'You are drafting a workflow for an AI employee. Output STRICT JSON only — no markdown fences, no commentary.',
    '',
    '## Employee context',
    agentContext,
    '',
    '## User requirement',
    requirement,
    '',
    '## Output shape (STRICT JSON)',
    '{',
    '  "summary": "one-line description of what this workflow does",',
    '  "trigger": { "type": "manual" | "schedule" | "keyword", "cron": "0 9 * * *", "keywords": ["keyword"] },',
    '  "steps": [',
    '    { "stepKey": "scan", "type": "DO", "instruction": "what to do", "verifyRubric": "how to verify" },',
    '    { "stepKey": "notify", "type": "NOTIFY", "message": "...", "channel": "LINE" }',
    '  ]',
    '}',
    '',
    '## Step types and required flat fields',
    '- DO: instruction (string, required). Optional: permissions ("full"|"restricted"), skipVerify (boolean), verifyRubric (string).',
    '- TOOL: tool (string, required). Optional: args, deviceId. For device-local LINE use tool "device-mcp:line-desktop:<tool>" with deviceId (required). Central MCP remains "mcp:<serverId>:<tool>".',
    '- AGENT: agentSlug (string, required). Optional: brief (string).',
    '- CONDITION: expr (string, required). Optional: onTrue (stepKey), onFalse (stepKey).',
    '- NOTIFY: message (string, required). Optional: channel ("LINE"), bindingId, to.',
    '- COMPUTER_CONTROL: skillId + deviceId (both required — target enrolled device). Optional: instructions, timeoutMs, app, checkpoint.',
    '',
    '## Rules',
    '- stepKey: short alphanumeric (and underscore) keys; must be unique within steps.',
    '- First step is usually DO.',
    '- For money / numbers / reconciliation tasks, always provide verifyRubric on the DO step.',
    '- Prefer 2–6 steps; keep instructions concrete and aligned with the employee role and skills.',
    '- trigger.type defaults to "manual" unless the requirement clearly implies a schedule or keyword.',
    '- For schedule triggers include cron (5-field). For keyword triggers include keywords array.',
    '- Output ONLY the JSON object.',
  ].join('\n');
}

/**
 * Background worker: draft steps with the engine and persist them on the
 * workflow. Always ends with at least one fallback DO step so the UI can
 * detect completion by polling stepCount > 0.
 */
export async function draftAndSaveWorkflowSteps(params: {
  workflowId: string;
  agentId: string;
  requirement: string;
  engine: DraftEngine;
}): Promise<void> {
  const { workflowId, agentId, requirement, engine } = params;
  let steps: NormalizedStep[] = [fallbackStep(requirement)];
  let triggerToApply: Record<string, unknown> | null = null;

  try {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { skills: { include: { skill: true } } },
    });

    const skillNames =
      agent?.skills
        .map((as) => as.skill)
        .filter((s) => s.reviewStatus === 'CONFIRMED' && !s.deletedAt)
        .map((s) => `${s.name} (${s.slug})`) ?? [];

    const agentContext = [
      `Name: ${agent?.name ?? '(unknown)'}`,
      `Slug: ${agent?.slug ?? ''}`,
      `Role prompt:\n${agent?.rolePrompt?.trim() || '(none)'}`,
      `Confirmed skills: ${skillNames.length ? skillNames.join(', ') : '(none)'}`,
    ].join('\n');

    const prompt = buildComposePrompt(agentContext, requirement);
    const raw = await draftWithEngine(engine, prompt);
    const parsed = raw ? looseParseJson(raw) : undefined;

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
      const normalized = dedupeByStepKey(
        rawSteps.map(normalizeFlatStep).filter((s): s is NormalizedStep => s != null),
      );
      if (normalized.length > 0) {
        steps = normalized;
      }

      if (obj.trigger != null) {
        const t = TriggerSchema.safeParse(obj.trigger);
        if (t.success) {
          triggerToApply = normalizeTrigger(t.data as Record<string, unknown>);
        }
      }
    }
  } catch (e) {
    console.error('[compose] draftAndSaveWorkflowSteps draft phase failed', { workflowId, err: e });
    steps = [fallbackStep(requirement)];
  }

  // Guarantee steps land in DB even if drafting failed.
  try {
    await writeSteps(workflowId, steps);
  } catch (e) {
    console.error('[compose] writeSteps failed, retrying fallback', { workflowId, err: e });
    try {
      await writeSteps(workflowId, [fallbackStep(requirement)]);
    } catch (e2) {
      console.error('[compose] fallback writeSteps also failed', { workflowId, err: e2 });
    }
  }

  if (triggerToApply) {
    try {
      await prisma.workflow.update({
        where: { id: workflowId },
        data: { trigger: triggerToApply as object },
      });
      // Compose only produces a draft — never auto-enable the schedule.
      await syncSchedule(workflowId, triggerToApply, false);
    } catch (e) {
      console.error('[compose] trigger update failed', { workflowId, err: e });
    }
  }
}

/**
 * Create a disabled draft workflow and kick off background step drafting.
 * Returns immediately with the new workflow id (steps arrive later).
 */
export async function composeWorkflowForAgent(params: {
  agentId: string;
  requirement: string;
  engine: DraftEngine;
  createdBy: string;
}): Promise<{ workflowId: string }> {
  const { agentId, requirement, engine } = params;
  void params.createdBy; // reserved for audit / future ownership fields

  const firstLine = (requirement.split(/\r?\n/)[0] ?? '').slice(0, 40).trim() || '新工作流';
  const workflowId = ulid();

  await prisma.workflow.create({
    data: {
      id: workflowId,
      agentId,
      name: firstLine,
      description: requirement,
      enabled: false,
      trigger: { type: 'manual' } as object,
    },
  });

  void (async () => {
    await draftAndSaveWorkflowSteps({ workflowId, agentId, requirement, engine });
  })();

  return { workflowId };
}
