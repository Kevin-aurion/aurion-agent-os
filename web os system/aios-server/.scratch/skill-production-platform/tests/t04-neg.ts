/**
 * Ticket 04 — negative auth / idempotency / path-trust for RecordingService.
 * Run: npx tsx .scratch/skill-production-platform/tests/t04-neg.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  RecordingService,
  type RecordingDeps,
} from '../../../src/lib/recording.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<unknown> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ASSERT FAIL: expected throw')) throw e;
    return e;
  }
}

async function main() {
  const userA = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(userA, 'need OWNER/TRAINER userA in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const userBId = ulid();
  let createdUserB = false;

  let stopCalls = 0;
  let buildCalls = 0;
  let lastBuildMeta: string | undefined;
  let lastBuildEvents: string | undefined;

  const fakeMeta = '/tmp/fake/session.json';
  const fakeEvents = '/tmp/fake/events.jsonl';

  const fakeDeps: RecordingDeps = {
    startRecording: async () => ({ sessionActive: true, raw: {} }),
    recordingStatus: async () => ({ status: 'recording' }),
    stopRecording: async () => {
      stopCalls += 1;
      return { metadataPath: fakeMeta, eventsPath: fakeEvents, raw: {} };
    },
    buildSkillFromRecording: async (args) => {
      buildCalls += 1;
      lastBuildMeta = args.metadataPath;
      lastBuildEvents = args.eventsPath;
      const skillId = ulid();
      const slug = `t04-neg-${tag}-${skillId.slice(-6).toLowerCase()}`;
      await prisma.skill.create({
        data: {
          id: skillId,
          slug,
          name: `T04 Neg Skill ${tag}`,
          origin: 'RECORDED',
          kind: 'COMPUTER_CONTROL',
          contentMd: '---\nname: t04-neg\n---\n# Draft\n',
          generator: 'record-and-replay',
          reviewStatus: 'AWAITING_USER_CONFIRM',
          executionEnv: 'DESKTOP_APP',
        },
      });
      await prisma.agentSkill.upsert({
        where: { agentId_skillId: { agentId: args.agentId, skillId } },
        create: { agentId: args.agentId, skillId },
        update: {},
      });
      return { skillId, reviewStatus: 'AWAITING_USER_CONFIRM' };
    },
  };

  console.log('── setup agent + userB ──');
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `t04-neg-${tag}`,
      name: 'T04 Neg Agent',
      description: 'neg test',
      rolePrompt: 'test',
      engineExecute: 'CODEX',
      restrictions: {
        webSearch: false,
        computerUse: true,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
      riskTier: 'low',
      createdBy: userA.id,
    },
  });

  // Prefer an existing different user; else create a throwaway MEMBER.
  let userB = await prisma.user.findFirst({
    where: { deletedAt: null, id: { not: userA.id } },
  });
  if (!userB) {
    await prisma.user.create({
      data: {
        id: userBId,
        email: `t04-neg-${tag}@test.local`,
        displayName: 'T04 Neg UserB',
        passwordHash: 'not-a-real-hash',
        role: 'MEMBER',
      },
    });
    createdUserB = true;
    userB = await prisma.user.findUniqueOrThrow({ where: { id: userBId } });
  }

  const svc = new RecordingService(fakeDeps);

  console.log('── userA start ──');
  const started = await svc.start(userA.id, agentId);
  const sessionId = started.sessionId;

  const wrongAgentStart = await expectThrow(
    () => svc.start(userA.id, ulid()),
    'same user switches agent during recording',
  );
  assert(wrongAgentStart instanceof ApiError, 'wrong-agent start is ApiError');
  assert((wrongAgentStart as ApiError).statusCode === 409, 'wrong-agent start fails closed');

  // ── auth: userB cannot stop / compile ──
  console.log('── auth forbidden ──');
  const stopErr = await expectThrow(
    () => svc.stop(userB!.id, sessionId),
    'userB stop',
  );
  assert(stopErr instanceof ApiError, `stop err is ApiError, got ${stopErr}`);
  assert(
    (stopErr as ApiError).statusCode === 403,
    `stop 403, got ${(stopErr as ApiError).statusCode}`,
  );

  // Stop as owner so we can test compile auth and idempotency
  const stop1 = await svc.stop(userA.id, sessionId);
  assert(stop1.artifactId, 'artifact after stop');
  const artifact1 = stop1.artifactId;

  const compileErr = await expectThrow(
    () => svc.compileToDraft(userB!.id, sessionId, agentId),
    'userB compile',
  );
  assert(compileErr instanceof ApiError, 'compile err is ApiError');
  assert(
    (compileErr as ApiError).statusCode === 403,
    `compile 403, got ${(compileErr as ApiError).statusCode}`,
  );

  const wrongAgentCompile = await expectThrow(
    () => svc.compileToDraft(userA.id, sessionId, ulid()),
    'compile recording into another agent',
  );
  assert(wrongAgentCompile instanceof ApiError, 'wrong-agent compile is ApiError');
  assert((wrongAgentCompile as ApiError).statusCode === 409, 'wrong-agent compile fails closed');

  // ── stop idempotency ──
  console.log('── stop idempotency ──');
  assert(stopCalls === 1, `stop calls before re-stop: ${stopCalls}`);
  const stop2 = await svc.stop(userA.id, sessionId);
  assert(stop2.artifactId === artifact1, 'same artifactId on second stop');
  assert(stopCalls === 1, `stopRecording still once after re-stop, got ${stopCalls}`);
  const rowAfterDoubleStop = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
  });
  assert(rowAfterDoubleStop!.artifactId === artifact1, 'DB artifactId unchanged');

  // ── path-trust: compile uses server-held paths only ──
  console.log('── path-trust + compile ──');
  // compileToDraft signature: (userId, sessionId, agentId, hint?) — no path param.
  const compiled1 = await svc.compileToDraft(userA.id, sessionId, agentId, 'no-path-here');
  assert(buildCalls === 1, `build once, got ${buildCalls}`);
  assert(lastBuildMeta === fakeMeta, `build used server meta path, got ${lastBuildMeta}`);
  assert(lastBuildEvents === fakeEvents, `build used server events path, got ${lastBuildEvents}`);
  assert(compiled1.reviewStatus === 'AWAITING_USER_CONFIRM', 'never CONFIRMED on compile');

  const skillCount1 = await prisma.skill.count({
    where: { agents: { some: { agentId } }, slug: { startsWith: `t04-neg-${tag}` } },
  });

  // ── compile idempotency ──
  console.log('── compile idempotency ──');
  const compiled2 = await svc.compileToDraft(userA.id, sessionId, agentId, 'second');
  assert(compiled2.skillId === compiled1.skillId, 'same skillId on re-compile');
  assert(buildCalls === 1, `build still once after re-compile, got ${buildCalls}`);
  const skillCount2 = await prisma.skill.count({
    where: { agents: { some: { agentId } }, slug: { startsWith: `t04-neg-${tag}` } },
  });
  assert(skillCount2 === skillCount1, `skill count unchanged ${skillCount1}→${skillCount2}`);

  // ── auto-confirm guard (lightweight) ──
  console.log('── auto-confirm guard ──');
  const skill = await prisma.skill.findUnique({ where: { id: compiled1.skillId } });
  assert(skill!.reviewStatus === 'AWAITING_USER_CONFIRM', 'skill stays AWAITING');
  assert(skill!.reviewStatus !== 'CONFIRMED', 'skill not CONFIRMED');
  const finalRow = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
  assert(finalRow!.status === 'RECORDED', 'session RECORDED');
  // Forcibly set CONFIRMED then re-compile — idempotent path returns existing skill without re-build
  await prisma.skill.update({
    where: { id: compiled1.skillId },
    data: { reviewStatus: 'CONFIRMED' },
  });
  const compiled3 = await svc.compileToDraft(userA.id, sessionId, agentId);
  assert(compiled3.skillId === compiled1.skillId, 'idempotent still same skill');
  assert(buildCalls === 1, 'no new build when skillId already set');
  // Note: compileToDraft itself never sets CONFIRMED; the forced update above is only for
  // proving re-entry does not re-run build. Reset for cleanup consistency.
  await prisma.skill.update({
    where: { id: compiled1.skillId },
    data: { reviewStatus: 'AWAITING_USER_CONFIRM' },
  });

  console.log('T04 NEG OK');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.recordingSession.deleteMany({
        where: {
          OR: [
            { metadataPath: { startsWith: '/tmp/fake/' } },
            { note: 'server restart' },
            { note: 'superseded by new recording' },
          ],
        },
      });
      const skills = await prisma.skill.findMany({
        where: { slug: { startsWith: 't04-neg-' } },
        select: { id: true },
      });
      const skillIds = skills.map((s) => s.id);
      if (skillIds.length) {
        await prisma.agentSkill.deleteMany({ where: { skillId: { in: skillIds } } });
        await prisma.skillVersion.deleteMany({ where: { skillId: { in: skillIds } } }).catch(() => {});
        await prisma.skill.deleteMany({ where: { id: { in: skillIds } } });
      }
      await prisma.agent.deleteMany({ where: { slug: { startsWith: 't04-neg-' } } });
      await prisma.user.deleteMany({
        where: { email: { startsWith: 't04-neg-' } },
      });
    } catch (e) {
      console.warn('cleanup warn', e);
    }
    await prisma.$disconnect();
    if (!process.exitCode) process.exit(0);
  });
