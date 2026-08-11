import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import { createExternalBuilderSession } from '../../src/lib/externalagentbuilder.js';

async function main() {
  process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
  const owner = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { email: 'kevin@lazyoffice.app' },
        { role: 'OWNER' },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!owner) throw new Error('Owner test account not found');
  const conversationId = `idempotency-${ulid()}`;
  const calls = await Promise.all(
    Array.from({ length: 12 }, () => createExternalBuilderSession({
      userId: owner.id,
      source: 'CLAUDE_DESKTOP',
      externalConversationId: conversationId,
      initialRequest: '建立一個 Agent Builder 併發冪等性測試員工',
      requestedAgentName: 'Agent Builder 併發測試員工',
    })),
  );
  const ids = new Set(calls.map((result) => result.session.id));
  const rows = await prisma.agentBuildSession.findMany({
    where: {
      userId: owner.id,
      brief: { path: ['externalConversationId'], equals: conversationId },
    },
    select: { id: true },
  });
  try {
    if (ids.size !== 1 || rows.length !== 1) {
      throw new Error(`Expected one session, got returnIds=${ids.size} dbRows=${rows.length}`);
    }
    const createdCount = calls.filter((result) => !result.deduplicated).length;
    if (createdCount !== 1) {
      throw new Error(`Expected one creator, got ${createdCount}`);
    }
    console.log(JSON.stringify({
      passed: true,
      concurrentCalls: calls.length,
      sessionId: rows[0]!.id,
      createdCount,
      deduplicatedCount: calls.length - createdCount,
    }, null, 2));
  } finally {
    await prisma.agentBuildSession.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
