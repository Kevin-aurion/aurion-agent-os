/**
 * Temporal worker bootstrap for the durable agent-run PoC.
 * Run: npm run temporal:worker  (or: tsx src/temporal/worker.ts)
 *
 * ESM + workflowsPath: Temporal's webpack bundler needs a resolvable path.
 * We pass the .ts source via fileURLToPath so the bundler can compile it
 * (pointing at .js fails when no emitted JS exists under src/).
 */

import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.js';

const TASK_QUEUE = 'aios-durable';
const TEMPORAL_ADDRESS = 'localhost:7233';

async function main(): Promise<void> {
  // Absolute path to the workflow module source (TS). Temporal Worker bundles
  // this with webpack; import.meta.url is the ESM-safe way to resolve it.
  const workflowsPath = fileURLToPath(new URL('./workflows.ts', import.meta.url));

  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities,
  });

  console.log(`[temporal] worker ready — queue=${TASK_QUEUE} address=${TEMPORAL_ADDRESS}`);
  console.log(`[temporal] workflowsPath=${workflowsPath}`);
  await worker.run();
}

main().catch((err) => {
  console.error('[temporal] worker failed:', err);
  process.exit(1);
});
