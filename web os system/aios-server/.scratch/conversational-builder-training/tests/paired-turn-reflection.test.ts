import assert from 'node:assert/strict';
import { ulid } from 'ulid';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

const { prisma } = await import('../../../src/lib/db.js');
const {
  createExternalBuilderSession,
  syncExternalBuilderTurn,
} = await import('../../../src/lib/externalagentbuilder.js');

const userId = ulid();
let sessionId = '';
try {
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@paired-reflection.test`,
      displayName: 'Paired Reflection',
      passwordHash: 'unused',
      role: 'MEMBER',
    },
  });
  const created = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_DESKTOP',
    externalConversationId: `paired-${ulid()}`,
    initialRequest: '建立一位報價 AI 員工。',
  });
  sessionId = created.session.id;
  const result = await syncExternalBuilderTurn({
    sessionId,
    userId,
    role: 'MEMBER',
    source: 'CLAUDE_DESKTOP',
    externalEventId: 'paired-turn-1',
    turns: [
      { role: 'user', content: '報價單不能缺少付款條件。' },
      { role: 'assistant', content: '了解，我會把付款條件列為必要欄位。' },
    ],
  });
  assert.equal(result.iteration?.triggerKind, 'reflection');
  assert.match(result.iteration?.triggerSummary ?? '', /付款條件/);
  assert.match(result.iteration?.triggerSummary ?? '', /使用者回饋/);

  const duplicate = await syncExternalBuilderTurn({
    sessionId,
    userId,
    role: 'MEMBER',
    source: 'CLAUDE_DESKTOP',
    externalEventId: 'paired-turn-1',
    turns: [{ role: 'user', content: '重試不應建立新版' }],
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(
    await prisma.agentBuildIteration.count({ where: { sessionId, triggerKind: 'reflection' } }),
    1,
  );
  console.log(JSON.stringify({ passed: true, sessionId }));
} finally {
  if (sessionId) await prisma.agentBuildSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
}
