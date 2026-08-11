/**
 * Ticket 19 — deployment activate/rollback/deactivate audit trail + chain integrity.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t19-audit-chain.test.ts
 *
 * Real DB. Mock adapter for validate/deploy. Does NOT delete AuditLog (append-only).
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
import { verifyAuditChain } from '../../../src/lib/audit.js';
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

function createMockAdapter(): RuntimeAdapter {
  return {
    kind: 'LANGFLOW',
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
    async *execute(_input: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      yield { type: 'run.started', runId: 'x', at: nowIso() };
      yield { type: 'run.finished', runId: 'x', at: nowIso(), status: 'SUCCEEDED' };
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
  console.log('── t19-audit-chain ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRun1 = ulid();
  const evalRun2 = ulid();
  const contentMd = `# t19 audit ${tag}\n`;

  let skillVersionId = '';
  let skillVersion2Id = '';
  let artifactA = '';
  let artifactB = '';
  let deployA = '';
  let deployB = '';
  const mock = createMockAdapter();

  try {
    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t19-audit-owner-${tag}@aios.test`,
        displayName: 'T19 Audit Owner',
        passwordHash: 'x',
        role: 'TRAINER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t19-audit-agent-${tag}`,
        name: `T19 Audit Agent ${tag}`,
        description: 't19 audit',
        rolePrompt: 't19',
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
        slug: `t19-audit-skill-${tag}`,
        name: `T19 Audit Skill ${tag}`,
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
    const sv2 = await createSkillVersion(skillId, contentMd + '\nv2\n', ownerId);
    skillVersion2Id = sv2.id;

    await prisma.evalSuite.create({
      data: {
        id: suiteId,
        skillId,
        name: `T19 Audit Suite ${tag}`,
        createdBy: ownerId,
      },
    });
    for (const [id, versionId] of [
      [evalRun1, skillVersionId],
      [evalRun2, skillVersion2Id],
    ] as const) {
      await prisma.evalRun.create({
        data: {
          id,
          suiteId,
          skillId,
          candidateVersionId: versionId,
          executeEngine: 'CLAUDE_CODE',
          verifyEngine: 'CODEX',
          status: 'PASSED',
          totalCases: 1,
          passedCases: 1,
          finishedAt: new Date(),
          triggeredBy: ownerId,
        },
      });
    }

    async function makeValidated(versionId: string, compilerTag: string): Promise<string> {
      const art = await createFlowArtifact({
        skillVersionId: versionId,
        runtimeKind: 'LANGFLOW',
        template: 'email-triage-readonly-v1',
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

    artifactA = await makeValidated(skillVersionId, `t19-audit-a-${tag}`);
    artifactB = await makeValidated(skillVersion2Id, `t19-audit-b-${tag}`);

    console.log('\n── activate → rollback → deactivate ──');
    const a1 = await activateDeployment(
      {
        artifactId: artifactA,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'TRAINER',
      },
      { adapter: mock },
    );
    deployA = a1.id;

    const a2 = await activateDeployment(
      {
        artifactId: artifactB,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'TRAINER',
      },
      { adapter: mock },
    );
    deployB = a2.id;

    // Rollback to first deploy (now inactive)
    await rollbackDeployment({
      deploymentId: deployA,
      actorId: ownerId,
      actorRole: 'TRAINER',
    });

    await deactivateDeployment({
      deploymentId: deployA,
      actorId: ownerId,
      actorRole: 'TRAINER',
    });

    const activateLogs = await prisma.auditLog.findMany({
      where: {
        action: 'runtime.deployment.activate',
        entityId: { in: [deployA, deployB] },
      },
    });
    const rollbackLogs = await prisma.auditLog.findMany({
      where: {
        action: 'runtime.deployment.rollback',
        entityId: deployA,
      },
    });
    const deactivateLogs = await prisma.auditLog.findMany({
      where: {
        action: 'runtime.deployment.deactivate',
        entityId: deployA,
      },
    });

    check(
      activateLogs.length >= 1,
      'AuditLog has runtime.deployment.activate',
      `count=${activateLogs.length} ids=${activateLogs.map((l) => l.entityId).join(',')}`,
    );
    check(
      rollbackLogs.length >= 1,
      'AuditLog has runtime.deployment.rollback for deployA',
      `count=${rollbackLogs.length}`,
    );
    check(
      deactivateLogs.length >= 1,
      'AuditLog has runtime.deployment.deactivate for deployA',
      `count=${deactivateLogs.length}`,
    );

    // Also accept activate on either deploy entity
    const anyActivate =
      activateLogs.some((l) => l.entityId === deployA) ||
      activateLogs.some((l) => l.entityId === deployB);
    check(anyActivate, 'activate entityId matches a deployment we created', 'none matched');

    const chain = await verifyAuditChain();
    check(chain.valid === true, 'verifyAuditChain() valid=true', JSON.stringify(chain));
  } finally {
    console.log('\n── cleanup test-owned rows only (no AuditLog delete) ──');
    for (const id of [deployA, deployB].filter(Boolean)) {
      await prisma.runtimeDeployment.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: { in: [evalRun1, evalRun2] } } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    for (const aid of [artifactA, artifactB].filter(Boolean)) {
      await prisma.flowArtifact.deleteMany({ where: { id: aid } }).catch(() => undefined);
    }
    for (const vid of [skillVersionId, skillVersion2Id].filter(Boolean)) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId: vid } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: vid } }).catch(() => undefined);
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
