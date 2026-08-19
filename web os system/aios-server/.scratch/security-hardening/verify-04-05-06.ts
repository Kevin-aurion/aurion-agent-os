/**
 * Acceptance tests for tickets 04 / 05 / 06 (security-hardening).
 * Run: npx tsx .scratch/security-hardening/verify-04-05-06.ts
 * Creates temporary agent/workflow rows and cleans them up.
 */
import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import {
  isRunApproved,
  durableHighRiskRejected,
  createApproval,
  requiresApproval,
} from '../../src/lib/approval.js';
import { runAgent } from '../../src/engine/index.js';
import { runWorkflow } from '../../src/workflow/runner.js';
import { ApiError } from '../../src/lib/http.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  const user = await prisma.user.findFirst();
  assert(user, 'need at least one user in DB');

  const agentId = ulid();
  const slug = `sec-test-${agentId.slice(-8).toLowerCase()}`;
  const wfId = ulid();
  const createdRunIds: string[] = [];
  const createdApprovalIds: string[] = [];

  console.log('── setup temp high-risk agent ──');
  await prisma.agent.create({
    data: {
      id: agentId,
      slug,
      name: 'SEC-TEST high-risk',
      description: 'temp for security-hardening verify',
      rolePrompt: 'You are a test agent. Reply with OK.',
      riskTier: 'high',
      createdBy: user.id,
      restrictions: { webSearch: false, computerUse: false, sendEmail: false, cloudWrite: false, shell: false },
    },
  });
  await prisma.workflow.create({
    data: {
      id: wfId,
      agentId,
      name: 'SEC-TEST durable high',
      description: 'temp',
      enabled: true,
      durable: true,
      trigger: { type: 'manual' },
      steps: {
        create: [
          {
            id: ulid(),
            position: 0,
            stepKey: 'step1',
            type: 'DO',
            config: { instruction: 'Reply with the single word OK.' },
          },
        ],
      },
    },
  });

  try {
    // ── 04/2 負向：偽造 approvedApprovalId 不可繞過 ─────────────────────
    console.log('\n── [2] negative: fake approvedApprovalId must NOT bypass gate ──');
    const fakeRunId = ulid();
    const fakeOut = await runAgent({
      agentId,
      runId: fakeRunId,
      input: { message: 'should not execute' },
      triggeredBy: user.id,
      approvedApprovalId: 'temporal-durable',
    });
    createdRunIds.push(fakeOut.runId);
    console.log('outcome:', {
      status: fakeOut.status,
      ok: fakeOut.ok,
      stoppedAt: fakeOut.stoppedAt,
      runId: fakeOut.runId,
    });
    assert(fakeOut.status === 'AWAITING_REVIEW', `expected AWAITING_REVIEW, got ${fakeOut.status}`);
    assert(fakeOut.ok === false, 'ok should be false');
    const fakeIsApproved = await isRunApproved(fakeRunId, 'temporal-durable');
    console.log('isRunApproved(fake):', fakeIsApproved);
    assert(fakeIsApproved === false, 'isRunApproved must be false for forged id');
    console.log('PASS [2] fake approval blocked');

    // ── 04/3 正向：真 APPROVED 後可續跑 ─────────────────────────────────
    console.log('\n── [3] positive: real APPROVED approval resumes past gate ──');
    const haltOut = await runAgent({
      agentId,
      input: { message: 'halt for approval' },
      triggeredBy: user.id,
    });
    createdRunIds.push(haltOut.runId);
    assert(haltOut.status === 'AWAITING_REVIEW', `halt expected AWAITING_REVIEW, got ${haltOut.status}`);

    const pending = await prisma.approvalRequest.findUnique({ where: { runId: haltOut.runId } });
    assert(pending, 'ApprovalRequest should exist after halt');
    createdApprovalIds.push(pending.id);
    assert(pending.status === 'PENDING', 'should be PENDING');

    await prisma.approvalRequest.update({
      where: { id: pending.id },
      data: { status: 'APPROVED', decidedBy: user.id, decidedAt: new Date() },
    });
    const realApproved = await isRunApproved(haltOut.runId, pending.id);
    console.log('isRunApproved(real):', realApproved);
    assert(realApproved === true, 'isRunApproved must be true after APPROVED');
    assert(
      requiresApproval('high', realApproved) === false,
      'requiresApproval must be false when already approved',
    );

    // Resume: should pass gate. Engine may SUCCEED/FAIL depending on CLI — not AWAITING_REVIEW.
    const resumeOut = await runAgent({
      agentId,
      runId: haltOut.runId,
      input: { message: 'resume after approval — reply OK' },
      triggeredBy: user.id,
      approvedApprovalId: pending.id,
    });
    console.log('resume outcome:', {
      status: resumeOut.status,
      ok: resumeOut.ok,
      stoppedAt: resumeOut.stoppedAt,
      resultsLen: resumeOut.results?.length,
      hasRunDir: !!resumeOut.runDir,
    });
    assert(
      resumeOut.status !== 'AWAITING_REVIEW',
      `legal approval must not re-halt; got ${resumeOut.status}`,
    );
    // Full serializable shape (ticket 05 shape on any run path)
    assert(typeof resumeOut.ok === 'boolean', 'ok boolean');
    assert(typeof resumeOut.runId === 'string', 'runId');
    assert(typeof resumeOut.runDir === 'string', 'runDir');
    assert(Array.isArray(resumeOut.results), 'results array');
    assert(Array.isArray(resumeOut.reworkHistory), 'reworkHistory array');
    console.log('PASS [3] legal approval resumes past gate (status=' + resumeOut.status + ')');

    // ── 04/4 durable + high risk throw ──────────────────────────────────
    console.log('\n── [4] durable + high risk rejected at runWorkflow ──');
    assert(durableHighRiskRejected('high', true) === true, 'helper high+durable');
    assert(durableHighRiskRejected('medium', true) === false, 'helper medium+durable');
    assert(durableHighRiskRejected('high', false) === false, 'helper high+nondurable');

    let threw: unknown = null;
    try {
      await runWorkflow(wfId, { message: 'should not start temporal' }, user.id);
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof ApiError, `expected ApiError, got ${threw}`);
    const err = threw as ApiError;
    console.log('error:', { statusCode: err.statusCode, code: err.code, message: err.message });
    assert(err.statusCode === 400, 'status 400');
    assert(
      err.message.includes('耐久工作流尚不支援高風險員工'),
      `message must explain durable+high-risk; got: ${err.message}`,
    );
    console.log('PASS [4] durable+high risk throws badRequest (no Temporal)');

    // ── 06 embedding fail-closed ────────────────────────────────────────
    console.log('\n── [5] agentAllowsCloudEmbedding fail-closed (code + inject) ──');
    const memPath = path.resolve(__dirname, '../../src/memory/memoryService.ts');
    const memSrc = readFileSync(memPath, 'utf8');
    // Extract the catch of agentAllowsCloudEmbedding
    const fnMatch = memSrc.match(
      /async function agentAllowsCloudEmbedding[\s\S]*?catch\s*\{[\s\S]*?return\s+(true|false)\s*;/,
    );
    assert(fnMatch, 'could not find agentAllowsCloudEmbedding catch');
    console.log('catch return value in source:', fnMatch[1]);
    assert(fnMatch[1] === 'false', 'catch must return false (fail-closed)');

    // Inject failure via prisma mock: temporarily break findUnique by using a bad agent id path
    // is already covered by source; also verify public isRunApproved fail-closed pattern exists
    const approvalSrc = readFileSync(
      path.resolve(__dirname, '../../src/lib/approval.ts'),
      'utf8',
    );
    assert(approvalSrc.includes('isRunApproved'), 'isRunApproved exported');
    assert(!approvalSrc.includes("'temporal-durable'"), 'no fake temporal id in approval');
    const actSrc = readFileSync(
      path.resolve(__dirname, '../../src/temporal/activities.ts'),
      'utf8',
    );
    assert(
      !actSrc.includes("approvedApprovalId: 'temporal-durable'"),
      'fake temporal-durable removed from activities',
    );
    assert(actSrc.includes('RunOutcome'), 'activities return RunOutcome type');

    // Runtime inject: force prisma.agent.findUnique to throw inside a local replica of the logic
    async function agentAllowsCloudEmbeddingReplica(agentId: string): Promise<boolean> {
      try {
        const row = await prisma.agent.findUnique({
          where: { id: agentId },
          select: { restrictions: true },
        });
        // same default path as production when row loads
        const r = (row?.restrictions ?? {}) as { cloudEmbedding?: boolean };
        return r.cloudEmbedding !== false;
      } catch {
        return false; // fail-closed (matches production after ticket 06)
      }
    }
    // Monkey-patch: call with disconnect to force failure
    const original = prisma.agent.findUnique.bind(prisma.agent);
    (prisma.agent as { findUnique: typeof original }).findUnique = (async () => {
      throw new Error('injected DB failure');
    }) as typeof original;
    try {
      const allowed = await agentAllowsCloudEmbeddingReplica(agentId);
      console.log('on injected DB failure, allowsCloudEmbedding =', allowed);
      assert(allowed === false, 'must be false on DB failure');
    } finally {
      (prisma.agent as { findUnique: typeof original }).findUnique = original;
    }
    console.log('PASS [5] embedding fail-closed');

    // ── isRunApproved unit edges ────────────────────────────────────────
    console.log('\n── isRunApproved edges ──');
    assert((await isRunApproved('', null)) === false, 'empty → false');
    assert((await isRunApproved(ulid(), 'nope')) === false, 'unknown → false');
    console.log('PASS isRunApproved edges');

    console.log('\n✅ ALL ACCEPTANCE CHECKS PASSED (04/05/06)');
  } finally {
    console.log('\n── cleanup ──');
    await prisma.approvalRequest.deleteMany({
      where: { OR: [{ agentId }, { id: { in: createdApprovalIds } }, { runId: { in: createdRunIds } }] },
    });
    await prisma.run.deleteMany({ where: { agentId } });
    await prisma.workflowStep.deleteMany({ where: { workflowId: wfId } });
    await prisma.workflow.deleteMany({ where: { id: wfId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
