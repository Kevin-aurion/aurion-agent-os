/**
 * Ticket 19 — WS event parity + RunTrace pilot ingest + legacy null runtimeKind.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t19-trace-parity.test.ts
 *
 * Real DB. Mock RuntimeAdapter. Monkey-patch hub.publish. Cleanup only test-owned rows.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { activateDeployment } from '../../../src/lib/runtimedeployment.js';
import { hub } from '../../../src/ws/hub.js';
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
};

function createMockAdapter(
  script: (req: ExecuteRequest) => AsyncGenerator<NormalizedRunEvent>,
): MockAdapter {
  const executeCalls: ExecuteRequest[] = [];
  return {
    kind: 'LANGFLOW',
    executeCalls,
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
      return {
        kind: 'LANGFLOW' as const,
        bindingRef: `mock-bind:${input.artifactId}`,
        deployedAt: nowIso(),
      };
    },
    async *execute(input: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      executeCalls.push(input);
      yield* script(input);
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
    async resumeRun(_input: ResumeRequest): Promise<void> {},
  };
}

async function main(): Promise<void> {
  console.log('── t19-trace-parity ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const evalRunId = ulid();
  const runId = ulid();
  const legacyRunId = ulid();
  const contentMd = `# t19 trace parity ${tag}\n`;
  const secretSnippet = 'sk-test-FAKESECRET1234567890ABCDEFGH';

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const published: Array<{ topic: string; payload: unknown }> = [];
  const originalPublish = hub.publish.bind(hub);

  let executePilotRun: typeof import('../../../src/lib/runtimeexecution.js').executePilotRun;
  let ingestPilotRunTrace: typeof import('../../../src/lib/trace.js').ingestPilotRunTrace;
  let ingestRunTrace: typeof import('../../../src/lib/trace.js').ingestRunTrace;

  try {
    try {
      const execMod = await import('../../../src/lib/runtimeexecution.js');
      executePilotRun = execMod.executePilotRun;
      const traceMod = await import('../../../src/lib/trace.js');
      ingestPilotRunTrace = (traceMod as { ingestPilotRunTrace?: typeof ingestPilotRunTrace })
        .ingestPilotRunTrace as typeof ingestPilotRunTrace;
      ingestRunTrace = traceMod.ingestRunTrace;
      if (typeof ingestPilotRunTrace !== 'function') {
        fail('import ingestPilotRunTrace', 'function not exported yet');
      }
    } catch (e) {
      fail('import modules', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit) ──`);
      return;
    }

    hub.publish = (topic: string, payload: unknown) => {
      published.push({ topic, payload });
      return originalPublish(topic, payload);
    };

    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t19-trace-owner-${tag}@aios.test`,
        displayName: 'T19 Trace Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t19-trace-agent-${tag}`,
        name: `T19 Trace Agent ${tag}`,
        description: 't19 trace',
        rolePrompt: 't19',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'CODEX',
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t19-trace-skill-${tag}`,
        name: `T19 Trace Skill ${tag}`,
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
        name: `T19 Trace Suite ${tag}`,
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
      compilerVersion: `t19-trace-${tag}`,
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

    const mock = createMockAdapter(async function* (req: ExecuteRequest) {
      const rid = req.runId ?? runId;
      const at = nowIso();
      yield { type: 'run.started', runId: rid, at };
      yield { type: 'step.started', runId: rid, stepKey: 's1', at: nowIso() };
      yield { type: 'tool.call', runId: rid, tool: 'gmail.read', at: nowIso() };
      yield {
        type: 'step.finished',
        runId: rid,
        stepKey: 's1',
        ok: true,
        at: nowIso(),
        summary: `done with key ${secretSnippet}`,
      };
      yield { type: 'run.finished', runId: rid, at: nowIso(), status: 'SUCCEEDED' };
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
        name: `T19 Trace WF ${tag}`,
        description: 't19',
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

    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        workflowId,
        triggeredBy: ownerId,
        status: 'RUNNING',
        input: { messageId: `msg-${tag}` },
        runtimeKind: 'LANGFLOW',
        artifactId,
        runDir: `/tmp/aios-t19-trace-${tag}`,
      },
    });

    // ── 1. executePilotRun WS + RunTrace ─────────────────────────────────
    console.log('\n── [1] executePilotRun WS parity + RunTrace ──');
    published.length = 0;
    const result = await executePilotRun(
      {
        runId,
        deployment: await prisma.runtimeDeployment.findUniqueOrThrow({ where: { id: deployId } }),
        artifact: await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } }),
        triggeredBy: ownerId,
      },
      { adapter: mock },
    );
    check(result.status === 'SUCCEEDED', 'executePilotRun status SUCCEEDED', `status=${result.status}`);

    const stepEvents = published.filter((p) => p.topic === 'run.step');
    const logEvents = published.filter((p) => p.topic === 'run.log');
    const finishedEvents = published.filter((p) => p.topic === 'run.finished');

    const stepPayloads = stepEvents.map((e) => e.payload as Record<string, unknown>);
    const hasExecuting = stepPayloads.some((p) => p.phase === 'executing');
    const hasApproved = stepPayloads.some((p) => p.phase === 'approved');
    check(hasExecuting, "run.step phase 'executing' present", JSON.stringify(stepPayloads));
    check(hasApproved, "run.step phase 'approved' present", JSON.stringify(stepPayloads));

    const stepWithKeys = stepPayloads.find(
      (p) =>
        typeof p.runId === 'string' &&
        typeof p.stepKey === 'string' &&
        typeof p.type === 'string' &&
        typeof p.round === 'number' &&
        typeof p.phase === 'string',
    );
    check(
      Boolean(stepWithKeys),
      'run.step payload keys {runId,stepKey,type,round,phase}',
      JSON.stringify(stepPayloads[0] ?? null),
    );
    if (stepWithKeys) {
      const keys = Object.keys(stepWithKeys).sort().join(',');
      // awaiting_review shape has agentId; normal step has type/round/stepKey
      check(
        keys.includes('runId') && keys.includes('phase'),
        'run.step has runId+phase',
        keys,
      );
    }

    const toolLog = logEvents.find((e) => {
      const p = e.payload as { line?: string };
      return typeof p.line === 'string' && p.line.includes('[tool]');
    });
    check(Boolean(toolLog), 'run.log tool line present', JSON.stringify(logEvents.map((e) => e.payload)));

    check(finishedEvents.length >= 1, 'run.finished published', `count=${finishedEvents.length}`);
    const fin = finishedEvents[0]?.payload as Record<string, unknown> | undefined;
    check(
      fin?.status === 'SUCCEEDED' &&
        fin?.runId === runId &&
        fin?.agentId === agentId &&
        fin?.stoppedAt === null,
      'run.finished payload shape',
      JSON.stringify(fin),
    );

    const trace = await prisma.runTrace.findUnique({ where: { runId } });
    check(Boolean(trace), 'RunTrace created for runId', `trace=${trace?.id}`);
    check(
      (trace as { runtimeKind?: string | null } | null)?.runtimeKind === 'LANGFLOW',
      "RunTrace.runtimeKind === 'LANGFLOW'",
      `runtimeKind=${(trace as { runtimeKind?: string | null } | null)?.runtimeKind}`,
    );
    check(
      (trace as { artifactId?: string | null } | null)?.artifactId === artifactId,
      'RunTrace.artifactId matches run.artifactId',
      `artifactId=${(trace as { artifactId?: string | null } | null)?.artifactId}`,
    );
    const trajStr = JSON.stringify(trace?.trajectory ?? null);
    check(
      !trajStr.includes('FAKESECRET'),
      'trajectory redacts secret (no FAKESECRET)',
      trajStr.slice(0, 300),
    );
    check(trace?.trajectoryKey === null, 'trajectoryKey is null', `key=${trace?.trajectoryKey}`);

    // ── 2. idempotent re-ingest ─────────────────────────────────────────
    console.log('\n── [2] ingestPilotRunTrace P2002 idempotent ──');
    if (typeof ingestPilotRunTrace === 'function') {
      try {
        await ingestPilotRunTrace({
          runId,
          agentId,
          artifactId,
          engineExecute: 'CLAUDE_CODE',
          engineVerify: 'CODEX',
          status: 'SUCCEEDED',
          events: [
            { type: 'run.started', runId, at: nowIso() },
            { type: 'run.finished', runId, at: nowIso(), status: 'SUCCEEDED' },
          ],
        });
        pass('second ingestPilotRunTrace does not throw');
      } catch (e) {
        fail('second ingestPilotRunTrace does not throw', String(e));
      }
      const count = await prisma.runTrace.count({ where: { runId } });
      check(count === 1, 'RunTrace still exactly 1 row after re-ingest', `count=${count}`);
    } else {
      fail('ingestPilotRunTrace available', 'not exported');
    }

    // ── 3. legacy ingestRunTrace → runtimeKind null ─────────────────────
    console.log('\n── [3] legacy ingestRunTrace runtimeKind null ──');
    // Need a dummy agent-owned runId unique for trace (run not required by schema)
    try {
      await ingestRunTrace({
        agent: { id: agentId },
        manifest: {
          agentSlug: `t19-trace-agent-${tag}`,
          agentId,
          agentDir: '/tmp/x',
          engineExecute: 'CLAUDE_CODE',
          engineVerify: 'CODEX',
          maxRounds: 3,
          rolePrompt: 'x',
          restrictions: {
            webSearch: false,
            computerUse: false,
            sendEmail: false,
            cloudWrite: false,
            shell: false,
          },
          skills: [],
          steps: [],
          memoryCore: '',
          identityCard: null,
        } as never,
        outcome: {
          ok: true,
          runId: legacyRunId,
          runDir: '/tmp/legacy',
          status: 'SUCCEEDED',
          results: [],
          reworkHistory: [],
        },
      });
      pass('legacy ingestRunTrace does not throw');
    } catch (e) {
      fail('legacy ingestRunTrace does not throw', String(e));
    }
    const legacy = await prisma.runTrace.findUnique({ where: { runId: legacyRunId } });
    check(Boolean(legacy), 'legacy RunTrace row created', `id=${legacy?.id}`);
    check(
      (legacy as { runtimeKind?: string | null } | null)?.runtimeKind == null,
      'legacy runtimeKind is null',
      `runtimeKind=${(legacy as { runtimeKind?: string | null } | null)?.runtimeKind}`,
    );
  } finally {
    hub.publish = originalPublish;
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.runTrace.deleteMany({ where: { runId: { in: [runId, legacyRunId] } } }).catch(() => undefined);
    await prisma.approvalRequest.deleteMany({ where: { runId } }).catch(() => undefined);
    await prisma.runStep.deleteMany({ where: { runId } }).catch(() => undefined);
    await prisma.costLog.deleteMany({ where: { runId } }).catch(() => undefined);
    await prisma.run.deleteMany({ where: { id: runId } }).catch(() => undefined);
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
