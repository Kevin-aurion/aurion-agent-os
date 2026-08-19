/**
 * Ticket 18 — HITL approval.required → createApproval → isRunApproved → resume.
 * Also dead runtime + budget exhausted fail-closed paths.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t18-hitl-resume.test.ts
 */
import { ulid } from 'ulid';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { activateDeployment } from '../../../src/lib/runtimedeployment.js';
import { decideApproval } from '../../../src/lib/approval.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  RuntimeAdapterError,
  nowIso,
  type DeployArtifactRequest,
  type ExecuteRequest,
  type NormalizedRunEvent,
  type ResumeRequest,
  type RuntimeAdapter,
  type RuntimeHealth,
  type RuntimeRunState,
  type ValidateArtifactRequest,
  type ValidationResult,
} from '../../../src/runtime/adapter.js';

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
  resumeCalls: ResumeRequest[];
  toolWrites: Array<{ runId: string; tool: string }>;
  script: (req: ExecuteRequest) => AsyncGenerator<NormalizedRunEvent>;
  throwOnExecute: Error | null;
};

function createMockAdapter(): MockAdapter {
  const executeCalls: ExecuteRequest[] = [];
  const resumeCalls: ResumeRequest[] = [];
  const toolWrites: Array<{ runId: string; tool: string }> = [];

  const adapter: MockAdapter = {
    kind: 'LANGFLOW',
    executeCalls,
    resumeCalls,
    toolWrites,
    throwOnExecute: null,
    script: async function* (req: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      const runId = req.runId ?? 'unknown';
      yield {
        type: 'approval.required',
        runId,
        at: nowIso(),
        reason: 'refund requested',
      };
      // Intentionally no tool.call / write events before approval.
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
    async validateArtifact(_input: ValidateArtifactRequest): Promise<ValidationResult> {
      return { valid: true, errors: [] };
    },
    async deployArtifact(input: DeployArtifactRequest) {
      // Ticket 24: runtimeBinding must be langflow:flow:<safe id> for executePilotRun.
      return {
        kind: 'LANGFLOW' as const,
        bindingRef: `langflow:flow:lf-${input.artifactId}`,
        deployedAt: nowIso(),
      };
    },
    async *execute(input: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      executeCalls.push(input);
      if (adapter.throwOnExecute) {
        throw adapter.throwOnExecute;
      }
      for await (const ev of adapter.script(input)) {
        if (ev.type === 'tool.call') {
          toolWrites.push({ runId: ev.runId, tool: ev.tool });
        }
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
    async resumeRun(input: ResumeRequest): Promise<void> {
      resumeCalls.push(input);
    },
  };
  return adapter;
}

async function main(): Promise<void> {
  console.log('── t18-hitl-resume ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const memberId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const evalRunId = ulid();
  const contentMd = `# t18 hitl ${tag}\n`;
  const costLogId = ulid();

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const runIds: string[] = [];
  const mock = createMockAdapter();

  let dispatchScheduledWorkflow: typeof import('../../../src/lib/runtimeexecution.js').dispatchScheduledWorkflow;
  let resumePilotRun: typeof import('../../../src/lib/runtimeexecution.js').resumePilotRun;

  try {
    try {
      const mod = await import('../../../src/lib/runtimeexecution.js');
      dispatchScheduledWorkflow = mod.dispatchScheduledWorkflow;
      resumePilotRun = mod.resumePilotRun;
    } catch (e) {
      fail('import runtimeexecution module', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit) ──`);
      return;
    }

    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t18-hitl-owner-${tag}@aios.test`,
        displayName: 'T18 HITL Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.user.create({
      data: {
        id: memberId,
        email: `t18-hitl-member-${tag}@aios.test`,
        displayName: 'T18 HITL Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t18-hitl-agent-${tag}`,
        name: `T18 HITL Agent ${tag}`,
        description: 't18 hitl',
        rolePrompt: 't18',
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
        slug: `t18-hitl-skill-${tag}`,
        name: `T18 HITL Skill ${tag}`,
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
        name: `T18 HITL Suite ${tag}`,
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

    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t18-hitl-${tag}`,
      artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'langflow', tag },
      createdBy: ownerId,
    });
    artifactId = art.id;
    const row = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: {
        status: 'VALIDATED',
        digest: computeFlowArtifactDigest(row.artifactJson),
      },
    });

    await prisma.agentSkill.create({ data: { agentId, skillId } });

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

    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T18 HITL WF ${tag}`,
        description: 't18',
        enabled: true,
        trigger: { type: 'manual' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepId,
        workflowId,
        position: 0,
        stepKey: 'do-1',
        type: 'DO',
        config: { prompt: 'triage' },
      },
    });

    // ── 1. approval.required → AWAITING_REVIEW, no tool writes ───────────
    console.log('\n── [1] approval.required (refund) ──');
    const msg1 = `msg-refund-${tag}`;
    const d1 = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: msg1, body: 'please refund $50' },
      ownerId,
      { adapter: mock },
    );
    if (d1.runId) runIds.push(d1.runId);
    check(d1.status === 'AWAITING_REVIEW', 'run status AWAITING_REVIEW', `status=${d1.status}`);
    check(d1.routed === 'LANGFLOW', 'routed LANGFLOW', `routed=${d1.routed}`);

    const runRow = await prisma.run.findUnique({ where: { id: d1.runId! } });
    check(runRow?.status === 'AWAITING_REVIEW', 'DB run AWAITING_REVIEW', `status=${runRow?.status}`);

    const approval = await prisma.approvalRequest.findUnique({ where: { runId: d1.runId! } });
    check(
      approval?.status === 'PENDING',
      'ApprovalRequest PENDING for run',
      `status=${approval?.status} id=${approval?.id}`,
    );
    check(
      mock.toolWrites.length === 0,
      'zero tool writes before true ApprovalRequest',
      `toolWrites=${mock.toolWrites.length}`,
    );

    // ── 2. fake approvalRequestId → forbidden ────────────────────────────
    console.log('\n── [2] fake approval id rejected ──');
    const resumeBefore = mock.resumeCalls.length;
    try {
      await resumePilotRun(
        {
          runId: d1.runId!,
          approvalRequestId: 'fake-approval-id-not-real',
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: mock },
      );
      fail('fake approval id throws forbidden', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 403,
        'fake approval → forbidden',
        String(e),
      );
    }
    const afterFake = await prisma.run.findUnique({ where: { id: d1.runId! } });
    check(
      afterFake?.status === 'AWAITING_REVIEW',
      'run still AWAITING_REVIEW after fake resume',
      `status=${afterFake?.status}`,
    );
    check(
      mock.resumeCalls.length === resumeBefore,
      'resumeRun not called for fake id',
      `resumeCalls=${mock.resumeCalls.length}`,
    );

    // ── 3. PENDING still rejects ─────────────────────────────────────────
    console.log('\n── [3] PENDING approval rejects resume ──');
    try {
      await resumePilotRun(
        {
          runId: d1.runId!,
          approvalRequestId: approval!.id,
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: mock },
      );
      fail('PENDING resume throws', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 403,
        'PENDING approval → forbidden',
        String(e),
      );
    }
    check(
      mock.resumeCalls.length === resumeBefore,
      'resumeRun not called while PENDING',
      `resumeCalls=${mock.resumeCalls.length}`,
    );

    // ── 4. decideApproval then resume ────────────────────────────────────
    console.log('\n── [4] approve then resume ──');
    await decideApproval(approval!.id, true, ownerId);
    const resumed = await resumePilotRun(
      {
        runId: d1.runId!,
        approvalRequestId: approval!.id,
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    check(resumed.status === 'RUNNING', 'resume → RUNNING', `status=${resumed.status}`);
    check(
      mock.resumeCalls.length === resumeBefore + 1,
      'resumeRun called once after true approve',
      `resumeCalls=${mock.resumeCalls.length}`,
    );
    const runAfter = await prisma.run.findUnique({ where: { id: d1.runId! } });
    check(runAfter?.status === 'RUNNING', 'DB run RUNNING after resume', `status=${runAfter?.status}`);

    // ── 5. MEMBER forbidden ──────────────────────────────────────────────
    console.log('\n── [5] MEMBER resume forbidden ──');
    // Put run back to AWAITING_REVIEW for role check (approval already APPROVED)
    await prisma.run.update({
      where: { id: d1.runId! },
      data: { status: 'AWAITING_REVIEW' },
    });
    try {
      await resumePilotRun(
        {
          runId: d1.runId!,
          approvalRequestId: approval!.id,
          actorId: memberId,
          actorRole: 'MEMBER',
        },
        { adapter: mock },
      );
      fail('MEMBER resume throws forbidden', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 403,
        'MEMBER role → forbidden',
        String(e),
      );
    }

    // ── 6. dead runtime → FAILED not SUCCEEDED ───────────────────────────
    console.log('\n── [6] dead runtime → FAILED ──');
    mock.throwOnExecute = new RuntimeAdapterError(
      'RUNTIME_UNREACHABLE',
      'langflow down for t18 test',
    );
    const dead = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: `msg-dead-${tag}` },
      ownerId,
      { adapter: mock },
    );
    if (dead.runId) runIds.push(dead.runId);
    check(dead.status === 'FAILED', 'dead runtime status FAILED', `status=${dead.status}`);
    const deadRun = await prisma.run.findUnique({ where: { id: dead.runId! } });
    check(
      deadRun?.status === 'FAILED',
      'DB run FAILED (never SUCCEEDED)',
      `status=${deadRun?.status}`,
    );
    check(deadRun?.status !== 'SUCCEEDED', 'explicitly not SUCCEEDED', `status=${deadRun?.status}`);
    mock.throwOnExecute = null;

    // ── 7. budget exhausted → FAILED, no execute ─────────────────────────
    console.log('\n── [7] budget exhausted ──');
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        costPolicy: {
          dailyBudgetUsd: 0.01,
          monthlyBudgetUsd: 0.01,
          hardStop: true,
        },
      },
    });
    await prisma.costLog.create({
      data: {
        id: costLogId,
        agentId,
        runId: null,
        engine: 'CLAUDE_CODE',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: new Prisma.Decimal('999.000000'),
        stepKey: null,
      },
    });
    const callsBeforeBudget = mock.executeCalls.length;
    const budgeted = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: `msg-budget-${tag}` },
      ownerId,
      { adapter: mock },
    );
    if (budgeted.runId) runIds.push(budgeted.runId);
    check(budgeted.status === 'FAILED', 'budget exceeded → FAILED', `status=${budgeted.status}`);
    check(
      mock.executeCalls.length === callsBeforeBudget,
      'execute not called when budget exhausted',
      `calls=${mock.executeCalls.length} before=${callsBeforeBudget}`,
    );
    const budgetRun = await prisma.run.findUnique({ where: { id: budgeted.runId! } });
    check(budgetRun?.status === 'FAILED', 'DB budget run FAILED', `status=${budgetRun?.status}`);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    // Phase 6 DLQ: executePilotRun may enqueue RuntimeDeadLetter on adapter failure.
    await prisma.runtimeDeadLetter
      .deleteMany({ where: { workflowId } })
      .catch(() => undefined);
    await prisma.costLog.deleteMany({ where: { id: costLogId } }).catch(() => undefined);
    const agentRuns = await prisma.run.findMany({
      where: { agentId },
      select: { id: true },
    }).catch(() => []);
    const ids = [...new Set([...runIds, ...agentRuns.map((r) => r.id)].filter(Boolean))];
    if (ids.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await prisma.costLog.deleteMany({ where: { agentId } }).catch(() => undefined);
    await prisma.workflowStep.deleteMany({ where: { workflowId } }).catch(() => undefined);
    await prisma.workflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: evalRunId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    if (artifactId) {
      await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    }
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } }).catch(() => undefined);
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
