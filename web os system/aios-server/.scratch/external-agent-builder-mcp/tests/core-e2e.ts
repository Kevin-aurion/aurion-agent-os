import assert from 'node:assert/strict';

process.env.AIOS_BUILDER_EVOLUTION_QUEUE = 'off';
process.env.AIOS_BUILDER_EVOLUTION_MODEL = 'off';
process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';

const { prisma } = await import('../../../src/lib/db.js');
const {
  createExternalBuilderSession,
  guardExternalBuilderStop,
  importExternalBuilderArtifact,
  isExplicitAgentBuildPrompt,
  prepareExternalBuilderPrompt,
  submitExternalBuilderForReview,
  syncExternalBuilderTurn,
} = await import('../../../src/lib/externalagentbuilder.js');

const user = await prisma.user.findUnique({
  where: { email: 'claude-builder@local.aios' },
  select: { id: true, role: true },
});
assert(user, 'Run the MCP provisioner before this test');
assert.equal(user.role, 'MEMBER');

let sessionId: string | null = null;
let autoSessionId: string | null = null;
try {
  assert.equal(isExplicitAgentBuildPrompt('幫我建立一個財務管理 agent'), true);
  assert.equal(isExplicitAgentBuildPrompt('我想要一個財務管理 agent'), false);
  assert.equal(isExplicitAgentBuildPrompt('請解釋 agent 這個英文單字'), false);
  const unrelated = await prepareExternalBuilderPrompt({
    userId: user.id,
    source: 'CLAUDE_CODE',
    externalConversationId: `unrelated-${Date.now()}`,
    prompt: '請幫我解釋這段 TypeScript。',
  });
  assert.equal(unrelated.matched, false, 'unrelated Claude chats must remain no-op');

  const autoConversationId = `auto-hook-${Date.now()}`;
  const autoStarted = await prepareExternalBuilderPrompt({
    userId: user.id,
    source: 'CLAUDE_CODE',
    externalConversationId: autoConversationId,
    prompt: '幫我建立一位每天整理客戶回饋的 AI 員工。',
  });
  assert.equal(autoStarted.matched, true);
  assert.equal(autoStarted.created, true);
  assert.equal(autoStarted.userMessageSynced, true);
  assert.equal(autoStarted.backgroundBuildQueued, true);
  assert.match(autoStarted.additionalContext ?? '', /不要使用固定問卷/);
  autoSessionId = autoStarted.sessionId ?? null;

  const started = await createExternalBuilderSession({
    userId: user.id,
    source: 'CLAUDE_DESKTOP',
    externalConversationId: `core-e2e-${Date.now()}`,
    externalConversationTitle: 'AIOS MCP core E2E',
    requestedAgentName: 'MCP 測試員工',
    initialRequest: '建立一位每天整理客戶回饋、提出改善建議的 AI 員工。',
  });
  sessionId = started.session.id;
  assert.equal(started.deduplicated, false);
  assert.equal(started.session.status, 'DISCOVERY');

  const secret = 'sk-proj-super-secret-value-1234567890';
  const turn = await syncExternalBuilderTurn({
    sessionId,
    userId: user.id,
    role: user.role,
    source: 'CLAUDE_DESKTOP',
    externalEventId: 'turn-001',
    turns: [
      { role: 'user', content: `每天早上九點讀回饋；測試密鑰 ${secret}` },
      { role: 'assistant', content: '我會先確認回饋來源，再整理成三個可行動的改善項目。' },
    ],
  });
  assert.equal(turn.deduplicated, false);
  assert(!JSON.stringify(turn.session.transcript).includes(secret), 'transcript secret must be redacted');
  const transcriptLength = turn.session.transcript.length;

  const duplicateTurn = await syncExternalBuilderTurn({
    sessionId,
    userId: user.id,
    role: user.role,
    source: 'CLAUDE_DESKTOP',
    externalEventId: 'turn-001',
    turns: [{ role: 'user', content: '這是同一事件的重試，不應重複保存。' }],
  });
  assert.equal(duplicateTurn.deduplicated, true);
  assert.equal(duplicateTurn.session.transcript.length, transcriptLength);

  const synchronizedStop = await guardExternalBuilderStop({
    userId: user.id,
    source: 'CLAUDE_CODE',
    externalConversationId: started.session.brief.externalConversationId as string,
    lastAssistantMessage: '我會先確認回饋來源，再整理成三個可行動的改善項目。',
    stopHookActive: false,
  });
  assert.equal(synchronizedStop.matched, true);
  assert.equal(synchronizedStop.finalMessageSynced, true);
  assert.equal(synchronizedStop.artifactFresh, false);
  assert.equal(synchronizedStop.backgroundBuildQueued, false);

  const reentrantStop = await guardExternalBuilderStop({
    userId: user.id,
    source: 'CLAUDE_CODE',
    externalConversationId: started.session.brief.externalConversationId as string,
    lastAssistantMessage: '我會先確認回饋來源，再整理成三個可行動的改善項目。',
    stopHookActive: true,
  });
  assert.equal(reentrantStop.matched, true, 're-entrant Stop must remain idempotent');
  assert.equal(reentrantStop.backgroundBuildQueued, false);

  await assert.rejects(
    importExternalBuilderArtifact({
      sessionId,
      userId: user.id,
      role: user.role,
      source: 'CLAUDE_DESKTOP',
      externalEventId: 'artifact-unsafe',
      artifact: {
        identity: { name: 'MCP 測試員工', purpose: '整理客戶回饋' },
        memory: { documents: [{ path: '../../escape.md', contentMd: 'unsafe' }] },
      },
    }),
    /escapes the agent memory folder|unsafe segment/,
  );

  const artifact = await importExternalBuilderArtifact({
    sessionId,
    userId: user.id,
    role: user.role,
    source: 'CLAUDE_DESKTOP',
    externalEventId: 'artifact-001',
    artifact: {
      identity: {
        name: 'MCP 測試員工',
        purpose: '每天整理客戶回饋並提出三個可行動改善項目。',
        workingStyle: ['先引用原始回饋，再清楚區分事實與推論'],
      },
      agentMarkdown: '# MCP 測試員工\n\n只根據已同步的客戶回饋提出建議。',
      skills: [{
        name: '客戶回饋歸納',
        contentMd: '---\nname: customer-feedback\n---\n\n# 客戶回饋歸納\n\n輸出三個改善項目。',
        inputs: ['當日客戶回饋'],
        outputs: ['三個改善項目與引文'],
        edgeCases: ['沒有回饋時不得編造'],
      }],
      memory: {
        facts: ['每天早上九點執行'],
        documents: [{ path: 'customer-feedback/rules.md', contentMd: '# 規則\n\n不得編造。' }],
      },
      tools: [{ name: 'Gmail', purpose: '讀取客戶回饋', status: 'AVAILABLE' }],
      policies: { allowed: ['讀取經授權的回饋'], forbidden: ['捏造客戶說法'] },
      workflows: [{
        name: '每日回饋整理',
        trigger: { type: 'schedule', cron: '0 9 * * *' },
        steps: [{
          stepKey: 'summarize-feedback',
          type: 'DO',
          config: { instruction: '整理三個改善項目' },
          verifyRubric: '每項都有原始引文，且沒有編造。',
        }],
      }],
      tests: [{ name: '無回饋', input: '今天沒有任何回饋', expected: '明確回報沒有資料，不產生虛構項目' }],
    },
  });
  assert.equal(artifact.deduplicated, false);
  assert.equal(artifact.iteration.status, 'READY');
  const snapshot = artifact.iteration.harness as {
    tools: Array<{ name: string; status: string }>;
    memory: { documents: Array<{ path: string }> };
  };
  assert.equal(snapshot.tools[0]?.status, 'NEEDS_FDE', 'unverified tool status must be downgraded');
  assert.equal(snapshot.memory.documents[0]?.path, 'customer-feedback/rules.md');

  const allowedStop = await guardExternalBuilderStop({
    userId: user.id,
    source: 'CLAUDE_CODE',
    externalConversationId: started.session.brief.externalConversationId as string,
    lastAssistantMessage: '最新完整草稿已同步。',
    stopHookActive: false,
  });
  assert.equal(allowedStop.matched, true);
  assert.equal(allowedStop.artifactFresh, true);
  assert.equal(allowedStop.backgroundBuildQueued, false);

  const newlyUnsyncedUserTurn = await guardExternalBuilderStop({
    userId: user.id,
    source: 'CLAUDE_CODE',
    externalConversationId: started.session.brief.externalConversationId as string,
    lastUserMessage: '新增規則：遇到高風險客訴時必須交由主管處理。',
    lastUserMessageAt: new Date().toISOString(),
    lastAssistantMessage: '我會把這條規則加入員工草稿。',
    stopHookActive: false,
  });
  assert.equal(newlyUnsyncedUserTurn.userMessageSynced, true);
  assert.equal(newlyUnsyncedUserTurn.artifactFresh, false);
  assert.equal(newlyUnsyncedUserTurn.backgroundBuildQueued, true);

  const duplicateArtifact = await importExternalBuilderArtifact({
    sessionId,
    userId: user.id,
    role: user.role,
    source: 'CLAUDE_DESKTOP',
    externalEventId: 'artifact-001',
    artifact: {
      identity: { name: '不應覆蓋', purpose: '同事件重試' },
    },
  });
  assert.equal(duplicateArtifact.deduplicated, true);
  assert.equal(duplicateArtifact.iteration.id, artifact.iteration.id);

  // Deliberately pass OWNER to prove even an FDE credential cannot turn this
  // external submission endpoint into an approval/activation shortcut.
  const submitted = await submitExternalBuilderForReview({
    sessionId,
    userId: user.id,
    role: 'OWNER',
    strategy: 'create',
  });
  assert.equal(submitted.status, 'AWAITING_FDE');
  assert.equal(submitted.builtAgentId, null);
  assert.deepEqual(submitted.draftSkillIds, []);

  const reviewAudit = await prisma.auditLog.findFirst({
    where: {
      action: 'agent_builder.external_awaiting_fde',
      entityId: sessionId,
    },
    orderBy: { createdAt: 'desc' },
    select: { detail: true },
  });
  assert.equal((reviewAudit?.detail as { forcedReviewGate?: boolean } | null)?.forcedReviewGate, true);

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    checks: [
      'secret redaction',
      'turn idempotency',
      'memory path traversal rejection',
      'artifact idempotency',
      'UserPromptSubmit auto-starts only explicit Agent builds',
      'Stop hook saves without blocking for an artifact',
      'Stop hook recovers the latest Claude user prompt',
      're-entrant Stop stays idempotent',
      'unverified tool downgrade',
      'OWNER cannot bypass FDE review',
    ],
  }, null, 2));
} finally {
  if (sessionId) {
    await prisma.agentBuildSession.delete({ where: { id: sessionId } }).catch(() => {});
  }
  if (autoSessionId) {
    await prisma.agentBuildSession.delete({ where: { id: autoSessionId } }).catch(() => {});
  }
  await prisma.$disconnect();
}
