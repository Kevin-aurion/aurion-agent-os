import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import {
  ReflectionService,
  reflectionWindowFor,
  proposeReflectionSuggestion,
  type AnalyzeReflectionBatch,
} from '../../../src/lib/reflection.js';
import { approveProposal } from '../../../src/lib/changeproposal.js';
import { signAccess } from '../../../src/lib/auth.js';
import { reflectionRoutes } from '../../../src/routes/reflections.js';
import { agentRoutes } from '../../../src/routes/agents.js';

function testWindows() {
  const atNine = reflectionWindowFor(new Date('2026-07-29T01:00:01.000Z'), 'Asia/Taipei');
  assert.equal(atNine.start.toISOString(), '2026-07-28T16:00:00.000Z');
  assert.equal(atNine.end.toISOString(), '2026-07-29T01:00:00.000Z');

  const atSix = reflectionWindowFor(new Date('2026-07-29T10:00:01.000Z'), 'Asia/Taipei');
  assert.equal(atSix.start.toISOString(), '2026-07-29T01:00:00.000Z');
  assert.equal(atSix.end.toISOString(), '2026-07-29T10:00:00.000Z');

  const atMidnight = reflectionWindowFor(new Date('2026-07-29T16:00:01.000Z'), 'Asia/Taipei');
  assert.equal(atMidnight.start.toISOString(), '2026-07-29T10:00:00.000Z');
  assert.equal(atMidnight.end.toISOString(), '2026-07-29T16:00:00.000Z');
}

