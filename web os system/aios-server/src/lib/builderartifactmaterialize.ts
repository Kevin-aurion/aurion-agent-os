// Materialize externally authored Harness artifacts only after the existing
// Agent Builder test + FDE finalization gate succeeds.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { Prisma } from '@prisma/client';
import { audit } from './audit.js';
import { safeJoin } from './safepath.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { materializeAgent } from '../engine/materialize.js';
import { reindexAgent } from '../memory/memoryService.js';
import type { HarnessSnapshot } from './agentbuilderevolution.js';

export async function createExternalBuilderWorkflows(
  tx: Prisma.TransactionClient,
  opts: {
    agentId: string;
    harness: HarnessSnapshot | null;
  },
): Promise<string[]> {
  const workflows = opts.harness?.workflows ?? [];
  const ids: string[] = [];
  for (const blueprint of workflows) {
    const workflowId = ulid();
    await tx.workflow.create({
      data: {
        id: workflowId,
        agentId: opts.agentId,
        name: blueprint.name.slice(0, 160),
        description: [
          blueprint.description,
          '由外部 Agent Builder 匯入；預設停用，需 FDE 另行檢查觸發與工具連線後啟用。',
        ].filter(Boolean).join('\n\n'),
        // Importing a workflow is not permission to schedule or execute it.
        enabled: false,
        durable: blueprint.durable === true,
        trigger: deepRedactSecrets(blueprint.trigger) as Prisma.InputJsonValue,
        steps: {
          create: blueprint.steps.map((step, position) => ({
            id: ulid(),
            position,
            stepKey: step.stepKey,
            type: step.type,
            config: deepRedactSecrets(step.config) as Prisma.InputJsonValue,
            verifyRubric: step.verifyRubric ?? null,
            onFail: step.onFail == null
              ? Prisma.JsonNull
              : deepRedactSecrets(step.onFail) as Prisma.InputJsonValue,
          })),
        },
      },
    });
    ids.push(workflowId);
  }
  return ids;
}

/**
 * Memory is an auxiliary layer: every write is redacted and path-guarded, but
 * failures must not invalidate an otherwise verified Agent finalization.
 */
export async function materializeExternalBuilderFiles(opts: {
  agentId: string;
  userId: string;
  sessionId: string;
  harness: HarnessSnapshot | null;
  workflowIds: string[];
}): Promise<void> {
  const agentDir = await materializeAgent(opts.agentId);
  const memoryRoot = safeJoin(agentDir, 'memory', 'wiki');
  const documents = opts.harness?.memory.documents ?? [];
  for (const document of documents) {
    const segments = document.path.replaceAll('\\', '/').split('/').filter(Boolean);
    const target = safeJoin(memoryRoot, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(deepRedactSecrets(document.contentMd)), 'utf8');
  }

  await reindexAgent(opts.agentId, agentDir).catch(() => ({ indexed: 0, skipped: 0, files: 0 }));
  await audit(opts.userId, 'agent_builder.external_artifacts_materialized', 'Agent', opts.agentId, {
    sessionId: opts.sessionId,
    workflowIds: opts.workflowIds,
    memoryDocuments: documents.map((document) => document.path),
  }).catch(() => {});
}
