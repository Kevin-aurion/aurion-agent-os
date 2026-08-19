/**
 * Ticket 20 PoC 07 — digest drift (negative).
 * Tamper VALIDATED artifactJson → verify/assertDigest/getVerified throw;
 * activateDeployment rejects with zero new RuntimeDeployment rows.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-07-digest-drift.test.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  createFlowArtifact,
  getVerifiedFlowArtifact,
  verifyArtifactDigest,
  FlowArtifactError,
} from '../../../src/lib/flowartifact.js';
import { assertDigestMatches, RuntimeAdapterError } from '../../../src/runtime/adapter.js';
import { ApiError } from '../../../src/lib/http.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';

const LIVE_LANGFLOW = 'http://127.0.0.1:7860';

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

async function throwsAsync(
  fn: () => Promise<unknown>,
  label: string,
  pred: (err: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    fail(label, 'expected throw, got none');
  } catch (e) {
    if (pred(e)) pass(label);
    else fail(label, `threw but predicate failed: ${String(e)}`);
  }
}

function throwsSync(fn: () => void, label: string, pred: (err: unknown) => boolean): void {
  try {
    fn();
    fail(label, 'expected throw, got none');
  } catch (e) {
    if (pred(e)) pass(label);
    else fail(label, `threw but predicate failed: ${String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log('── t20-poc-07-digest-drift ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const contentMd = `# t20 poc07 digest ${tag}\n`;
  let skillVersionId = '';
  let artifactId = '';

  // Ticket 23: targets FDE sandbox @ 7860 — fixed sandbox placeholder only (never Production key).
  const liveAdapter = new LangflowAdapter({
    baseUrl: LIVE_LANGFLOW,
    apiKey: 'sandbox-flow-api-key-not-production-local-only-v1',
    timeoutMs: 8_000,
  });

  try {
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    try {
      const dep = await import('../../../src/lib/runtimedeployment.js');
      activateDeployment = dep.activateDeployment;
      validateArtifactForRuntime = dep.validateArtifactForRuntime;
    } catch (e) {
      fail('import runtimedeployment', String(e));
      return;
    }

    console.log('── setup VALIDATED artifact ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc07-owner-${tag}@aios.test`,
        displayName: 'T20 PoC07 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc07-skill-${tag}`,
        name: `T20 PoC07 Skill ${tag}`,
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
      data: { id: suiteId, skillId, name: `T20 PoC07 Suite ${tag}`, createdBy: ownerId },
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
      compilerVersion: `t20-poc07-${tag}`,
      artifactJson: {
        schemaVersion: 'aios.flow-graph/1',
        template: 'email-triage-readonly-v1',
        nodes: [
          { id: 'n1', kind: 'input', config: {} },
          { id: 'n2', kind: 'output', config: {} },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      },
      createdBy: ownerId,
    });
    artifactId = art.id;

    await validateArtifactForRuntime(
      { artifactId, actorId: ownerId, actorRole: 'OWNER' },
      { adapter: liveAdapter },
    );
    const beforeTamper = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    check(beforeTamper.status === 'VALIDATED', 'pre-tamper VALIDATED', `status=${beforeTamper.status}`);
    const originalDigest = beforeTamper.digest;

    // ── [1] tamper test-owned row only ───────────────────────────────────
    console.log('\n── [1] DB tamper artifactJson ──');
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: {
        artifactJson: {
          schemaVersion: 'aios.flow-graph/1',
          template: 'email-triage-readonly-v1',
          nodes: [{ id: 'TAMPERED', kind: 'input', config: { evil: true } }],
          edges: [],
          injected: true,
        },
      },
    });
    const tampered = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    check(tampered.digest === originalDigest, 'digest column unchanged after tamper', tampered.digest);
    console.log(`  evidence: stored digest still=${originalDigest}`);

    // ── [2] verifyArtifactDigest / assertDigestMatches throw ─────────────
    console.log('\n── [2] digest verify throws ──');
    throwsSync(
      () => verifyArtifactDigest(tampered.artifactJson, tampered.digest),
      'verifyArtifactDigest throws on drift',
      (e) =>
        e instanceof FlowArtifactError &&
        (e.code === 'DIGEST_MISMATCH' || /digest/i.test(e.message)),
    );
    throwsSync(
      () => assertDigestMatches(tampered.artifactJson, tampered.digest),
      'assertDigestMatches throws on drift',
      (e) =>
        e instanceof RuntimeAdapterError &&
        (e.code === 'VALIDATION_FAILED' || /digest/i.test(e.message)),
    );

    await throwsAsync(
      () => getVerifiedFlowArtifact(artifactId),
      'getVerifiedFlowArtifact rejects drift',
      (e) =>
        e instanceof FlowArtifactError &&
        (e.code === 'DIGEST_MISMATCH' || /digest/i.test(e.message)),
    );

    // ── [3] activateDeployment rejects; zero new deployments ─────────────
    console.log('\n── [3] activateDeployment reject + zero new rows ──');
    const countBefore = await prisma.runtimeDeployment.count({ where: { skillId } });
    const globalBefore = await prisma.runtimeDeployment.count();
    console.log(`  evidence: RuntimeDeployment skill count before=${countBefore} global=${globalBefore}`);

    await throwsAsync(
      () =>
        activateDeployment(
          {
            artifactId,
            environment: 'PRODUCTION',
            channel: 'CANARY',
            actorId: ownerId,
            actorRole: 'OWNER',
          },
          { adapter: liveAdapter },
        ),
      'activateDeployment throws on digest drift',
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/digest/i.test(msg)) return false;
        if (e instanceof ApiError) return e.statusCode === 409 || e.code === 'CONFLICT';
        return true;
      },
    );

    const countAfter = await prisma.runtimeDeployment.count({ where: { skillId } });
    const globalAfter = await prisma.runtimeDeployment.count();
    console.log(`  evidence: RuntimeDeployment skill count after=${countAfter} global=${globalAfter}`);
    check(countAfter === countBefore, 'zero new RuntimeDeployment for skill', `before=${countBefore} after=${countAfter}`);
    check(globalAfter === globalBefore, 'zero new RuntimeDeployment globally', `before=${globalBefore} after=${globalAfter}`);

    const still = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    check(still.status === 'VALIDATED', 'status remains VALIDATED after failed activate', `status=${still.status}`);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: evalRunId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
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
