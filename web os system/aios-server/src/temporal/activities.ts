/**
 * Temporal activities for the durable agent-run PoC.
 * Activities may have side effects; keep them simple for this opt-in demo.
 */

export async function executeStepActivity(instruction: string): Promise<string> {
  return `executed: ${instruction}`;
}

export async function finishActivity(runId: string): Promise<string> {
  return `finished: ${runId}`;
}

/** Real engine entrypoint as a Temporal activity (durable workflow path). */
export async function runAgentActivity(input: {
  runId?: string;
  agentId: string;
  workflowId?: string;
  input: Record<string, unknown>;
  triggeredBy: string;
}): Promise<{ runId: string; status: string; stoppedAt?: string | null }> {
  const { runAgent } = await import('../engine/index.js');
  const o = await runAgent({
    ...(input.runId ? { runId: input.runId } : {}),
    agentId: input.agentId,
    workflowId: input.workflowId,
    input: input.input,
    triggeredBy: input.triggeredBy,
    approvedApprovalId: 'temporal-durable',
  });
  return { runId: o.runId, status: o.status, stoppedAt: o.stoppedAt ?? null };
}
