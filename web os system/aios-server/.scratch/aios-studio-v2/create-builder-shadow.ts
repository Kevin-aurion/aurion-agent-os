import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prisma } from '../../src/lib/db.js';
import {
  createExternalBuilderSession,
  importExternalBuilderArtifact,
  submitExternalBuilderForReview,
} from '../../src/lib/externalagentbuilder.js';
import {
  buildKnowledgeShadowArtifact,
  validateKnowledgeShadowArtifact,
} from './builder-shadow-contract.js';

const sourceSessionId = '01KZKPM049RKZ0CD8N5T6T1CZ5';
const externalConversationId = `langflow-shadow:${sourceSessionId}`;
const snapshot = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sourceBefore = await prisma.agentBuildSession.findUnique({
  where: { id: sourceSessionId },
  include: { iterations: { orderBy: { sequence: 'asc' } } },
});
assert.ok(sourceBefore, 'Source AI 知識採集 builder session was not found');
const sourceDigestBefore = snapshot(sourceBefore);
const owner = await prisma.user.findUnique({ where: { id: sourceBefore.userId } });
assert.ok(owner, 'Source builder owner was not found');
assert.ok(['OWNER', 'TRAINER'].includes(owner.role), 'Shadow clone requires an FDE owner');

const created = await createExternalBuilderSession({
  userId: owner.id,
  source: 'OTHER',
  initialRequest:
    '複製 AI 知識採集為 Langflow Sandbox 影子草稿。只測試唯讀輸入輸出閉環，不啟用檔案、網路、Shell、排程或 Production。',
  externalConversationId,
  externalConversationTitle: 'AI 知識採集 Langflow Sandbox Pilot',
  requestedAgentName: 'AI 知識採集 — Langflow Sandbox',
});

const artifact = buildKnowledgeShadowArtifact(sourceSessionId);
validateKnowledgeShadowArtifact(artifact);
await importExternalBuilderArtifact({
  sessionId: created.session.id,
  userId: owner.id,
  role: owner.role,
  source: 'OTHER',
  externalEventId: 'langflow-native-roundtrip-v1',
  artifact,
});

let shadow = await prisma.agentBuildSession.findUnique({ where: { id: created.session.id } });
assert.ok(shadow);
if (shadow.status !== 'AWAITING_FDE') {
  await submitExternalBuilderForReview({
    sessionId: shadow.id,
    userId: owner.id,
    role: owner.role,
    strategy: 'create',
  });
}

const sourceAfter = await prisma.agentBuildSession.findUnique({
  where: { id: sourceSessionId },
  include: { iterations: { orderBy: { sequence: 'asc' } } },
});
assert.equal(snapshot(sourceAfter), sourceDigestBefore, 'Original builder session was mutated');
shadow = await prisma.agentBuildSession.findUnique({
  where: { id: created.session.id },
  include: { iterations: { orderBy: { sequence: 'desc' }, take: 1 } },
});
assert.ok(shadow);
assert.equal(shadow.status, 'AWAITING_FDE');

const report = {
  passed: true,
  sourceSessionId,
  sourceUnchanged: true,
  shadowSessionId: shadow.id,
  shadowStatus: shadow.status,
  latestIterationStatus: shadow.iterations[0]?.status ?? null,
  productionActivated: false,
  createdAt: new Date().toISOString(),
};
await writeFile(new URL('./builder-shadow-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await prisma.$disconnect();
