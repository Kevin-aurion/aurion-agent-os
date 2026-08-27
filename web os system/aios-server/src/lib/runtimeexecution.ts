// Ticket 18 — Production pilot runtime execution: schedule routing, idempotent
// pilot Runs, HITL resume, kill-switch HOLD, read-only template whitelist.
// Runtime ≠ Engine: LANGFLOW is RuntimeKind only.
// Gates (budget, approval, digest, template) are fail-closed; audit/trace fail-safe.
import { ulid } from 'ulid';
import type { Engine, FlowArtifact, Run, RuntimeDeployment } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { paths } from '../config.js';
import { prisma } from './db.js';
import { errors } from './http.js';
import { safeJoin } from './safepath.js';
import { audit } from './audit.js';
import {
  createApproval,
  isRunApproved,
} from './approval.js';
import {
  BudgetExceededError,
  guardBudget,
} from '../engine/cost.js';
import { resolveVerifyEngine } from '../engine/verify.js';
import {
  loadProductionArtifact,
  ProductionLoadError,
} from '../runtime/productionloader.js';
import {
  isNormalizedRunEvent,
  type NormalizedRunEvent,
  type RuntimeAdapter,
} from '../runtime/adapter.js';
import {
  isSafeLangflowFlowId,
  parseSafeLangflowFlowId,
} from '../runtime/langflow.js';
import { resolveRuntimeAdapter } from './runtimedeployment.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import { hub } from '../ws/hub.js';
import { ingestPilotRunTrace } from './trace.js';
import { allowWrite } from './stopwrite.js';
import {
  beforeDispatch,
  checkRateLimit,
  recordFailure,
  recordSuccess,
} from './runtimeguard.js';

// Re-export shared pure Flow ID parser for deploy/binding callers and tests.
export { parseSafeLangflowFlowId, isSafeLangflowFlowId };

/** Fail-safe WS publish — never throws to callers. */
function safePublish(topic: string, payload: unknown): void {
  try {
    hub.publish(topic, payload);
  } catch (e) {
    console.warn(
      `[runtimeexecution] safePublish ${topic} failed:`,
      e instanceof Error ? e.message : e,
    );
  }
}

function resolvePilotEngines(agent: {
  engineExecute: Engine;
  engineVerify: Engine | null;
}): { engineExecute: Engine; engineVerify: Engine } {
  const engineExecute = agent.engineExecute;
  const engineVerify =
    agent.engineVerify && agent.engineVerify !== engineExecute
      ? agent.engineVerify
      : resolveVerifyEngine(engineExecute);
  return { engineExecute, engineVerify };
}

/** Translate a normalized pilot event into Native-parity WS topics (fail-safe). */
function publishPilotEvent(
  runId: string,
  agentId: string,
  ev: NormalizedRunEvent,
): void {
  if (ev.type === 'step.started') {
    safePublish('run.step', {
      runId,
      stepKey: ev.stepKey,
      type: 'DO',
      round: 1,
      phase: 'executing',
    });
    return;
  }
  if (ev.type === 'step.finished') {
    safePublish('run.step', {
      runId,
      stepKey: ev.stepKey,
      type: 'DO',
      round: 1,
      phase: ev.ok ? 'approved' : 'rejected',
    });
    if (ev.summary) {
      safePublish('run.log', {
        runId,
        stepKey: ev.stepKey,
        round: 1,
        line: redactSecrets(ev.summary),
      });
    }
    return;
  }
  if (ev.type === 'tool.call') {
    safePublish('run.log', {
      runId,
      stepKey: 'tool',
      round: 1,
      line: redactSecrets(`[tool] ${ev.tool}`),
    });
    return;
  }
  if (ev.type === 'run.error') {
    safePublish('run.log', {
      runId,
      stepKey: 'runtime',
      round: 1,
      line: redactSecrets(ev.message),
    });
    return;
  }
  if (ev.type === 'run.output') {
    // Fail-safe: never re-broadcast raw wire; only already-normalized redacted output.
    safePublish('run.log', {
      runId,
      stepKey: 'output',
      round: 1,
      line: redactSecrets('[run.output] normalized'),
    });
    return;
  }
  if (ev.type === 'approval.required') {
    safePublish('run.step', {
      runId,
      agentId,
      phase: 'awaiting_review',
    });
    safePublish('approval.requested', {
      runId,
      agentId,
    });
  }
}

