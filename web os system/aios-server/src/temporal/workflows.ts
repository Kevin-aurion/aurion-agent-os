/**
 * Deterministic Temporal workflow for durable agent runs + HITL approve signal.
 * No Date.now / random / direct IO — only activities and Temporal APIs.
 */

import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';
import type * as activities from './activities.js';

const { executeStepActivity, finishActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

const { runAgentActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
});

export const approveSignal = defineSignal('approve');

export interface DurableRunInput {
  runId: string;
  agentId: string;
  riskTier: string;
  instruction: string;
}

export async function durableAgentRun(
  input: DurableRunInput,
): Promise<{ runId: string; status: string; step: string }> {
  // High risk → durably wait for human approval before executing
  if (input.riskTier === 'high') {
    let approved = false;
    setHandler(approveSignal, () => {
      approved = true;
    });
    await condition(() => approved);
  }

  const step = await executeStepActivity(input.instruction);
  await finishActivity(input.runId);
  return { runId: input.runId, status: 'SUCCEEDED', step };
}

export interface DurableWorkflowInput {
  runId: string;
  agentId: string;
  workflowId: string;
  triggeredBy: string;
  riskTier: string;
  input: Record<string, unknown>;
}

/**
 * Opt-in durable workflow path: high-risk waits for approveSignal, then
 * runs the real engine via runAgentActivity.
 * Requires temporal worker (`npm run temporal:worker`) to progress.
 */
export async function durableWorkflowRun(
  input: DurableWorkflowInput,
): Promise<{ runId: string; status: string; stoppedAt?: string | null }> {
  if (input.riskTier === 'high') {
    let approved = false;
    setHandler(approveSignal, () => {
      approved = true;
    });
    await condition(() => approved);
  }
  return await runAgentActivity({
    runId: input.runId,
    agentId: input.agentId,
    workflowId: input.workflowId,
    input: input.input,
    triggeredBy: input.triggeredBy,
  });
}
