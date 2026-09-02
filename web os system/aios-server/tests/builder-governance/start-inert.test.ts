/**
 * Builder start-path governance: MEMBER starts stay inert.
 *
 * Internal and external create must write a DISCOVERY AgentBuildSession
 * with null create bindings and zero Agent rows. External retry is
 * idempotent. No paid CLI, no evolution worker.
 *
 * Run from `web os system/aios-server/`:
 *   npx tsx tests/builder-governance/start-inert.test.ts
 */
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { createBuilderSession } from '../../src/lib/agentbuilder.ts';
import { createExternalBuilderSession } from '../../src/lib/externalagentbuilder.ts';

const TEST_PREFIX = 'gov-start-inert-';
const originalQueue = process.env.AIOS_BUILDER_EVOLUTION_QUEUE;
const originalAdaptive = process.env.AIOS_BUILDER_ADAPTIVE_MODEL;
process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    });
}

async function createMember() {
  const id = ulid();
  return prisma.user.create({
    data: {
      id,
      email: `${TEST_PREFIX}${id.slice(-8)}@test.local`,
      displayName: 'Start Inert MEMBER',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });
}

async function agentsOwnedBy(userId: string) {
  return prisma.agent.findMany({
    where: { createdBy: userId },
    select: {
      id: true,
      name: true,
      status: true,
      rolePrompt: true,
      restrictions: true,
      updatedAt: true,
    },
  });
}

function assertNullCreateBindings(row: {
  agentId: string | null;
  targetAgentId: string | null;
  builtAgentId: string | null;
}, label: string): void {
  assert.equal(row.agentId, null, `${label} agentId`);
  assert.equal(row.targetAgentId, null, `${label} targetAgentId`);
  assert.equal(row.builtAgentId, null, `${label} builtAgentId`);
}

async function cleanupUser(userId: string): Promise<void> {
  const sessions = await prisma.agentBuildSession.findMany({
    where: { userId },
    select: { id: true },
  });
  const sessionIds = sessions.map((row) => row.id);
  if (sessionIds.length) {
    await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
  }
  await prisma.agentBuilderWorkspace.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { createdBy: userId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
}

async function sweepLeftovers(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  for (const user of users) await cleanupUser(user.id);
}

await sweepLeftovers();

try {
  await test('internal MEMBER start creates DISCOVERY session with zero Agent rows', async () => {
    const member = await createMember();
    try {
      const before = await agentsOwnedBy(member.id);
      const result = await createBuilderSession({
        userId: member.id,
        message: '我想做一個只整理對帳草稿的員工，不要寄信',
      });
      const row = await prisma.agentBuildSession.findUnique({ where: { id: result.session.id } });
      assert.ok(row, 'session row missing');
      assert.equal(result.status, 'DISCOVERY');
      assert.equal(result.session.status, 'DISCOVERY');
      assert.equal(row!.status, 'DISCOVERY');
      assertNullCreateBindings(result.session, 'dto');
      assertNullCreateBindings(row!, 'db');
      const after = await agentsOwnedBy(member.id);
      assert.equal(after.length, before.length, 'start path created Agent rows');
      assert.equal(after.length, 0);
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('external MEMBER create start is DISCOVERY with null bindings and zero Agent rows', async () => {
    const member = await createMember();
    try {
      const conversationId = `${TEST_PREFIX}conv-${ulid()}`;
      const result = await createExternalBuilderSession({
        userId: member.id,
        source: 'CLAUDE_CODE',
        initialRequest: '幫我建立一位整理帳款草稿的員工',
        externalConversationId: conversationId,
      });
      assert.equal(result.deduplicated, false);
      assert.equal(result.session.status, 'DISCOVERY');
      assertNullCreateBindings(result.session, 'dto');
      const row = await prisma.agentBuildSession.findUnique({ where: { id: result.session.id } });
      assert.ok(row, 'session row missing');
      assert.equal(row!.status, 'DISCOVERY');
      assertNullCreateBindings(row!, 'db');
      assert.equal(row!.strategy, 'create');
      const owned = await agentsOwnedBy(member.id);
      assert.equal(owned.length, 0);
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('external MEMBER create retry stays idempotent and still creates zero Agent rows', async () => {
    const member = await createMember();
    try {
      const conversationId = `${TEST_PREFIX}retry-${ulid()}`;
      const first = await createExternalBuilderSession({
        userId: member.id,
        source: 'CHATGPT',
        initialRequest: '請幫我規劃一位報價單員工',
        externalConversationId: conversationId,
      });
      const second = await createExternalBuilderSession({
        userId: member.id,
        source: 'CHATGPT',
        initialRequest: '請幫我規劃一位報價單員工（重送）',
        externalConversationId: conversationId,
      });
      assert.equal(first.deduplicated, false);
      assert.equal(second.deduplicated, true);
      assert.equal(second.session.id, first.session.id);
      assert.equal(second.session.status, 'DISCOVERY');
      assertNullCreateBindings(second.session, 'retry dto');
      const sessions = await prisma.agentBuildSession.findMany({
        where: { userId: member.id, externalConversationId: conversationId },
      });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.status, 'DISCOVERY');
      assertNullCreateBindings(sessions[0]!, 'retry db');
      const owned = await agentsOwnedBy(member.id);
      assert.equal(owned.length, 0);
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('external reuse binds the existing Agent without mutating or creating rows', async () => {
    const member = await createMember();
    const agentId = ulid();
    try {
      await prisma.agent.create({
        data: {
          id: agentId,
          slug: `${TEST_PREFIX}${agentId.slice(-8)}`.toLowerCase(),
          name: '既有對帳員工',
          description: 'reuse 綁定用，開始路徑不得改這列',
          department: '財務',
          rolePrompt: '整理對帳草稿，不得寄信。',
          engineExecute: 'CLAUDE_CODE',
          restrictions: { webSearch: false, sendEmail: false, shell: false },
          riskTier: 'medium',
          status: 'PAUSED',
          createdBy: member.id,
        },
      });
      const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const result = await createExternalBuilderSession({
        userId: member.id,
        source: 'CURSOR',
        initialRequest: '幫這位既有員工補一個對帳技能',
        externalConversationId: `${TEST_PREFIX}reuse-${ulid()}`,
        targetAgentId: agentId,
      });
      assert.equal(result.session.status, 'DISCOVERY');
      assert.equal(result.session.strategy, 'reuse');
      assert.equal(result.session.agentId, agentId);
      assert.equal(result.session.targetAgentId, agentId);
      assert.equal(result.session.builtAgentId, null);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.equal(after.status, before.status);
      assert.equal(after.name, before.name);
      assert.equal(after.rolePrompt, before.rolePrompt);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
      const owned = await agentsOwnedBy(member.id);
      assert.equal(owned.length, 1);
      assert.equal(owned[0]!.id, agentId);
    } finally {
      await cleanupUser(member.id);
    }
  });
} finally {
  await sweepLeftovers();
  if (originalQueue === undefined) delete process.env.AIOS_BUILDER_EVOLUTION_QUEUE;
  else process.env.AIOS_BUILDER_EVOLUTION_QUEUE = originalQueue;
  if (originalAdaptive === undefined) delete process.env.AIOS_BUILDER_ADAPTIVE_MODEL;
  else process.env.AIOS_BUILDER_ADAPTIVE_MODEL = originalAdaptive;
  await disconnectDb();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
