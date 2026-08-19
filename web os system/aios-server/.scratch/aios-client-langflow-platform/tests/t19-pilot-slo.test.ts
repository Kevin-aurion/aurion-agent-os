/**
 * Ticket 19 — Pilot SLO aggregation (7d LANGFLOW runs).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t19-pilot-slo.test.ts
 *
 * Real DB. Baseline-then-delta assertions. Cleanup only test-owned rows.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { paths } from '../../../src/config.js';
import { safeJoin } from '../../../src/lib/safepath.js';

let failed = 0;
let passed = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

type PilotSlo = {
  windowDays: number;
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    awaitingReview: number;
    running: number;
  };
  runLatencyMs: { avg: number; p95: number } | null;
  errorCounters: {
    adapterTimeout: number;
    budgetExceeded: number;
    noTerminalEvent: number;
    other: number;
  };
  approvalLatencyMs: { avg: number; count: number } | null;
  costUsd: number;
};

async function main(): Promise<void> {
  console.log('── t19-pilot-slo ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const runOk = ulid();
  const runTimeout = ulid();
  const runNoTerm = ulid();
  const approvalId = ulid();
  const cost1 = ulid();
  const cost2 = ulid();
  const now = Date.now();

  let computePilotSloMetrics: () => Promise<PilotSlo>;

  try {
    try {
      const mod = await import('../../../src/routes/dashboard.js');
      computePilotSloMetrics = (mod as { computePilotSloMetrics?: () => Promise<PilotSlo> })
        .computePilotSloMetrics as () => Promise<PilotSlo>;
      if (typeof computePilotSloMetrics !== 'function') {
        fail('import computePilotSloMetrics', 'function not exported yet');
        console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit) ──`);
        return;
      }
    } catch (e) {
      fail('import dashboard module', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit) ──`);
      return;
    }

    const baseline = await computePilotSloMetrics();
    pass('baseline computePilotSloMetrics ok');

    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t19-slo-owner-${tag}@aios.test`,
        displayName: 'T19 SLO Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t19-slo-agent-${tag}`,
        name: `T19 SLO Agent ${tag}`,
        description: 't19 slo',
        rolePrompt: 't19',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    // SUCCEEDED with 1200ms latency
    const startedOk = new Date(now - 60_000);
    const finishedOk = new Date(startedOk.getTime() + 1200);
    await prisma.run.create({
      data: {
        id: runOk,
        agentId,
        triggeredBy: ownerId,
        status: 'SUCCEEDED',
        input: { tag, kind: 'ok' },
        runtimeKind: 'LANGFLOW',
        runDir: safeJoin(paths.runs, runOk),
        startedAt: startedOk,
        finishedAt: finishedOk,
      },
    });

    // FAILED TIMEOUT
    await prisma.run.create({
      data: {
        id: runTimeout,
        agentId,
        triggeredBy: ownerId,
        status: 'FAILED',
        input: { tag, kind: 'timeout' },
        output: { code: 'TIMEOUT' },
        runtimeKind: 'LANGFLOW',
        runDir: safeJoin(paths.runs, runTimeout),
        startedAt: new Date(now - 50_000),
        finishedAt: new Date(now - 49_000),
      },
    });

    // FAILED NO_TERMINAL_EVENT
    await prisma.run.create({
      data: {
        id: runNoTerm,
        agentId,
        triggeredBy: ownerId,
        status: 'FAILED',
        input: { tag, kind: 'no-term' },
        output: { code: 'NO_TERMINAL_EVENT' },
        runtimeKind: 'LANGFLOW',
        runDir: safeJoin(paths.runs, runNoTerm),
        startedAt: new Date(now - 40_000),
        finishedAt: new Date(now - 39_000),
      },
    });

    // Approval on SUCCEEDED run with known latency (2500ms)
    const apprCreated = new Date(now - 30_000);
    const apprDecided = new Date(apprCreated.getTime() + 2500);
    await prisma.approvalRequest.create({
      data: {
        id: approvalId,
        runId: runOk,
        agentId,
        reason: `t19 slo approval ${tag}`,
        payload: { source: 't19-slo-test' },
        status: 'APPROVED',
        resumeToken: `rt-${tag}`,
        decidedBy: ownerId,
        decidedAt: apprDecided,
        createdAt: apprCreated,
      },
    });

    await prisma.costLog.create({
      data: {
        id: cost1,
        agentId,
        runId: runOk,
        engine: 'CLAUDE_CODE',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      },
    });
    await prisma.costLog.create({
      data: {
        id: cost2,
        agentId,
        runId: runTimeout,
        engine: 'CLAUDE_CODE',
        inputTokens: 20,
        outputTokens: 0,
        costUsd: 0.02,
      },
    });

    console.log('\n── computePilotSloMetrics delta ──');
    const after = await computePilotSloMetrics();

    check(after.windowDays === 7, 'windowDays === 7', `windowDays=${after.windowDays}`);

    const dTotal = after.runs.total - baseline.runs.total;
    const dSucc = after.runs.succeeded - baseline.runs.succeeded;
    const dFail = after.runs.failed - baseline.runs.failed;
    check(dTotal >= 3, 'runs.total delta >= 3', `delta=${dTotal} after=${after.runs.total}`);
    check(dSucc >= 1, 'runs.succeeded delta >= 1', `delta=${dSucc}`);
    check(dFail >= 2, 'runs.failed delta >= 2', `delta=${dFail}`);

    const dTimeout =
      after.errorCounters.adapterTimeout - baseline.errorCounters.adapterTimeout;
    const dNoTerm =
      after.errorCounters.noTerminalEvent - baseline.errorCounters.noTerminalEvent;
    check(
      after.errorCounters.adapterTimeout >= 1 && dTimeout >= 1,
      'errorCounters.adapterTimeout >= 1 (delta)',
      `after=${after.errorCounters.adapterTimeout} delta=${dTimeout}`,
    );
    check(
      after.errorCounters.noTerminalEvent >= 1 && dNoTerm >= 1,
      'errorCounters.noTerminalEvent >= 1 (delta)',
      `after=${after.errorCounters.noTerminalEvent} delta=${dNoTerm}`,
    );

    const dCost = after.costUsd - baseline.costUsd;
    check(
      after.costUsd >= 0.03 && dCost >= 0.029,
      'costUsd >= 0.03 (delta ~0.03)',
      `after=${after.costUsd} delta=${dCost}`,
    );

    const baseApprCount = baseline.approvalLatencyMs?.count ?? 0;
    const afterApprCount = after.approvalLatencyMs?.count ?? 0;
    check(
      after.approvalLatencyMs != null && afterApprCount - baseApprCount >= 1,
      'approvalLatencyMs.count >= 1 (delta)',
      `after=${JSON.stringify(after.approvalLatencyMs)} baseCount=${baseApprCount}`,
    );

    check(
      after.runLatencyMs != null &&
        typeof after.runLatencyMs.avg === 'number' &&
        typeof after.runLatencyMs.p95 === 'number',
      'runLatencyMs non-null with avg/p95',
      JSON.stringify(after.runLatencyMs),
    );
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.costLog.deleteMany({ where: { id: { in: [cost1, cost2] } } }).catch(() => undefined);
    await prisma.approvalRequest.deleteMany({ where: { id: approvalId } }).catch(() => undefined);
    await prisma.run.deleteMany({
      where: { id: { in: [runOk, runTimeout, runNoTerm] } },
    }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('FATAL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