async function safeIngestPilotTrace(args: {
  runId: string;
  agentId: string;
  artifactId: string | null;
  engineExecute: Engine;
  engineVerify: Engine;
  status: string;
  events: NormalizedRunEvent[];
}): Promise<void> {
  try {
    if (
      args.status !== 'SUCCEEDED' &&
      args.status !== 'FAILED' &&
      args.status !== 'CANCELLED'
    ) {
      return;
    }
    await ingestPilotRunTrace({
      runId: args.runId,
      agentId: args.agentId,
      artifactId: args.artifactId,
      engineExecute: args.engineExecute,
      engineVerify: args.engineVerify,
      status: args.status,
      events: args.events,
    });
  } catch (e) {
    console.warn(
      '[runtimeexecution] ingestPilotRunTrace failed:',
      e instanceof Error ? e.message : e,
    );
  }
}

/** Only these templates may be scheduled onto Langflow Production pilot. */
export const PILOT_READONLY_TEMPLATES: ReadonlySet<string> = new Set([
  'email-triage-readonly-v1',
  'scheduled-report-v1',
]);

export type ScheduledRuntimeRoute =
  | { kind: 'NATIVE' }
  | { kind: 'LANGFLOW'; deployment: RuntimeDeployment; artifact: FlowArtifact }
  | { kind: 'HOLD_FOR_REVIEW'; reason: string };

export type RuntimeExecutionDeps = {
  adapter?: RuntimeAdapter;
};

function channelRank(channel: string): number {
  // Lower = higher priority. CANARY preferred over STABLE for pilot routing.
  if (channel === 'CANARY') return 0;
  if (channel === 'STABLE') return 1;
  return 2;
}

function sortPilotCandidates(rows: RuntimeDeployment[]): RuntimeDeployment[] {
  return [...rows].sort((a, b) => {
    const cr = channelRank(a.channel) - channelRank(b.channel);
    if (cr !== 0) return cr;
    return b.activatedAt.getTime() - a.activatedAt.getTime();
  });
}

function nativeFallbackAvailable(workflow: {
  deletedAt: Date | null;
  enabled: boolean;
  steps: unknown[];
} | null): boolean {
  if (!workflow) return false;
  if (workflow.deletedAt) return false;
  if (!workflow.enabled) return false;
  return Array.isArray(workflow.steps) && workflow.steps.length > 0;
}

/**
 * Resolve where a scheduled workflow should run.
 * Fail-safe outer catch → NATIVE so existing schedules never break on router bugs.
 */
export async function resolveScheduledRuntimeRoute(
  workflowId: string,
): Promise<ScheduledRuntimeRoute> {
  try {
    if (typeof workflowId !== 'string' || !workflowId.trim()) {
      return { kind: 'NATIVE' };
    }

    const workflow = await prisma.workflow.findUnique({
      where: { id: workflowId },
      include: { steps: { orderBy: { position: 'asc' } } },
    });

    if (!workflow || workflow.deletedAt) {
      return { kind: 'NATIVE' };
    }

    const agentId = workflow.agentId;
    const agentSkills = await prisma.agentSkill.findMany({
      where: { agentId },
      select: { skillId: true },
    });
    const skillIds = agentSkills.map((s) => s.skillId);

    if (skillIds.length === 0) {
      return { kind: 'NATIVE' };
    }

    const activeCandidates = await prisma.runtimeDeployment.findMany({
      where: {
        skillId: { in: skillIds },
        environment: 'PRODUCTION',
        active: true,
      },
    });

    const ordered = sortPilotCandidates(activeCandidates);

    for (const candidate of ordered) {
      try {
        const loaded = await loadProductionArtifact(candidate.id);
        const template = loaded.artifact.template ?? '';
        if (!PILOT_READONLY_TEMPLATES.has(template)) {
          continue;
        }
        return {
          kind: 'LANGFLOW',
          deployment: loaded.deployment,
          artifact: loaded.artifact,
        };
      } catch (e) {
        if (e instanceof ProductionLoadError) {
          console.warn(
            `[runtimeexecution] skip deployment ${candidate.id}: ${e.code} ${e.message}`,
          );
          continue;
        }
        console.warn(
          `[runtimeexecution] skip deployment ${candidate.id}:`,
          e instanceof Error ? e.message : e,
        );
        continue;
      }
    }

    // No loadable pilot deployment.
    if (nativeFallbackAvailable(workflow)) {
      return { kind: 'NATIVE' };
    }

    // Kill-switch / disabled native: if this agent ever had PRODUCTION deploys,
    // hold for FDE review rather than silent native failure or silent no-op.
    const anyProdHistory = await prisma.runtimeDeployment.findFirst({
      where: {
        skillId: { in: skillIds },
        environment: 'PRODUCTION',
      },
      select: { id: true },
    });
    if (anyProdHistory) {
      return {
        kind: 'HOLD_FOR_REVIEW',
        reason:
          'No active PRODUCTION pilot deployment and native fallback is unavailable (workflow disabled, deleted, or has no steps). Kill-switch / routing hold for FDE review.',
      };
    }

    return { kind: 'NATIVE' };
  } catch (e) {
    console.warn(
      '[runtimeexecution] resolveScheduledRuntimeRoute unexpected error — NATIVE:',
      e instanceof Error ? e.message : e,
    );
    return { kind: 'NATIVE' };
  }
}

