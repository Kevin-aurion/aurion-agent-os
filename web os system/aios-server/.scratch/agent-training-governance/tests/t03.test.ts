/**
 * Ticket 03 — hard-block intercepts auto-create VIOLATION proposals.
 * Run: npx tsx .scratch/agent-training-governance/tests/t03.test.ts
 *
 * Seams (external behaviour only):
 * 1. COMPUTER_CONTROL with computerUse=false → step rejected + VIOLATION proposal
 * 2. upload_to_cloud with cloudWrite=false → still throws + proposal
 * 3. budget exceed → run fail-closed + proposal
 * 4. same runId + same kind → only one proposal (dedup)
 * 5. recordViolation failure must not affect caller (fail-safe)
 *
 * Unobservable intercepts (shell/webSearch via CLI --disallowedTools, OS sandbox
 * EPERM) are intentionally NOT faked — see ADR 0004 + issue comments in code.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { runAgent } from '../../../src/engine/runner.js';
import { runTool } from '../../../src/engine/tools.js';
import { recordViolation } from '../../../src/lib/changeproposal.js';
import { guardBudget, BudgetExceededError, recordCost } from '../../../src/engine/cost.js';

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

async function countViolationProposals(agentId: string, runId: string | null, kindSubstring: string) {
  const rows = await prisma.changeProposal.findMany({
    where: {
      agentId,
      ...(runId ? { runId } : {}),
      source: 'VIOLATION',
      status: 'PENDING',
    },
  });
  return rows.filter((p) => {
    const c = p.proposedChange as { violation?: unknown } | null;
    const v = typeof c?.violation === 'string' ? c.violation : '';
    return v.toLowerCase().includes(kindSubstring.toLowerCase());
  });
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER user');

  const tag = ulid().slice(-8).toLowerCase();
  const agentCcId = ulid();
  const agentCloudId = ulid();
  const agentBudgetId = ulid();
  const agentDedupId = ulid();
  const agentFailSafeId = ulid();
  const wfCcId = ulid();
  const stepCcId = ulid();
  const agentIds = [agentCcId, agentCloudId, agentBudgetId, agentDedupId, agentFailSafeId];
  const runIds: string[] = [];

  console.log('── setup: agents + workflow ──');
  await prisma.agent.create({
    data: {
      id: agentCcId,
      slug: `t03-cc-${tag}`,
      name: 'T03 ComputerUse Off',
      description: 'temp t03',
      rolePrompt: 'test',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
    },
  });
  await prisma.workflow.create({
    data: {
      id: wfCcId,
      agentId: agentCcId,
      name: 't03-cc-wf',
      description: 't03 computer control hard-block',
      enabled: true,
      trigger: { type: 'MANUAL' },
      steps: {
        create: [
          {
            id: stepCcId,
            position: 0,
            stepKey: 'desktop',
            type: 'COMPUTER_CONTROL',
            config: { skillId: 'dummy-skill', instructions: 'open calculator' },
          },
        ],
      },
    },
  });

  await prisma.agent.create({
    data: {
      id: agentCloudId,
      slug: `t03-cloud-${tag}`,
      name: 'T03 CloudWrite Off',
      description: 'temp t03',
      rolePrompt: 'test',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
    },
  });

  await prisma.agent.create({
    data: {
      id: agentBudgetId,
      slug: `t03-budget-${tag}`,
      name: 'T03 Budget Hard Stop',
      description: 'temp t03',
      rolePrompt: 'test',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
      costPolicy: { dailyBudgetUsd: 0.000001, hardStop: true },
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
    },
  });

  await prisma.agent.create({
    data: {
      id: agentDedupId,
      slug: `t03-dedup-${tag}`,
      name: 'T03 Dedup',
      description: 'temp t03',
      rolePrompt: 'test',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
    },
  });

  await prisma.agent.create({
    data: {
      id: agentFailSafeId,
      slug: `t03-fs-${tag}`,
      name: 'T03 FailSafe',
      description: 'temp t03',
      rolePrompt: 'test',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
    },
  });

  try {
    // ── [1] computerUse=false → COMPUTER_CONTROL rejected + VIOLATION ──
    console.log('\n── [1] computerUse=false COMPUTER_CONTROL → reject + VIOLATION ──');
    const outcomeCc = await runAgent({
      agentId: agentCcId,
      workflowId: wfCcId,
      triggeredBy: owner.id,
      input: {},
    });
    runIds.push(outcomeCc.runId);
    console.log('cc status:', outcomeCc.status, 'ok:', outcomeCc.ok, 'stoppedAt:', outcomeCc.stoppedAt);
    assert(outcomeCc.ok === false, 'run must fail');
    const ccStep = outcomeCc.results.find((r) => r.stepKey === 'desktop') ?? outcomeCc.results[0];
    assert(!!ccStep, 'have step result');
    assert(ccStep!.ok === false, 'step must fail');
    assert(
      /RESTRICTED|電腦操控|computer/i.test(ccStep!.reason ?? ccStep!.output ?? ''),
      `reason should mention restricted computer use, got: ${ccStep!.reason}`,
    );
    const ccProps = await countViolationProposals(agentCcId, outcomeCc.runId, 'computer_use');
    console.log('cc proposals:', ccProps.length, ccProps.map((p) => p.proposedChange));
    assert(ccProps.length === 1, `expected 1 computer_use VIOLATION, got ${ccProps.length}`);
    assert(ccProps[0]!.source === 'VIOLATION', 'source VIOLATION');
    assert(ccProps[0]!.proposedBy === 'system', 'proposedBy system');
    assert(ccProps[0]!.targetType === 'RESTRICTION', 'targetType RESTRICTION');
    assert((ccProps[0]!.severity ?? '').toLowerCase() === 'high', 'severity high');
    console.log('PASS [1] computer_use violation proposal');

    // ── [2] cloudWrite=false → upload_to_cloud throws + proposal ──
    console.log('\n── [2] cloudWrite=false upload_to_cloud → throw + VIOLATION ──');
    const cloudRunId = ulid();
    runIds.push(cloudRunId);
    // Create a run row so FK / observability is consistent if needed
    await prisma.run.create({
      data: {
        id: cloudRunId,
        agentId: agentCloudId,
        triggeredBy: owner.id,
        status: 'RUNNING',
        input: {},
        runDir: `/tmp/t03-${cloudRunId}`,
      },
    });
    const cloudErr = await expectThrow(
      () =>
        runTool(
          '/tmp',
          'upload_to_cloud',
          { files: ['out.txt'] },
          {
            agentId: agentCloudId,
            agentDir: '/tmp',
            cloudWrite: false,
            sendEmail: false,
            runId: cloudRunId,
          },
        ),
      'upload_to_cloud restricted',
    );
    console.log('cloud throw:', cloudErr.message.slice(0, 120));
    assert(/^RESTRICTED:/i.test(cloudErr.message), `must still throw RESTRICTED, got: ${cloudErr.message}`);
    // Give async record a tick if fire-and-forget (should be awaited)
    await new Promise((r) => setTimeout(r, 50));
    const cloudProps = await countViolationProposals(agentCloudId, cloudRunId, 'cloud_write');
    console.log('cloud proposals:', cloudProps.length);
    assert(cloudProps.length === 1, `expected 1 cloud_write VIOLATION, got ${cloudProps.length}`);
    console.log('PASS [2] cloud_write violation proposal');

    // ── [3] budget exceed → fail-closed + proposal ──
    console.log('\n── [3] budget exceed → fail-closed + VIOLATION ──');
    // Seed spend so guardBudget trips immediately
    await recordCost({
      agentId: agentBudgetId,
      engine: 'CLAUDE_CODE',
      inputText: 'x'.repeat(5000),
      outputText: 'y'.repeat(5000),
      stepKey: 'seed',
    });
    // Direct guard evidence
    const budgetErr = await expectThrow(
      () => guardBudget(agentBudgetId, { dailyBudgetUsd: 0.000001, hardStop: true }),
      'guardBudget',
    );
    assert(budgetErr instanceof BudgetExceededError, 'BudgetExceededError');
    console.log('guardBudget:', budgetErr.message.slice(0, 100));

    // Full run path: chat DO step hits guardBudget before engine
    const outcomeBudget = await runAgent({
      agentId: agentBudgetId,
      triggeredBy: owner.id,
      input: { message: 'hello budget test' },
    });
    runIds.push(outcomeBudget.runId);
    console.log('budget status:', outcomeBudget.status, 'ok:', outcomeBudget.ok);
    assert(outcomeBudget.ok === false, 'budget run must fail');
    const budgetReason = [
      outcomeBudget.stoppedAt,
      ...outcomeBudget.results.map((r) => r.reason ?? r.output),
    ].join(' | ');
    console.log('budget reason sample:', budgetReason.slice(0, 200));
    assert(
      /預算|budget|BUDGET|fail-closed/i.test(budgetReason),
      `expect budget fail-closed wording, got: ${budgetReason.slice(0, 300)}`,
    );
    const budgetProps = await countViolationProposals(agentBudgetId, outcomeBudget.runId, 'budget');
    console.log('budget proposals:', budgetProps.length, budgetProps.map((p) => p.proposedChange));
    assert(budgetProps.length >= 1, `expected ≥1 budget VIOLATION, got ${budgetProps.length}`);
    assert(budgetProps.length === 1, `dedup within budget run: expected 1, got ${budgetProps.length}`);
    console.log('PASS [3] budget violation proposal');

    // ── [4] same runId + kind → only one proposal ──
    console.log('\n── [4] dedup: same runId + kind → one proposal ──');
    const dedupRunId = ulid();
    runIds.push(dedupRunId);
    await recordViolation({
      agentId: agentDedupId,
      runId: dedupRunId,
      kind: 'computer_use',
      detail: { n: 1 },
    });
    await recordViolation({
      agentId: agentDedupId,
      runId: dedupRunId,
      kind: 'computer_use',
      detail: { n: 2 },
    });
    await recordViolation({
      agentId: agentDedupId,
      runId: dedupRunId,
      kind: 'computer_use',
      detail: { n: 3 },
    });
    const dedupProps = await countViolationProposals(agentDedupId, dedupRunId, 'computer_use');
    assert(dedupProps.length === 1, `dedup expected 1, got ${dedupProps.length}`);
    // Different kind still allowed
    await recordViolation({
      agentId: agentDedupId,
      runId: dedupRunId,
      kind: 'cloud_write',
      detail: { n: 4 },
    });
    const cloudKind = await countViolationProposals(agentDedupId, dedupRunId, 'cloud_write');
    assert(cloudKind.length === 1, 'different kind creates second proposal');
    console.log('PASS [4] dedup by runId+kind');

    // ── [5] recordViolation create failure does not throw ──
    console.log('\n── [5] fail-safe: createProposal failure is swallowed ──');
    const origCreate = prisma.changeProposal.create.bind(prisma.changeProposal);
    (prisma.changeProposal as { create: typeof origCreate }).create = (async () => {
      throw new Error('injected changeProposal.create failure');
    }) as typeof origCreate;
    try {
      // Must resolve (not throw) even when underlying create always fails.
      await recordViolation({
        agentId: agentFailSafeId,
        runId: ulid(),
        kind: 'computer_use',
        detail: { inject: true },
      });
    } finally {
      (prisma.changeProposal as { create: typeof origCreate }).create = origCreate;
    }
    console.log('PASS [5] recordViolation is fail-safe (never throws)');

    console.log('\n══ ALL t03 TESTS PASSED ══');
  } finally {
    console.log('\n── cleanup ──');
    try {
      await prisma.changeProposal.deleteMany({ where: { agentId: { in: agentIds } } });
    } catch {
      /* ignore */
    }
    await prisma.costLog.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.runStep.deleteMany({ where: { run: { agentId: { in: agentIds } } } }).catch(() => {});
    await prisma.computerControlTask.deleteMany({ where: { run: { agentId: { in: agentIds } } } }).catch(() => {});
    await prisma.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.workflowStep.deleteMany({ where: { workflowId: wfCcId } }).catch(() => {});
    await prisma.workflow.deleteMany({ where: { id: wfCcId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('\nTEST FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
