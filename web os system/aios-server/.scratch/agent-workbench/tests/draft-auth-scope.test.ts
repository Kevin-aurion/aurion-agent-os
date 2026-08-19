/**
 * Workbench audit — draft capture auth + skillId agent scope.
 * Run: npx tsx .scratch/agent-workbench/tests/draft-auth-scope.test.ts
 *
 * - train/message, voice, recording start: requireAuth (MEMBER allowed past guard)
 * - skillId update must be linked to the route agent (cannot edit foreign draft)
 * - skill confirm remains requireTrainer
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { draftSkillFromMessage } from '../../../src/lib/skilltraining.js';
import { trainingRoutes } from '../../../src/routes/training.js';
import { recordingRoutes } from '../../../src/routes/recording.js';
import { skillRoutes } from '../../../src/routes/skills.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<Error> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ASSERT FAIL: expected throw')) throw e;
    return e as Error;
  }
}

async function main() {
  console.log('── draft auth + skillId scope ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need FDE');

  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMember: string | null = null;
  if (!member) {
    createdMember = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMember,
        email: `wb-da-${createdMember.slice(-6)}@test.local`,
        displayName: 'WB DA Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentA = ulid();
  const agentB = ulid();
  const skillOnA = ulid();
  const skillIds = [skillOnA];
  const agentIds = [agentA, agentB];

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
  await app.register(trainingRoutes);
  await app.register(recordingRoutes);
  await app.register(skillRoutes);

  const memberToken = await signAccess({
    sub: member.id,
    email: member.email,
    role: 'MEMBER',
  });
  const trainerToken = await signAccess({
    sub: owner.id,
    email: owner.email,
    role: owner.role,
  });

  try {
    await prisma.agent.create({
      data: {
        id: agentA,
        slug: `wb-da-a-${tag}`,
        name: 'WB DA Agent A',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
      },
    });
    await prisma.agent.create({
      data: {
        id: agentB,
        slug: `wb-da-b-${tag}`,
        name: 'WB DA Agent B',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillOnA,
        slug: `wb-da-sk-${tag}`,
        name: 'Draft on A',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# original on A\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
    await prisma.agentSkill.create({
      data: { agentId: agentA, skillId: skillOnA },
    });

    // ── [1] MEMBER can hit train/message auth (not 401/403) ───────────────
    // We do not assert full draft success (Claude may be offline / slow); only guard.
    // Use invalid empty body → 400 from zod, not 403.
    console.log('\n── [1] MEMBER train/message past requireAuth ──');
    const rTrainUnauth = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentA}/train/message`,
      payload: { message: 'x' },
    });
    assert(rTrainUnauth.statusCode === 401, `unauth expected 401, got ${rTrainUnauth.statusCode}`);

    const rTrainMember = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentA}/train/message`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {}, // missing message → 400, not 403
    });
    console.log('MEMBER train empty body:', rTrainMember.statusCode, rTrainMember.body.slice(0, 160));
    assert(rTrainMember.statusCode === 400, `missing message expected 400, got ${rTrainMember.statusCode}`);
    console.log('PASS [1]');

    // ── [2] recording start unauth 401; MEMBER not 403 ────────────────────
    // Do not call start for real (MCP). Check unauth only + status for MEMBER.
    console.log('\n── [2] recording requireAuth ──');
    const rStartUnauth = await app.inject({ method: 'POST', url: '/api/recording/start' });
    assert(rStartUnauth.statusCode === 401, `start unauth 401, got ${rStartUnauth.statusCode}`);
    const rStatusMember = await app.inject({
      method: 'GET',
      url: '/api/recording/status',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(rStatusMember.statusCode !== 403, 'MEMBER status not forbidden');
    console.log('PASS [2]');

    // No user may stop an unowned host-global recording or inject arbitrary
    // local recording paths into the Codex synthesis prompt.
    console.log('\n── [2b] recording ownership + path trust boundary ──');
    const rStopUnowned = await app.inject({
      method: 'POST',
      url: '/api/recording/stop',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(rStopUnowned.statusCode === 409, `unowned stop expected 409, got ${rStopUnowned.statusCode}`);

    const rInjectedPaths = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentA}/recording/to-skill`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { metadataPath: '/etc/passwd', eventsPath: '/tmp/foreign-events.jsonl' },
    });
    assert(rInjectedPaths.statusCode === 400, `path injection expected 400, got ${rInjectedPaths.statusCode}`);
    assert(!rInjectedPaths.body.includes('/etc/passwd'), 'response must not echo injected path');
    const rInvalidSession = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentA}/recording/to-skill`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { sessionId: '../../foreign-session', hint: 'x' },
    });
    assert(rInvalidSession.statusCode === 400, `invalid opaque session id expected 400, got ${rInvalidSession.statusCode}`);
    assert(!rInvalidSession.body.includes('../../foreign-session'), 'response must not echo invalid session id');
    console.log('PASS [2b]');

    // ── [3] skillId foreign agent → forbidden ────────────────────────────
    console.log('\n── [3] skillId not scoped to agent → fail-closed ──');
    const errScope = await expectThrow(
      () =>
        draftSkillFromMessage({
          agentId: agentB,
          message: 'try to overwrite foreign draft',
          skillId: skillOnA,
          createdBy: member.id,
        }),
      'foreign skillId',
    );
    assert(errScope instanceof ApiError, 'ApiError');
    assert(
      (errScope as ApiError).statusCode === 403 || (errScope as ApiError).statusCode === 400,
      `expected 403/400, got ${(errScope as ApiError).statusCode}`,
    );
    const unchanged = await prisma.skill.findUnique({ where: { id: skillOnA } });
    assert(unchanged?.contentMd === '# original on A\n', 'foreign draft content unchanged');
    console.log('PASS [3] skillId scope');

    // ── [4] skill confirm remains trainer-only ───────────────────────────
    console.log('\n── [4] skill confirm requireTrainer ──');
    const rConfirmMember = await app.inject({
      method: 'POST',
      url: `/api/skills/${skillOnA}/confirm`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(rConfirmMember.statusCode === 403, `confirm member expected 403, got ${rConfirmMember.statusCode}`);

    const rConfirmTrainer = await app.inject({
      method: 'POST',
      url: `/api/skills/${skillOnA}/confirm`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    console.log('trainer confirm:', rConfirmTrainer.statusCode, rConfirmTrainer.body.slice(0, 200));
    assert(rConfirmTrainer.statusCode === 200, `trainer confirm 200, got ${rConfirmTrainer.statusCode}`);
    const confirmed = await prisma.skill.findUnique({ where: { id: skillOnA } });
    assert(confirmed?.reviewStatus === 'CONFIRMED', 'CONFIRMED');
    console.log('PASS [4]');

    console.log('\n✅ draft-auth-scope: all passed');
  } finally {
    await app.close();
    await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { id: { in: skillIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
    if (createdMember) await prisma.user.deleteMany({ where: { id: createdMember } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
