/**
 * Temporal activities for the durable agent-run PoC.
 * Activities may have side effects; keep them simple for this opt-in demo.
 */

import type { RunOutcome } from '../engine/types.js';

export async function executeStepActivity(instruction: string): Promise<string> {
  return `executed: ${instruction}`;
}

export async function finishActivity(runId: string): Promise<string> {
  return `finished: ${runId}`;
}

/**
 * Real engine entrypoint as a Temporal activity (durable workflow path).
 * Returns the full serializable RunOutcome (no fake approvedApprovalId —
 * high-risk durable is rejected at dispatch; see durableHighRiskRejected).
 */
export async function runAgentActivity(input: {
  runId?: string;
  agentId: string;
  workflowId?: string;
  input: Record<string, unknown>;
  triggeredBy: string;
}): Promise<RunOutcome> {
  const { runAgent } = await import('../engine/index.js');
  return runAgent({
    ...(input.runId ? { runId: input.runId } : {}),
    agentId: input.agentId,
    workflowId: input.workflowId,
    input: input.input,
    triggeredBy: input.triggeredBy,
  });
}
