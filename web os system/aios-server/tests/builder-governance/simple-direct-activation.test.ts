/**
 * Simple Builder: the first complete MEMBER-owned snapshot is callable without
 * an activation command or Builder test Run, preserves the Agent id, and
 * resumes one durable session.
 *
 * No paid CLI. Run from aios-server:
 *   npx tsx tests/builder-governance/simple-direct-activation.test.ts
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { paths } from '../../src/config.ts';
import { safeJoin } from '../../src/lib/safepath.ts';
import { isBuilderAgentReleased } from '../../src/lib/builderrelease.ts';
import { setBuilderLessonRunAgentForTest } from '../../src/lib/builderlessons.ts';
import {
  createBuilderSession,
  finalizeBuilderSession,
  postBuilderMessage,
} from '../../src/lib/agentbuilder.ts';
import {
  activateExternalBuilderSession,
  createExternalBuilderSession,
  importExternalBuilderArtifact,
} from '../../src/lib/externalagentbuilder.ts';

const TEST_PREFIX = 'simple-builder-';
const originalLessonQueue = process.env.AIOS_BUILDER_EVOLUTION_QUEUE;
process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
setBuilderLessonRunAgentForTest(async () => ({
  ok: true,
  runId: ulid(),
  runDir: '/tmp/aios-simple-builder-lesson',
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

async function cleanup(userId: string): Promise<void> {
  const agents = await prisma.agent.findMany({
    where: { createdBy: userId },
    select: { id: true, department: true, slug: true },
  });
  const agentIds = agents.map((row) => row.id);
  const links = agentIds.length
    ? await prisma.agentSkill.findMany({ where: { agentId: { in: agentIds } }, select: { skillId: true } })
    : [];
  const skillIds = [...new Set(links.map((row) => row.skillId))];
  const skills = skillIds.length
    ? await prisma.skill.findMany({ where: { id: { in: skillIds } }, select: { slug: true } })
    : [];
  if (agentIds.length) {
    await prisma.workflowStep.deleteMany({ where: { workflow: { agentId: { in: agentIds } } } }).catch(() => {});
    await prisma.workflow.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => {});
    await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => {});
    await prisma.run.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => {});
  }
  await prisma.agentBuildSession.deleteMany({ where: { userId } }).catch(() => {});
  if (skillIds.length) await prisma.skill.deleteMany({ where: { id: { in: skillIds } } }).catch(() => {});
  if (agentIds.length) await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await Promise.all(skills.map((skill) => rm(safeJoin(paths.skills, skill.slug), { recursive: true, force: true })));
  await Promise.all(agents.map((agent) =>
    rm(safeJoin(paths.agents, agent.department, agent.slug), { recursive: true, force: true }),
  ));
}

const leftovers = await prisma.user.findMany({
  where: { email: { startsWith: TEST_PREFIX } },
  select: { id: true },
});
for (const row of leftovers) await cleanup(row.id);

const userId = ulid();
await prisma.user.create({
  data: {
    id: userId,
    email: `${TEST_PREFIX}${userId.slice(-8)}@test.local`,
    displayName: 'Simple Builder Member',
    passwordHash: 'x',
    role: 'MEMBER',
  },
});

function artifact(version: string, department: string) {
  return {
    identity: {
      name: '簡單查詢顧問',
      purpose: `依內部知識回答產品問題（${version}）`,
      department,
      workingStyle: ['先查資料，再用繁體中文簡潔回答'],
    },
    skills: [{
      name: `知識查詢 ${version}`,
      purpose: '查詢知識並附上依據',
      instructions: ['讀取問題', '查詢可用知識', '整理答案與來源'],
      inputs: ['產品編號或問題'],
      outputs: ['繁體中文答案與來源'],
      edgeCases: ['找不到資料時明確說明'],
      contentMd: `# 知識查詢 ${version}\n\n先查資料，再回答；找不到時不得猜測。`,
    }],
    memory: { facts: [], preferences: ['使用繁體中文'], glossary: [], documents: [] },
    tools: [{ name: 'Vincent Knowledge MCP', purpose: '唯讀查詢', status: 'AVAILABLE' as const }],
    policies: {
      allowed: ['唯讀查詢與回答'],
      requiresApproval: ['任何外部寫入'],
      forbidden: ['猜測不存在的資料'],
    },
    tests: [],
    workflows: [{
      name: '回答知識問題',
      description: `simple builder ${version}`,
      trigger: { type: 'manual' },
      steps: [{ stepKey: 'answer', type: 'DO' as const, config: { prompt: '回答使用者問題' } }],
    }],
    userSummary: `完成 ${version} 訓練`,
  };
}

try {
  const started = await createExternalBuilderSession({
    userId,
    source: 'CLAUDE_CODE',
    initialRequest: '建立一位能查詢產品知識的 AI 員工',
    externalConversationId: `claude-${ulid()}`,
  });
  assert.equal(started.session.status, 'DISCOVERY');
  assert.equal(started.session.agentId, null);

  const firstSnapshot = await importExternalBuilderArtifact({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
    source: 'CLAUDE_CODE',
    externalEventId: `artifact-v1-${ulid()}`,
    artifact: artifact('v1', '知識管理'),
  });
  assert.equal(firstSnapshot.session.status, 'ACTIVE');
  assert.equal(firstSnapshot.becameCallable, true);
  const agentId = firstSnapshot.session.agentId ?? firstSnapshot.session.builtAgentId;
  assert.ok(agentId, 'the first complete snapshot must return a callable Agent id');
  assert.equal(await isBuilderAgentReleased(agentId!), true);

  const agent = await prisma.agent.findUnique({
    where: { id: agentId! },
    include: {
      skills: { include: { skill: true } },
      workflows: { include: { steps: { orderBy: { position: 'asc' } } } },
    },
  });
  assert.equal(agent?.status, 'ACTIVE');
  assert.equal(agent?.department, '知識管理');
  assert.ok(agent?.skills.length);
  const originalSkillId = agent?.skills[0]?.skillId;
  assert.ok(originalSkillId);
  assert.ok(agent?.skills.every((row) => row.skill.reviewStatus === 'CONFIRMED'));
  assert.equal(agent?.workflows.length, 1);
  assert.equal(agent?.workflows[0]?.enabled, true, 'manual Builder workflow must be callable immediately');
  assert.equal(agent?.workflows[0]?.durable, false, 'manual Builder workflow must not require Temporal');
  assert.equal(
    (agent?.workflows[0]?.steps[0]?.config as Record<string, unknown>)?.skipVerify,
    true,
    'manual Builder workflow must not enter the intermediate verifier loop',
  );
  assert.equal(await prisma.run.count({ where: { agentId: agentId! } }), 0, 'Builder must not run a mandatory test');

  const repeatedActivation = await activateExternalBuilderSession({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
    strategy: 'create',
  });
  assert.equal(repeatedActivation.status, 'ACTIVE');
  assert.equal(
    await prisma.agentSkill.count({ where: { agentId: agentId! } }),
    agent?.skills.length,
    'retrying activation for the same READY iteration must not duplicate Skills',
  );

  const resumed = await createExternalBuilderSession({
    userId,
    source: 'CODEX',
    initialRequest: '把回答規則再教精準一點',
    externalConversationId: `another-claude-session-${ulid()}`,
    agentId: agentId!,
  });
  assert.equal(resumed.session.id, started.session.id, 'same Agent must resume the same durable build session');
  assert.equal(resumed.deduplicated, true);

  const retrained = await importExternalBuilderArtifact({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
    source: 'CODEX',
    externalEventId: `artifact-v2-${ulid()}`,
    artifact: artifact('v2', '產品支援'),
  });
  assert.equal(retrained.session.status, 'ACTIVE');
  assert.equal(retrained.becameCallable, false);
  assert.equal(
    retrained.session.agentId ?? retrained.session.builtAgentId,
    agentId,
    'retraining must preserve Agent id without a separate activation call',
  );
  assert.equal(
    (await prisma.agent.findUnique({ where: { id: agentId! }, select: { department: true } }))?.department,
    '產品支援',
    'retraining must apply the latest explicit department',
  );
  const retrainedSkills = await prisma.skill.findMany({
    where: { agents: { some: { agentId: agentId! } }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(retrainedSkills.length, 1, 'retraining must update the Builder Skill instead of attaching a duplicate');
  assert.equal(retrainedSkills[0]?.id, originalSkillId, 'retraining must preserve the Skill id');
  assert.equal(retrainedSkills[0]?.version, 2, 'retraining must increment the existing Skill version');
  assert.match(retrainedSkills[0]?.contentMd ?? '', /v2/, 'the preserved Skill must contain the latest training content');
  assert.equal(await prisma.agent.count({ where: { createdBy: userId } }), 1);
  assert.equal(await prisma.workflow.count({ where: { agentId: agentId!, name: '回答知識問題' } }), 1, 'retraining must update, not duplicate, imported workflows');
  assert.equal(await prisma.run.count({ where: { agentId: agentId! } }), 0);

  const legacyActiveAlias = await finalizeBuilderSession({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
  });
  assert.equal(legacyActiveAlias.status, 'ACTIVE', 'legacy finalize must be idempotent after direct activation');

  await prisma.agentBuildSession.update({
    where: { id: started.session.id },
    data: { status: 'FAILED' },
  });
  const retiredFailedGate = await finalizeBuilderSession({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
  });
  assert.equal(retiredFailedGate.status, 'ACTIVE', 'a retired failed test gate must not block owner activation');

  // The native Web interview also skips a separate activation click: once it
  // has a usable plan, the same message request returns the callable employee.
  process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';
  const nativeStarted = await createBuilderSession({
    userId,
    message: '建立一位會整理每日待辦、列出負責人與期限的工作助理',
  });
  const nativeCallable = await postBuilderMessage({
    sessionId: nativeStarted.session.id,
    userId,
    role: 'MEMBER',
    message: '確認目前版本，正式建立；資料不足就標待補，不要猜。',
  });
  assert.equal(nativeCallable.status, 'ACTIVE', 'native Web training must not need a second activation request');
  const nativeAgentId = nativeCallable.session.agentId ?? nativeCallable.session.builtAgentId;
  assert.ok(nativeAgentId, 'native Web training must return an Agent id');
  assert.equal(await isBuilderAgentReleased(nativeAgentId!), true);

  console.log('ok - MCP snapshot and native Web plan are callable without an activation command or mandatory test');
} finally {
  setBuilderLessonRunAgentForTest();
  if (originalLessonQueue === undefined) delete process.env.AIOS_BUILDER_EVOLUTION_QUEUE;
  else process.env.AIOS_BUILDER_EVOLUTION_QUEUE = originalLessonQueue;
  await cleanup(userId);
  await disconnectDb();
}
