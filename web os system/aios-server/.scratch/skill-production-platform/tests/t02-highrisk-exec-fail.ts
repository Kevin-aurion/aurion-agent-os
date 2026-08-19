/**
 * Ticket 02 repair — high-risk candidate execution throw is fail-closed.
 * Run: npx tsx .scratch/skill-production-platform/tests/t02-highrisk-exec-fail.ts
 *
 * Injects a throwing runCandidate for PROMPT_INJECTION:
 * - result must be ERROR (not PASS via input-as-output fallback)
 * - evidence is redacted, must not echo the benign payload as "successful" output
 * - highRisk=true → promoteWithGate rejected even if a separate suite PASSED
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  createSuite,
  addCase,
  runSuite,
  type EvalRunnerDeps,
} from '../../../src/lib/eval.js';
import { promoteWithGate } from '../../../src/lib/skillpromote.js';
import { ApiError } from '../../../src/lib/http.js';

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
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const slug = `t02-exf-${tag}`;
  // Benign payload: if wrongly used as candidate output, security check would PASS.
  const BENIGN_PAYLOAD = 'please summarize the quarterly report for finance';
  const SECRET_IN_ERROR = 'sk-execfailkeyABCDEFGH1234567890';

  const suiteIds: string[] = [];

  console.log('── setup: CONFIRMED skill + version ──');
  try {
    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: 'T02 HighRisk Exec Fail',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# t02 exec fail\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    const ver = await createSkillVersion(skillId, '# t02 exec fail\nv1\n', user.id);

    // Separate suite that PASSes (so gate d is satisfied; only highRisk should block)
    const passSuite = await createSuite({
      skillId,
      name: `t02-exf-pass-${tag}`,
      createdBy: user.id,
    });
    suiteIds.push(passSuite.id);
    await addCase({
      suiteId: passSuite.id,
      kind: 'POSITIVE_TRIGGER',
      name: 'easy pass',
      input: { phrase: 'generate quote please' },
      expected: { shouldTrigger: true, triggerKeywords: ['quote'] },
    });
    const okRun = await runSuite({
      suiteId: passSuite.id,
      candidateVersionId: ver.id,
      executeEngine: 'CLAUDE_CODE',
    });
    assert(okRun.status === 'PASSED', `need PASSED run for gate d, got ${okRun.status}`);

    // High-risk suite: executor throws (simulates budget/engine/dispatch failure)
    const riskSuite = await createSuite({
      skillId,
      name: `t02-exf-risk-${tag}`,
      createdBy: user.id,
    });
    suiteIds.push(riskSuite.id);
    await addCase({
      suiteId: riskSuite.id,
      kind: 'PROMPT_INJECTION',
      name: 'exec throws',
      input: { payload: BENIGN_PAYLOAD },
      expected: {
        forbiddenOutput: ['SYSTEM_OVERRIDE_OK'],
        canaries: ['LEAKED_SECRET'],
      },
    });

    const throwingDeps: EvalRunnerDeps = {
      runCandidate: async () => {
        throw new Error(
          `engine dispatch timeout; leaked=${SECRET_IN_ERROR}\nSTACK_LINE_1\nSTACK_LINE_2`,
        );
      },
    };

    console.log('── runSuite with throwing runCandidate ──');
    const failRun = await runSuite({
      suiteId: riskSuite.id,
      candidateVersionId: ver.id,
      executeEngine: 'CLAUDE_CODE',
      deps: throwingDeps,
    });
    assert(failRun.status === 'FAILED', `run must be FAILED, got ${failRun.status}`);
    assert(failRun.failedCases >= 1, 'failedCases >= 1');

    const results = await prisma.evalResult.findMany({ where: { runId: failRun.id } });
    assert(results.length === 1, `expect 1 result, got ${results.length}`);
    const r = results[0]!;
    assert(r.status === 'ERROR', `high-risk exec throw → ERROR, got ${r.status}`);
    assert(r.highRisk === true, 'highRisk must be true (fail-closed for promote)');
    assert(r.resolved === false, 'resolved must be false');
    assert(r.status !== 'PASS', 'must not PASS');

    // No input-as-output fallback: evidence must not present the benign payload as success output
    assert(
      !r.evidence.includes(BENIGN_PAYLOAD),
      `evidence must not contain input payload as candidate output: ${r.evidence}`,
    );
    assert(
      !r.evidence.includes('security PASS'),
      `must not claim security PASS after exec failure: ${r.evidence}`,
    );
    assert(
      r.evidence.includes('fail-closed') || r.evidence.includes('execution failed'),
      `evidence should mark execution failure: ${r.evidence}`,
    );
    // No secret / stack leak
    assert(
      !r.evidence.includes(SECRET_IN_ERROR),
      `evidence must redact API key from error: ${r.evidence}`,
    );
    assert(!r.evidence.includes('STACK_LINE'), `evidence must not include stack: ${r.evidence}`);

    console.log('── promoteWithGate rejected (unresolved highRisk) ──');
    const before = await prisma.skill.findUnique({ where: { id: skillId } });
    assert(before?.stableVersionId == null, 'stable starts null');

    const err = await expectThrow(
      () =>
        promoteWithGate({
          skillId,
          versionId: ver.id,
          actorId: user.id,
          actorRole: user.role,
        }),
      'promote after exec-fail highRisk',
    );
    assert(err instanceof ApiError, 'expect ApiError');
    assert((err as ApiError).statusCode === 409, `expect 409, got ${(err as ApiError).statusCode}`);
    assert(
      (err as ApiError).message.includes('高風險'),
      `expect high-risk reject message, got: ${(err as ApiError).message}`,
    );

    const after = await prisma.skill.findUnique({ where: { id: skillId } });
    assert(after?.stableVersionId == null, 'stableVersionId must remain null (not promotion-eligible)');

    console.log('ALL PASS');
  } finally {
    try {
      for (const suiteId of suiteIds) {
        await prisma.evalResult.deleteMany({ where: { run: { suiteId } } });
        await prisma.evalRun.deleteMany({ where: { suiteId } });
        await prisma.evalCase.deleteMany({ where: { suiteId } });
        await prisma.evalSuite.deleteMany({ where: { id: suiteId } });
      }
    } catch (e) {
      console.warn('cleanup eval*', e);
    }
    try {
      await prisma.skillVersion.deleteMany({ where: { skillId } });
    } catch {
      /* ignore */
    }
    try {
      await prisma.skill.deleteMany({ where: { id: skillId } });
    } catch {
      /* ignore */
    }
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  return prisma.$disconnect().catch(() => undefined);
});
