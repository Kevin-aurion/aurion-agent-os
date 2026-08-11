import assert from 'node:assert/strict';
import { ulid } from 'ulid';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

const { prisma } = await import('../../../src/lib/db.js');
const {
  createExternalBuilderSession,
  guardExternalBuilderStop,
  prepareExternalBuilderPrompt,
} = await import('../../../src/lib/externalagentbuilder.js');
const { processBuilderEvolution } = await import('../../../src/lib/agentbuilderevolution.js');

const userId = ulid();
const conversationId = `reflection-${ulid()}`;
let sessionId = '';

try {
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@reflection.test`,
      displayName: 'Reflection Tester',
      passwordHash: 'unused',
      role: 'MEMBER',
    },
  });

  const created = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_CODE',
    externalConversationId: conversationId,
    initialRequest: '建立一個會產生報價單的 AI 員工。',
  });
  sessionId = created.session.id;

  const prompt = '剛剛的結果少了報價單有效期限；以後報價單一定要有有效期限欄位。';
  const prepared = await prepareExternalBuilderPrompt({
    userId,
    source: 'CLAUDE_CODE',
    externalConversationId: conversationId,
    prompt,
  });
  assert.equal(prepared.userMessageSynced, true);

  const beforeStop = await prisma.agentBuildIteration.count({ where: { sessionId } });
  const stopped = await guardExternalBuilderStop({
    userId,
    source: 'CLAUDE_CODE',
    externalConversationId: conversationId,
    lastUserMessage: prompt,
    lastAssistantMessage: '了解，我會把有效期限加入報價單必要欄位。',
    stopHookActive: false,
  });

  assert.equal(stopped.reflectionQueued, true);
  assert.equal(stopped.finalMessageSynced, true);
  const reflection = await prisma.agentBuildIteration.findFirstOrThrow({
    where: { sessionId, triggerKind: 'reflection' },
    orderBy: { sequence: 'desc' },
  });
  assert.equal(await prisma.agentBuildIteration.count({ where: { sessionId } }), beforeStop + 1);
  assert.match(reflection.triggerSummary, /有效期限/);
  assert.match(reflection.triggerSummary, /使用者回饋/);

  await processBuilderEvolution(reflection.id);
  const ready = await prisma.agentBuildIteration.findUniqueOrThrow({ where: { id: reflection.id } });
  assert.equal(ready.status, 'READY');
  assert.match(JSON.stringify(ready.artifactSnapshot), /有效期限/);

  const duplicate = await guardExternalBuilderStop({
    userId,
    source: 'CLAUDE_CODE',
    externalConversationId: conversationId,
    lastUserMessage: prompt,
    lastAssistantMessage: '了解，我會把有效期限加入報價單必要欄位。',
    stopHookActive: true,
  });
  assert.equal(duplicate.reflectionQueued, false);
  assert.equal(
    await prisma.agentBuildIteration.count({ where: { sessionId, triggerKind: 'reflection' } }),
    1,
  );

  console.log(JSON.stringify({ passed: true, sessionId, reflectionId: reflection.id }));
} finally {
  if (sessionId) await prisma.agentBuildSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
}
