/**
 * Temporal client helpers for the durable agent-run PoC.
 * Connects to localhost:7233, task queue aios-durable.
 */

import { Client, Connection } from '@temporalio/client';
import type { DurableRunInput } from './workflows.js';
import { durableAgentRun, approveSignal } from './workflows.js';

const TEMPORAL_ADDRESS = 'localhost:7233';
const TASK_QUEUE = 'aios-durable';

let cachedClient: Client | undefined;

async function getClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  cachedClient = new Client({ connection, namespace: 'default' });
  return cachedClient;
}

/** Start durableAgentRun workflow; workflowId = input.runId. Returns workflowId. */
export async function startDurableRun(input: DurableRunInput): Promise<string> {
  const client = await getClient();
  const handle = await client.workflow.start(durableAgentRun, {
    taskQueue: TASK_QUEUE,
    workflowId: input.runId,
    args: [input],
  });
  return handle.workflowId;
}

/** Send the approve signal so a high-risk workflow can proceed past HITL wait. */
export async function approveDurableRun(workflowId: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(approveSignal);
}

/** Await and return the workflow result. */
export async function getDurableRunResult(workflowId: string): Promise<unknown> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  return handle.result();
}

/** Return current workflow status string (e.g. RUNNING, COMPLETED, FAILED). */
export async function describeDurableRun(workflowId: string): Promise<string> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  return desc.status.name;
}
