// Materialize externally authored Harness artifacts when the owner activates
// the latest training snapshot.
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
    const name = blueprint.name.slice(0, 160);
    const isManual = blueprint.trigger.type === 'manual';
    const existing = await tx.workflow.findFirst({
      where: {
        agentId: opts.agentId,
        name,
        OR: [
          { description: { contains: '由 Agent Builder 訓練 session 匯入' } },
          { description: { contains: '由外部 Agent Builder 匯入' } },
        ],
      },
      select: { id: true },
    });
    const workflowId = existing?.id ?? ulid();
    const stepCreates = blueprint.steps.map((step, position) => ({
      id: ulid(),
      position,
      stepKey: step.stepKey,
      type: step.type,
      // Simple Builder manual workflows are conversational execution plans.
      // The owner explicitly asked to remove the intermediate verifier loop;
      // runtime safety restrictions still apply in the engine.
      config: deepRedactSecrets({ ...step.config, ...(isManual ? { skipVerify: true } : {}) }) as Prisma.InputJsonValue,
      verifyRubric: step.verifyRubric ?? null,
      onFail: step.onFail == null
        ? Prisma.JsonNull
        : deepRedactSecrets(step.onFail) as Prisma.InputJsonValue,
    }));
    const data = {
      name,
      description: [
        blueprint.description,
        isManual
          ? '由 Agent Builder 訓練 session 匯入；僅人工觸發，不建立排程。'
          : '由 Agent Builder 訓練 session 匯入；待使用者完成工具連線或觸發設定後再啟用。',
      ].filter(Boolean).join('\n\n'),
      // A manual workflow has no automatic external side effect, so it is
      // callable as soon as the Agent is active. Scheduled/event workflows
      // remain inert until the user explicitly enables their trigger.
      enabled: isManual,
      // Manual Builder workflows run on the native path. Opting them into
      // Temporal without a worker leaves a RUNNING row with zero steps.
      durable: isManual ? false : blueprint.durable === true,
      trigger: deepRedactSecrets(blueprint.trigger) as Prisma.InputJsonValue,
    };
    if (existing) {
      await tx.workflow.update({
        where: { id: workflowId },
        data: { ...data, steps: { deleteMany: {}, create: stepCreates } },
      });
    } else {
      await tx.workflow.create({
        data: { id: workflowId, agentId: opts.agentId, ...data, steps: { create: stepCreates } },
      });
    }
    ids.push(workflowId);
  }
  return ids;
}

/**
 * Memory is an auxiliary layer: every write is redacted and path-guarded, but
 * failures must not invalidate an otherwise activated Agent.
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
