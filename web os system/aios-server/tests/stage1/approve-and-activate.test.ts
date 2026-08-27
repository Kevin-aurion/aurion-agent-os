/**
 * Stage-1 S1-1: approve-and-activate one-click pipeline.
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/stage1/approve-and-activate.test.ts
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { signAccess } from '../../src/lib/auth.ts';
import { ApiError, sendError } from '../../src/lib/http.ts';
import { paths } from '../../src/config.ts';
import { agentBuilderRoutes } from '../../src/routes/agentbuilder.ts';
import {
  approveAndActivate,
  authorizeBuilderSession,
  finalizeBuilderSession,
} from '../../src/lib/agentbuilder.ts';
import { setBuilderLessonRunAgentForTest } from '../../src/lib/builderlessons.ts';
import type { RunAgentOptions, RunOutcome } from '../../src/engine/types.ts';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';

setBuilderLessonRunAgentForTest(async (opts) => ({
  ok: true,
  runId: opts.runId ?? ulid(),
  runDir: '/tmp/s11-lesson',
  status: 'SUCCEEDED',
  results: [{
    ok: true,
    stepKey: 'do',
    type: 'DO',
    output: '{"candidates":[]}',
    rounds: 1,
    approved: true,
    records: [],
  }],
  reworkHistory: [],
}));

const TEST_PREFIX = 's11-aaa-';

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

function passOutcome(runId: string): RunOutcome {
  return {
    ok: true,
    runId,
    runDir: `/tmp/${runId}`,
    status: 'SUCCEEDED',
    results: [
      {
        ok: true,
        stepKey: 'chat',
        type: 'DO',
        output: 'ok',
        rounds: 1,
        approved: true,
        records: [{ round: 1, approved: true, verdict: 'APPROVED' }],
      },
    ],
    reworkHistory: [],
  };
}

function skippedVerifyOutcome(runId: string): RunOutcome {
  const out = passOutcome(runId);
  out.results[0]!.records = [
    { round: 1, approved: true, verdict: '(skipVerify: 對話模式不進行跨模型驗證)' },
  ];
  return out;
}

const TEXT_REQUIREMENT = {
  key: 'manual_input',
  label: '測試內容',
  description: '匿名化測試資料',
  kind: 'TEXT' as const,
  required: true,
  acceptedExtensions: [] as string[],
  minFiles: 0,
  maxFiles: 0,
};

function harnessSnapshot(tag: string, withTestIdea: boolean) {
  return {
    identity: { name: `S11對帳${tag}`, purpose: '整理帳款做成草稿', workingStyle: ['不確定就停下'] },
    skills: [{
      name: `S11對帳技能${tag}`,
      purpose: '整理帳款',
      instructions: ['讀取測試資料', '產出對帳草稿'],
      inputs: ['測試資料'],
      outputs: ['對帳草稿'],
      edgeCases: ['不確定就停下'],
      status: 'DRAFT' as const,
    }],
    memory: { facts: [], preferences: [], glossary: [] },
    tools: [],
    policies: {
      allowed: ['讀取使用者提供的測試資料'],
      requiresApproval: ['寄信'],
      forbidden: ['未經核准啟用'],
    },
    testIdeas: withTestIdea
      ? [{ name: '假帳款', input: '帳款 100 與 200', expected: '合計 300 的對帳草稿，不寄信' }]
      : [],
    testInputRequirements: [TEXT_REQUIREMENT],
  };
}

async function persistRunEvidence(opts: {
  runId: string;
  agentId: string;
  triggeredBy: string;
  sessionId: string;
  draftSkillIds: string[];
  skipVerify?: boolean;
}): Promise<void> {
  await prisma.run.create({
    data: {
      id: opts.runId,
      agentId: opts.agentId,
      triggeredBy: opts.triggeredBy,
      status: 'SUCCEEDED',
      input: {
        builderTest: true,
        builderTestEvidence: {
          sessionId: opts.sessionId,
          draftSkillIds: opts.draftSkillIds,
        },
      },
      output: { ok: true },
      runDir: `/tmp/${opts.runId}`,
    },
  });
  await prisma.runStep.create({
    data: {
      id: ulid(),
      runId: opts.runId,
      stepKey: 'chat',
      round: 1,
      status: opts.skipVerify ? 'approved' : 'approved',
      output: 'ok',
      verdict: opts.skipVerify
        ? '(skipVerify: 對話模式不進行跨模型驗證)'
        : '## Verdict\nAPPROVED',
      approved: true,
      endedAt: new Date(),
    },
  });
}

function passingRunner(): (opts: RunAgentOptions) => Promise<RunOutcome> {
  return async (opts) => {
    const runId = opts.runId ?? ulid();
    const session = await prisma.agentBuildSession.findUnique({
      where: { id: opts.builderTestSessionId! },
    });
    if (!session) throw new Error('builder session missing in mock runner');
    await persistRunEvidence({
      runId,
      agentId: opts.agentId,
      triggeredBy: opts.triggeredBy,
      sessionId: session.id,
      draftSkillIds: session.draftSkillIds,
    });
    return passOutcome(runId);
  };
}

function skipVerifyRunner(): (opts: RunAgentOptions) => Promise<RunOutcome> {
  return async (opts) => {
    const runId = opts.runId ?? ulid();
    const session = await prisma.agentBuildSession.findUnique({
      where: { id: opts.builderTestSessionId! },
    });
    if (!session) throw new Error('builder session missing in mock runner');
    await persistRunEvidence({
      runId,
      agentId: opts.agentId,
      triggeredBy: opts.triggeredBy,
      sessionId: session.id,
      draftSkillIds: session.draftSkillIds,
      skipVerify: true,
    });
    return skippedVerifyOutcome(runId);
  };
}

type SeedOpts = {
  ownerId: string;
  withTestData?: boolean;
  withTestIdea?: boolean;
};

async function seedAwaitingFde(opts: SeedOpts) {
  const tag = ulid().slice(-8).toLowerCase();
  const sessionId = `${TEST_PREFIX}${tag}`;
  const name = `S11對帳${tag}`;
  await prisma.agentBuildSession.create({
    data: {
      id: sessionId,
      userId: opts.ownerId,
      status: 'AWAITING_FDE',
      strategy: 'create',
      brief: {
        objective: '整理帳款郵件做成對帳草稿',
        inputs: '測試資料',
        outputs: '對帳草稿',
        process: '讀取 → 整理 → 產出草稿',
        exceptions: '不確定就停下',
        permissions: '不寄信、不寫入雲端',
      },
      plan: {
        summary: '新建對帳員工',
        strategyRecommendation: 'create',
        reuseCandidates: [],
        skillMatches: [],
        connections: [],
        gaps: [],
        proposedAgentName: name,
        proposedSkillName: `S11對帳技能${tag}`,
        privilegeNote: '預設關閉寄信',
      },
      transcript: [
        { role: 'user', content: '幫我做對帳員工', at: new Date().toISOString() },
      ],
      testData: opts.withTestData
        ? { version: 1, manualText: { manual_input: '帳款 100 與 200' }, fixtures: [] }
        : undefined,
      testExpected: opts.withTestData ? '合計 300 的對帳草稿，不寄信' : undefined,
    },
  });
  await prisma.agentBuildIteration.create({
    data: {
      id: `${TEST_PREFIX}iter-${tag}`,
      sessionId,
      sequence: 1,
      triggerKind: 'message',
      triggerSummary: '建立對帳員工',
      status: 'READY',
      artifactSnapshot: harnessSnapshot(tag, opts.withTestIdea !== false),
      userSummary: '第一版草稿',
      fdeSummary: '待審核',
      startedAt: new Date(),
      completedAt: new Date(),
    },
  });
  return { sessionId, tag, name };
}

async function cleanupSession(sessionId: string): Promise<void> {
  const row = await prisma.agentBuildSession.findUnique({ where: { id: sessionId } });
  const agentId = row?.builtAgentId ?? row?.targetAgentId ?? null;
  const skillIds = row?.draftSkillIds ?? [];
  const runId = row?.lastRunId ?? null;
  const skills = skillIds.length
    ? await prisma.skill.findMany({ where: { id: { in: skillIds } }, select: { id: true, slug: true } })
    : [];

  if (agentId) {
    await prisma.changeProposal.deleteMany({ where: { agentId } }).catch(() => {});
  }
  if (runId) {
    await prisma.run.deleteMany({ where: { id: runId } }).catch(() => {});
  }
  if (agentId) {
    await prisma.run.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.workflow.deleteMany({ where: { agentId } }).catch(() => {});
  }
  if (skillIds.length) {
    await prisma.agentSkill.deleteMany({ where: { skillId: { in: skillIds } } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { id: { in: skillIds } } }).catch(() => {});
  }
  await prisma.agentBuildSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
  if (agentId) {
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  }
  for (const skill of skills) {
    await rm(path.join(paths.skills, skill.slug), { recursive: true, force: true }).catch(() => {});
  }
}

async function createUser(role: 'TRAINER' | 'MEMBER') {
  const id = ulid();
  return prisma.user.create({
    data: {
      id,
      email: `${TEST_PREFIX}${role.toLowerCase()}-${id.slice(-6)}@test.local`,
      displayName: `S11 ${role}`,
      passwordHash: 'x',
      role,
    },
  });
}

async function sweepLeftovers(): Promise<void> {
  const sessions = await prisma.agentBuildSession.findMany({
    where: { id: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  for (const row of sessions) await cleanupSession(row.id);
  const users = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  for (const user of users) {
    const agents = await prisma.agent.findMany({
      where: { createdBy: user.id },
      select: { id: true },
    });
    for (const agent of agents) {
      await prisma.changeProposal.deleteMany({ where: { agentId: agent.id } }).catch(() => {});
      await prisma.run.deleteMany({ where: { agentId: agent.id } }).catch(() => {});
      await prisma.agentSkill.deleteMany({ where: { agentId: agent.id } }).catch(() => {});
      await prisma.workflow.deleteMany({ where: { agentId: agent.id } }).catch(() => {});
      await prisma.conversation.deleteMany({ where: { agentId: agent.id } }).catch(() => {});
      await prisma.agent.deleteMany({ where: { id: agent.id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  }
}

await sweepLeftovers();
const fde = await createUser('TRAINER');
const member = await createUser('MEMBER');
const createdUserIds = [fde.id, member.id];

try {
  await test('(a) AWAITING_FDE + test data + mock PASSED → ACTIVE and skill CONFIRMED', async () => {
    const seeded = await seedAwaitingFde({ ownerId: member.id, withTestData: true });
    try {
      const result = await approveAndActivate({
        sessionId: seeded.sessionId,
        userId: fde.id,
        role: fde.role,
        runAgentFn: passingRunner(),
      });
      assert.equal(result.ok, true, `expected ok, got ${JSON.stringify({ stage: result.stage, reason: result.reason })}`);
      assert.equal(result.status, 'ACTIVE');
      assert.equal(result.session.status, 'ACTIVE');
      assert.ok(result.session.builtAgentId, 'built agent missing');
      assert.ok(result.session.draftSkillIds.length >= 1, 'draft skill missing');

      const skill = await prisma.skill.findUnique({ where: { id: result.session.draftSkillIds[0]! } });
      assert.equal(skill?.reviewStatus, 'CONFIRMED');
      const agent = await prisma.agent.findUnique({ where: { id: result.session.builtAgentId! } });
      assert.equal(agent?.status, 'ACTIVE');
    } finally {
      await cleanupSession(seeded.sessionId);
    }
  });

  await test('(b) skipVerify evidence gate → stay TESTING/FAILED with stage=evidence', async () => {
    const seeded = await seedAwaitingFde({ ownerId: member.id, withTestData: true });
    try {
      const result = await approveAndActivate({
        sessionId: seeded.sessionId,
        userId: fde.id,
        role: fde.role,
        runAgentFn: skipVerifyRunner(),
      });
      assert.equal(result.ok, false);
      assert.equal(result.stage, 'evidence');
      assert.ok(result.reason && result.reason.length > 0, 'evidence failure needs a reason');
      assert.match(result.status, /^(TESTING|FAILED)$/);
      assert.notEqual(result.status, 'ACTIVE');

      const skillIds = result.session.draftSkillIds;
      assert.ok(skillIds.length >= 1, 'approve should have created a draft before evidence failed');
      const skill = await prisma.skill.findUnique({ where: { id: skillIds[0]! } });
      assert.equal(skill?.reviewStatus, 'AWAITING_USER_CONFIRM');
      const agent = await prisma.agent.findUnique({ where: { id: result.session.builtAgentId! } });
      assert.equal(agent?.status, 'PAUSED');
    } finally {
      await cleanupSession(seeded.sessionId);
    }
  });

  await test('(c) MEMBER calling approve-and-activate gets HTTP 403', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    await app.register(agentBuilderRoutes);
    const memberToken = await signAccess({
      sub: member.id,
      email: member.email,
      role: 'MEMBER',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agent-builder/sessions/${ulid()}/approve-and-activate`,
        headers: {
          authorization: `Bearer ${memberToken}`,
          'content-type': 'application/json',
        },
        payload: {},
      });
      assert.equal(res.statusCode, 403);
      const body = res.json() as { success: boolean; error?: { code: string } };
      assert.equal(body.success, false);
      assert.equal(body.error?.code, 'FORBIDDEN');

      await assert.rejects(
        () => approveAndActivate({
          sessionId: ulid(),
          userId: member.id,
          role: 'MEMBER',
          runAgentFn: passingRunner(),
        }),
        (error: unknown) => error instanceof ApiError && error.statusCode === 403,
      );
    } finally {
      await app.close();
    }
  });

  await test('(d) no test data and no autoAdoptSuggestedTest → stage=test, session not advanced', async () => {
    const seeded = await seedAwaitingFde({
      ownerId: member.id,
      withTestData: false,
      withTestIdea: true,
    });
    try {
      const before = await prisma.agent.count({ where: { createdBy: member.id } });
      const result = await approveAndActivate({
        sessionId: seeded.sessionId,
        userId: fde.id,
        role: fde.role,
        runAgentFn: passingRunner(),
      });
      assert.equal(result.ok, false);
      assert.equal(result.stage, 'test');
      assert.match(result.reason ?? '', /測試資料|補件|autoAdoptSuggestedTest/);
      assert.equal(result.status, 'AWAITING_FDE');
      const after = await prisma.agent.count({ where: { createdBy: member.id } });
      assert.equal(after, before, 'must not create an agent when test data is missing');
    } finally {
      await cleanupSession(seeded.sessionId);
    }
  });

  await test('(e) stepwise approve-build / finalize APIs still behave', async () => {
    const seeded = await seedAwaitingFde({ ownerId: member.id, withTestData: true });
    try {
      const approved = await authorizeBuilderSession({
        sessionId: seeded.sessionId,
        userId: fde.id,
        role: fde.role,
        strategy: 'create',
      });
      assert.equal(approved.status, 'AWAITING_TEST_DATA');
      assert.ok(approved.session.builtAgentId);
      const agent = await prisma.agent.findUnique({ where: { id: approved.session.builtAgentId! } });
      assert.equal(agent?.status, 'PAUSED');
      const skill = await prisma.skill.findUnique({ where: { id: approved.session.draftSkillIds[0]! } });
      assert.equal(skill?.reviewStatus, 'AWAITING_USER_CONFIRM');

      await assert.rejects(
        () => finalizeBuilderSession({
          sessionId: seeded.sessionId,
          userId: fde.id,
          role: fde.role,
        }),
        (error: unknown) => error instanceof ApiError && error.statusCode === 409,
      );
      const still = await prisma.agentBuildSession.findUnique({ where: { id: seeded.sessionId } });
      assert.equal(still?.status, 'AWAITING_TEST_DATA');
      const skillAfter = await prisma.skill.findUnique({ where: { id: approved.session.draftSkillIds[0]! } });
      assert.equal(skillAfter?.reviewStatus, 'AWAITING_USER_CONFIRM');
    } finally {
      await cleanupSession(seeded.sessionId);
    }
  });
} finally {
  for (const userId of createdUserIds) {
    const leftover = await prisma.agentBuildSession.findMany({
      where: { id: { startsWith: TEST_PREFIX }, userId },
      select: { id: true },
    });
    for (const row of leftover) await cleanupSession(row.id);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  }
  setBuilderLessonRunAgentForTest();
  await disconnectDb();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
