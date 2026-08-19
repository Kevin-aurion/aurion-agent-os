/**
 * Workbench audit — conversation privacy (fail-closed).
 * Run: npx tsx .scratch/agent-workbench/tests/conversation-privacy.test.ts
 *
 * - List conversations only for req.user.sub
 * - GET/POST messages reject non-owner (404, no leak)
 * - sendMessage path enforces userId (shared by REST + WS chat.send)
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { conversationRoutes } from '../../../src/routes/conversations.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  console.log('── conversation privacy ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER');

  let memberA = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdA: string | null = null;
  if (!memberA) {
    createdA = ulid();
    memberA = await prisma.user.create({
      data: {
        id: createdA,
        email: `wb-priv-a-${createdA.slice(-6)}@test.local`,
        displayName: 'WB Priv A',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const memberBId = ulid();
  const memberB = await prisma.user.create({
    data: {
      id: memberBId,
      email: `wb-priv-b-${memberBId.slice(-6)}@test.local`,
      displayName: 'WB Priv B',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const convAId = ulid();
  const msgId = ulid();

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400) {
      return reply.code(anyErr.statusCode).send({
        success: false,
        error: { code: anyErr.code ?? 'ERROR', message: anyErr.message ?? 'error' },
      });
    }
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(conversationRoutes);

  const tokenA = await signAccess({ sub: memberA.id, email: memberA.email, role: 'MEMBER' });
  const tokenB = await signAccess({ sub: memberB.id, email: memberB.email, role: 'MEMBER' });
  const authA = { authorization: `Bearer ${tokenA}` };
  const authB = { authorization: `Bearer ${tokenB}` };

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `wb-priv-${tag}`,
        name: 'WB Privacy Agent',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
      },
    });

    await prisma.conversation.create({
      data: {
        id: convAId,
        agentId,
        userId: memberA.id,
        title: 'A private thread',
      },
    });
    await prisma.message.create({
      data: {
        id: msgId,
        conversationId: convAId,
        role: 'USER',
        content: 'secret from A',
      },
    });

    // ── [1] Owner A lists own conversation ───────────────────────────────
    console.log('\n── [1] owner lists own threads ──');
    const listA = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/conversations`,
      headers: authA,
    });
    assert(listA.statusCode === 200, `list A expected 200, got ${listA.statusCode}`);
    const bodyA = JSON.parse(listA.body);
    assert(bodyA.success === true, 'success');
    assert(Array.isArray(bodyA.data), 'data array');
    assert(
      bodyA.data.some((c: { id: string }) => c.id === convAId),
      'A must see own conversation',
    );
    console.log('PASS [1]');

    // ── [2] Negative: B list must not include A's thread ─────────────────
    console.log('\n── [2] negative: other user list excludes foreign thread ──');
    const listB = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/conversations`,
      headers: authB,
    });
    assert(listB.statusCode === 200, `list B expected 200, got ${listB.statusCode}`);
    const bodyB = JSON.parse(listB.body);
    assert(bodyB.success === true, 'success');
    assert(
      !bodyB.data.some((c: { id: string }) => c.id === convAId),
      'B must NOT see A conversation',
    );
    console.log('PASS [2]');

    // ── [3] Negative: B cannot read messages ─────────────────────────────
    console.log('\n── [3] negative: other user GET messages → 404 ──');
    const getB = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convAId}/messages`,
      headers: authB,
    });
    console.log('GET messages as B:', getB.statusCode, getB.body.slice(0, 200));
    assert(getB.statusCode === 404, `expected 404, got ${getB.statusCode}`);
    const getBBody = JSON.parse(getB.body);
    assert(getBBody.success === false, 'success false');
    // Must not leak message content
    assert(!getB.body.includes('secret from A'), 'must not leak content');
    console.log('PASS [3]');

    // ── [4] Negative: B cannot POST messages ─────────────────────────────
    console.log('\n── [4] negative: other user POST messages → 404 ──');
    const postB = await app.inject({
      method: 'POST',
      url: `/api/conversations/${convAId}/messages`,
      headers: authB,
      payload: { content: 'hijack attempt' },
    });
    console.log('POST messages as B:', postB.statusCode, postB.body.slice(0, 200));
    assert(postB.statusCode === 404, `expected 404, got ${postB.statusCode}`);
    const hijackMsg = await prisma.message.findFirst({
      where: { conversationId: convAId, content: 'hijack attempt' },
    });
    assert(!hijackMsg, 'must not persist hijacked message');
    console.log('PASS [4]');

    // ── [5] Owner A can still read ────────────────────────────────────────
    console.log('\n── [5] owner GET messages ok ──');
    const getA = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convAId}/messages`,
      headers: authA,
    });
    assert(getA.statusCode === 200, `expected 200, got ${getA.statusCode}`);
    const getABody = JSON.parse(getA.body);
    assert(
      getABody.data.some((m: { content: string }) => m.content === 'secret from A'),
      'owner sees message',
    );
    console.log('PASS [5]');

    console.log('\n✅ conversation-privacy: all passed');
  } finally {
    await app.close();
    await prisma.message.deleteMany({ where: { conversationId: convAId } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: convAId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: memberBId } }).catch(() => {});
    if (createdA) await prisma.user.deleteMany({ where: { id: createdA } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
