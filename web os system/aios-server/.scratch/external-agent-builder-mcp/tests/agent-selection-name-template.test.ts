import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

const { paths } = await import('../../../src/config.js');
const { prisma } = await import('../../../src/lib/db.js');
const { approveProposal } = await import('../../../src/lib/changeproposal.js');
const { attachBuilderSourceFile, authorizeBuilderSession } = await import('../../../src/lib/agentbuilder.js');
const {
  createExternalBuilderSession,
  guardExternalBuilderStop,
  importExternalBuilderArtifact,
  isExplicitAgentBuildPrompt,
  listOwnedBuilderAgents,
  prepareExternalBuilderPrompt,
  requestOwnedAgentRename,
  setExternalBuilderName,
  submitExternalBuilderForReview,
} = await import('../../../src/lib/externalagentbuilder.js');

const ownerUserId = ulid();
const foreignUserId = ulid();
const agentIds: string[] = [];
const sessionIds: string[] = [];
const skillIds: string[] = [];
const skillSlugs: string[] = [];
const proposalIds: string[] = [];

async function makeAgent(userId: string, name: string) {
  const id = ulid();
  agentIds.push(id);
  return prisma.agent.create({
    data: {
      id,
      slug: `selection-${id.toLowerCase()}`,
      name,
      description: `${name} test fixture`,
      department: 'QA',
      rolePrompt: `你是「${name}」。`,
      status: 'PAUSED',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
      createdBy: userId,
    },
  });
}