/** Pure: pilot:${workflowId}:${messageId} after trim; both must be non-empty. */
export function buildPilotIdempotencyKey(
  workflowId: string,
  messageId: string,
): string {
  const wf = typeof workflowId === 'string' ? workflowId.trim() : '';
  const mid = typeof messageId === 'string' ? messageId.trim() : '';
  if (!wf || !mid) {
    throw errors.badRequest('workflowId and messageId are required for pilot idempotency key');
  }
  return `pilot:${wf}:${mid}`;
}

function extractMessageId(input: Record<string, unknown>): string | null {
  const raw = input.messageId ?? input.message_id;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * Get-or-create an idempotent pilot Run (DeviceTask P2002 pattern).
 * artifactId may be null for HOLD_FOR_REVIEW rows.
 */
export async function getOrCreatePilotRun(args: {
  workflowId: string;
  agentId: string;
  artifactId: string | null;
  messageId?: string | null;
  triggeredBy: string;
  input: Record<string, unknown>;
}): Promise<{ run: Run; created: boolean }> {
  const messageId =
    typeof args.messageId === 'string' && args.messageId.trim()
      ? args.messageId.trim()
      : null;
  const idempotencyKey = messageId
    ? buildPilotIdempotencyKey(args.workflowId, messageId)
    : null;

  if (idempotencyKey) {
    const existing = await prisma.run.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return { run: existing, created: false };
    }
  }

  const runId = ulid();
  const runDir = safeJoin(paths.runs, runId);
  const redactedInput = deepRedactSecrets(args.input) as Prisma.InputJsonValue;

  try {
    const run = await prisma.run.create({
      data: {
        id: runId,
        agentId: args.agentId,
        workflowId: args.workflowId,
        triggeredBy: args.triggeredBy,
        status: 'RUNNING',
        input: redactedInput,
        runtimeKind: 'LANGFLOW',
        artifactId: args.artifactId,
        idempotencyKey,
        runDir,
      },
    });
    return { run, created: true };
  } catch (e: unknown) {
    if (
      idempotencyKey &&
      e &&
      typeof e === 'object' &&
      'code' in e &&
      (e as { code?: string }).code === 'P2002'
    ) {
      const existing = await prisma.run.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return { run: existing, created: false };
      }
    }
    throw e;
  }
}

async function markRunFailed(
  runId: string,
  output: Record<string, unknown>,
): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      output: deepRedactSecrets(output) as Prisma.InputJsonValue,
    },
  });
}

/**
 * Ticket 24/25 — Fail-closed parse of untrusted RuntimeDeployment.runtimeBinding.
 *
 * Accepts only a plain object with:
 * - kind exactly "LANGFLOW"
 * - bindingRef exactly matching `langflow:flow:<safe non-empty flow id>`
 *
 * Flow id uses the shared pure parser (parseSafeLangflowFlowId / isSafeLangflowFlowId).
 * Rejects arrays, null, missing fields, wrong kind/prefix, whitespace ambiguity,
 * control characters, path separators, and empty flow ids.
 * Never falls back to an AIOS FlowArtifact id.
 * Wrong-kind errors use a constant message (never reflect untrusted kind value).
 */
export type ParsedLangflowBinding =
  | { ok: true; flowId: string }
  | { ok: false; reason: string };

/** Exact prefix; flow id is everything after (no trim — whitespace = reject). */
const LANGFLOW_BINDING_PREFIX = 'langflow:flow:';

