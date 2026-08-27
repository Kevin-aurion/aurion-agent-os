import assert from 'node:assert/strict';
import { ulid } from 'ulid';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

const { prisma } = await import('../../../src/lib/db.js');
const { createExternalBuilderSession } = await import('../../../src/lib/externalagentbuilder.js');
const { ensureBuilderWorkingAgent } = await import('../../../src/lib/builderworkingagent.js');

const userId = ulid();
const externalConversationId = `immediate-${ulid()}`;
const sessionIds: string[] = [];
const agentIds: string[] = [];

try {
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@working-agent.test`,
      displayName: 'Working Agent Owner',
      passwordHash: 'unused',
      role: 'MEMBER',
    },
  });
  const first = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_CODE',
    externalConversationId,
    requestedAgentName: '即時可用測試員工',
    initialRequest: '建立一位只能整理文字、不能執行任何外部操作的員工。',
  });
  sessionIds.push(first.session.id);
  assert.equal(first.deduplicated, false);
  assert.equal(first.session.status, 'ACTIVE');
  assert.ok(first.session.builtAgentId);
  agentIds.push(first.session.builtAgentId!);

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: first.session.builtAgentId! } });
  assert.equal(agent.createdBy, userId);
  assert.equal(agent.status, 'ACTIVE');
  assert.equal(agent.name, '即時可用測試員工');
  assert.deepEqual(agent.restrictions, {
    webSearch: false,
    computerUse: false,
    sendEmail: false,
    cloudWrite: false,
    shell: false,
    cloudEmbedding: false,
    notes: '建立後即可對話；外部工具、寫入與不可逆操作仍需另外授權。',
  });

  const retry = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_CODE',
    externalConversationId,
    requestedAgentName: '不應再建立第二位',
    initialRequest: '相同 hook 重試。',
  });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.session.id, first.session.id);
  assert.equal(retry.session.builtAgentId, first.session.builtAgentId);
  assert.equal(await prisma.agent.count({ where: { createdBy: userId } }), 1);

  const ensured = await ensureBuilderWorkingAgent(first.session.id);
  assert.equal(ensured.created, false);
  assert.equal(ensured.agentId, first.session.builtAgentId);
  assert.equal(await prisma.agent.count({ where: { createdBy: userId } }), 1);

  console.log(JSON.stringify({ passed: true, sessionId: first.session.id, agentId: agent.id }));
} finally {
  await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
}
