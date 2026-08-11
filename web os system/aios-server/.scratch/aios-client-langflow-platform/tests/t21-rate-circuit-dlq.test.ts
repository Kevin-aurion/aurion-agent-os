/**
 * Ticket 21 — Rate limit, circuit breaker, DLQ + manual replay (Phase 6).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t21-rate-circuit-dlq.test.ts
 */
import { ulid } from 'ulid';
import Fastify from 'fastify';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { activateDeployment } from '../../../src/lib/runtimedeployment.js';
import { signAccess } from '../../../src/lib/auth.js';
import { sendError } from '../../../src/lib/http.js';
import type {
  DeployArtifactRequest,
  ExecuteRequest,
  NormalizedRunEvent,
  ResumeRequest,
  RuntimeAdapter,
  RuntimeHealth,
  RuntimeRunState,
  ValidateArtifactRequest,
  ValidationResult,
} from '../../../src/runtime/adapter.js';
import { nowIso } from '../../../src/runtime/adapter.js';

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

type MockAdapter = RuntimeAdapter & {
  executeCalls: ExecuteRequest[];
  failMode: boolean;
  script: (req: ExecuteRequest) => AsyncGenerator<NormalizedRunEvent>;
};

function createMockAdapter(): MockAdapter {
  const executeCalls: ExecuteRequest[] = [];
  const adapter: MockAdapter = {
    kind: 'LANGFLOW',
    executeCalls,
    failMode: false,
    script: async function* (req: ExecuteRequest) {
      yield { type: 'run.started', runId: req.runId ?? 'x', at: nowIso() };
      yield {
        type: 'run.finished',
        runId: req.runId ?? 'x',
        at: nowIso(),
        status: 'SUCCEEDED',
      };
    },
    async health(): Promise<RuntimeHealth> {
      return {
        kind: 'LANGFLOW',
        healthy: true,
        checkedAt: nowIso(),
        latencyMs: 1,
        detail: null,
      };
    },
    async validateArtifact(_i: ValidateArtifactRequest): Promise<ValidationResult> {
      return { valid: true, errors: [] };
    },
    async deployArtifact(input: DeployArtifactRequest) {
      return {
        kind: 'LANGFLOW' as const,
        bindingRef: `mock:${input.artifactId}`,
        deployedAt: nowIso(),
      };
    },
    async *execute(input: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      executeCalls.push(input);
      if (adapter.failMode) {
        const err = new Error('runtime unreachable');
        (err as { code?: string }).code = 'RUNTIME_UNREACHABLE';
        throw err;
      }
      for await (const ev of adapter.script(input)) {
        yield ev;
      }
    },
    async getRun(runId: string): Promise<RuntimeRunState> {
      return {
        runId,
        kind: 'LANGFLOW',
        status: 'RUNNING',
        startedAt: null,
        finishedAt: null,
      };
    },
    async cancelRun(): Promise<void> {},
    async resumeRun(_i: ResumeRequest): Promise<void> {},
  };
  return adapter;
}

