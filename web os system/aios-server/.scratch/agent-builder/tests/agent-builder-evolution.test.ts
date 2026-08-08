import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import {
  buildGrillFallbackTurn,
  createBuilderSession,
  getBuilderSession,
  listBuilderEvolutionSessions,
  postBuilderMessage,
} from '../../../src/lib/agentbuilder.js';
import {
  createBuilderEvolutionIteration,
  processBuilderEvolution,
} from '../../../src/lib/agentbuilderevolution.js';

process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';

const userId = ulid();

async function main() {
  const concreteTurn = buildGrillFallbackTurn({
    fallbackKey: 'objective',
    brief: { objective: '每天人工比對銀行收款與 ERP 應收，常常漏掉差異' },
    recentTranscript: [
      { role: 'user', content: '每天人工比對銀行收款與 ERP 應收，常常漏掉差異', at: new Date().toISOString() },
      { role: 'assistant', content: '請描述最近一次案例', at: new Date().toISOString() },
      { role: 'user', content: '先看交易序號，再看日期金額；一筆銀行款有時對到兩張發票', at: new Date().toISOString() },
    ],
  });
  assert.equal(concreteTurn.key, 'exceptions');
  assert.match(concreteTurn.question, /候選清單/);

  const correctionTurn = buildGrillFallbackTurn({
    fallbackKey: 'exceptions',
    brief: { objective: '比對收款' },
    recentTranscript: [{ role: 'user', content: '我反悔了，多對一不要自動配對', at: new Date().toISOString() }],
  });
  assert.notEqual(correctionTurn.intent, 'resolve_conflict', 'first-turn safety boundaries are not corrections');

  const laterCorrectionTurn = buildGrillFallbackTurn({
    fallbackKey: 'exceptions',
    brief: { objective: '比對收款' },
    recentTranscript: [
      { role: 'user', content: '先自動配對所有相同金額', at: new Date().toISOString() },
      { role: 'assistant', content: '我先依這個做法整理', at: new Date().toISOString() },
      { role: 'user', content: '我反悔了，多對一不要自動配對', at: new Date().toISOString() },
    ],
  });
  assert.equal(laterCorrectionTurn.intent, 'resolve_conflict');

  const confirmedRevisionTurn = buildGrillFallbackTurn({
    fallbackKey: 'objective',
    brief: { objective: '每天人工比對收款，常常漏掉差異' },
    recentTranscript: [
      { role: 'user', content: '我反悔了，多對一不要自動配對', at: new Date().toISOString() },
      { role: 'assistant', content: '最新說法完整取代舊版嗎？', at: new Date().toISOString() },
      { role: 'user', content: '完整以最新說法取代', at: new Date().toISOString() },
    ],
  });
  assert.equal(confirmedRevisionTurn.intent, 'offer_test');
  assert.match(confirmedRevisionTurn.question, /最新版規則/);

  const acceptedTestTurn = buildGrillFallbackTurn({
    fallbackKey: 'process',
    brief: { objective: '比對收款' },
    recentTranscript: [
      { role: 'user', content: '要現在建立三筆測試嗎？', at: new Date().toISOString() },
      { role: 'assistant', content: '請確認', at: new Date().toISOString() },
      { role: 'user', content: '好，建立三筆測試', at: new Date().toISOString() },
    ],
  });
  assert.equal(acceptedTestTurn.intent, 'clarify');
  assert.match(acceptedTestTurn.question, /預期結果/);

  const before = await Promise.all([prisma.agent.count(), prisma.skill.count()]);
  await prisma.user.create({
    data: {
      id: userId,
      email: `builder-evolution-${userId.toLowerCase()}@test.local`,
      displayName: 'Builder Evolution Test',
      passwordHash: 'not-used',
      role: 'MEMBER',
    },
  });

  const started = await createBuilderSession({
    userId,
    message: '我想減少每天人工整理競品更新的時間，先做一位會持續學習的市場情報員工，但不要自動寄信。',
  });
  assert.equal(started.session.iterations.length, 1);
  assert.equal(started.session.latestIteration?.status, 'QUEUED');

  await processBuilderEvolution(started.session.latestIteration!.id);
  const first = await getBuilderSession({ sessionId: started.session.id, userId, role: 'MEMBER' });
  assert.equal(first.latestIteration?.status, 'READY');
  assert.equal(first.latestIteration?.sequence, 1);
  assert.equal(first.latestIteration?.changes[0]?.area, 'identity', 'a first-turn safety boundary is not a correction');
  assert.ok(first.latestIteration?.harness?.skills.length);
  assert.ok(first.latestIteration?.harness?.skills.every((skill) => skill.status === 'DRAFT'));
  assert.ok(first.latestIteration?.harness?.policies.requiresApproval.length);

  const revised = await postBuilderMessage({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
    message: '我反悔了，不要每天整理，改成每週一先給我候選清單，我選完再做深入分析。',
  });
  assert.equal(revised.session.latestIteration?.sequence, 2);
  assert.equal(revised.session.latestIteration?.basedOnIterationId, first.latestIteration?.id);
  assert.equal(revised.session.latestIteration?.triggerKind, 'correction');

  const interruptedAt = new Date(Date.now() - 60_000);
  await prisma.agentBuildIteration.update({
    where: { id: revised.session.latestIteration!.id },
    data: { status: 'ANALYZING', startedAt: interruptedAt, updatedAt: interruptedAt },
  });
  await processBuilderEvolution(revised.session.latestIteration!.id);
  const second = await getBuilderSession({ sessionId: started.session.id, userId, role: 'MEMBER' });
  assert.equal(second.iterations.length, 2);
  assert.equal(second.latestIteration?.status, 'READY');
  assert.ok(second.latestIteration?.changes.some((change) => change.area === 'workflow'));
  assert.ok(second.latestIteration?.understanding?.decisions.some((decision) => decision.status === 'revised'));
  assert.ok(second.latestIteration?.harness?.skills[0]?.instructions.some((instruction) => instruction.includes('每週一')));
  assert.notDeepEqual(second.latestIteration?.harness, first.latestIteration?.harness, 'each turn compiles a new Harness snapshot');

  await prisma.agentBuildSession.update({
    where: { id: started.session.id },
    data: { status: 'ACTIVE' },
  });
  const tomorrow = await postBuilderMessage({
    sessionId: started.session.id,
    userId,
    role: 'MEMBER',
    message: '明天開始再加入投資人電話會議摘要，但先只做草稿，不要主動寄出。',
  });
  assert.equal(tomorrow.status, 'DISCOVERY', 'an active employee re-enters a shadow discovery cycle');
  assert.equal(tomorrow.session.latestIteration?.sequence, 3);
  await processBuilderEvolution(tomorrow.session.latestIteration!.id);

  const testIteration = await createBuilderEvolutionIteration({
    sessionId: started.session.id,
    triggerKind: 'test',
    triggerSummary: '建立三筆測試：唯一一對一、一對多候選、只有日期金額相近。',
  });
  await processBuilderEvolution(testIteration.id);
  const withTests = await getBuilderSession({ sessionId: started.session.id, userId, role: 'MEMBER' });
  assert.equal(withTests.latestIteration?.sequence, 4);
  assert.ok(withTests.latestIteration?.harness?.testIdeas.length);
  assert.ok(withTests.latestIteration?.changes.some((change) => change.area === 'test'));

  const ledger = await listBuilderEvolutionSessions({ userId, role: 'MEMBER' });
  assert.ok(ledger.some((session) => session.id === started.session.id && session.iterations.length === 4));
  assert.ok(ledger.every((session) => session.ownedByCurrentUser === true));

  const after = await Promise.all([prisma.agent.count(), prisma.skill.count()]);
  assert.deepEqual(after, before, 'shadow iterations must not create effective Agent/Skill rows');
  console.log('✓ asynchronous shadow Harness iterations are append-only and non-effective');
  console.log('✓ later user corrections produce a new revision without erasing history');
  console.log('✓ an ACTIVE employee can re-enter conversation-driven shadow evolution');
  console.log('✓ role-aware evolution ledger exposes every owned draft iteration');
  console.log('✓ Grill fallback follows the concrete case and recognizes corrections');
  console.log('✓ interrupted background builds can be reclaimed without losing the version');
}

main()
  .finally(async () => {
    await prisma.agentBuildSession.deleteMany({ where: { userId } });
    await prisma.agentBuilderWorkspace.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
