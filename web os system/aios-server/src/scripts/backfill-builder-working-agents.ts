import { prisma } from '../lib/db.js';
import { ensureBuilderWorkingAgent } from '../lib/builderworkingagent.js';
import { audit } from '../lib/audit.js';
import { hub } from '../ws/hub.js';

async function main() {
  const userEmail = process.env.AIOS_BUILDER_BACKFILL_USER_EMAIL?.trim().toLowerCase();
  const namePrefix = process.env.AIOS_BUILDER_BACKFILL_NAME_PREFIX?.trim();
  const allowAll = process.env.AIOS_BUILDER_BACKFILL_ALL === 'true';
  if (!allowAll && !userEmail && !namePrefix) {
    throw new Error(
      'Refusing broad backfill: set AIOS_BUILDER_BACKFILL_USER_EMAIL, '
      + 'AIOS_BUILDER_BACKFILL_NAME_PREFIX, or AIOS_BUILDER_BACKFILL_ALL=true',
    );
  }
  const user = userEmail
    ? await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true } })
    : null;
  if (userEmail && !user) throw new Error(`Backfill user not found: ${userEmail}`);
  const candidates = await prisma.agentBuildSession.findMany({
    where: {
      ...(user ? { userId: user.id } : {}),
      abandonedAt: null,
      status: 'DISCOVERY',
      externalSource: { not: null },
      agentId: null,
      builtAgentId: null,
      OR: [{ strategy: null }, { strategy: 'create' }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, brief: true, externalConversationTitle: true },
  });
  const rows = candidates.filter((row) => {
    if (!namePrefix) return true;
    const brief = row.brief && typeof row.brief === 'object' && !Array.isArray(row.brief)
      ? row.brief as Record<string, unknown>
      : {};
    const name = typeof brief.requestedAgentName === 'string'
      ? brief.requestedAgentName
      : row.externalConversationTitle ?? '';
    return name.startsWith(namePrefix);
  });
  let created = 0;
  let skipped = 0;
  const results = [];
  for (const row of rows) {
    const result = await ensureBuilderWorkingAgent(row.id);
    if (result.created) {
      created += 1;
      await audit(row.userId, 'agent_builder.working_agent_backfilled', 'Agent', result.agentId!, {
        sessionId: row.id,
        status: 'ACTIVE',
        leastPrivilege: true,
      });
      hub.publish('agent.status', { id: result.agentId, status: 'ACTIVE', event: 'created' });
    } else skipped += 1;
    results.push(result);
  }
  console.log(JSON.stringify({ scanned: candidates.length, candidates: rows.length, created, skipped, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
