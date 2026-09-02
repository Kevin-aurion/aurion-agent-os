// Layer-2: Workflow -> Run mapping. This module owns nothing about *how* a
// step executes — that loop (DO/TOOL/AGENT/CONDITION/NOTIFY/COMPUTER_CONTROL,
// execute/verify rounds, defect rework) lives entirely in the engine
// (src/engine/runner.ts). This file just:
//   1. resolves a Workflow -> its Agent + ordered steps,
//   2. hands the run off to the engine via runAgent({ agentId, workflowId }),
//   3. publishes the 'workflow.triggered' event before execution starts,
//   4. enforces the RunOutcome status contract on the way back out.
import { prisma } from '../lib/db.js';
import { errors } from '../lib/http.js';
import { hub } from '../ws/hub.js';
import { durableHighRiskRejected } from '../lib/approval.js';
import type { RunOutcome } from '../engine/index.js';
import { prepareWorkflowInput } from './input.js';

const VALID_STATUSES = new Set(['RUNNING', 'SUCCEEDED', 'FAILED', 'AWAITING_REVIEW', 'CANCELLED']);

/**
 * Run a workflow to completion. Loads the Workflow (+ its ordered
 * WorkflowStep[] purely to validate it has steps and to size the
 * 'workflow.triggered' event), then delegates the actual execution to the
 * engine (`runAgent`), which compiles the manifest from Workflow.steps again
 * and owns the Run/RunStep persistence + WS run.* events.
 *
 * Resolves only when the run finishes (success, failure, or
 * awaiting-review) — callers that must not block an HTTP response on this
 * (e.g. the manual-run / webhook routes) should race this promise against a
 * short poll for the Run row instead of awaiting it directly, OR pre-generate
 * a `runId` and pass it in so it's known immediately (see `runId` param).
 */
export async function runWorkflow(
  workflowId: string,
  input: Record<string, unknown>,
  triggeredBy: string,
  runId?: string,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: {
      agent: { select: { status: true, deletedAt: true } },
      steps: { orderBy: { position: 'asc' } },
    },
  });
  if (!workflow || workflow.deletedAt) throw errors.notFound(`Workflow not found: ${workflowId}`);
  if (!workflow.enabled) throw errors.conflict(`Workflow is not enabled: ${workflowId}`);
  if (workflow.agent.deletedAt || workflow.agent.status !== 'ACTIVE') {
    throw errors.conflict(`Workflow Agent is not active: ${workflow.agentId}`);
  }
  if (workflow.steps.length === 0) throw errors.badRequest(`Workflow ${workflowId} has no steps configured`);

  const prepared = prepareWorkflowInput(input, workflow.inputSchema, workflow.steps);
  if (prepared.issues.length > 0) {
    throw errors.badRequest('Workflow input does not match its required schema', {
      workflowId: workflow.id,
      workflowName: workflow.name,
      issues: prepared.issues,
      expectedInputSchema: prepared.schema,
    });
  }
  const effectiveInput = prepared.input;

  hub.publish('workflow.triggered', {
    workflowId: workflow.id,
    agentId: workflow.agentId,
    name: workflow.name,
    stepCount: workflow.steps.length,
    triggeredBy,
    at: new Date().toISOString(),
  });

  // Dynamic import: the engine is a separate execution layer; importing it
  // lazily here keeps this module a thin adapter and avoids any load-order
  // coupling with the rest of the spine.
  // Opt-in durable path: Workflow.durable=true → Temporal (HITL wait +
  // runAgent activity). Requires `npm run temporal:worker` or the workflow
  // will not progress. Non-durable stays in-process (unchanged).
  // Durable + high-risk is rejected fail-closed (no Temporal HITL wiring yet).
  let outcome: RunOutcome;
  if (workflow.durable) {
    const agent = await prisma.agent.findUnique({ where: { id: workflow.agentId } });
    if (durableHighRiskRejected(agent?.riskTier, true)) {
      throw errors.badRequest(
        '耐久工作流尚不支援高風險員工的人工核准，請關閉 durable 或調降 riskTier',
      );
    }
    const rid = runId ?? (await import('ulid')).ulid();
    const { startDurableWorkflowRun, getDurableRunResult } = await import('../temporal/client.js');
    await startDurableWorkflowRun({
      runId: rid,
      agentId: workflow.agentId,
      workflowId: workflow.id,
      triggeredBy,
      input: effectiveInput,
      riskTier: agent?.riskTier ?? 'medium',
    });
    outcome = await getDurableRunResult(rid);
  } else {
    const { runAgent } = await import('../engine/index.js');
    outcome = await runAgent({
      ...(runId ? { runId } : {}),
      agentId: workflow.agentId,
      workflowId: workflow.id,
      input: effectiveInput,
      triggeredBy,
      signal,
    });
  }

  // Status contract: the engine must resolve to one of the RunStatus enum
  // values (never a thrown error masquerading as success, and never a bare
  // 'success'/'failed' string) — a run that "completes" outside that
  // contract is a bug in the engine, so fail loudly here rather than let a
  // malformed outcome propagate to routes/scheduler/webhooks.
  if (!outcome || !VALID_STATUSES.has(outcome.status)) {
    throw errors.internal(`Engine returned an invalid run outcome for workflow ${workflowId}`);
  }

  return outcome;
}
