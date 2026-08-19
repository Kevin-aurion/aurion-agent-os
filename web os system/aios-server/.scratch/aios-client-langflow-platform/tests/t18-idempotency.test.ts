/**
 * Ticket 18 — Pilot run idempotency (messageId / P2002).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t18-idempotency.test.ts
 *
 * Real DB via prisma singleton. Langflow via injected mock RuntimeAdapter.
 * Cleanup deletes only test-owned rows.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { activateDeployment } from '../../../src/lib/runtimedeployment.js';
import { ApiError } from '../../../src/lib/http.js';
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
  resumeCalls: ResumeRequest[];
  toolWrites: Array<{ runId: string; tool: string }>;
  script: (req: ExecuteRequest) => AsyncGenerator<NormalizedRunEvent>;
};

function createMockAdapter(
  script?: (req: ExecuteRequest) => AsyncGenerator<NormalizedRunEvent>,
): MockAdapter {
  const executeCalls: ExecuteRequest[] = [];
  const resumeCalls: ResumeRequest[] = [];
  const toolWrites: Array<{ runId: string; tool: string }> = [];

  const defaultScript = async function* (req: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
    const runId = req.runId ?? 'unknown';
    const at = nowIso();
    yield { type: 'run.started', runId, at };
    yield { type: 'run.finished', runId, at: nowIso(), status: 'SUCCEEDED' };
  };

  const adapter: MockAdapter = {
    kind: 'LANGFLOW',
    executeCalls,
    resumeCalls,
    toolWrites,
    script: script ?? defaultScript,
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
  console.log('── t18-idempotency ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const evalRunId = ulid();
  const contentMd = `# t18 idempotency ${tag}\n`;

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const runIds: string[] = [];
  const mock = createMockAdapter();

  let buildPilotIdempotencyKey: typeof import('../../../src/lib/runtimeexecution.js').buildPilotIdempotencyKey;
  let dispatchScheduledWorkflow: typeof import('../../../src/lib/runtimeexecution.js').dispatchScheduledWorkflow;

  try {
    try {
      const mod = await import('../../../src/lib/runtimeexecution.js');
      buildPilotIdempotencyKey = mod.buildPilotIdempotencyKey;
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
        email: `t18-idem-owner-${tag}@aios.test`,
        displayName: 'T18 Idem Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t18-idem-agent-${tag}`,
        name: `T18 Idem Agent ${tag}`,
        description: 't18 idempotency',
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
        slug: `t18-idem-skill-${tag}`,
        name: `T18 Idem Skill ${tag}`,
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
        name: `T18 Idem Suite ${tag}`,
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
      compilerVersion: `t18-idem-${tag}`,
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

    await prisma.agentSkill.create({
      data: { agentId, skillId },
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

    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T18 Idem WF ${tag}`,
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

    // ── 1. sequential duplicate messageId ────────────────────────────────
    console.log('\n── [1] sequential duplicate messageId ──');
    const messageId = `msg-${tag}-dup`;
    const r1 = await dispatchScheduledWorkflow(
      workflowId,
      { messageId, subject: 'hello' },
      ownerId,
      { adapter: mock },
    );
    if (r1.runId) runIds.push(r1.runId);
    check(r1.routed === 'LANGFLOW', 'first dispatch routed LANGFLOW', `routed=${r1.routed}`);
    check(r1.deduped !== true, 'first dispatch not deduped', `deduped=${String(r1.deduped)}`);
    check(Boolean(r1.runId), 'first dispatch has runId', String(r1.runId));
    const callsAfter1 = mock.executeCalls.length;

    const r2 = await dispatchScheduledWorkflow(
      workflowId,
      { messageId, subject: 'hello again' },
      ownerId,
      { adapter: mock },
    );
    if (r2.runId) runIds.push(r2.runId);
    check(r2.deduped === true, 'second dispatch deduped:true', `deduped=${String(r2.deduped)}`);
    check(r2.runId === r1.runId, 'second dispatch same runId', `r1=${r1.runId} r2=${r2.runId}`);
    check(
      mock.executeCalls.length === callsAfter1,
      'execute not called again on dedupe',
      `calls=${mock.executeCalls.length} expected=${callsAfter1}`,
    );

    const key = buildPilotIdempotencyKey(workflowId, messageId);
    const count = await prisma.run.count({ where: { idempotencyKey: key } });
    check(count === 1, 'exactly one Run for idempotencyKey', `count=${count}`);

    // ── 2. concurrent same messageId ─────────────────────────────────────
    console.log('\n── [2] concurrent same messageId ──');
    const messageId2 = `msg-${tag}-concurrent`;
    const beforeCalls = mock.executeCalls.length;
    const [c1, c2] = await Promise.all([
      dispatchScheduledWorkflow(
        workflowId,
        { messageId: messageId2 },
        ownerId,
        { adapter: mock },
      ),
      dispatchScheduledWorkflow(
        workflowId,
        { messageId: messageId2 },
        ownerId,
        { adapter: mock },
      ),
    ]);
    if (c1.runId) runIds.push(c1.runId);
    if (c2.runId) runIds.push(c2.runId);
    const key2 = buildPilotIdempotencyKey(workflowId, messageId2);
    const concurrentCount = await prisma.run.count({ where: { idempotencyKey: key2 } });
    check(concurrentCount === 1, 'concurrent dispatch → single Run row', `count=${concurrentCount}`);
    check(c1.runId === c2.runId, 'concurrent same runId', `c1=${c1.runId} c2=${c2.runId}`);
    // At most one execute should have run (the created path); deduped path skips.
    const newExecutes = mock.executeCalls.length - beforeCalls;
    check(
      newExecutes <= 1,
      'concurrent: execute at most once',
      `newExecutes=${newExecutes}`,
    );

    // ── 3. different messageId → different Runs ──────────────────────────
    console.log('\n── [3] different messageIds ──');
    const d1 = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: `msg-${tag}-a` },
      ownerId,
      { adapter: mock },
    );
    const d2 = await dispatchScheduledWorkflow(
      workflowId,
      { messageId: `msg-${tag}-b` },
      ownerId,
      { adapter: mock },
    );
    if (d1.runId) runIds.push(d1.runId);
    if (d2.runId) runIds.push(d2.runId);
    check(
      Boolean(d1.runId) && Boolean(d2.runId) && d1.runId !== d2.runId,
      'different messageId → different runId',
      `d1=${d1.runId} d2=${d2.runId}`,
    );

    // ── 4. buildPilotIdempotencyKey empty throws ─────────────────────────
    console.log('\n── [4] empty key throws ──');
    try {
      buildPilotIdempotencyKey('', 'm');
      fail('empty workflowId throws', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 400,
        'empty workflowId → badRequest',
        String(e),
      );
    }
    try {
      buildPilotIdempotencyKey('w', '  ');
      fail('empty messageId throws', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 400,
        'empty messageId → badRequest',
        String(e),
      );
    }
    try {
      const k = buildPilotIdempotencyKey(`  ${workflowId}  `, `  mid  `);
      check(
        k === `pilot:${workflowId}:mid`,
        'key format pilot:workflowId:messageId (trimmed)',
        k,
      );
    } catch (e) {
      fail('valid key format', String(e));
    }
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    // Phase 6 DLQ: pilot adapter failures may leave RuntimeDeadLetter rows.
    await prisma.runtimeDeadLetter
      .deleteMany({ where: { workflowId } })
      .catch(() => undefined);
    const uniqueRunIds = [...new Set(runIds.filter(Boolean))];
    if (uniqueRunIds.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: uniqueRunIds } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: uniqueRunIds } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: uniqueRunIds } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: uniqueRunIds } } }).catch(() => undefined);
    }
    // Also clean any runs created by concurrent paths via agent
    const leftover = await prisma.run.findMany({
      where: { agentId },
      select: { id: true },
    }).catch(() => []);
    if (leftover.length) {
      const ids = leftover.map((r) => r.id);
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await prisma.workflowStep.deleteMany({ where: { workflowId } }).catch(() => undefined);
    await prisma.workflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
    if (deployId) {
      await prisma.runtimeDeployment.deleteMany({ where: { id: deployId } }).catch(() => undefined);
    }
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
