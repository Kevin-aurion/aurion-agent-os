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