export function parseLangflowRuntimeBinding(
  raw: unknown,
): ParsedLangflowBinding {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'runtimeBinding missing or null' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'runtimeBinding must be a plain object' };
  }
  const obj = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, 'kind')) {
    return { ok: false, reason: 'runtimeBinding.kind missing' };
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'bindingRef')) {
    return { ok: false, reason: 'runtimeBinding.bindingRef missing' };
  }
  const kind = obj['kind'];
  // Constant message — never reflect untrusted kind (Ticket 25).
  if (kind !== 'LANGFLOW') {
    return {
      ok: false,
      reason: 'runtimeBinding.kind must be exactly LANGFLOW',
    };
  }
  const bindingRef = obj['bindingRef'];
  if (typeof bindingRef !== 'string') {
    return { ok: false, reason: 'runtimeBinding.bindingRef must be a string' };
  }
  // Whitespace ambiguity: no trim — leading/trailing space is reject.
  if (bindingRef !== bindingRef.trim() || /\s/.test(bindingRef)) {
    return {
      ok: false,
      reason: 'runtimeBinding.bindingRef must not contain whitespace',
    };
  }
  // Control characters (C0, DEL, C1, U+2028/U+2029) anywhere in the ref.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(bindingRef)) {
    return {
      ok: false,
      reason: 'runtimeBinding.bindingRef must not contain control characters',
    };
  }
  if (!bindingRef.startsWith(LANGFLOW_BINDING_PREFIX)) {
    return {
      ok: false,
      reason: 'runtimeBinding.bindingRef must start with langflow:flow:',
    };
  }
  const flowId = bindingRef.slice(LANGFLOW_BINDING_PREFIX.length);
  if (!flowId) {
    return { ok: false, reason: 'runtimeBinding flow id is empty' };
  }
  // Shared pure safe Flow ID parser (Ticket 25) — no raw reflection in reason.
  if (!isSafeLangflowFlowId(flowId)) {
    return {
      ok: false,
      reason: 'runtimeBinding flow id is not a safe non-empty id',
    };
  }
  // Exact match only: prefix + flowId must reconstruct bindingRef (no extras).
  if (`${LANGFLOW_BINDING_PREFIX}${flowId}` !== bindingRef) {
    return { ok: false, reason: 'runtimeBinding.bindingRef malformed' };
  }
  return { ok: true, flowId };
}