async function main(): Promise<void> {
  console.log('── t21-rate-circuit-dlq ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const memberId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const evalRunId = ulid();
  const contentMd = `# t21 rcd ${tag}\n`;

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const trackedRunIds: string[] = [];
  const trackedDlqIds: string[] = [];
  const mock = createMockAdapter();

  const prevRate = process.env.AIOS_RUNTIME_RATE_LIMIT_PER_MIN;
  const prevThresh = process.env.AIOS_RUNTIME_CIRCUIT_THRESHOLD;
  const prevCool = process.env.AIOS_RUNTIME_CIRCUIT_COOLDOWN_MS;
  process.env.AIOS_RUNTIME_RATE_LIMIT_PER_MIN = '2';
  process.env.AIOS_RUNTIME_CIRCUIT_THRESHOLD = '2';
  process.env.AIOS_RUNTIME_CIRCUIT_COOLDOWN_MS = '50';

  try {
    const {
      checkRateLimit,
      beforeDispatch,
      recordFailure,
      recordSuccess,
      _resetRuntimeGuardStateForTests,
      _getRuntimeGuardSnapshotForTests,
    } = await import('../../../src/lib/runtimeguard.js');
    const { executePilotRun, dispatchScheduledWorkflow, getOrCreatePilotRun } =
      await import('../../../src/lib/runtimeexecution.js');
    const { runtimeRoutes } = await import('../../../src/routes/runtime.js');

    _resetRuntimeGuardStateForTests();

    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t21-rcd-owner-${tag}@aios.test`,
        displayName: 'T21 RCD Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.user.create({
      data: {
        id: memberId,
        email: `t21-rcd-member-${tag}@aios.test`,
        displayName: 'T21 RCD Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t21-rcd-agent-${tag}`,
        name: `T21 RCD ${tag}`,
        description: 't21',
        rolePrompt: 't21',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t21-rcd-skill-${tag}`,
        name: `T21 RCD Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, contentMd, ownerId);
    skillVersionId = sv.id;

    await prisma.evalSuite.create({
      data: {
        id: suiteId,
        skillId,
        name: `t21-rcd-suite-${tag}`,
        description: 'gate',
        createdBy: ownerId,
      },
    });
    await prisma.evalRun.create({
      data: {
        id: evalRunId,
        suiteId,
        skillId,
        candidateVersionId: skillVersionId,
        executeEngine: 'CLAUDE_CODE',
        verifyEngine: 'CODEX',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });

    const { computeFlowArtifactDigest } = await import(
      '../../../src/lib/flowartifact.js'
    );
    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'scheduled-report-v1',
      compilerVersion: `t21-rcd-${tag}`,
      artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'langflow', tag },
      createdBy: ownerId,
    });
    artifactId = art.id;
    const row = await prisma.flowArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: {
        status: 'VALIDATED',
        digest: computeFlowArtifactDigest(row.artifactJson),
      },
    });

    await prisma.agentSkill.create({
      data: { agentId, skillId },
    });

    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `t21-rcd-wf-${tag}`,
        description: 't21',
        enabled: true,
        trigger: { type: 'manual' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepId,
        workflowId,
        position: 0,
        stepKey: 'do',
        type: 'DO',
        config: { prompt: 'hi' },
      },
    });

    const dep = await activateDeployment(
      {
        artifactId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    deployId = dep.id;

    const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({
      where: { id: deployId },
    });
    const artifact = await prisma.flowArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });

    // ── Pure rate limit ─────────────────────────────────────────────────
    console.log('\n── rate limit unit ──');
    _resetRuntimeGuardStateForTests();
    const t0 = 1_000_000;
    check(checkRateLimit(deployId, t0).allow === true, 'rate 1st allow', '');
    check(checkRateLimit(deployId, t0 + 1).allow === true, 'rate 2nd allow', '');
    const r3 = checkRateLimit(deployId, t0 + 2);
    check(r3.allow === false, 'rate 3rd reject (limit=2)', JSON.stringify(r3));

    // ── executePilotRun rate limited ────────────────────────────────────
    console.log('\n── executePilotRun RATE_LIMITED ──');
    _resetRuntimeGuardStateForTests();
    // Saturate sliding window with wall-clock now (executePilotRun uses Date.now()).
    const wall = Date.now();
    checkRateLimit(deployId, wall);
    checkRateLimit(deployId, wall + 1);
    mock.executeCalls.length = 0;
    const dlqBefore = await prisma.runtimeDeadLetter.count({
      where: { workflowId },
    });

    const { run: rateRun } = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId: `rate-${tag}`,
      triggeredBy: ownerId,
      input: { messageId: `rate-${tag}`, n: 1 },
    });
    trackedRunIds.push(rateRun.id);

    const rateRes = await executePilotRun(
      {
        runId: rateRun.id,
        deployment,
        artifact,
        triggeredBy: ownerId,
      },
      { adapter: mock },
    );
    check(rateRes.status === 'FAILED', 'rate run FAILED', rateRes.status);
    const rateRow = await prisma.run.findUniqueOrThrow({ where: { id: rateRun.id } });
    const rateOut = rateRow.output as { code?: string };
    check(rateOut?.code === 'RATE_LIMITED', 'rate code RATE_LIMITED', JSON.stringify(rateOut));
    check(mock.executeCalls.length === 0, 'rate: adapter zero calls', `n=${mock.executeCalls.length}`);
    const dlqAfterRate = await prisma.runtimeDeadLetter.count({
      where: { workflowId },
    });
    check(dlqAfterRate === dlqBefore + 1, 'rate: DLQ +1', `before=${dlqBefore} after=${dlqAfterRate}`);
    const rateDlq = await prisma.runtimeDeadLetter.findFirst({
      where: { workflowId, code: 'RATE_LIMITED', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (rateDlq) trackedDlqIds.push(rateDlq.id);
    check(!!rateDlq, 'rate DLQ PENDING row exists', '');

    // ── Circuit breaker ─────────────────────────────────────────────────
    console.log('\n── circuit breaker ──');
    // Raise rate limit so rate gate does not mask circuit OPEN.
    process.env.AIOS_RUNTIME_RATE_LIMIT_PER_MIN = '100';
    _resetRuntimeGuardStateForTests();
    mock.failMode = true;
    mock.executeCalls.length = 0;

    for (let i = 0; i < 2; i++) {
      const mid = `circ-fail-${i}-${tag}`;
      const { run } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: mid,
        triggeredBy: ownerId,
        input: { messageId: mid },
      });
      trackedRunIds.push(run.id);
      await executePilotRun(
        { runId: run.id, deployment, artifact, triggeredBy: ownerId },
        { adapter: mock },
      );
    }
    check(mock.executeCalls.length === 2, 'circuit: 2 failures hit adapter', `n=${mock.executeCalls.length}`);
    const snap = _getRuntimeGuardSnapshotForTests(deployId);
    check(snap?.circuit === 'OPEN', 'circuit OPEN after threshold', JSON.stringify(snap));

    mock.executeCalls.length = 0;
    const midOpen = `circ-open-${tag}`;
    const { run: openRun } = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId: midOpen,
      triggeredBy: ownerId,
      input: { messageId: midOpen },
    });
    trackedRunIds.push(openRun.id);
    const openRes = await executePilotRun(
      { runId: openRun.id, deployment, artifact, triggeredBy: ownerId },
      { adapter: mock },
    );
    check(openRes.status === 'FAILED', 'circuit open run FAILED', openRes.status);
    const openOut = (await prisma.run.findUniqueOrThrow({ where: { id: openRun.id } }))
      .output as { code?: string };
    check(openOut?.code === 'CIRCUIT_OPEN', 'code CIRCUIT_OPEN', JSON.stringify(openOut));
    check(mock.executeCalls.length === 0, 'circuit OPEN: adapter zero', `n=${mock.executeCalls.length}`);
    const openDlq = await prisma.runtimeDeadLetter.findFirst({
      where: { runId: openRun.id, code: 'CIRCUIT_OPEN' },
    });
    if (openDlq) trackedDlqIds.push(openDlq.id);
    check(!!openDlq, 'circuit OPEN DLQ row', '');

    // cooldown → HALF_OPEN → success → CLOSED
    const coolNow = Date.now();
    // force openedAt into the past via re-record with explicit now
    _resetRuntimeGuardStateForTests();
    recordFailure(deployId, coolNow);
    recordFailure(deployId, coolNow);
    let bd = beforeDispatch(deployId, coolNow);
    check(bd.allow === false, 'fresh OPEN blocks', JSON.stringify(bd));
    bd = beforeDispatch(deployId, coolNow + 100);
    check(
      bd.allow === true && bd.state === 'HALF_OPEN',
      'after cooldown HALF_OPEN probe',
      JSON.stringify(bd),
    );
    recordSuccess(deployId);
    const snap2 = _getRuntimeGuardSnapshotForTests(deployId);
    check(snap2?.circuit === 'CLOSED', 'success → CLOSED', JSON.stringify(snap2));

    // ── Manual replay exactly-once ──────────────────────────────────────
    console.log('\n── DLQ replay ──');
    _resetRuntimeGuardStateForTests();
    mock.failMode = false;
    mock.executeCalls.length = 0;

    // Ensure a PENDING DLQ we control
    const dlqId = ulid();
    trackedDlqIds.push(dlqId);
    await prisma.runtimeDeadLetter.create({
      data: {
        id: dlqId,
        runId: openRun.id,
        workflowId,
        deploymentId: deployId,
        artifactId,
        code: 'CIRCUIT_OPEN',
        reason: 'test replay',
        payload: { messageId: `orig-msg-${tag}`, note: 'replay-me' },
        status: 'PENDING',
      },
    });

    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    await app.register(runtimeRoutes);
    await app.ready();

    const ownerJwt = await signAccess({
      sub: ownerId,
      email: `t21-rcd-owner-${tag}@aios.test`,
      role: 'OWNER',
    });
    const memberJwt = await signAccess({
      sub: memberId,
      email: `t21-rcd-member-${tag}@aios.test`,
      role: 'MEMBER',
    });

    const runsBefore = await prisma.run.count({ where: { workflowId } });

    // MEMBER → 403
    const rMember = await app.inject({
      method: 'POST',
      url: `/api/runtime/dead-letters/${dlqId}/replay`,
      headers: { authorization: `Bearer ${memberJwt}` },
    });
    check(rMember.statusCode === 403, 'MEMBER replay → 403', `got ${rMember.statusCode}`);
    check(
      (await prisma.run.count({ where: { workflowId } })) === runsBefore,
      'MEMBER replay: run count unchanged',
      '',
    );
    const stillPending = await prisma.runtimeDeadLetter.findUniqueOrThrow({
      where: { id: dlqId },
    });
    check(stillPending.status === 'PENDING', 'MEMBER: DLQ still PENDING', stillPending.status);

    // Spy adapter for replay via patching resolve is hard; use dispatch with mock deps
    // by calling dispatchScheduledWorkflow after claim path via route — route uses real adapter.
    // Instead exercise replay claim + second conflict with pure prisma + dispatch in-process
    // after first route... Route will try real LANGFLOW adapter which may fail.
    // So: use library path for successful replay semantics + route for auth/exactly-once.

    // First trainer replay — may create run even if adapter fails later; claim is what matters.
    // Prefer direct: updateMany claim pattern already in route. Use mock via dispatchScheduledWorkflow:
    const claimed = await prisma.runtimeDeadLetter.updateMany({
      where: { id: dlqId, status: 'PENDING' },
      data: {
        status: 'REPLAYED',
        replayedBy: ownerId,
        replayedAt: new Date(),
      },
    });
    check(claimed.count === 1, 'exactly-once claim count=1', `count=${claimed.count}`);

    const replayMid = `orig-msg-${tag}:replay:${dlqId}`;
    const dispatchRes = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: replayMid, note: 'replay-me' },
      ownerId,
      { adapter: mock },
    );
    if (dispatchRes.runId) trackedRunIds.push(dispatchRes.runId);
    check(
      dispatchRes.routed === 'LANGFLOW' && !!dispatchRes.runId,
      'replay dispatch new run',
      JSON.stringify(dispatchRes),
    );
    await prisma.runtimeDeadLetter.update({
      where: { id: dlqId },
      data: { replayedRunId: dispatchRes.runId ?? null },
    });
    const replayRun = await prisma.run.findUniqueOrThrow({
      where: { id: dispatchRes.runId! },
    });
    check(
      replayRun.idempotencyKey === `pilot:${workflowId}:${replayMid}`,
      'replay messageId derived idempotency key',
      String(replayRun.idempotencyKey),
    );

    // Second claim → 0
    const claimed2 = await prisma.runtimeDeadLetter.updateMany({
      where: { id: dlqId, status: 'PENDING' },
      data: { status: 'REPLAYED', replayedBy: ownerId, replayedAt: new Date() },
    });
    check(claimed2.count === 0, 'second claim count=0', `count=${claimed2.count}`);

    // Route second replay → 409
    const runsMid = await prisma.run.count({ where: { workflowId } });
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/runtime/dead-letters/${dlqId}/replay`,
      headers: { authorization: `Bearer ${ownerJwt}` },
    });
    check(r2.statusCode === 409, 'second route replay → 409', `got ${r2.statusCode} ${r2.body.slice(0, 160)}`);
    check(
      (await prisma.run.count({ where: { workflowId } })) === runsMid,
      'second replay: run count unchanged',
      '',
    );

    // List + discard
    const dlq2 = ulid();
    trackedDlqIds.push(dlq2);
    await prisma.runtimeDeadLetter.create({
      data: {
        id: dlq2,
        workflowId,
        deploymentId: deployId,
        artifactId,
        code: 'TIMEOUT',
        reason: 'discard me',
        payload: {},
        status: 'PENDING',
      },
    });
    const listR = await app.inject({
      method: 'GET',
      url: '/api/runtime/dead-letters?status=PENDING',
      headers: { authorization: `Bearer ${ownerJwt}` },
    });
    check(listR.statusCode === 200, 'list dead-letters 200', `got ${listR.statusCode}`);
    const disc = await app.inject({
      method: 'POST',
      url: `/api/runtime/dead-letters/${dlq2}/discard`,
      headers: { authorization: `Bearer ${ownerJwt}` },
    });
    check(disc.statusCode === 200, 'discard 200', `got ${disc.statusCode}`);
    const discRow = await prisma.runtimeDeadLetter.findUniqueOrThrow({ where: { id: dlq2 } });
    check(discRow.status === 'DISCARDED', 'discard status DISCARDED', discRow.status);
    const disc2 = await app.inject({
      method: 'POST',
      url: `/api/runtime/dead-letters/${dlq2}/discard`,
      headers: { authorization: `Bearer ${ownerJwt}` },
    });
    check(disc2.statusCode === 409, 'second discard 409', `got ${disc2.statusCode}`);

    await app.close();
  } catch (e) {
    fail('suite error', String(e));
    console.error(e);
  } finally {
    if (prevRate === undefined) delete process.env.AIOS_RUNTIME_RATE_LIMIT_PER_MIN;
    else process.env.AIOS_RUNTIME_RATE_LIMIT_PER_MIN = prevRate;
    if (prevThresh === undefined) delete process.env.AIOS_RUNTIME_CIRCUIT_THRESHOLD;
    else process.env.AIOS_RUNTIME_CIRCUIT_THRESHOLD = prevThresh;
    if (prevCool === undefined) delete process.env.AIOS_RUNTIME_CIRCUIT_COOLDOWN_MS;
    else process.env.AIOS_RUNTIME_CIRCUIT_COOLDOWN_MS = prevCool;

    try {
      const { _resetRuntimeGuardStateForTests } = await import(
        '../../../src/lib/runtimeguard.js'
      );
      _resetRuntimeGuardStateForTests();
    } catch {
      /* ignore */
    }

    try {
      if (trackedDlqIds.length)
        await prisma.runtimeDeadLetter.deleteMany({
          where: { id: { in: trackedDlqIds } },
        });
      await prisma.runtimeDeadLetter.deleteMany({ where: { workflowId } });
      await prisma.runTrace.deleteMany({
        where: { runId: { in: trackedRunIds } },
      }).catch(() => undefined);
      await prisma.approvalRequest.deleteMany({
        where: { runId: { in: trackedRunIds } },
      });
      await prisma.costLog.deleteMany({ where: { agentId } });
      await prisma.run.deleteMany({
        where: { OR: [{ id: { in: trackedRunIds } }, { workflowId }] },
      });
      if (deployId)
        await prisma.runtimeDeployment.deleteMany({ where: { id: deployId } });
      if (artifactId)
        await prisma.flowArtifact.deleteMany({ where: { id: artifactId } });
      await prisma.evalRun.deleteMany({ where: { id: evalRunId } });
      await prisma.evalSuite.deleteMany({ where: { id: suiteId } });
      if (skillVersionId)
        await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } });
      await prisma.workflowStep.deleteMany({ where: { id: stepId } });
      await prisma.workflow.deleteMany({ where: { id: workflowId } });
      await prisma.agentSkill.deleteMany({ where: { agentId, skillId } });
      await prisma.skill.deleteMany({ where: { id: skillId } });
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    } catch (ce) {
      console.warn('cleanup warning', ce);
    }
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
