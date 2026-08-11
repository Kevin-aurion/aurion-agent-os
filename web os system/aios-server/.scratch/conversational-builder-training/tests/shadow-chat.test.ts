import assert from 'node:assert/strict';
import { ulid } from 'ulid';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

const { prisma } = await import('../../../src/lib/db.js');
const { createExternalBuilderSession } = await import('../../../src/lib/externalagentbuilder.js');
const { processBuilderEvolution } = await import('../../../src/lib/agentbuilderevolution.js');
const { chatWithBuilderShadow } = await import('../../../src/lib/builderconversation.js');

const userId = ulid();
const foreignId = ulid();
const sessionIds: string[] = [];

try {
  await prisma.user.createMany({
    data: [
      { id: userId, email: `${userId}@shadow.test`, displayName: 'Owner', passwordHash: 'unused', role: 'MEMBER' },
      { id: foreignId, email: `${foreignId}@shadow.test`, displayName: 'Foreign', passwordHash: 'unused', role: 'MEMBER' },
    ],
  });
  const created = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_DESKTOP',
    externalConversationId: `shadow-${ulid()}`,
    initialRequest: '建立一位報價助理，報價單必須有客戶名稱、有效期限與未稅總額。',
  });
  sessionIds.push(created.session.id);
  const initial = await prisma.agentBuildIteration.findFirstOrThrow({
    where: { sessionId: created.session.id },
    orderBy: { sequence: 'asc' },
  });
  await processBuilderEvolution(initial.id);

  let capturedPrompt = '';
  const result = await chatWithBuilderShadow({
    sessionId: created.session.id,
    userId,
    role: 'MEMBER',
    message: '請替星河公司做一份報價。token=sk-test-secret',
    execute: async ({ prompt }) => {
      capturedPrompt = prompt;
      return '以下是報價草稿：客戶名稱星河公司；有效期限待確認；未稅總額待確認。';
    },
  });

  assert.match(capturedPrompt, /報價助理/);
  assert.match(capturedPrompt, /禁止使用任何工具/);
  assert.doesNotMatch(capturedPrompt, /sk-test-secret/);
  assert.match(result.reply, /有效期限/);
  assert.equal(result.reflectionQueued, true);
  const stored = await prisma.agentBuildSession.findUniqueOrThrow({ where: { id: created.session.id } });
  assert.doesNotMatch(JSON.stringify(stored.transcript), /sk-test-secret/);
  assert.match(JSON.stringify(stored.transcript), /互動試教輸入/);
  assert.equal(
    await prisma.agentBuildIteration.count({ where: { sessionId: created.session.id, triggerKind: 'reflection' } }),
    1,
  );

  await assert.rejects(
    chatWithBuilderShadow({
      sessionId: created.session.id,
      userId: foreignId,
      role: 'MEMBER',
      message: '偷看別人的草稿',
      execute: async () => '不應執行',
    }),
    /Session not found/,
  );

  console.log(JSON.stringify({ passed: true, sessionId: created.session.id }));
} finally {
  await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [userId, foreignId] } } }).catch(() => {});
  await prisma.$disconnect();
}
