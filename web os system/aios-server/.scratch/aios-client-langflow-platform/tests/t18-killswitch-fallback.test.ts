/**
 * Ticket 18 — CANARY/STABLE routing, kill switch, Native fallback, HOLD, rollback, whitelist.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t18-killswitch-fallback.test.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import {
  activateDeployment,
  deactivateDeployment,
  rollbackDeployment,
} from '../../../src/lib/runtimedeployment.js';
import {
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
};

function createMockAdapter(): MockAdapter {
  const executeCalls: ExecuteRequest[] = [];
  const resumeCalls: ResumeRequest[] = [];
  const toolWrites: Array<{ runId: string; tool: string }> = [];

  return {
    kind: 'LANGFLOW',
    executeCalls,
    resumeCalls,
    toolWrites,
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
      const runId = input.runId ?? 'unknown';
      yield { type: 'run.started', runId, at: nowIso() };
      yield { type: 'run.finished', runId, at: nowIso(), status: 'SUCCEEDED' };
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
}

async function main(): Promise<void> {
  console.log('── t18-killswitch-fallback ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const skill2Id = ulid();
  const suiteId = ulid();
  const suite2Id = ulid();
  const workflowId = ulid();
  const workflowNoDepId = ulid();
  const stepId = ulid();
  const stepNoDepId = ulid();
  const evalRunId = ulid();
  const evalRun2Id = ulid();
  const contentMd = `# t18 kill ${tag}\n`;
  const content2 = `# t18 kill gated ${tag}\n`;

  let skillVersionId = '';
  let skillVersion2Id = '';
  let artifactCanaryId = '';
  let artifactStableId = '';
  let artifactGatedId = '';
  let canaryDeployId = '';
  let stableDeployId = '';
  let gatedDeployId = '';
  let agentNoDep = '';
  let evalStableId = '';
  const runIds: string[] = [];
  const mock = createMockAdapter();

  let resolveScheduledRuntimeRoute: typeof import('../../../src/lib/runtimeexecution.js').resolveScheduledRuntimeRoute;
  let dispatchScheduledWorkflow: typeof import('../../../src/lib/runtimeexecution.js').dispatchScheduledWorkflow;

  try {
    try {
      const mod = await import('../../../src/lib/runtimeexecution.js');
      resolveScheduledRuntimeRoute = mod.resolveScheduledRuntimeRoute;
      dispatchScheduledWorkflow = mod.dispatchScheduledWorkflow;
    } catch (e) {
      fail('import runtimeexecution module', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit) ──`);
      return;
    }

    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t18-kill-owner-${tag}@aios.test`,
        displayName: 'T18 Kill Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t18-kill-agent-${tag}`,
        name: `T18 Kill Agent ${tag}`,
        description: 't18 kill',
        rolePrompt: 't18',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    // Primary skill — readonly templates
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t18-kill-skill-${tag}`,
        name: `T18 Kill Skill ${tag}`,
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
        name: `T18 Kill Suite ${tag}`,
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

    async function makeValidatedArtifact(
      versionId: string,
      template: string,
      compilerTag: string,
    ): Promise<string> {
      const art = await createFlowArtifact({
        skillVersionId: versionId,
        runtimeKind: 'LANGFLOW',
        template,
        compilerVersion: compilerTag,
        artifactJson: {
          nodes: [{ id: `n-${compilerTag}` }],
          edges: [],
          kind: 'langflow',
          tag,
        },
        createdBy: ownerId,
      });
      const row = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: art.id } });
      await prisma.flowArtifact.update({
        where: { id: art.id },
        data: {
          status: 'VALIDATED',
          digest: computeFlowArtifactDigest(row.artifactJson),
        },
      });
      return art.id;
    }

    artifactCanaryId = await makeValidatedArtifact(
      skillVersionId,
      'email-triage-readonly-v1',
      `t18-canary-${tag}`,
    );
    // Second skillVersion for STABLE artifact (same skill) so unique constraints OK
    const svStable = await createSkillVersion(skillId, contentMd + '\nstable\n', ownerId);
    // Need PASSED eval for this version too if activate requires candidateVersionId match
    evalStableId = ulid();
    await prisma.evalRun.create({
      data: {
        id: evalStableId,
        suiteId,
        skillId,
        candidateVersionId: svStable.id,
        executeEngine: 'CLAUDE_CODE',
        verifyEngine: 'CODEX',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });
    artifactStableId = await makeValidatedArtifact(
      svStable.id,
      'email-triage-readonly-v1',
      `t18-stable-${tag}`,
    );

    await prisma.agentSkill.create({ data: { agentId, skillId } });

    const canaryDep = await activateDeployment(
      {
        artifactId: artifactCanaryId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    canaryDeployId = canaryDep.id;

    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T18 Kill WF ${tag}`,
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

    // Workflow with no deployment skill (separate agent skill set)
    agentNoDep = ulid();
    await prisma.agent.create({
      data: {
        id: agentNoDep,
        slug: `t18-nodep-agent-${tag}`,
        name: `T18 NoDep Agent ${tag}`,
        description: 't18 nodep',
        rolePrompt: 't18',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.workflow.create({
      data: {
        id: workflowNoDepId,
        agentId: agentNoDep,
        name: `T18 NoDep WF ${tag}`,
        description: 't18',
        enabled: true,
        trigger: { type: 'manual' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepNoDepId,
        workflowId: workflowNoDepId,
        position: 0,
        stepKey: 'do-1',
        type: 'DO',
        config: { prompt: 'x' },
      },
    });

    // ── 1. CANARY active → LANGFLOW CANARY ───────────────────────────────
    console.log('\n── [1] CANARY active ──');
    const r1 = await resolveScheduledRuntimeRoute(workflowId);
    check(r1.kind === 'LANGFLOW', 'route LANGFLOW when CANARY active', `kind=${r1.kind}`);
    if (r1.kind === 'LANGFLOW') {
      check(
        r1.deployment.channel === 'CANARY',
        'deployment channel CANARY',
        `channel=${r1.deployment.channel}`,
      );
    }

    // ── 2. promote CANARY→STABLE ─────────────────────────────────────────
    console.log('\n── [2] CANARY→STABLE promotion ──');
    const stableDep = await activateDeployment(
      {
        artifactId: artifactStableId,
        environment: 'PRODUCTION',
        channel: 'STABLE',
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    stableDeployId = stableDep.id;
    await deactivateDeployment({
      deploymentId: canaryDeployId,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    const r2 = await resolveScheduledRuntimeRoute(workflowId);
    check(r2.kind === 'LANGFLOW', 'route still LANGFLOW after STABLE', `kind=${r2.kind}`);
    if (r2.kind === 'LANGFLOW') {
      check(
        r2.deployment.channel === 'STABLE',
        'route picks STABLE after CANARY deactivated',
        `channel=${r2.deployment.channel}`,
      );
      check(
        r2.deployment.id === stableDeployId,
        'STABLE deployment id matches',
        `id=${r2.deployment.id}`,
      );
    }

    // ── 3. kill switch all → NATIVE (workflow still runnable) ────────────
    console.log('\n── [3] kill switch → NATIVE fallback ──');
    await deactivateDeployment({
      deploymentId: stableDeployId,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    const r3 = await resolveScheduledRuntimeRoute(workflowId);
    check(r3.kind === 'NATIVE', 'kill switch + enabled workflow → NATIVE', `kind=${r3.kind}`);

    // ── 4. kill switch + native unavailable → HOLD ───────────────────────
    console.log('\n── [4] kill switch + native unavailable → HOLD ──');
    await prisma.workflow.update({
      where: { id: workflowId },
      data: { enabled: false },
    });
    const r4 = await resolveScheduledRuntimeRoute(workflowId);
    check(
      r4.kind === 'HOLD_FOR_REVIEW',
      'disabled workflow + past PRODUCTION deploys → HOLD_FOR_REVIEW',
      `kind=${r4.kind}`,
    );
    const callsBeforeHold = mock.executeCalls.length;
    const hold = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: `msg-hold-${tag}`, note: 'hold me' },
      ownerId,
      { adapter: mock },
    );
    if (hold.runId) runIds.push(hold.runId);
    check(hold.routed === 'HOLD_FOR_REVIEW', 'dispatch HOLD_FOR_REVIEW', `routed=${hold.routed}`);
    check(hold.status === 'AWAITING_REVIEW', 'HOLD status AWAITING_REVIEW', `status=${hold.status}`);
    const holdRun = await prisma.run.findUnique({ where: { id: hold.runId! } });
    check(
      holdRun?.status === 'AWAITING_REVIEW',
      'HOLD run DB AWAITING_REVIEW',
      `status=${holdRun?.status}`,
    );
    const holdApproval = await prisma.approvalRequest.findUnique({
      where: { runId: hold.runId! },
    });
    check(
      holdApproval?.status === 'PENDING',
      'HOLD creates ApprovalRequest',
      `status=${holdApproval?.status}`,
    );
    check(
      mock.executeCalls.length === callsBeforeHold,
      'HOLD does not call adapter.execute',
      `calls=${mock.executeCalls.length}`,
    );

    // re-enable for later tests
    await prisma.workflow.update({
      where: { id: workflowId },
      data: { enabled: true },
    });

    // ── 5. rollback does not delete ──────────────────────────────────────
    console.log('\n── [5] rollback preserves rows ──');
    // Reactivate canary then stable, then rollback to canary
    await activateDeployment(
      {
        artifactId: artifactCanaryId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    await activateDeployment(
      {
        artifactId: artifactStableId,
        environment: 'PRODUCTION',
        channel: 'STABLE',
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    // Make STABLE the active one for skill+env+channel STABLE; CANARY active too.
    // Deactivate STABLE path first? For rollback: target inactive canary, switch pointer.
    await deactivateDeployment({
      deploymentId: canaryDeployId,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    // Ensure canary is inactive, stable active — then rollback to canary
    // (rollback re-activates target and deactivates others on same skill+env+channel)
    const depCountBefore = await prisma.runtimeDeployment.count({ where: { skillId } });
    const artCountBefore = await prisma.flowArtifact.count({
      where: {
        skillVersion: { skillId },
      },
    });
    const rolled = await rollbackDeployment({
      deploymentId: canaryDeployId,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    check(Boolean(rolled.id), 'rollback returns deployment', String(rolled.id));
    const depCountAfter = await prisma.runtimeDeployment.count({ where: { skillId } });
    const artCountAfter = await prisma.flowArtifact.count({
      where: {
        skillVersion: { skillId },
      },
    });
    check(
      depCountBefore === depCountAfter,
      'rollback: runtimeDeployment count unchanged',
      `${depCountBefore}→${depCountAfter}`,
    );
    check(
      artCountBefore === artCountAfter,
      'rollback: flowArtifact count unchanged',
      `${artCountBefore}→${artCountAfter}`,
    );
    const canaryRow = await prisma.runtimeDeployment.findUnique({ where: { id: canaryDeployId } });
    check(canaryRow?.active === true, 'rollback target active=true', `active=${canaryRow?.active}`);
    // Other same skill+env+channel rows should be inactive if any share CANARY channel
    // STABLE channel is different so may still be active — ticket: 原 active 列 active=false 但仍存在
    // For same channel only. Re-activate STABLE then rollback within STABLE channel if needed.
    // Document: after rollback to canary, canary is active; any prior active on same skill/env/channel is false.
    check(canaryRow != null, 'canary row still exists (not deleted)', String(canaryRow?.id));

    // ── 6. non-whitelist template skipped ────────────────────────────────
    console.log('\n── [6] non-whitelist template ──');
    // Kill all active deploys on skillId first
    const actives = await prisma.runtimeDeployment.findMany({
      where: { skillId, active: true },
    });
    for (const a of actives) {
      await deactivateDeployment({
        deploymentId: a.id,
        actorId: ownerId,
        actorRole: 'OWNER',
      });
    }

    await prisma.skill.create({
      data: {
        id: skill2Id,
        slug: `t18-gated-skill-${tag}`,
        name: `T18 Gated Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: content2,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv2 = await createSkillVersion(skill2Id, content2, ownerId);
    skillVersion2Id = sv2.id;
    await prisma.evalSuite.create({
      data: {
        id: suite2Id,
        skillId: skill2Id,
        name: `T18 Gated Suite ${tag}`,
        createdBy: ownerId,
      },
    });
    await prisma.evalRun.create({
      data: {
        id: evalRun2Id,
        suiteId: suite2Id,
        skillId: skill2Id,
        candidateVersionId: skillVersion2Id,
        executeEngine: 'CLAUDE_CODE',
        verifyEngine: 'CODEX',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });
    artifactGatedId = await makeValidatedArtifact(
      skillVersion2Id,
      'approval-gated-action-v1',
      `t18-gated-${tag}`,
    );
    await prisma.agentSkill.create({ data: { agentId, skillId: skill2Id } });
    const gatedDep = await activateDeployment(
      {
        artifactId: artifactGatedId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'OWNER',
      },
      { adapter: mock },
    );
    gatedDeployId = gatedDep.id;

    const r6 = await resolveScheduledRuntimeRoute(workflowId);
    check(
      r6.kind === 'NATIVE',
      'non-whitelist template alone → NATIVE (not LANGFLOW)',
      `kind=${r6.kind}`,
    );
    if (r6.kind === 'LANGFLOW') {
      fail(
        'non-whitelist template alone → NATIVE (not LANGFLOW)',
        `picked template via deployment ${r6.deployment.id}`,
      );
    }

    // ── 7. never had deployment → NATIVE ─────────────────────────────────
    console.log('\n── [7] no-deployment workflow → NATIVE ──');
    const r7 = await resolveScheduledRuntimeRoute(workflowNoDepId);
    check(r7.kind === 'NATIVE', 'zero-history workflow → NATIVE', `kind=${r7.kind}`);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    // Phase 6 DLQ: pilot failures may enqueue RuntimeDeadLetter for these workflows.
    await prisma.runtimeDeadLetter
      .deleteMany({ where: { workflowId: { in: [workflowId, workflowNoDepId] } } })
      .catch(() => undefined);
    const agentIds = [agentId, agentNoDep].filter(Boolean);
    const agentRuns = await prisma.run.findMany({
      where: { agentId: { in: agentIds } },
      select: { id: true },
    }).catch(() => []);
    const ids = [...new Set([...runIds, ...agentRuns.map((r) => r.id)].filter(Boolean))];
    if (ids.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }

    for (const wid of [workflowId, workflowNoDepId]) {
      await prisma.workflowStep.deleteMany({ where: { workflowId: wid } }).catch(() => undefined);
      await prisma.workflow.deleteMany({ where: { id: wid } }).catch(() => undefined);
    }

    await prisma.runtimeDeployment
      .deleteMany({ where: { skillId: { in: [skillId, skill2Id] } } })
      .catch(() => undefined);

    await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => undefined);

    const evalIds = [evalRunId, evalRun2Id, evalStableId].filter(Boolean);
    if (evalIds.length) {
      await prisma.evalRun.deleteMany({ where: { id: { in: evalIds } } }).catch(() => undefined);
    }
    await prisma.evalSuite.deleteMany({ where: { id: { in: [suiteId, suite2Id] } } }).catch(() => undefined);

    for (const aid of [artifactCanaryId, artifactStableId, artifactGatedId].filter(Boolean)) {
      await prisma.flowArtifact.deleteMany({ where: { id: aid } }).catch(() => undefined);
    }
    for (const sid of [skillId, skill2Id]) {
      const versions = await prisma.skillVersion
        .findMany({ where: { skillId: sid }, select: { id: true } })
        .catch(() => []);
      const vids = versions.map((v) => v.id);
      if (vids.length) {
        await prisma.flowArtifact.deleteMany({ where: { skillVersionId: { in: vids } } }).catch(() => undefined);
        await prisma.skillVersion.deleteMany({ where: { skillId: sid } }).catch(() => undefined);
      }
      await prisma.skill.deleteMany({ where: { id: sid } }).catch(() => undefined);
    }

    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => undefined);
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