/** Fail-safe DLQ enqueue — never throws to callers / never changes run outcome. */
async function safeEnqueueDeadLetter(args: {
  runId?: string | null;
  workflowId: string;
  deploymentId?: string | null;
  artifactId?: string | null;
  code: string;
  reason: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!allowWrite('langflowRuntime')) return;
  try {
    await prisma.runtimeDeadLetter.create({
      data: {
        id: ulid(),
        runId: args.runId ?? null,
        workflowId: args.workflowId,
        deploymentId: args.deploymentId ?? null,
        artifactId: args.artifactId ?? null,
        code: args.code,
        reason: redactSecrets(args.reason),
        payload: deepRedactSecrets(args.payload) as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
  } catch (e) {
    console.warn(
      '[runtimeexecution] safeEnqueueDeadLetter failed:',
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Execute a pilot Run against a RuntimeAdapter (Langflow). Fail-closed on
 * budget, template, adapter errors, and missing terminal events.
 */
export async function executePilotRun(
  args: {
    runId: string;
    deployment: RuntimeDeployment;
    artifact: FlowArtifact;
    triggeredBy: string;
  },
  deps?: RuntimeExecutionDeps,
): Promise<{ status: string }> {
  const run = await prisma.run.findUnique({
    where: { id: args.runId },
    include: { agent: true },
  });
  if (!run) {
    throw errors.notFound(`Run not found: ${args.runId}`);
  }
  if (run.runtimeKind !== 'LANGFLOW') {
    throw errors.forbidden('executePilotRun requires runtimeKind LANGFLOW');
  }
  if (run.artifactId !== args.deployment.artifactId) {
    throw errors.forbidden('Run artifactId does not match deployment artifact');
  }

  const template = args.artifact.template ?? '';
  if (!PILOT_READONLY_TEMPLATES.has(template)) {
    await markRunFailed(run.id, {
      error: 'template not in pilot readonly whitelist',
      template,
    });
    return { status: 'FAILED' };
  }

  try {
    await guardBudget(run.agent.id, run.agent.costPolicy);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      await markRunFailed(run.id, {
        error: redactSecrets(e.message),
        code: 'BUDGET_EXCEEDED',
      });
      return { status: 'FAILED' };
    }
    throw e;
  }

  const input =
    run.input && typeof run.input === 'object' && !Array.isArray(run.input)
      ? (run.input as Record<string, unknown>)
      : {};
  const workflowId = run.workflowId ?? '';
  const deploymentId = args.deployment.id;
  const dlqBase = {
    runId: run.id,
    workflowId: workflowId || 'unknown',
    deploymentId,
    artifactId: args.artifact.id,
    payload: { ...input, workflowId },
  };

  // Ticket 24: fail-closed parse of untrusted runtimeBinding BEFORE any adapter call.
  // Never fall back to AIOS FlowArtifact.id — Langflow /api/v1/run needs the flow id.
  const binding = parseLangflowRuntimeBinding(args.deployment.runtimeBinding);
  if (!binding.ok) {
    await markRunFailed(run.id, {
      error: redactSecrets(binding.reason),
      code: 'INVALID_RUNTIME_BINDING',
    });
    return { status: 'FAILED' };
  }
  const langflowFlowId = binding.flowId;

  // Phase 6: rate limit (fail-closed) before circuit / adapter.
  const rate = checkRateLimit(deploymentId);
  if (!rate.allow) {
    await markRunFailed(run.id, {
      error: redactSecrets(rate.reason),
      code: 'RATE_LIMITED',
    });
    await safeEnqueueDeadLetter({
      ...dlqBase,
      code: 'RATE_LIMITED',
      reason: rate.reason,
    });
    return { status: 'FAILED' };
  }

  // Phase 6: circuit breaker (fail-closed) before adapter.
  const circuit = beforeDispatch(deploymentId);
  if (!circuit.allow) {
    await markRunFailed(run.id, {
      error: redactSecrets(circuit.reason),
      code: 'CIRCUIT_OPEN',
    });
    await safeEnqueueDeadLetter({
      ...dlqBase,
      code: 'CIRCUIT_OPEN',
      reason: circuit.reason,
    });
    return { status: 'FAILED' };
  }

  let adapter: RuntimeAdapter;
  try {
    // Ticket 25: explicit deployment environment — never fall back across envs.
    adapter =
      deps?.adapter ??
      resolveRuntimeAdapter('LANGFLOW', args.deployment.environment);
  } catch (e) {
    await markRunFailed(run.id, {
      error: redactSecrets(e instanceof Error ? e.message : String(e)),
      code: 'ADAPTER_RESOLVE_FAILED',
    });
    return { status: 'FAILED' };
  }

  let terminalStatus: string | null = null;
  const collectedEvents: NormalizedRunEvent[] = [];
  const engines = resolvePilotEngines(run.agent);
  /** Last normalized output (for persistence before terminal success). */
  let lastNormalizedOutput: Record<string, unknown> | null = null;

  try {
    const stream = adapter.execute({
      runId: run.id,
      agentId: run.agentId,
      workflowId: run.workflowId ?? undefined,
      // Ticket 24: Langflow flow id from binding — never AIOS artifact id.
      artifactId: langflowFlowId,
      input,
      triggeredBy: args.triggeredBy,
    });

    for await (const raw of stream) {
      if (!isNormalizedRunEvent(raw)) {
        continue;
      }
      const ev = raw;
      collectedEvents.push(ev);

      // Fail-safe WS translation (Native payload shape).
      publishPilotEvent(run.id, run.agentId, ev);

      if (ev.type === 'run.output') {
        // Persist bounded/deep-redacted output before any terminal success.
        lastNormalizedOutput = deepRedactSecrets(ev.output) as Record<
          string,
          unknown
        >;
        await prisma.run.update({
          where: { id: run.id },
          data: {
            output: lastNormalizedOutput as Prisma.InputJsonValue,
          },
        });
        continue;
      }

      if (ev.type === 'approval.required') {
        const existing = await prisma.approvalRequest.findUnique({
          where: { runId: run.id },
        });
        if (!existing) {
          // Server-generated durable binding for resume (Ticket 25).
          await createApproval({
            runId: run.id,
            agentId: run.agentId,
            reason: redactSecrets(ev.reason || 'approval required'),
            payload: {
              source: 'langflow-pilot',
              deploymentId: args.deployment.id,
              environment: args.deployment.environment,
              artifactId: args.artifact.id,
            },
          });
        }
        await prisma.run.update({
          where: { id: run.id },
          data: {
            status: 'AWAITING_REVIEW',
            finishedAt: null,
          },
        });
        try {
          await audit(null, 'runtime.pilot.approval_required', 'Run', run.id, {
            reason: redactSecrets(ev.reason || ''),
            source: 'langflow-pilot',
            deploymentId: args.deployment.id,
            environment: args.deployment.environment,
          });
        } catch (auditErr) {
          console.warn(
            '[runtimeexecution] audit approval_required failed:',
            auditErr instanceof Error ? auditErr.message : auditErr,
          );
        }
        terminalStatus = 'AWAITING_REVIEW';
        break;
      }

      if (ev.type === 'run.finished') {
        const status = ev.status;
        // On SUCCEEDED, ensure normalized output (if any) is already on the Run.
        const data: {
          status: typeof status;
          finishedAt: Date;
          output?: Prisma.InputJsonValue;
        } = {
          status,
          finishedAt: new Date(),
        };
        if (status === 'SUCCEEDED' && lastNormalizedOutput) {
          data.output = lastNormalizedOutput as Prisma.InputJsonValue;
        }
        await prisma.run.update({
          where: { id: run.id },
          data,
        });
        terminalStatus = status;
        break;
      }

      if (ev.type === 'run.error') {
        await markRunFailed(run.id, {
          error: redactSecrets(ev.message),
          code: ev.code,
        });
        terminalStatus = 'FAILED';
        break;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code =
      e && typeof e === 'object' && 'code' in e
        ? String((e as { code?: string }).code ?? 'INTERNAL')
        : 'INTERNAL';
    await markRunFailed(run.id, {
      error: redactSecrets(message),
      code,
    });
    terminalStatus = 'FAILED';
    // Phase 6: adapter throw → circuit failure + DLQ for unreachable/timeout.
    if (code === 'RUNTIME_UNREACHABLE' || code === 'TIMEOUT') {
      recordFailure(deploymentId);
      await safeEnqueueDeadLetter({
        ...dlqBase,
        code,
        reason: message,
      });
    } else {
      recordFailure(deploymentId);
    }
    safePublish('run.finished', {
      runId: run.id,
      agentId: run.agentId,
      status: 'FAILED',
      stoppedAt: null,
    });
    await safeIngestPilotTrace({
      runId: run.id,
      agentId: run.agentId,
      artifactId: run.artifactId,
      engineExecute: engines.engineExecute,
      engineVerify: engines.engineVerify,
      status: 'FAILED',
      events: collectedEvents,
    });
    return { status: 'FAILED' };
  }

  if (!terminalStatus) {
    // Stream ended without a terminal event — fail-closed (no zombie SUCCESS).
    const still = await prisma.run.findUnique({ where: { id: run.id } });
    if (still?.status === 'RUNNING') {
      await markRunFailed(run.id, {
        error: 'adapter stream ended without terminal event',
        code: 'NO_TERMINAL_EVENT',
      });
      terminalStatus = 'FAILED';
    } else {
      terminalStatus = still?.status ?? 'FAILED';
    }
  }

  // Phase 6: circuit bookkeeping on terminal outcome.
  if (terminalStatus === 'SUCCEEDED') {
    recordSuccess(deploymentId);
  } else if (terminalStatus === 'FAILED') {
    const failedRun = await prisma.run.findUnique({ where: { id: run.id } });
    const out =
      failedRun?.output &&
      typeof failedRun.output === 'object' &&
      !Array.isArray(failedRun.output)
        ? (failedRun.output as Record<string, unknown>)
        : null;
    const code = out && typeof out.code === 'string' ? out.code : 'INTERNAL';
    const reason =
      out && typeof out.error === 'string' ? out.error : 'run failed';
    if (
      code === 'RUNTIME_UNREACHABLE' ||
      code === 'TIMEOUT' ||
      code === 'NO_TERMINAL_EVENT'
    ) {
      recordFailure(deploymentId);
      await safeEnqueueDeadLetter({
        ...dlqBase,
        code: code === 'NO_TERMINAL_EVENT' ? 'RUNTIME_UNREACHABLE' : code,
        reason,
      });
    } else {
      recordFailure(deploymentId);
    }
  }

  // Terminal WS + trace for finished runs (not AWAITING_REVIEW).
  if (
    terminalStatus === 'SUCCEEDED' ||
    terminalStatus === 'FAILED' ||
    terminalStatus === 'CANCELLED'
  ) {
    safePublish('run.finished', {
      runId: run.id,
      agentId: run.agentId,
      status: terminalStatus,
      stoppedAt: null,
    });
    await safeIngestPilotTrace({
      runId: run.id,
      agentId: run.agentId,
      artifactId: run.artifactId,
      engineExecute: engines.engineExecute,
      engineVerify: engines.engineVerify,
      status: terminalStatus,
      events: collectedEvents,
    });
  }

  return { status: terminalStatus };
}

/**
 * Top-level scheduled dispatch: resolve route then NATIVE / LANGFLOW / HOLD.
 */
export async function dispatchScheduledWorkflow(
  workflowId: string,
  input: Record<string, unknown>,
  triggeredBy: string,
  deps?: RuntimeExecutionDeps,
): Promise<{
  routed: 'NATIVE' | 'LANGFLOW' | 'HOLD_FOR_REVIEW';
  runId?: string;
  status?: string;
  deduped?: boolean;
}> {
  const route = await resolveScheduledRuntimeRoute(workflowId);

  if (route.kind === 'NATIVE') {
    const { runWorkflow } = await import('../workflow/runner.js');
    const outcome = await runWorkflow(workflowId, input, triggeredBy);
    return { routed: 'NATIVE', status: outcome.status };
  }

  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
  });
  if (!workflow) {
    throw errors.notFound(`Workflow not found: ${workflowId}`);
  }

  const messageId = extractMessageId(input);
  const redactedInput =
    (deepRedactSecrets(input) as Record<string, unknown>) ?? {};

  if (route.kind === 'HOLD_FOR_REVIEW') {
    const { run, created } = await getOrCreatePilotRun({
      workflowId,
      agentId: workflow.agentId,
      artifactId: null,
      messageId,
      triggeredBy,
      input: redactedInput,
    });

    if (!created) {
      return {
        routed: 'HOLD_FOR_REVIEW',
        runId: run.id,
        status: run.status,
        deduped: true,
      };
    }

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'AWAITING_REVIEW',
        finishedAt: null,
        output: deepRedactSecrets({ reason: route.reason }) as Prisma.InputJsonValue,
      },
    });

    const existingApproval = await prisma.approvalRequest.findUnique({
      where: { runId: run.id },
    });
    if (!existingApproval) {
      await createApproval({
        runId: run.id,
        agentId: workflow.agentId,
        reason: redactSecrets(route.reason),
        payload: { source: 'langflow-pilot-hold' },
      });
    }

    try {
      await audit(null, 'runtime.pilot.hold_for_review', 'Run', run.id, {
        reason: redactSecrets(route.reason),
        workflowId,
      });
    } catch (auditErr) {
      console.warn(
        '[runtimeexecution] audit hold_for_review failed:',
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
    }

    safePublish('run.step', {
      runId: run.id,
      agentId: workflow.agentId,
      phase: 'awaiting_review',
    });
    safePublish('approval.requested', {
      runId: run.id,
      agentId: workflow.agentId,
    });

    return {
      routed: 'HOLD_FOR_REVIEW',
      runId: run.id,
      status: 'AWAITING_REVIEW',
    };
  }

  // LANGFLOW
  const { run, created } = await getOrCreatePilotRun({
    workflowId,
    agentId: workflow.agentId,
    artifactId: route.artifact.id,
    messageId,
    triggeredBy,
    input: redactedInput,
  });

  if (!created) {
    return {
      routed: 'LANGFLOW',
      runId: run.id,
      status: run.status,
      deduped: true,
    };
  }

  const result = await executePilotRun(
    {
      runId: run.id,
      deployment: route.deployment,
      artifact: route.artifact,
      triggeredBy,
    },
    deps,
  );

  return {
    routed: 'LANGFLOW',
    runId: run.id,
    status: result.status,
  };
}

/**
 * Resume a pilot Run after true FDE ApprovalRequest (DB APPROVED).
 * Langflow-side approve / PENDING / fake ids are all rejected via isRunApproved.
 *
 * Ticket 25: resume reloads the server-bound deployment id + environment from
 * ApprovalRequest.payload, verifies the active deployment matches the Run
 * artifact, and resolves the adapter from that exact environment. Missing,
 * stale, mismatched, or client-invented metadata fails closed before adapter call.
 */
export async function resumePilotRun(
  args: {
    runId: string;
    approvalRequestId: string;
    actorId: string;
    actorRole: string;
  },
  deps?: RuntimeExecutionDeps,
): Promise<{ runId: string; status: string }> {
  if (args.actorRole !== 'OWNER' && args.actorRole !== 'TRAINER') {
    throw errors.forbidden('需要訓練權限（OWNER 或 TRAINER）才能 resume pilot run');
  }

  const run = await prisma.run.findUnique({ where: { id: args.runId } });
  if (!run) {
    throw errors.notFound(`Run not found: ${args.runId}`);
  }
  if (run.runtimeKind !== 'LANGFLOW') {
    throw errors.conflict('resumePilotRun requires runtimeKind LANGFLOW');
  }
  if (run.status !== 'AWAITING_REVIEW') {
    throw errors.conflict(
      `Run must be AWAITING_REVIEW to resume, current status=${run.status}`,
    );
  }

  const approved = await isRunApproved(args.runId, args.approvalRequestId);
  if (!approved) {
    throw errors.forbidden(
      'Run is not approved (requires real ApprovalRequest with status APPROVED)',
    );
  }

  // Server-generated binding only — never trust client-invented resume metadata.
  const approval = await prisma.approvalRequest.findUnique({
    where: { id: args.approvalRequestId },
  });
  if (!approval || approval.runId !== args.runId) {
    throw errors.forbidden('ApprovalRequest does not match run');
  }
  const payload =
    approval.payload &&
    typeof approval.payload === 'object' &&
    !Array.isArray(approval.payload)
      ? (approval.payload as Record<string, unknown>)
      : null;
  const deploymentId =
    payload && typeof payload['deploymentId'] === 'string'
      ? payload['deploymentId']
      : null;
  const environment =
    payload && typeof payload['environment'] === 'string'
      ? payload['environment']
      : null;
  if (!deploymentId || !environment) {
    throw errors.conflict(
      'ApprovalRequest missing server-bound deploymentId/environment',
    );
  }
  if (
    environment !== 'SANDBOX' &&
    environment !== 'STAGING' &&
    environment !== 'PRODUCTION'
  ) {
    throw errors.conflict('ApprovalRequest has invalid deployment environment');
  }

  const deployment = await prisma.runtimeDeployment.findUnique({
    where: { id: deploymentId },
  });
  if (!deployment || !deployment.active) {
    throw errors.conflict('Bound deployment is missing or inactive');
  }
  if (deployment.environment !== environment) {
    throw errors.conflict('Deployment environment does not match approval binding');
  }
  // Fail-closed triple artifact binding: run + server payload + deployment must
  // all be non-empty and exactly equal. Missing is not optional.
  const runArtifactId =
    typeof run.artifactId === 'string' && run.artifactId.length > 0
      ? run.artifactId
      : null;
  const payloadArtifactId =
    payload &&
    typeof payload['artifactId'] === 'string' &&
    payload['artifactId'].length > 0
      ? payload['artifactId']
      : null;
  const deploymentArtifactId =
    typeof deployment.artifactId === 'string' && deployment.artifactId.length > 0
      ? deployment.artifactId
      : null;
  if (!runArtifactId || !payloadArtifactId || !deploymentArtifactId) {
    throw errors.conflict(
      'Resume requires non-empty run, approval, and deployment artifact bindings',
    );
  }
  if (
    runArtifactId !== payloadArtifactId ||
    runArtifactId !== deploymentArtifactId
  ) {
    throw errors.conflict('Resume artifact bindings do not match');
  }

  const adapter =
    deps?.adapter ?? resolveRuntimeAdapter('LANGFLOW', environment);

  try {
    await adapter.resumeRun({
      runId: args.runId,
      approvalRequestId: args.approvalRequestId,
    });
  } catch (e) {
    // Keep AWAITING_REVIEW; rethrow for caller / route layer.
    throw e;
  }

  await prisma.run.update({
    where: { id: args.runId },
    data: {
      status: 'RUNNING',
      finishedAt: null,
    },
  });

  try {
    await audit(args.actorId, 'runtime.pilot.resume', 'Run', args.runId, {
      approvalRequestId: args.approvalRequestId,
      deploymentId,
      environment,
    });
  } catch (auditErr) {
    console.warn(
      '[runtimeexecution] audit resume failed:',
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
  }

  return { runId: args.runId, status: 'RUNNING' };
}