try {
  await prisma.user.createMany({
    data: [
      { id: ownerUserId, email: `selection-${ownerUserId}@test.local`, displayName: 'Owner A', passwordHash: 'unused', role: 'MEMBER' },
      { id: foreignUserId, email: `selection-${foreignUserId}@test.local`, displayName: 'Owner B', passwordHash: 'unused', role: 'MEMBER' },
    ],
  });
  const finance = await makeAgent(ownerUserId, '財務對帳專員');
  await makeAgent(ownerUserId, '客戶成功專員');
  const foreign = await makeAgent(foreignUserId, '外部帳號私有專員');

  const owned = await listOwnedBuilderAgents(ownerUserId);
  assert.deepEqual(new Set(owned.map((agent) => agent.id)), new Set(agentIds.slice(0, 2)));
  assert(!owned.some((agent) => agent.id === foreign.id), 'owner-scoped list leaked a foreign Agent');

  const beforeAmbiguous = await prisma.agentBuildSession.count({ where: { userId: ownerUserId } });
  const ambiguous = await prepareExternalBuilderPrompt({
    userId: ownerUserId,
    source: 'CLAUDE_CODE',
    externalConversationId: `ambiguous-${ulid()}`,
    prompt: '我想繼續訓練一位 AI 員工，讓他更會處理例外。',
  });
  assert.equal(ambiguous.selectionRequired, true);
  assert.equal(ambiguous.sessionId, undefined);
  assert.match(ambiguous.additionalContext ?? '', /都不是/);
  assert.equal(await prisma.agentBuildSession.count({ where: { userId: ownerUserId } }), beforeAmbiguous);

  const exact = await prepareExternalBuilderPrompt({
    userId: ownerUserId,
    source: 'CLAUDE_CODE',
    externalConversationId: `exact-${ulid()}`,
    prompt: '請繼續訓練財務對帳專員這位 AI 員工，加入月底例外規則。',
  });
  assert(exact.sessionId);
  sessionIds.push(exact.sessionId);
  const exactRow = await prisma.agentBuildSession.findUniqueOrThrow({ where: { id: exact.sessionId } });
  assert.equal(exactRow.targetAgentId, finance.id);
  assert.equal(exactRow.strategy, 'reuse');

  assert.equal(isExplicitAgentBuildPrompt('不要建立新的 Agent，我只是在討論設計。'), false);
  const internalConversationId = `internal-${ulid()}`;
  const internal = await prepareExternalBuilderPrompt({
    userId: ownerUserId,
    source: 'CLAUDE_CODE',
    externalConversationId: internalConversationId,
    prompt: '[This step\'s task]\n【Agent Builder 試跑】請依技能流程建立測試輸出。',
  });
  assert.equal(internal.matched, false);
  const internalStop = await guardExternalBuilderStop({
    userId: ownerUserId,
    source: 'CLAUDE_CODE',
    externalConversationId: internalConversationId,
    lastUserMessage: '【Agent Builder 試跑】請依技能流程建立測試輸出。',
    lastAssistantMessage: '測試輸出',
    stopHookActive: false,
  });
  assert.equal(internalStop.matched, false);

  await assert.rejects(
    createExternalBuilderSession({
      userId: ownerUserId,
      source: 'CHATGPT',
      initialRequest: '繼續訓練既有 Agent',
      requestedAgentName: foreign.name,
      targetAgentId: foreign.id,
    }),
    /Target agent not found/,
  );
  await assert.rejects(
    requestOwnedAgentRename({ agentId: foreign.id, userId: ownerUserId, name: '不應成功' }),
    /Agent not found/,
  );

  const rename = await requestOwnedAgentRename({
    agentId: finance.id,
    userId: ownerUserId,
    name: '財務月結專員',
  });
  proposalIds.push(rename.proposal.id);
  assert.equal(rename.proposal.status, 'PENDING');
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: finance.id } })).name, '財務對帳專員');
  await approveProposal(rename.proposal.id, ownerUserId);
  const renamed = await prisma.agent.findUniqueOrThrow({ where: { id: finance.id } });
  assert.equal(renamed.name, '財務月結專員');
  assert.match(renamed.rolePrompt, /財務月結專員/);

  const templateBuild = await createExternalBuilderSession({
    userId: ownerUserId,
    source: 'CHATGPT',
    externalConversationId: `template-${ulid()}`,
    initialRequest: '建立一位會使用公司 HTML 範本產出提案的 AI 員工。',
    requestedAgentName: '提案範本專員',
  });
  sessionIds.push(templateBuild.session.id);
  await setExternalBuilderName({
    sessionId: templateBuild.session.id,
    userId: ownerUserId,
    role: 'MEMBER',
    name: '提案樣板製作專員',
  });
  await attachBuilderSourceFile({
    sessionId: templateBuild.session.id,
    userId: ownerUserId,
    role: 'MEMBER',
    name: 'proposal-template.html',
    mimeType: 'text/html',
    size: 56,
    content: '<main><h1>{{客戶名稱}}</h1><p>{{提案摘要}}</p></main>',
    useAsTemplate: true,
  });
  await importExternalBuilderArtifact({
    sessionId: templateBuild.session.id,
    userId: ownerUserId,
    role: 'MEMBER',
    source: 'CHATGPT',
    externalEventId: 'template-artifact-1',
    artifact: {
      identity: { name: '提案樣板製作專員', purpose: '依公司範本產出提案草稿。' },
      skills: [{
        name: '提案樣板製作',
        contentMd: '---\nname: proposal-template\ndescription: 依核准範本製作提案\n---\n\n# 提案樣板製作',
      }],
      tests: [{ name: '套版', input: '客戶：Lazyoffice', expected: 'HTML 標題含 Lazyoffice' }],
    },
  });
  await submitExternalBuilderForReview({
    sessionId: templateBuild.session.id,
    userId: ownerUserId,
    role: 'MEMBER',
    strategy: 'create',
  });
  const approved = await authorizeBuilderSession({
    sessionId: templateBuild.session.id,
    userId: ownerUserId,
    role: 'OWNER',
    strategy: 'create',
  });
  const generatedSkillId = approved.session.draftSkillIds[0];
  assert(generatedSkillId);
  skillIds.push(...approved.session.draftSkillIds);
  if (approved.session.builtAgentId) agentIds.push(approved.session.builtAgentId);
  const skill = await prisma.skill.findUniqueOrThrow({ where: { id: generatedSkillId } });
  skillSlugs.push(skill.slug);
  assert.equal(skill.reviewStatus, 'AWAITING_USER_CONFIRM');
  const assets = skill.assets as { templates?: Array<{ path: string }> } | null;
  assert.equal(assets?.templates?.[0]?.path, 'assets/templates/proposal-template.html');
  const templatePath = path.join(paths.skills, skill.slug, 'assets', 'templates', 'proposal-template.html');
  assert.match(await readFile(templatePath, 'utf8'), /\{\{客戶名稱\}\}/);
  assert.match(skill.contentMd, /assets\/templates\/proposal-template\.html/);

  console.log(JSON.stringify({
    passed: true,
    checks: [
      'account-scoped Agent list',
      'ambiguous continuation asks before creating',
      'exact continuation targets an owned Agent',
      'internal Builder tests are ignored by prompt and Stop hooks',
      'foreign Agent ids fail closed',
      'live rename requires and applies through FDE proposal',
      'user-chosen draft naming',
      'template file materializes under Skill assets/templates',
    ],
  }, null, 2));
} finally {
  await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
  await prisma.changeProposal.deleteMany({ where: { id: { in: proposalIds } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
  await prisma.skill.deleteMany({ where: { id: { in: skillIds } } }).catch(() => {});
  await Promise.all(skillSlugs.map((slug) => rm(path.join(paths.skills, slug), { recursive: true, force: true })));
  await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, foreignUserId] } } }).catch(() => {});
  await prisma.$disconnect();
}
