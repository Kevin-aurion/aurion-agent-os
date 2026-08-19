/**
 * Ticket 24 — Runtime binding correctly routes to Langflow Flow ID.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t24-runtime-binding-execution.test.ts
 *
 * - Valid runtimeBinding → adapter.execute receives Langflow flow id (not AIOS artifact id)
 * - malformed / missing / wrong-kind / control-char binding → Run FAILED, zero adapter calls
 * - Never falls back to AIOS FlowArtifact.id
 *
 * Real DB via prisma. Injected mock RuntimeAdapter. Cleanup deletes only test-owned rows.
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
import {
  parseLangflowRuntimeBinding,
  getOrCreatePilotRun,
  executePilotRun,
} from '../../../src/lib/runtimeexecution.js';
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

/** Fixed Langflow flow id returned by mock deploy (must not equal AIOS artifact id). */
const MOCK_LANGFLOW_FLOW_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

type MockAdapter = RuntimeAdapter & {
  executeCalls: ExecuteRequest[];
  resumeCalls: ResumeRequest[];
  callCount: number;
};

function createMockAdapter(opts?: {
  flowId?: string;
  /** Override deploy binding entirely (for negative path setup via activate). */
  bindingRef?: string;
  kind?: string;
}): MockAdapter {
  const executeCalls: ExecuteRequest[] = [];
  const resumeCalls: ResumeRequest[] = [];
  const flowId = opts?.flowId ?? MOCK_LANGFLOW_FLOW_ID;
  const bindingRef = opts?.bindingRef ?? `langflow:flow:${flowId}`;
  const kind = opts?.kind ?? 'LANGFLOW';

  const adapter: MockAdapter = {
    kind: 'LANGFLOW',
    executeCalls,
    resumeCalls,
    callCount: 0,
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
    async deployArtifact(_input: DeployArtifactRequest) {
      return {
        kind: kind as 'LANGFLOW',
        bindingRef,
        deployedAt: nowIso(),
      };
    },
    async *execute(input: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      adapter.callCount += 1;
      executeCalls.push(input);
      const runId = input.runId ?? 'unknown';
      yield { type: 'run.started', runId, at: nowIso() };
      yield {
        type: 'run.finished',
        runId,
        at: nowIso(),
        status: 'SUCCEEDED',
      };
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

type NegCase = { name: string; binding: unknown };

const NEGATIVE_BINDINGS: NegCase[] = [
  { name: 'null binding', binding: null },
  { name: 'undefined binding', binding: undefined },
  { name: 'array binding', binding: [{ kind: 'LANGFLOW', bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` }] },
  { name: 'string binding', binding: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` },
  { name: 'missing kind', binding: { bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'missing bindingRef', binding: { kind: 'LANGFLOW' } },
  { name: 'wrong kind NATIVE', binding: { kind: 'NATIVE', bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'wrong kind lowercase', binding: { kind: 'langflow', bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'kind with whitespace', binding: { kind: ' LANGFLOW', bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'wrong prefix native:', binding: { kind: 'LANGFLOW', bindingRef: `native:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'wrong prefix mock-bind', binding: { kind: 'LANGFLOW', bindingRef: `mock-bind:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'empty flow id', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:' } },
  { name: 'bindingRef with leading space', binding: { kind: 'LANGFLOW', bindingRef: ` langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'bindingRef with trailing space', binding: { kind: 'LANGFLOW', bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID} ` } },
  { name: 'flow id with internal space', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:abc def' } },
  { name: 'flow id with tab', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:abc\tdef' } },
  { name: 'flow id with CR', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:abc\rdef' } },
  { name: 'flow id with LF', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:abc\ndef' } },
  { name: 'flow id with NUL', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:abc\u0000def' } },
  { name: 'flow id with slash', binding: { kind: 'LANGFLOW', bindingRef: 'langflow:flow:abc/../x' } },
  { name: 'bindingRef null', binding: { kind: 'LANGFLOW', bindingRef: null } },
  { name: 'extra prefix/suffix garbage', binding: { kind: 'LANGFLOW', bindingRef: `xxlangflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
  { name: 'double prefix', binding: { kind: 'LANGFLOW', bindingRef: `langflow:flow:langflow:flow:${MOCK_LANGFLOW_FLOW_ID}` } },
];

async function setupFixtures(tag: string): Promise<{
  ownerId: string;
  agentId: string;
  skillId: string;
  skillVersionId: string;
  suiteId: string;
  evalRunId: string;
  artifactId: string;
  workflowId: string;
  stepId: string;
}> {
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const contentMd = `# t24 runtime binding ${tag}\n`;

  await prisma.user.create({
    data: {
      id: ownerId,
      email: `t24-owner-${tag}@aios.test`,
      displayName: 'T24 Owner',
      passwordHash: 'x',
      role: 'OWNER',
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `t24-agent-${tag}`,
      name: `T24 Agent ${tag}`,
      description: 't24',
      rolePrompt: 't24',
      engineExecute: 'CLAUDE_CODE',
      engineVerify: null,
      createdBy: ownerId,
      riskTier: 'low',
    },
  });
  await prisma.skill.create({
    data: {
      id: skillId,
      slug: `t24-skill-${tag}`,
      name: `T24 Skill ${tag}`,
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
  const skillVersionId = sv.id;

  await prisma.evalSuite.create({
    data: {
      id: suiteId,
      skillId,
      name: `T24 Suite ${tag}`,
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
    compilerVersion: `t24-${tag}`,
    artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'langflow', tag },
    createdBy: ownerId,
  });
  const artifactId = art.id;
  const row = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
  await prisma.flowArtifact.update({
    where: { id: artifactId },
    data: {
      status: 'VALIDATED',
      digest: computeFlowArtifactDigest(row.artifactJson),
    },
  });

  await prisma.agentSkill.create({ data: { agentId, skillId } });
  await prisma.workflow.create({
    data: {
      id: workflowId,
      agentId,
      name: `T24 WF ${tag}`,
      description: 't24',
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

  return {
    ownerId,
    agentId,
    skillId,
    skillVersionId,
    suiteId,
    evalRunId,
    artifactId,
    workflowId,
    stepId,
  };
}

async function cleanupFixtures(f: {
  ownerId: string;
  agentId: string;
  skillId: string;
  skillVersionId: string;
  suiteId: string;
  evalRunId: string;
  artifactId: string;
  workflowId: string;
  runIds: string[];
}): Promise<void> {
  const agentRuns = await prisma.run
    .findMany({ where: { agentId: f.agentId }, select: { id: true } })
    .catch(() => []);
  const ids = [...new Set([...f.runIds, ...agentRuns.map((r) => r.id)].filter(Boolean))];
  if (ids.length) {
    await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
    await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
    await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
    await prisma.runTrace.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
    await prisma.runtimeDeadLetter.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
    await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }
  await prisma.runtimeDeadLetter
    .deleteMany({ where: { workflowId: f.workflowId } })
    .catch(() => undefined);
  await prisma.workflowStep.deleteMany({ where: { workflowId: f.workflowId } }).catch(() => undefined);
  await prisma.workflow.deleteMany({ where: { id: f.workflowId } }).catch(() => undefined);
  await prisma.runtimeDeployment.deleteMany({ where: { skillId: f.skillId } }).catch(() => undefined);
  await prisma.agentSkill.deleteMany({ where: { agentId: f.agentId } }).catch(() => undefined);
  await prisma.evalRun.deleteMany({ where: { id: f.evalRunId } }).catch(() => undefined);
  await prisma.evalSuite.deleteMany({ where: { id: f.suiteId } }).catch(() => undefined);
  if (f.artifactId) {
    await prisma.flowArtifact.deleteMany({ where: { id: f.artifactId } }).catch(() => undefined);
  }
  if (f.skillVersionId) {
    await prisma.flowArtifact.deleteMany({ where: { skillVersionId: f.skillVersionId } }).catch(() => undefined);
    await prisma.skillVersion.deleteMany({ where: { id: f.skillVersionId } }).catch(() => undefined);
  }
  await prisma.skill.deleteMany({ where: { id: f.skillId } }).catch(() => undefined);
  await prisma.agent.deleteMany({ where: { id: f.agentId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: f.ownerId } }).catch(() => undefined);
}

async function main(): Promise<void> {
  console.log('── t24-runtime-binding-execution ──');

  // ── Unit: pure parser ──────────────────────────────────────────────────
  console.log('\n── [0] parseLangflowRuntimeBinding pure cases ──');
  {
    const ok = parseLangflowRuntimeBinding({
      kind: 'LANGFLOW',
      bindingRef: `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}`,
      deployedAt: nowIso(),
    });
    check(ok.ok === true, 'valid binding parses', JSON.stringify(ok));
    if (ok.ok) {
      check(
        ok.flowId === MOCK_LANGFLOW_FLOW_ID,
        'extracted flowId equals Langflow id',
        `flowId=${ok.flowId}`,
      );
    }

    for (const c of NEGATIVE_BINDINGS) {
      const r = parseLangflowRuntimeBinding(c.binding);
      check(r.ok === false, `parser rejects: ${c.name}`, JSON.stringify(r));
    }

    // Must never return AIOS artifact id when binding is wrong even if object has artifactId field.
    const spoof = parseLangflowRuntimeBinding({
      kind: 'LANGFLOW',
      bindingRef: 'mock-bind:AIOS-ARTIFACT-ID-SPOOF',
      artifactId: 'AIOS-ARTIFACT-ID-SPOOF',
    });
    check(spoof.ok === false, 'parser never falls back to artifactId field', JSON.stringify(spoof));
  }

  const tag = ulid().slice(-8).toLowerCase();
  const runIds: string[] = [];
  let fixtures: Awaited<ReturnType<typeof setupFixtures>> | null = null;

  try {
    fixtures = await setupFixtures(tag);
    const { ownerId, agentId, skillId, artifactId, workflowId } = fixtures;

    // ── Positive: adapter receives Langflow flow id ──────────────────────
    console.log('\n── [1] positive: execute uses Langflow flow id ──');
    const mock = createMockAdapter({ flowId: MOCK_LANGFLOW_FLOW_ID });
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
    const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({
      where: { id: dep.id },
    });
    // Confirm stored binding is the Langflow ref (not AIOS artifact id).
    const storedBinding = deployment.runtimeBinding as { bindingRef?: string };
    check(
      storedBinding?.bindingRef === `langflow:flow:${MOCK_LANGFLOW_FLOW_ID}`,
      'deployment stores langflow:flow:<flowId>',
      JSON.stringify(deployment.runtimeBinding),
    );
    check(
      MOCK_LANGFLOW_FLOW_ID !== artifactId,
      'Langflow flow id ≠ AIOS artifact id (test invariant)',
      `flow=${MOCK_LANGFLOW_FLOW_ID} art=${artifactId}`,
    );

    const artifact = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    const { run, created } = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId: `msg-pos-${tag}`,
      triggeredBy: ownerId,
      input: { messageId: `msg-pos-${tag}`, subject: 'hello' },
    });
    runIds.push(run.id);
    check(created === true, 'pilot run created', run.id);

    const result = await executePilotRun(
      {
        runId: run.id,
        deployment,
        artifact,
        triggeredBy: ownerId,
      },
      { adapter: mock },
    );
    check(result.status === 'SUCCEEDED', 'executePilotRun SUCCEEDED', `status=${result.status}`);
    check(mock.executeCalls.length === 1, 'adapter.execute called once', `calls=${mock.executeCalls.length}`);
    const execReq = mock.executeCalls[0];
    check(
      execReq?.artifactId === MOCK_LANGFLOW_FLOW_ID,
      'adapter.artifactId is Langflow flow id',
      `got=${execReq?.artifactId}`,
    );
    check(
      execReq?.artifactId !== artifactId,
      'adapter.artifactId is NOT AIOS artifact id',
      `got=${execReq?.artifactId} aios=${artifactId}`,
    );

    // ── Negative: overwrite binding on deployment, zero adapter calls ────
    console.log('\n── [2] negative: invalid binding → FAILED, zero adapter calls ──');
    for (const c of NEGATIVE_BINDINGS) {
      // undefined: pure parser covers it; deployment always has a Json value in DB.
      if (c.binding === undefined) continue;

      const negMock = createMockAdapter();
      const baseDep = await prisma.runtimeDeployment.findUniqueOrThrow({ where: { id: dep.id } });
      // Untrusted binding is exercised in-memory (mirrors productionloader handoff).
      // Postgres rejects \u0000 in json text — pure parser in [0] still covers NUL.
      const deploymentForExec = {
        ...baseDep,
        runtimeBinding: c.binding as Prisma.JsonValue,
      };

      const { run: badRun } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: `msg-neg-${tag}-${c.name.replace(/\W+/g, '_').slice(0, 40)}`,
        triggeredBy: ownerId,
        input: { subject: c.name },
      });
      runIds.push(badRun.id);

      const before = negMock.executeCalls.length;
      const beforeCount = negMock.callCount;
      const negResult = await executePilotRun(
        {
          runId: badRun.id,
          deployment: deploymentForExec,
          artifact,
          triggeredBy: ownerId,
        },
        { adapter: negMock },
      );
      check(
        negResult.status === 'FAILED',
        `neg status FAILED: ${c.name}`,
        `status=${negResult.status}`,
      );
      check(
        negMock.executeCalls.length === before && negMock.callCount === beforeCount,
        `neg zero adapter execute: ${c.name}`,
        `calls=${negMock.executeCalls.length} count=${negMock.callCount}`,
      );
      const row = await prisma.run.findUniqueOrThrow({ where: { id: badRun.id } });
      check(row.status === 'FAILED', `neg DB FAILED: ${c.name}`, `status=${row.status}`);
      check(row.status !== 'SUCCEEDED', `neg never SUCCEEDED: ${c.name}`, `status=${row.status}`);
      // output should not leak secret-looking strings (redactor path)
      const outStr = JSON.stringify(row.output ?? {});
      check(
        !outStr.includes('sk-') && !outStr.includes('Bearer '),
        `neg output no secret-like leak: ${c.name}`,
        outStr.slice(0, 120),
      );
    }

    void skillId;
  } catch (e) {
    fail('unexpected', e instanceof Error ? e.message : String(e));
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    if (fixtures) {
      await cleanupFixtures({ ...fixtures, runIds });
    }
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
