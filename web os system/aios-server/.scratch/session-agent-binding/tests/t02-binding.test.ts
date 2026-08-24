/**
 * Session-agent binding — two-phase key, unique indexes, resume, backfill.
 *
 * Run: npx tsx .scratch/session-agent-binding/tests/t02-binding.test.ts
 *
 * Seams: resolveBuilderSession, createExternalBuilderSession,
 * assertBuilderAgentBindingAvailable, listBuilderSessions, Prisma unique indexes.
 */
process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

import { Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  assertBuilderAgentBindingAvailable,
  listBuilderSessions,
} from '../../../src/lib/agentbuilder.js';
import {
  createExternalBuilderSession,
  resolveBuilderSession,
} from '../../../src/lib/externalagentbuilder.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<Error> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ASSERT FAIL: expected throw')) throw error;
    return error as Error;
  }
}

const tag = ulid().slice(-10).toLowerCase();
const userId = ulid();
const agentId = ulid();
const sessionIds: string[] = [];

try {
  console.log('── session-agent-binding acceptance ──');

  await prisma.user.create({
    data: {
      id: userId,
      email: `bind-${tag}@test.local`,
      displayName: 'Binding Test',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `bind-agent-${tag}`,
      name: 'Binding 測試員工',
      description: 'session-agent-binding fixture',
      department: '測試',
      rolePrompt: '測試用員工，不得對外生效。',
      createdBy: userId,
      status: 'PAUSED',
    },
  });

  // 3. Same agent resumes the bound session.
  const first = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_CODE',
    initialRequest: '建立一位 Binding 測試員工並訓練既有流程。',
    externalConversationId: `conv-a-${tag}`,
    externalConversationTitle: 'binding-a',
    agentId,
  });
  sessionIds.push(first.session.id);
  assert(first.deduplicated === false, 'first create must insert');
  assert(first.session.agentId === agentId, `session.agentId ${first.session.agentId} != ${agentId}`);
  assert(first.session.targetAgentId === agentId, 'start with agentId should reuse-bind targetAgentId');

  const resolved = await resolveBuilderSession({ userId, agentId });
  assert(resolved != null, 'resolveBuilderSession by agentId must find the session');
  assert(resolved.id === first.session.id, `resolve returned ${resolved.id}, expected ${first.session.id}`);

  // 4. Different conversation, same agent → still the same session.
  const second = await createExternalBuilderSession({
    userId,
    source: 'CURSOR',
    initialRequest: '繼續訓練同一位 Binding 測試員工，這是另一段對話。',
    externalConversationId: `conv-b-${tag}`,
    agentId,
  });
  assert(second.deduplicated === true, 'second create for same agent must resume');
  assert(second.session.id === first.session.id, `different conversation opened ${second.session.id}`);

  const listed = await listBuilderSessions({ userId });
  assert(listed.length >= 1, 'listBuilderSessions should include the bound session');
  assert(listed.some((row) => row.id === first.session.id && row.agentId === agentId), 'list DTO must expose agentId');
  assert(listed.every((row) => row.status !== 'ABANDONED'), 'list must keep excluding ABANDONED');

  // Application-level bind conflict (do not silently steal the agent).
  const stray = await createExternalBuilderSession({
    userId,
    source: 'CHATGPT',
    initialRequest: '另外建立一段無關的建置對話。',
    externalConversationId: `conv-stray-${tag}`,
  });
  sessionIds.push(stray.session.id);
  const bindErr = await expectThrow(
    () => assertBuilderAgentBindingAvailable({ userId, agentId, exceptSessionId: stray.session.id }),
    'assertBuilderAgentBindingAvailable',
  );
  assert(bindErr instanceof ApiError, 'bind conflict must be ApiError');
  assert((bindErr as ApiError).statusCode === 400, `status ${(bindErr as ApiError).statusCode}`);
  assert(
    bindErr.message.includes(first.session.id),
    `conflict message must include existing session id, got: ${bindErr.message}`,
  );

  // 5. Unique index rejects a second non-ABANDONED row for the same (userId, agentId).
  const dupId = ulid();
  sessionIds.push(dupId);
  const dupErr = await expectThrow(
    () => prisma.agentBuildSession.create({
      data: {
        id: dupId,
        userId,
        status: 'DISCOVERY',
        agentId,
        transcript: [],
        brief: { objective: 'duplicate bind' },
      },
    }),
    'partial unique index',
  );
  assert(
    dupErr instanceof Prisma.PrismaClientKnownRequestError && dupErr.code === 'P2002',
    `expected P2002, got ${dupErr.name} ${(dupErr as Prisma.PrismaClientKnownRequestError).code ?? dupErr.message}`,
  );

  // 6. ABANDONED does not block a new bind for the same agent.
  await prisma.agentBuildSession.update({
    where: { id: first.session.id },
    data: { status: 'ABANDONED', abandonedAt: new Date() },
  });
  const resumed = await resolveBuilderSession({ userId, agentId });
  assert(resumed == null, 'ABANDONED session must not be resolved');

  const replacement = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_DESKTOP',
    initialRequest: '先前建置已捨棄，重新訓練同一位 Binding 測試員工。',
    externalConversationId: `conv-c-${tag}`,
    agentId,
  });
  sessionIds.push(replacement.session.id);
  assert(replacement.deduplicated === false, 'after abandon, a new session must be created');
  assert(replacement.session.id !== first.session.id, 'replacement must be a new session');
  assert(replacement.session.agentId === agentId, 'replacement must bind agentId');

  // 2. Backfill: existing sessions copied brief.externalConversationId onto the column.
  const hank = await prisma.user.findFirst({
    where: { email: 'hank@aurion-group.com' },
    select: { id: true },
  });
  assert(hank, 'Hank fixture user');
  const hankSessions = await prisma.agentBuildSession.findMany({
    where: { userId: hank.id },
    select: { id: true, externalConversationId: true, externalSource: true, brief: true, status: true },
  });
  const withBriefExt = hankSessions.filter((row) => {
    const brief = row.brief && typeof row.brief === 'object' && !Array.isArray(row.brief)
      ? row.brief as Record<string, unknown>
      : {};
    return typeof brief.externalConversationId === 'string' && brief.externalConversationId.length > 0;
  });
  assert(withBriefExt.length > 0, 'Hank should have brief.externalConversationId samples');
  for (const row of withBriefExt) {
    const brief = row.brief as Record<string, unknown>;
    assert(
      row.externalConversationId === brief.externalConversationId,
      `backfill mismatch ${row.id}: column=${row.externalConversationId} brief=${String(brief.externalConversationId)}`,
    );
    assert(row.externalSource === 'CLAUDE_CODE' || row.externalSource === brief.externalSource, `source ${row.id}`);
  }

  const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'AgentBuildSession'
      AND indexname IN (
        'AgentBuildSession_external_binding_key',
        'AgentBuildSession_user_agent_active_key'
      )
  `;
  assert(indexes.length === 2, `expected both unique indexes, got ${indexes.map((row) => row.indexname).join(',')}`);

  // 8. Skills still wait for FDE confirmation; abandon exclusion still in list.
  const source = await readFile(path.join(SERVER_ROOT, 'src/lib/agentbuilder.ts'), 'utf8');
  assert(
    source.includes("reviewStatus: 'AWAITING_USER_CONFIRM'"),
    'createInertSkillDraft must still persist AWAITING_USER_CONFIRM',
  );
  const hankList = await listBuilderSessions({ userId: hank.id });
  assert(hankList.every((row) => row.status !== 'ABANDONED'), 'Hank list must exclude ABANDONED');
  assert(hankList.every((row) => 'agentId' in row), 'list DTO includes agentId');

  console.log(JSON.stringify({
    passed: true,
    firstSessionId: first.session.id,
    replacementSessionId: replacement.session.id,
    hankBackfillChecked: withBriefExt.length,
    uniqueIndexes: indexes.map((row) => row.indexname),
  }, null, 2));
} finally {
  await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
}
