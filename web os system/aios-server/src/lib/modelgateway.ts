// Internal loopback Model Gateway (Ticket 16 + Phase 6 service identity).
// Service-to-service only: Langflow Runtime execute/verify reuses AIOS Engine
// adapters, budget, restrictions, cost ledger, and fail-closed isApproved.
// Caller cannot choose engine / modelFamily / restrictions / budget.
import type { Agent, Engine, Run, RuntimeDeployment } from '@prisma/client';
import { prisma } from './db.js';
import { ApiError, errors } from './http.js';
import { assertInsideRoot } from './safepath.js';
import { ENGINE_MODEL_FAMILY } from './runtimedeployment.js';
import {
  parseRestrictions,
  type AgentRestrictions,
} from '../engine/restrictions.js';
import {
  guardBudget,
  recordCost,
  BudgetExceededError,
} from '../engine/cost.js';
import {
  isApproved,
  dispatchEngineForGateway,
  type GatewayDispatchArgs,
} from '../engine/index.js';
import { redactSecrets } from '../memory/redactor.js';
import { paths } from '../config.js';
import {
  assertEnvironmentBinding,
  verifyServiceIdentity,
  type ServiceIdentity,
} from './serviceidentity.js';

export type GatewayDispatch = (
  args: GatewayDispatchArgs,
) => Promise<{ text: string; threadId: string | null; costInput: string }>;

export type ModelGatewayDeps = { dispatch?: GatewayDispatch };

const GATEWAY_TIMEOUT_MS = 10 * 60_000;

/**
 * Thin wrapper over verifyServiceIdentity (legacy callers / t16 zero-regression).
 * Fail-closed service-to-service auth for /internal/* gateways.
 */
export function assertServiceRequest(args: {
  authorization?: string;
  remoteAddress?: string;
}): void {
  verifyServiceIdentity(args);
}

export type { ServiceIdentity };

/**
 * Server-side verify-engine selection (mirrors runner autoVerify, by model family).
 * Post-condition: returned family must differ from execute family.
 */
export function chooseVerifyEngine(
  executeEngine: Engine,
  configured: Engine | null,
): Engine {
  let chosen: Engine;
  if (
    configured != null &&
    ENGINE_MODEL_FAMILY[configured] !== ENGINE_MODEL_FAMILY[executeEngine]
  ) {
    chosen = configured;
  } else {
    chosen = executeEngine === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE';
  }
  if (ENGINE_MODEL_FAMILY[chosen] === ENGINE_MODEL_FAMILY[executeEngine]) {
    throw errors.internal('verify engine family must differ (fail-closed)');
  }
  return chosen;
}

export type GatewayContext = {
  run: Run;
  deployment: RuntimeDeployment;
  agent: Agent;
  restrictions: AgentRestrictions;
};

/** Authoritative DB lookup — never trust caller for engine/restrictions/budget/paths. */
export async function loadGatewayContext(args: {
  runId: string;
  deploymentId: string;
  agentId: string;
}): Promise<GatewayContext> {
  const run = await prisma.run.findUnique({ where: { id: args.runId } });
  if (!run) throw errors.notFound('run not found');

  if (run.runtimeKind !== 'LANGFLOW') {
    throw errors.forbidden('Native run 不走 Model Gateway');
  }
  if (!run.artifactId) {
    throw errors.forbidden('run.artifactId 缺失，拒絕');
  }

  const deployment = await prisma.runtimeDeployment.findUnique({
    where: { id: args.deploymentId },
  });
  if (!deployment) throw errors.notFound('deployment not found');
  if (!deployment.active) {
    throw errors.forbidden('deployment 未啟用');
  }
  if (deployment.artifactId !== run.artifactId) {
    throw errors.forbidden('run.artifactId 與 deployment.artifactId 不符');
  }

  const agent = await prisma.agent.findFirst({
    where: { id: run.agentId, deletedAt: null },
  });
  if (!agent) throw errors.forbidden('agent 不存在或已刪除');
  if (args.agentId !== run.agentId) {
    throw errors.forbidden('caller agentId 與 run.agentId 不符');
  }

  try {
    assertInsideRoot(paths.runs, run.runDir);
  } catch {
    throw errors.forbidden('run.runDir 越界，拒絕');
  }

  return {
    run,
    deployment,
    agent,
    restrictions: parseRestrictions(agent.restrictions),
  };
}

async function guardBudgetOr403(
  agentId: string,
  costPolicy: unknown,
): Promise<void> {
  try {
    await guardBudget(agentId, costPolicy);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      throw new ApiError(403, 'BUDGET_EXCEEDED', e.message);
    }
    throw e;
  }
}

