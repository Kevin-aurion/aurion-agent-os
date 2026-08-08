/**
 * Agent Builder — focused true-DB tests (all acceptance + negatives).
 * Run: npx tsx .scratch/agent-builder/tests/agent-builder.test.ts
 *
 * Uses injectable runAgentFn so engine-failure paths never call paid CLIs.
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { agentBuilderRoutes } from '../../../src/routes/agentbuilder.js';
import {
  inferFromPrompt,
  attachBuilderSourceFile,
  buildCapabilityPlan,
  authorizeBuilderSession,
  createBuilderSession,
  finalizeBuilderSession,
  getBuilderSession,
  postBuilderMessage,
  runBuilderTest,
  submitBuilderTestData,
  type RunAgentFn,
} from '../../../src/lib/agentbuilder.js';
import { deepRedactSecrets } from '../../../src/memory/deepredact.js';
import type { RunOutcome } from '../../../src/engine/types.js';
import { canUseSemanticRecall, compileManifest } from '../../../src/engine/runner.js';
import { claudeDisallowedTools } from '../../../src/engine/restrictions.js';

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

function passOutcome(runId = ulid()): RunOutcome {
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

function failOutcome(runId = ulid()): RunOutcome {
  return {
    ok: false,
    runId,
    runDir: `/tmp/${runId}`,
    status: 'FAILED',
    results: [
      {
        ok: false,
        stepKey: 'chat',
        type: 'DO',
        output: '',
        rounds: 1,
        approved: false,
        reason: 'VERIFY_REJECTED',
        records: [{ round: 1, approved: false, verdict: 'ISSUES FOUND' }],
      },
    ],
    reworkHistory: [],
    stoppedAt: 'chat',
  };
}

function skippedVerifyOutcome(runId = ulid()): RunOutcome {
  const out = passOutcome(runId);
  out.results[0]!.records = [
    { round: 1, approved: true, verdict: '(skipVerify: 對話模式不進行跨模型驗證)' },
  ];
  return out;
}

async function main() {
  console.log('── agent-builder acceptance ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need FDE user in DB');

  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMember: string | null = null;
  if (!member) {
    createdMember = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMember,
        email: `ab-m-${createdMember.slice(-6)}@test.local`,
        displayName: 'AB Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  let foreign = await prisma.user.findFirst({
    where: { deletedAt: null, role: 'MEMBER', id: { not: member.id } },
  });
  let createdForeign: string | null = null;
  if (!foreign) {
    createdForeign = ulid();
    foreign = await prisma.user.create({
      data: {
        id: createdForeign,
        email: `ab-f-${createdForeign.slice(-6)}@test.local`,
        displayName: 'AB Foreign',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const financeAgentId = ulid();
  const sessionIds: string[] = [];
  const agentIds: string[] = [financeAgentId];
  const skillIds: string[] = [];

  // Seed a finance agent so plan can recommend reuse.
  await prisma.agent.create({
    data: {
      id: financeAgentId,
      slug: `ab-finance-${tag}`,
      name: '財務帳款助理',
      description: '整理帳款郵件與對帳表',
      department: '財務',
      rolePrompt: '處理帳款、Gmail、對帳',
      engineExecute: 'CLAUDE_CODE',
      restrictions: {
        webSearch: true,
        computerUse: true,
        sendEmail: true,
        cloudWrite: true,
        shell: true,
        cloudEmbedding: true,
      },
      status: 'ACTIVE',
      createdBy: owner.id,
    },
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    return reply
      .code(500)
      .send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(agentBuilderRoutes);

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
  const foreignToken = await signAccess({
    sub: foreign.id,
    email: foreign.email,
    role: 'MEMBER',
  });

  try {
    // ── 0. deep redaction ──
    const redacted = deepRedactSecrets({
      nested: { token: 'sk-abcdefghijklmnopqrstuvwxyz012345', email: 'a@b.com' },
      arr: ['Bearer abcdefghijklmnop'],
    });
    assert(
      JSON.stringify(redacted).includes('[REDACTED'),
      'deepRedactSecrets must mask secrets',
    );
    console.log('  ✓ deep redaction');

    // ── 1. CEO finance prompt skips stated facts, one question ──
    const ceoPrompt =
      '幫我做一個每天早上掃 Gmail 帳款郵件、整理成表、上傳 Drive 的財務員工，成功就是主管看得到當日帳款表';
    const inferred = inferFromPrompt(ceoPrompt);
    assert(inferred.answered.includes('objective'), 'should infer objective');
    assert(inferred.answered.includes('inputs'), 'should infer inputs (gmail)');
    assert(inferred.answered.includes('outputs'), 'should infer outputs');
    assert(inferred.answered.length < 7, 'should leave some questions open');
    assert(!inferred.answered.includes('testData'), 'no fixture was supplied yet');

    const s1 = await createBuilderSession({ userId: member.id, message: ceoPrompt });
    sessionIds.push(s1.session.id);
    assert(s1.status === 'DISCOVERY' || s1.status === 'PLAN_READY', 'start discovery or plan');
    if (s1.status === 'DISCOVERY') {
      assert(s1.assistantMessage.includes('？') || s1.assistantMessage.includes('?'), 'asks a question');
      assert(s1.assistantMessage.includes('建議'), 'includes recommended answer');
      // Only one open question mentioned as current
      assert(s1.progress?.currentKey, 'has currentKey');
    }
    console.log('  ✓ CEO prompt inference + first question');

    const uploadResult = await attachBuilderSourceFile({
      sessionId: s1.session.id,
      userId: member.id,
      role: 'MEMBER',
      name: '../AR-training.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 2048,
      content: 'SOP_每日收款｜invoice A-101｜api_key=sk-abcdefghijklmnopqrstuvwxyz012345',
    });
    assert(uploadResult.session.brief?.sourceFiles?.length === 1, 'front-end source persisted');
    assert(uploadResult.session.brief?.sourceFiles?.[0]?.name === 'AR-training.xlsx', 'safe basename');
    assert(
      uploadResult.session.brief?.sourceFiles?.[0]?.content.includes('[REDACTED'),
      'source content redacted before persistence',
    );
    console.log('  ✓ front-end training source persisted + redacted');

    const uncertainPrompt = inferFromPrompt(
      '我要財務員工讀 Gmail 和 Drive，產出現金流與異常支出報告並草擬催款信；任何寄信都先問我，但完整流程與例外我還不確定。',
    );
    assert(!uncertainPrompt.answered.includes('process'), 'uncertain process must stay open');
    assert(!uncertainPrompt.answered.includes('exceptions'), '異常支出 must not satisfy exception policy');
    assert(uncertainPrompt.answered.includes('permissions'), 'explicit approval rule is answered');
    assert(
      uncertainPrompt.brief.outputs?.includes('郵件草稿'),
      'draft collection email should be inferred as output',
    );
    console.log('  ✓ uncertainty beats keyword inference');

    const explicitNewAgent = inferFromPrompt(
      '我要建立一位全新的「應收帳款與通路對帳專員」，不可把工作交給任何既有 AI 員工，也不可改造既有員工。',
    );
    assert(
      explicitNewAgent.brief.requestedAgentName === '應收帳款與通路對帳專員',
      'explicit employee name must be preserved',
    );
    assert(
      explicitNewAgent.brief.requestedStrategy === 'create',
      'explicit new-only requirement must force create',
    );
    const explicitNewPlan = await buildCapabilityPlan(
      {
        ...explicitNewAgent.brief,
        inputs: 'ERP、銀行與通路對帳檔',
        outputs: '對帳報告與例外清單',
        process: '讀取 → 比對 → 列出差異',
      },
      member.id,
    );
    assert(explicitNewPlan.strategyRecommendation === 'create', 'catalog must not override create');
    assert(
      explicitNewPlan.proposedAgentName === '應收帳款與通路對帳專員',
      'plan must use the requested employee name',
    );
    assert(
      explicitNewPlan.summary.includes('不會被沿用或修改'),
      'plan must explain the no-reuse boundary',
    );
    console.log('  ✓ explicit new employee name + no-reuse intent');

    // ── 2. Progress to PLAN_READY; plan finds finance agent ──
    let session = s1.session;
    let guard = 0;
    while (session.status === 'DISCOVERY' && guard < 10) {
      guard += 1;
      const key = session.progress?.currentKey ?? 'process';
      const answers: Record<string, string> = {
        objective: '彙整每日帳款並可驗收',
        inputs: 'Gmail 帳款郵件',
        outputs: '表格給財務主管，每天早上',
        process: '讀信 → 整理 → 產出表 → 存草稿',
        exceptions: '無法判斷就標註待審，不寄出',
        permissions: '不允許寄信與雲端寫入，只做草稿',
        testData: '三封假郵件；期望三列表',
      };
      const msg = answers[key] ?? '依建議處理';
      const r = await postBuilderMessage({
        sessionId: session.id,
        userId: member.id,
        role: 'MEMBER',
        message: msg,
      });
      session = r.session;
    }
    assert(session.status === 'PLAN_READY', `expected PLAN_READY got ${session.status}`);
    assert(session.plan, 'plan present');
    const planNames = (session.plan?.reuseCandidates ?? []).map((c) => c.name).join(' ');
    assert(planNames.includes('財務') || planNames.includes('帳款'), 'plan should inventory relevant agents');
    // Finance agent should be a candidate given keywords
    const foundFinance = (session.plan?.reuseCandidates ?? []).some((c) => c.agentId === financeAgentId);
    assert(foundFinance, 'plan should find existing finance agent');
    console.log('  ✓ PLAN_READY + finance reuse candidate');

    // ── 3. MEMBER authorize → AWAITING_FDE, no mutation ──
    const agentsBefore = await prisma.agent.count({ where: { deletedAt: null } });
    const skillsBefore = await prisma.skill.count({ where: { deletedAt: null } });
    const badMemberTarget = await expectThrow(
      () =>
        authorizeBuilderSession({
          sessionId: session.id,
          userId: member.id,
          role: 'MEMBER',
          strategy: 'reuse',
          targetAgentId: ulid(),
        }),
      'member arbitrary reuse target',
    );
    assert(
      badMemberTarget instanceof ApiError && badMemberTarget.statusCode === 400,
      'MEMBER arbitrary reuse target rejected',
    );
    const mAuth = await authorizeBuilderSession({
      sessionId: session.id,
      userId: member.id,
      role: 'MEMBER',
      strategy: 'create',
    });
    assert(mAuth.status === 'AWAITING_FDE', 'MEMBER → AWAITING_FDE');
    const agentsAfter = await prisma.agent.count({ where: { deletedAt: null } });
    const skillsAfter = await prisma.skill.count({ where: { deletedAt: null } });
    assert(agentsAfter === agentsBefore, 'MEMBER must not create agent');
    assert(skillsAfter === skillsBefore, 'MEMBER must not create skill');
    console.log('  ✓ MEMBER authorize no mutation / arbitrary reuse rejected');

    // ── 4. FDE authorize create → PAUSED agent + AWAITING_USER_CONFIRM draft ──
    const fdeAuth = await authorizeBuilderSession({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      strategy: 'create',
    });
    assert(fdeAuth.status === 'AWAITING_TEST_DATA', `FDE build → AWAITING_TEST_DATA got ${fdeAuth.status}`);
    assert(fdeAuth.session.builtAgentId, 'built agent id');
    assert(fdeAuth.session.draftSkillIds.length >= 1, 'draft skill');
    agentIds.push(fdeAuth.session.builtAgentId!);
    skillIds.push(...fdeAuth.session.draftSkillIds);

    const built = await prisma.agent.findUnique({ where: { id: fdeAuth.session.builtAgentId! } });
    assert(built?.status === 'PAUSED', 'agent must be PAUSED');
    const restr = built?.restrictions as Record<string, unknown> | null;
    assert(restr?.sendEmail === false, 'sendEmail false');
    assert(restr?.cloudWrite === false, 'cloudWrite false');
    assert(restr?.shell === false, 'shell false');
    assert(restr?.computerUse === false, 'computerUse false');

    const draft = await prisma.skill.findUnique({ where: { id: fdeAuth.session.draftSkillIds[0]! } });
    assert(draft?.reviewStatus === 'AWAITING_USER_CONFIRM', 'skill awaiting confirm');
    assert(draft?.reviewStatus !== 'CONFIRMED', 'never confirmed on authorize');
    assert(draft?.contentMd.includes('AR-training.xlsx'), 'uploaded source included in skill draft');
    assert(!draft?.contentMd.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'raw secret absent from skill');
    console.log('  ✓ FDE create PAUSED + inert draft');

    // ── 5. Foreign user 404 ──
    const foreignErr = await expectThrow(
      () =>
        getBuilderSession({
          sessionId: session.id,
          userId: foreign.id,
          role: 'MEMBER',
        }),
      'foreign get',
    );
    assert(
      foreignErr instanceof ApiError && foreignErr.statusCode === 404,
      'foreign → 404',
    );

    const appForeign = await app.inject({
      method: 'GET',
      url: `/api/agent-builder/sessions/${session.id}`,
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    assert(appForeign.statusCode === 404, `HTTP foreign 404 got ${appForeign.statusCode}`);
    console.log('  ✓ foreign user 404');

    // FDE may inspect
    const fdeView = await getBuilderSession({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
    });
    assert(fdeView.id === session.id, 'FDE can inspect');

    // ── 6. Test without data fails closed; engine failure → FAILED ──
    const noDataErr = await expectThrow(
      () =>
        runBuilderTest({
          sessionId: session.id,
          userId: owner.id,
          role: owner.role,
          runAgentFn: async () => passOutcome(),
        }),
      'test without data',
    );
    assert(noDataErr instanceof ApiError, 'test without data is ApiError');

    await submitBuilderTestData({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      data: { mails: ['假帳款 A 100', '假帳款 B 200'] },
      expected: '兩列合計 300',
    });

    const failRun = await runBuilderTest({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async () => failOutcome(),
    });
    assert(failRun.status === 'FAILED', 'engine fail → FAILED');
    assert(failRun.session.testResult?.status === 'FAILED', 'testResult FAILED');
    assert(failRun.session.testResult?.ok === false, 'ok false');

    const throwRun = await runBuilderTest({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async () => {
        throw new Error('cli exploded sk-abcdefghijklmnopqrstuv');
      },
    });
    assert(throwRun.status === 'FAILED', 'throw → FAILED');
    assert(
      !JSON.stringify(throwRun.session.testResult).includes('sk-abcdefghijklmn'),
      'error redacted in test result',
    );
    console.log('  ✓ test fail-closed + injectable failure');

    // Pass path with injectable runner
    let forceVerifySeen = false;
    let draftMountedSeen = false;
    const passRun = await runBuilderTest({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async (opts) => {
        forceVerifySeen =
          opts.forceVerify === true && opts.builderTestSessionId === session.id;
        const normalManifest = await compileManifest(
          opts.agentId,
          undefined,
          `/tmp/${opts.agentId}`,
          String(opts.input.message ?? ''),
          true,
        );
        assert(
          !normalManifest.builderTestDraftContent &&
            !normalManifest.skills.some((skill) => skill.name === draft!.slug),
          'normal manifest must never mount the pending draft',
        );
        const foreignCapability = await expectThrow(
          () =>
            compileManifest(
              opts.agentId,
              undefined,
              `/tmp/${opts.agentId}`,
              String(opts.input.message ?? ''),
              true,
              { sessionId: opts.builderTestSessionId!, triggeredBy: foreign.id },
            ),
          'foreign actor builder test capability',
        );
        assert(foreignCapability instanceof ApiError, 'foreign actor cannot load draft test manifest');
        const manifest = await compileManifest(
          opts.agentId,
          undefined,
          `/tmp/${opts.agentId}`,
          String(opts.input.message ?? ''),
          true,
          { sessionId: opts.builderTestSessionId!, triggeredBy: opts.triggeredBy },
        );
        draftMountedSeen =
          manifest.builderTestDraftSkillIds?.includes(fdeAuth.session.draftSkillIds[0]!) === true &&
          manifest.builderTestDraftContent?.includes(draft!.contentMd) === true &&
          manifest.engineExecute === 'CLAUDE_CODE' &&
          manifest.engineVerify === 'CODEX' &&
          manifest.restrictions.testIsolation === true &&
          manifest.memoryCore === '' &&
          manifest.steps[0]?.verifyRubric?.includes('兩列合計 300') === true &&
          manifest.restrictions.webSearch === false &&
          manifest.restrictions.sendEmail === false &&
          manifest.restrictions.cloudWrite === false &&
          manifest.restrictions.shell === false;
        assert(
          canUseSemanticRecall(manifest.restrictions) === false,
          'isolated draft test must bypass semantic recall before embedding',
        );
        const deniedTools = claudeDisallowedTools(manifest.restrictions);
        for (const tool of ['WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit']) {
          assert(deniedTools.includes(tool), `isolated Claude test must deny ${tool}`);
        }
        return passOutcome();
      },
    });
    assert(passRun.status === 'PASSED', 'pass → PASSED');
    assert(forceVerifySeen, 'builder test must force cross-model verification');
    assert(draftMountedSeen, 'isolated test manifest must contain the exact draft under least privilege');
    const staleCapability = await expectThrow(
      () =>
        compileManifest(
          fdeAuth.session.builtAgentId!,
          undefined,
          `/tmp/${fdeAuth.session.builtAgentId}`,
          'stale',
          true,
          { sessionId: session.id, triggeredBy: owner.id },
        ),
      'stale builder test capability',
    );
    assert(staleCapability instanceof ApiError, 'non-TESTING session cannot load pending draft');
    console.log('  ✓ injectable pass tests exact draft under least privilege');

    const skippedRun = await runBuilderTest({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async () => skippedVerifyOutcome(),
    });
    assert(skippedRun.status === 'FAILED', 'skipVerify evidence must fail builder test');
    console.log('  ✓ skipVerify cannot produce PASSED');

    // Timeout must fail closed and clear its timer.
    await submitBuilderTestData({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      data: 'timeout fixture',
      expected: 'must not pass',
    });
    const timeoutRun = await runBuilderTest({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async () => new Promise<RunOutcome>(() => {}),
      timeoutMs: 5,
    });
    assert(timeoutRun.status === 'FAILED', 'timeout → FAILED');
    console.log('  ✓ timeout fail-closed');

    // Return the main session to PASSED for finalize.
    const passAgain = await runBuilderTest({
      sessionId: session.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async () => passOutcome(),
    });
    assert(passAgain.status === 'PASSED', 'retest pass → PASSED');

    // A model-returned pass without a persisted Run/RunStep must never activate.
    const noEvidenceFin = await expectThrow(
      () =>
        finalizeBuilderSession({
          sessionId: session.id,
          userId: owner.id,
          role: owner.role,
        }),
      'finalize without persisted evidence',
    );
    assert(noEvidenceFin instanceof ApiError && noEvidenceFin.statusCode === 409, 'missing run evidence → 409');

    // Injectable runner avoids paid CLIs, so seed persisted evidence in stages
    // and prove mismatched draft evidence / empty verdict both fail closed.
    const evidenceRunId = passAgain.session.lastRunId!;
    await prisma.run.create({
      data: {
        id: evidenceRunId,
        agentId: fdeAuth.session.builtAgentId!,
        triggeredBy: owner.id,
        status: 'SUCCEEDED',
        input: { fixture: true },
        output: { ok: true },
        runDir: `/tmp/${evidenceRunId}`,
      },
    });
    await prisma.runStep.create({
      data: {
        id: ulid(),
        runId: evidenceRunId,
        stepKey: 'chat',
        round: 1,
        status: 'approved',
        output: 'ok',
        verdict: null,
        approved: true,
        endedAt: new Date(),
      },
    });

    const wrongDraftEvidenceFin = await expectThrow(
      () =>
        finalizeBuilderSession({
          sessionId: session.id,
          userId: owner.id,
          role: owner.role,
        }),
      'finalize with mismatched draft evidence',
    );
    assert(wrongDraftEvidenceFin instanceof ApiError && wrongDraftEvidenceFin.statusCode === 409, 'wrong draft evidence → 409');

    await prisma.run.update({
      where: { id: evidenceRunId },
      data: {
        input: {
          fixture: true,
          builderTestEvidence: {
            sessionId: session.id,
            draftSkillIds: fdeAuth.session.draftSkillIds,
          },
        },
      },
    });
    const emptyVerdictFin = await expectThrow(
      () =>
        finalizeBuilderSession({
          sessionId: session.id,
          userId: owner.id,
          role: owner.role,
        }),
      'finalize with empty verdict',
    );
    assert(emptyVerdictFin instanceof ApiError && emptyVerdictFin.statusCode === 409, 'empty verdict → 409');
    await prisma.runStep.updateMany({
      where: { runId: evidenceRunId },
      data: { round: 2, verdict: '## Verdict\nAPPROVED' },
    });
    await prisma.runStep.create({
      data: {
        id: ulid(),
        runId: evidenceRunId,
        stepKey: 'chat',
        round: 1,
        status: 'rejected',
        output: 'first attempt',
        verdict: '## Verdict\nISSUES FOUND',
        approved: false,
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(Date.now() - 59_000),
      },
    });

    // ── 7. Finalize before PASSED / MEMBER fails; FDE finalize audited ──
    // MEMBER finalize
    const memFin = await expectThrow(
      () =>
        finalizeBuilderSession({
          sessionId: session.id,
          userId: member.id,
          role: 'MEMBER',
        }),
      'member finalize',
    );
    assert(memFin instanceof ApiError && memFin.statusCode === 403, 'MEMBER finalize 403');

    // Create a separate session stuck at PLAN_READY and try finalize
    const s2 = await createBuilderSession({
      userId: owner.id,
      message: '簡單的每日摘要機器人，讀內部公告做成三點摘要給主管',
    });
    sessionIds.push(s2.session.id);
    let s2s = s2.session;
    let g2 = 0;
    while (s2s.status === 'DISCOVERY' && g2 < 10) {
      g2 += 1;
      const key = s2s.progress?.currentKey ?? 'process';
      const r = await postBuilderMessage({
        sessionId: s2s.id,
        userId: owner.id,
        role: owner.role,
        message: `回答 ${key}：標準流程即可，不寄信`,
      });
      s2s = r.session;
    }
    if (s2s.status === 'PLAN_READY') {
      const earlyFin = await expectThrow(
        () =>
          finalizeBuilderSession({
            sessionId: s2s.id,
            userId: owner.id,
            role: owner.role,
          }),
        'finalize before passed',
      );
      assert(earlyFin instanceof ApiError, 'finalize before PASSED fails');
    }

    const concurrentFinalize = await Promise.allSettled([
      finalizeBuilderSession({
        sessionId: session.id,
        userId: owner.id,
        role: owner.role,
      }),
      finalizeBuilderSession({
        sessionId: session.id,
        userId: owner.id,
        role: owner.role,
      }),
    ]);
    const finalized = concurrentFinalize.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof finalizeBuilderSession>>> =>
        result.status === 'fulfilled',
    );
    const rejectedFinalize = concurrentFinalize.filter((result) => result.status === 'rejected');
    assert(finalized.length === 1 && rejectedFinalize.length === 1, 'concurrent finalize must have one winner');
    const fin = finalized[0]!.value;
    assert(fin.status === 'ACTIVE', 'finalize → ACTIVE');
    const confirmed = await prisma.skill.findUnique({
      where: { id: fdeAuth.session.draftSkillIds[0]! },
    });
    assert(confirmed?.reviewStatus === 'CONFIRMED', 'skill confirmed on finalize');
    const activated = await prisma.agent.findUnique({
      where: { id: fdeAuth.session.builtAgentId! },
    });
    assert(activated?.status === 'ACTIVE', 'agent activated');

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'agent_builder.finalized', entityId: session.id },
      orderBy: { createdAt: 'desc' },
    });
    assert(auditRow, 'finalize audited');
    console.log('  ✓ finalize FDE-only + audited');

    // Reuse strategy: only a builder draft link may change the existing Agent.
    const financeBefore = await prisma.agent.findUniqueOrThrow({ where: { id: financeAgentId } });
    const sReuse = await createBuilderSession({
      userId: owner.id,
      message: '請沿用財務帳款助理，讀 Gmail 帳款並做成每週財務報告；寄信一定先問我。',
    });
    sessionIds.push(sReuse.session.id);
    let reuseSession = sReuse.session;
    let reuseGuard = 0;
    while (reuseSession.status === 'DISCOVERY' && reuseGuard++ < 10) {
      const key = reuseSession.progress?.currentKey ?? 'process';
      const reply = await postBuilderMessage({
        sessionId: reuseSession.id,
        userId: owner.id,
        role: owner.role,
        message: key === 'testData' ? '測試資料：帳款 100；期望結果：報告金額 100' : `回答 ${key}：依建議且不可逆操作需核准`,
      });
      reuseSession = reply.session;
    }
    const reuseBuild = await authorizeBuilderSession({
      sessionId: reuseSession.id,
      userId: owner.id,
      role: owner.role,
      strategy: 'reuse',
      targetAgentId: financeAgentId,
    });
    skillIds.push(...reuseBuild.session.draftSkillIds);
    const financeAfter = await prisma.agent.findUniqueOrThrow({ where: { id: financeAgentId } });
    assert(financeAfter.name === financeBefore.name, 'reuse must not rename agent');
    assert(financeAfter.rolePrompt === financeBefore.rolePrompt, 'reuse must not rewrite role');
    assert(JSON.stringify(financeAfter.restrictions) === JSON.stringify(financeBefore.restrictions), 'reuse restrictions unchanged');
    const reuseDraft = await prisma.skill.findUniqueOrThrow({
      where: { id: reuseBuild.session.draftSkillIds[0]! },
    });
    assert(reuseDraft.reviewStatus === 'AWAITING_USER_CONFIRM', 'reuse draft inert');
    await submitBuilderTestData({
      sessionId: reuseSession.id,
      userId: owner.id,
      role: owner.role,
      data: '帳款 100',
      expected: '報告金額 100，不寄信',
    });
    let reuseIsolated = false;
    const reuseTest = await runBuilderTest({
      sessionId: reuseSession.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async (opts) => {
        const manifest = await compileManifest(
          opts.agentId,
          undefined,
          `/tmp/${opts.agentId}`,
          String(opts.input.message ?? ''),
          true,
          { sessionId: opts.builderTestSessionId!, triggeredBy: opts.triggeredBy },
        );
        reuseIsolated =
          manifest.builderTestDraftContent?.includes(reuseDraft.contentMd) === true &&
          manifest.engineExecute === 'CLAUDE_CODE' &&
          manifest.engineVerify === 'CODEX' &&
          manifest.restrictions.testIsolation === true &&
          manifest.memoryCore === '' &&
          manifest.restrictions.webSearch === false &&
          manifest.restrictions.computerUse === false &&
          manifest.restrictions.sendEmail === false &&
          manifest.restrictions.cloudWrite === false &&
          manifest.restrictions.shell === false &&
          manifest.restrictions.cloudEmbedding === false;
        return passOutcome();
      },
    });
    assert(reuseTest.status === 'PASSED', 'reuse isolated test passes');
    assert(reuseIsolated, 'reuse test must not inherit the existing Agent high privileges');
    const lateResult = await runBuilderTest({
      sessionId: reuseSession.id,
      userId: owner.id,
      role: owner.role,
      runAgentFn: async () => {
        await prisma.agentBuildSession.update({
          where: { id: reuseSession.id },
          data: {
            status: 'FAILED',
            lastAssistantMessage: '模擬逾時回收',
          },
        });
        return passOutcome();
      },
    });
    assert(lateResult.status === 'FAILED', 'late success must not overwrite recovered FAILED');
    console.log('  ✓ reuse isolation + late result cannot overwrite FAILED');

    // ── HTTP smoke: create session via route ──
    const httpCreate = await app.inject({
      method: 'POST',
      url: '/api/agent-builder/sessions',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      payload: { message: '幫我建立一個每週彙整專案進度的員工' },
    });
    assert(httpCreate.statusCode === 200, `http create ${httpCreate.statusCode}`);
    const httpBody = httpCreate.json() as { success: boolean; data: { session: { id: string } } };
    assert(httpBody.success, 'envelope ok');
    sessionIds.push(httpBody.data.session.id);

    // Unauthorized
    const noAuth = await app.inject({
      method: 'POST',
      url: '/api/agent-builder/sessions',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'x' },
    });
    assert(noAuth.statusCode === 401, `no auth must be 401, got ${noAuth.statusCode}`);

    // Trainer can authorize awaiting session via HTTP
    const httpGet = await app.inject({
      method: 'GET',
      url: `/api/agent-builder/sessions/${session.id}`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    assert(httpGet.statusCode === 200, 'trainer get session');

    console.log('  ✓ HTTP routes smoke');
    console.log('── all agent-builder tests passed ──');
  } finally {
    // Cleanup builder sessions first
    if (sessionIds.length) {
      await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
    // Unlink + delete skills
    if (skillIds.length) {
      await prisma.agentSkill.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skill.deleteMany({ where: { id: { in: skillIds } } });
    }
    // Delete agents created by tests (and finance seed)
    if (agentIds.length) {
      await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.run.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => undefined);
      await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    }
    if (createdMember) {
      await prisma.user.delete({ where: { id: createdMember } }).catch(() => undefined);
    }
    if (createdForeign) {
      await prisma.user.delete({ where: { id: createdForeign } }).catch(() => undefined);
    }
    await app.close();
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