async function main() {
  testWindows();
  const owner = await prisma.user.findFirst({
    where: { role: { in: ['OWNER', 'TRAINER'] }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  assert(owner, 'test requires an OWNER/TRAINER');

  const agentId = ulid();
  const skillId = ulid();
  const conversationId = ulid();
  const positiveId = ulid();
  const negativeId = ulid();
  const memberId = ulid();
  const window = {
    start: new Date('2096-01-01T00:00:00.000Z'),
    end: new Date('2096-01-01T09:00:00.000Z'),
  };
  let cycleId: string | undefined;

  try {
    await prisma.user.create({
      data: {
        id: memberId,
        email: `reflection-member-${memberId.toLowerCase()}@local.invalid`,
        displayName: 'Reflection Member Test',
        passwordHash: owner.passwordHash,
        role: 'MEMBER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `reflection-test-${agentId.toLowerCase()}`,
        name: 'Reflection Test Agent',
        description: 'temporary reflection integration test',
        rolePrompt: 'Original role prompt',
        createdBy: owner.id,
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `reflection-skill-${skillId.toLowerCase()}`,
        name: 'Reflection Test Skill',
        origin: 'BUILTIN',
        kind: 'PROMPT_MANUAL',
        contentMd: '# Original skill',
        reviewStatus: 'CONFIRMED',
        confirmedBy: owner.id,
        confirmedAt: new Date(),
      },
    });
    await prisma.agentSkill.create({ data: { agentId, skillId } });
    await prisma.conversation.create({
      data: { id: conversationId, agentId, userId: owner.id, title: 'reflection test' },
    });
    await prisma.message.createMany({
      data: [
        {
          id: positiveId,
          conversationId,
          role: 'USER',
          content: '系統真棒，幫了大忙！聯絡信箱是 kevin@example.com',
          createdAt: new Date('2096-01-01T01:00:00.000Z'),
        },
        {
          id: negativeId,
          conversationId,
          role: 'USER',
          content: '每次都要重複輸入客戶編號，很不好用。金鑰 sk-1234567890SECRET',
          createdAt: new Date('2096-01-01T02:00:00.000Z'),
        },
      ],
    });

    const analyzer: AnalyzeReflectionBatch = async (_reflectionAgentId, messages) => ({
      runId: `test-run-${ulid()}`,
      analysis: {
        overview: '有正面成效，也有重複輸入的摩擦。',
        themes: ['效率', '易用性'],
        feedback: [
          { messageId: positiveId, sentiment: 'POSITIVE', categories: ['稱讚'], reason: '明確表示幫助很大' },
          { messageId: negativeId, sentiment: 'NEGATIVE', categories: ['重複輸入'], reason: '流程摩擦' },
        ],
        suggestions: [
          {
            targetType: 'AGENT',
            agentId,
            title: '保留已提供的客戶編號',
            rationale: '員工明確反映重複輸入造成困擾。',
            proposedGuidance: '同一對話中已提供客戶編號時，後續步驟應沿用，不要重複詢問。',
            evidenceMessageIds: [negativeId],
            confidence: 0.95,
            priority: 'high',
          },
          {
            targetType: 'SKILL',
            agentId,
            skillId,
            title: '補上欄位重用規則',
            rationale: '技能應明訂既有欄位的重用方式。',
            proposedGuidance: '先檢查當前對話是否已有客戶編號；僅在缺少時詢問。',
            evidenceMessageIds: [negativeId],
            confidence: 0.9,
            priority: 'medium',
          },
          {
            targetType: 'AGENT',
            agentId: 'invented-agent-id',
            title: '不合法建議',
            rationale: '模型捏造的目標必須被丟棄。',
            proposedGuidance: '不可寫入',
            evidenceMessageIds: [negativeId],
            confidence: 1,
            priority: 'high',
          },
        ],
      },
    });
    const service = new ReflectionService(analyzer);
    const cycle = await service.runCycle({ window, triggeredBy: `test:${owner.id}` });
    cycleId = cycle.id;
    assert.equal(cycle.status, 'SUCCEEDED');
    assert.equal(cycle.sourceMessageCount, 2);

    const stored = await prisma.reflectionCycle.findUniqueOrThrow({
      where: { id: cycle.id },
      include: { feedback: true, suggestions: true },
    });
    assert.equal(stored.feedback.length, 2);
    assert.equal(stored.suggestions.length, 2, 'invented target must be dropped');
    assert(stored.feedback.every((row) => !row.excerpt.includes('kevin@example.com')));
    assert(stored.feedback.every((row) => !row.excerpt.includes('sk-1234567890SECRET')));
    assert(stored.feedback.some((row) => row.excerpt.includes('[REDACTED_EMAIL]')));
    assert(stored.feedback.some((row) => row.excerpt.includes('[REDACTED_API_KEY]')));

    const originalAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const originalSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skillId } });
    assert.equal(originalAgent.rolePrompt, 'Original role prompt');
    assert.equal(originalSkill.contentMd, '# Original skill');

    const agentSuggestion = stored.suggestions.find((item) => item.targetType === 'AGENT');
    const skillSuggestion = stored.suggestions.find((item) => item.targetType === 'SKILL');
    assert(agentSuggestion && skillSuggestion);
    const agentProposal = await proposeReflectionSuggestion(agentSuggestion.id, owner.id);
    const skillProposal = await proposeReflectionSuggestion(skillSuggestion.id, owner.id);

    // Sending to the proposal inbox must still leave both targets untouched.
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).rolePrompt, 'Original role prompt');
    assert.equal((await prisma.skill.findUniqueOrThrow({ where: { id: skillId } })).contentMd, '# Original skill');

    await approveProposal(agentProposal.proposalId, owner.id);
    await approveProposal(skillProposal.proposalId, owner.id);
    const changedAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const changedSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skillId } });
    assert.match(changedAgent.rolePrompt, /FDE 核准的反思優化指引/);
    assert.match(changedAgent.rolePrompt, /不要重複詢問/);
    assert.match(changedSkill.contentMd, /FDE 核准的反思優化指引/);
    assert.match(changedSkill.contentMd, /僅在缺少時詢問/);
    assert(changedSkill.stableVersionId, 'approved Skill guidance must create/promote a stable version');

    const again = await service.runCycle({ window, triggeredBy: 'test:duplicate' });
    assert.equal(again.id, cycle.id);
    assert.equal(await prisma.reflectionCycle.count({ where: { windowStart: window.start, windowEnd: window.end } }), 1);

    const app = Fastify();
    await app.register(reflectionRoutes);
    await app.register(agentRoutes);
    const memberToken = await signAccess({ sub: memberId, email: 'member@test.invalid', role: 'MEMBER' });
    const fdeToken = await signAccess({ sub: owner.id, email: owner.email, role: owner.role });
    const denied = await app.inject({ method: 'GET', url: '/api/reflections', headers: { authorization: `Bearer ${memberToken}` } });
    assert.equal(denied.statusCode, 403, 'MEMBER must not access reflection evidence');
    const allowed = await app.inject({ method: 'GET', url: '/api/reflections', headers: { authorization: `Bearer ${fdeToken}` } });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().data.schedule.times, ['00:00', '09:00', '18:00']);
    const agentsResponse = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: `Bearer ${fdeToken}` } });
    assert.equal(agentsResponse.statusCode, 200);
    assert(agentsResponse.json().data.every((item: { systemManaged: boolean }) => item.systemManaged === false));
    await app.close();
    console.log('reflection-center.test: PASS');
  } finally {
    await prisma.changeProposal.deleteMany({ where: { agentId } });
    if (cycleId) await prisma.reflectionCycle.deleteMany({ where: { id: cycleId } });
    await prisma.agentSkill.deleteMany({ where: { agentId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.skillVersion.deleteMany({ where: { skillId } });
    await prisma.skill.deleteMany({ where: { id: skillId } });
    await prisma.user.deleteMany({ where: { id: memberId } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