async function recordSideEffects(args: {
  agentId: string;
  runId: string;
  engine: Engine;
  inputText: string;
  outputText: string;
  stepKey?: string | null;
  familyField: 'executionModelFamily' | 'verificationModelFamily';
}): Promise<void> {
  try {
    await recordCost({
      agentId: args.agentId,
      runId: args.runId,
      engine: args.engine,
      inputText: args.inputText,
      outputText: args.outputText,
      stepKey: args.stepKey ?? undefined,
    });
  } catch (e) {
    console.error(
      '[modelgateway] recordCost failed (non-fatal):',
      e instanceof Error ? e.message : e,
    );
  }
  try {
    await prisma.run.update({
      where: { id: args.runId },
      data: {
        [args.familyField]: ENGINE_MODEL_FAMILY[args.engine],
      },
    });
  } catch (e) {
    console.error(
      '[modelgateway] run modelFamily update failed (non-fatal):',
      e instanceof Error ? e.message : e,
    );
  }
}

function buildGatewayVerifyPrompt(args: {
  artifact: string;
  rubric?: string;
  sourceOfTruth?: string;
}): string {
  const rubric = (args.rubric ?? '').trim() || '(none)';
  const sot = (args.sourceOfTruth ?? '').trim() || '(none)';
  return [
    'You are an independent cross-model verifier. Treat the artifact as a claim to falsify.',
    '',
    '## Rubric',
    rubric,
    '',
    '## Source of truth',
    sot,
    '',
    '## Artifact',
    args.artifact,
    '',
    'Respond with a section "## Verdict" followed by exactly one of:',
    'APPROVED',
    'or',
    'ISSUES FOUND: <brief reason>',
  ].join('\n');
}

export async function gatewayExecute(
  args: {
    runId: string;
    deploymentId: string;
    agentId: string;
    prompt: string;
    stepKey?: string;
    identity?: ServiceIdentity;
  },
  deps?: ModelGatewayDeps,
): Promise<{
  runId: string;
  engine: Engine;
  modelFamily: string;
  stepKey: string | null;
  text: string;
}> {
  if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
    throw errors.badRequest('prompt is required');
  }

  const ctx = await loadGatewayContext({
    runId: args.runId,
    deploymentId: args.deploymentId,
    agentId: args.agentId,
  });

  assertEnvironmentBinding(args.identity, ctx.deployment.environment);

  const engine = ctx.agent.engineExecute;
  await guardBudgetOr403(ctx.agent.id, ctx.agent.costPolicy);

  const dispatch = deps?.dispatch ?? dispatchEngineForGateway;
  const res = await dispatch({
    engine,
    kind: 'execute',
    prompt: args.prompt,
    cwd: ctx.run.runDir,
    timeoutMs: GATEWAY_TIMEOUT_MS,
    restrictions: ctx.restrictions,
  });

  await recordSideEffects({
    agentId: ctx.agent.id,
    runId: ctx.run.id,
    engine,
    inputText: res.costInput,
    outputText: res.text,
    stepKey: args.stepKey ?? null,
    familyField: 'executionModelFamily',
  });

  return {
    runId: ctx.run.id,
    engine,
    modelFamily: ENGINE_MODEL_FAMILY[engine],
    stepKey: args.stepKey ?? null,
    text: redactSecrets(res.text),
  };
}

export async function gatewayVerify(
  args: {
    runId: string;
    deploymentId: string;
    agentId: string;
    artifact: string;
    rubric?: string;
    sourceOfTruth?: string;
    threadId?: string | null;
    identity?: ServiceIdentity;
  },
  deps?: ModelGatewayDeps,
): Promise<{
  runId: string;
  approved: boolean;
  engine: Engine;
  modelFamily: string;
  executionModelFamily: string;
  text: string;
  threadId: string | null;
}> {
  if (typeof args.artifact !== 'string' || args.artifact.trim() === '') {
    throw errors.badRequest('artifact is required');
  }

  const ctx = await loadGatewayContext({
    runId: args.runId,
    deploymentId: args.deploymentId,
    agentId: args.agentId,
  });

  assertEnvironmentBinding(args.identity, ctx.deployment.environment);

  const executeEngine = ctx.agent.engineExecute;
  const verifyEngine = chooseVerifyEngine(
    executeEngine,
    ctx.agent.engineVerify ?? null,
  );

  await guardBudgetOr403(ctx.agent.id, ctx.agent.costPolicy);

  const prompt = buildGatewayVerifyPrompt({
    artifact: args.artifact,
    rubric: args.rubric,
    sourceOfTruth: args.sourceOfTruth,
  });

  const dispatch = deps?.dispatch ?? dispatchEngineForGateway;
  const res = await dispatch({
    engine: verifyEngine,
    kind: 'verify',
    prompt,
    cwd: ctx.run.runDir,
    timeoutMs: GATEWAY_TIMEOUT_MS,
    restrictions: ctx.restrictions,
    threadId: args.threadId ?? null,
  });

  const approved = isApproved(res.text);

  await recordSideEffects({
    agentId: ctx.agent.id,
    runId: ctx.run.id,
    engine: verifyEngine,
    inputText: res.costInput,
    outputText: res.text,
    familyField: 'verificationModelFamily',
  });

  return {
    runId: ctx.run.id,
    approved,
    engine: verifyEngine,
    modelFamily: ENGINE_MODEL_FAMILY[verifyEngine],
    executionModelFamily: ENGINE_MODEL_FAMILY[executeEngine],
    text: redactSecrets(res.text),
    threadId: res.threadId,
  };
}
