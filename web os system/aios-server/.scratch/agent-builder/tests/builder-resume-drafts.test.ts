/**
 * Agent Builder chooser + cross-device draft acceptance/negative tests.
 * Run: npx tsx .scratch/agent-builder/tests/builder-resume-drafts.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { agentBuilderRoutes } from '../../../src/routes/agentbuilder.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

type Draft = { reply: string; testData: string; testExpected: string };
type SessionRow = { id: string; status: string; draftState: Draft };
type Success<T> = { success: true; data: T };

async function main() {
  const suffix = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const foreignId = ulid();
  const discoveryId = ulid();
  const testingId = ulid();
  const activeId = ulid();

  await prisma.user.createMany({
    data: [
      {
        id: ownerId,
        email: `builder-owner-${suffix}@test.local`,
        displayName: 'Builder Owner',
        passwordHash: 'not-used',
        role: 'MEMBER',
      },
      {
        id: foreignId,
        email: `builder-foreign-${suffix}@test.local`,
        displayName: 'Builder Foreign',
        passwordHash: 'not-used',
        role: 'MEMBER',
      },
    ],
  });

  await prisma.agentBuildSession.createMany({
    data: [
      {
        id: discoveryId,
        userId: ownerId,
        status: 'DISCOVERY',
        transcript: [],
        brief: { objective: '第一筆未完成員工' },
        draftState: { reply: '還沒送出的補充', testData: '', testExpected: '' },
      },
      {
        id: testingId,
        userId: ownerId,
        status: 'AWAITING_TEST_DATA',
        transcript: [],
        brief: { objective: '第二筆等待測試員工' },
      },
      {
        id: activeId,
        userId: ownerId,
        status: 'ACTIVE',
        transcript: [],
        brief: { objective: '已完成員工' },
      },
    ],
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message },
      });
    }
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL', message: String(error) },
    });
  });
  await app.register(agentBuilderRoutes);

  const ownerToken = await signAccess({
    sub: ownerId,
    email: `builder-owner-${suffix}@test.local`,
    role: 'MEMBER',
  });
  const foreignToken = await signAccess({
    sub: foreignId,
    email: `builder-foreign-${suffix}@test.local`,
    role: 'MEMBER',
  });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  try {
    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/agent-builder/sessions',
      headers: auth(ownerToken),
    });
    assert(listResponse.statusCode === 200, 'chooser list should load');
    const listed = (listResponse.json() as Success<SessionRow[]>).data;
    assert(listed.length === 3, 'chooser includes unfinished sessions and active employees available for continued training');
    assert(listed.some((row) => row.id === discoveryId), 'DISCOVERY appears in chooser');
    assert(listed.some((row) => row.id === testingId), 'AWAITING_TEST_DATA appears in chooser');
    assert(listed.some((row) => row.id === activeId), 'ACTIVE remains available for continued training');
    assert(
      listed.find((row) => row.id === discoveryId)?.draftState.reply === '還沒送出的補充',
      'chooser advertises the existing unsent session draft',
    );

    const newDraftResponse = await app.inject({
      method: 'PUT',
      url: '/api/agent-builder/draft',
      headers: { ...auth(ownerToken), 'content-type': 'application/json' },
      payload: {
        reply: '寄給 finance@example.com，api_key=sk-abcdefghijklmnopqrstuvwxyz012345',
        testData: '',
        testExpected: '',
      },
    });
    assert(newDraftResponse.statusCode === 200, 'new-flow draft saves');
    const newDraft = (newDraftResponse.json() as Success<Draft>).data;
    assert(!newDraft.reply.includes('finance@example.com'), 'new draft email is redacted');
    assert(!newDraft.reply.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'new draft key is redacted');

    const restoredNewResponse = await app.inject({
      method: 'GET',
      url: '/api/agent-builder/draft',
      headers: auth(ownerToken),
    });
    const restoredNew = (restoredNewResponse.json() as Success<Draft>).data;
    assert(restoredNew.reply === newDraft.reply, 'new-flow draft restores from the account workspace');

    const sessionDraftResponse = await app.inject({
      method: 'PUT',
      url: '/api/agent-builder/draft',
      headers: { ...auth(ownerToken), 'content-type': 'application/json' },
      payload: {
        sessionId: testingId,
        reply: '測試前補充',
        testData: '客戶信箱 ceo@example.com',
        testExpected: '輸出清單',
      },
    });
    assert(sessionDraftResponse.statusCode === 200, 'existing-session draft saves');
    const sessionDraft = (sessionDraftResponse.json() as Success<Draft>).data;
    assert(sessionDraft.reply === '測試前補充', 'reply survives round-trip');
    assert(!sessionDraft.testData.includes('ceo@example.com'), 'test draft email is redacted');

    const restoredSessionResponse = await app.inject({
      method: 'GET',
      url: `/api/agent-builder/draft?sessionId=${testingId}`,
      headers: auth(ownerToken),
    });
    assert(restoredSessionResponse.statusCode === 200, 'session draft restores');
    const restoredSession = (restoredSessionResponse.json() as Success<Draft>).data;
    assert(restoredSession.reply === sessionDraft.reply, 'restored reply matches saved reply');
    assert(restoredSession.testData === sessionDraft.testData, 'restored test data matches redacted save');

    const foreignWrite = await app.inject({
      method: 'PUT',
      url: '/api/agent-builder/draft',
      headers: { ...auth(foreignToken), 'content-type': 'application/json' },
      payload: {
        sessionId: testingId,
        reply: '越權修改',
        testData: '',
        testExpected: '',
      },
    });
    assert(foreignWrite.statusCode === 404, 'foreign user cannot overwrite another user draft');

    const foreignRead = await app.inject({
      method: 'GET',
      url: `/api/agent-builder/draft?sessionId=${testingId}`,
      headers: auth(foreignToken),
    });
    assert(foreignRead.statusCode === 404, 'foreign user cannot read another user draft');

    const activeWrite = await app.inject({
      method: 'PUT',
      url: '/api/agent-builder/draft',
      headers: { ...auth(ownerToken), 'content-type': 'application/json' },
      payload: {
        sessionId: activeId,
        reply: '明天想繼續教它一個新做法',
        testData: '',
        testExpected: '',
      },
    });
    assert(activeWrite.statusCode === 200, 'ACTIVE session accepts a draft for continued training');

    console.log('✓ explicit unfinished-session chooser');
    console.log('✓ cross-device new/session draft restore');
    console.log('✓ redaction + ownership + ACTIVE continued-training drafts');
  } finally {
    await app.close();
    await prisma.agentBuildSession.deleteMany({
      where: { id: { in: [discoveryId, testingId, activeId] } },
    });
    await prisma.agentBuilderWorkspace.deleteMany({
      where: { userId: { in: [ownerId, foreignId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, foreignId] } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
