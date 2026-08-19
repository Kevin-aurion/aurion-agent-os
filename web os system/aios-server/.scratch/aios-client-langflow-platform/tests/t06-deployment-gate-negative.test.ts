/**
 * Ticket 06 — FDE Runtime Deployment Gate negative matrix (live HTTP + real DB + lib).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t06-deployment-gate-negative.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. Live HTTP http://127.0.0.1:8700.
 * Cleanup deletes only test-owned rows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { Engine, RuntimeKind } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { ApiError } from '../../../src/lib/http.js';

const BASE = 'http://127.0.0.1:8700';

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

function isForbidden(e: unknown): boolean {
  if (e instanceof ApiError) return e.statusCode === 403 || e.code === 'FORBIDDEN';
  const msg = e instanceof Error ? e.message : String(e);
  return /forbidden|訓練權限|403/i.test(msg);
}

function isConflict(e: unknown): boolean {
  if (e instanceof ApiError) return e.statusCode === 409 || e.code === 'CONFLICT';
  const msg = e instanceof Error ? e.message : String(e);
  return /conflict|拒絕|409/i.test(msg);
}

function isBadRequest(e: unknown): boolean {
  if (e instanceof ApiError) return e.statusCode === 400 || e.code === 'BAD_REQUEST';
  const msg = e instanceof Error ? e.message : String(e);
  return /bad\s*request|非法|400/i.test(msg);
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function deploymentCount(): Promise<number> {
  // Model may not exist until migration; treat missing as 0 for early red.
  try {
    return await (prisma as any).runtimeDeployment.count();
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const suiteId = ulid();
  const caseId = ulid();
  const memberId = ulid();
  const ownerId = ulid();
  const slug = `t06-dep-neg-${tag}`;
  const contentV1 = '# t06 deployment gate negative\n\ntest\n';

  let skillVersionId = '';
  let artifactCompiledId = '';
  let artifactValidatedId = '';
  let artifactSameFamilyId = '';
  let skillVersionSameFamilyId = '';
  let evalRunPassedId = '';
  let evalRunHighRiskId = '';
  let evalRunSameFamilyId = '';
  let deploymentForDriftId = '';
  let memberToken = '';
  let ownerToken = '';

  const trackedEvalRunIds: string[] = [];
  const trackedEvalResultIds: string[] = [];
  const trackedDeploymentIds: string[] = [];

  console.log('── setup: t06 negative fixtures ──');
  try {
    await prisma.user.create({
      data: {
        id: memberId,
        email: `t06-member-${tag}@aios.test`,
        displayName: 'T06 Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t06-owner-${tag}@aios.test`,
        displayName: 'T06 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    memberToken = await signAccess({
      sub: memberId,
      email: `t06-member-${tag}@aios.test`,
      role: 'MEMBER',
    });
    ownerToken = await signAccess({
      sub: ownerId,
      email: `t06-owner-${tag}@aios.test`,
      role: 'OWNER',
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: `T06 Deploy Neg ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: contentV1,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, contentV1);
    skillVersionId = sv.id;

    await prisma.evalSuite.create({
      data: {
        id: suiteId,
        skillId,
        name: `T06 Suite ${tag}`,
        description: 'fixture',
        createdBy: ownerId,
      },
    });
    await prisma.evalCase.create({
      data: {
        id: caseId,
        suiteId,
        kind: 'POSITIVE_TRIGGER',
        name: 'fixture case',
        input: { q: 'hello' },
        expected: { ok: true },
      },
    });

    const compiled = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-neg-compiled-${tag}`,
      artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    artifactCompiledId = compiled.id;

    const validated = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-neg-validated-${tag}`,
      artifactJson: { nodes: [{ id: 'n2' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    artifactValidatedId = validated.id;
    await prisma.flowArtifact.update({
      where: { id: artifactValidatedId },
      data: { status: 'VALIDATED' },
    });

    // Dynamic import so "module not found" still yields a structured red run.
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    let rollbackDeployment: typeof import('../../../src/lib/runtimedeployment.js').rollbackDeployment;
    try {
      const mod = await import('../../../src/lib/runtimedeployment.js');
      activateDeployment = mod.activateDeployment;
      validateArtifactForRuntime = mod.validateArtifactForRuntime;
      rollbackDeployment = mod.rollbackDeployment;
    } catch (e) {
      fail('import runtimedeployment module', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit: missing module) ──`);
      return;
    }

    // ── 1. MEMBER POST deployments → 403 ─────────────────────────────────
    console.log('\n── [1] MEMBER POST /api/runtime/deployments → 403 ──');
    const countBefore1 = await deploymentCount();
    const r1 = await json(`${BASE}/api/runtime/deployments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        artifactId: artifactValidatedId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
      }),
    });
    check(r1.response.status === 403, 'MEMBER activate HTTP 403', `HTTP ${r1.response.status} body=${JSON.stringify(r1.body)}`);
    const countAfter1 = await deploymentCount();
    check(countAfter1 === countBefore1, 'MEMBER activate: zero new RuntimeDeployment', `before=${countBefore1} after=${countAfter1}`);

    // ── 2. MEMBER POST validate → 403 ────────────────────────────────────
    console.log('\n── [2] MEMBER POST validate → 403 ──');
    const r2 = await json(`${BASE}/api/runtime/artifacts/${artifactCompiledId}/validate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    check(r2.response.status === 403, 'MEMBER validate HTTP 403', `HTTP ${r2.response.status}`);
    const stillCompiled = await prisma.flowArtifact.findUnique({ where: { id: artifactCompiledId } });
    check(stillCompiled?.status === 'COMPILED', 'MEMBER validate: artifact stays COMPILED', `status=${stillCompiled?.status}`);

    // ── 3. lib activateDeployment MEMBER → forbidden ─────────────────────
    console.log('\n── [3] lib activateDeployment MEMBER → forbidden ──');
    const countBefore3 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: artifactValidatedId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: memberId,
          actorRole: 'MEMBER',
        }),
      'lib activate MEMBER throws forbidden',
      isForbidden,
    );
    const countAfter3 = await deploymentCount();
    check(countAfter3 === countBefore3, 'lib MEMBER activate: zero new rows', `before=${countBefore3} after=${countAfter3}`);

    // ── 4. COMPILED-only activate → conflict ─────────────────────────────
    console.log('\n── [4] COMPILED-only activate → conflict ──');
    const countBefore4 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: artifactCompiledId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'COMPILED-only activate throws conflict',
      isConflict,
    );
    const countAfter4 = await deploymentCount();
    check(countAfter4 === countBefore4, 'COMPILED-only: zero new rows', `before=${countBefore4} after=${countAfter4}`);
    const stillCompiled4 = await prisma.flowArtifact.findUnique({ where: { id: artifactCompiledId } });
    check(stillCompiled4?.status === 'COMPILED', 'COMPILED-only: status unchanged', `status=${stillCompiled4?.status}`);

    // ── 5. no-eval: VALIDATED but no PASSED EvalRun ──────────────────────
    console.log('\n── [5] no-eval → reject ──');
    const countBefore5 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: artifactValidatedId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'no-eval activate throws conflict',
      isConflict,
    );
    const countAfter5 = await deploymentCount();
    check(countAfter5 === countBefore5, 'no-eval: zero new rows', `before=${countBefore5} after=${countAfter5}`);

    // Create a PASSED eval for subsequent cases (highRisk / happy-path setup for drift).
    evalRunPassedId = ulid();
    trackedEvalRunIds.push(evalRunPassedId);
    await prisma.evalRun.create({
      data: {
        id: evalRunPassedId,
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

    // ── 6. highRisk unresolved ───────────────────────────────────────────
    console.log('\n── [6] highRisk unresolved → reject ──');
    evalRunHighRiskId = ulid();
    const highRiskResultId = ulid();
    trackedEvalRunIds.push(evalRunHighRiskId);
    trackedEvalResultIds.push(highRiskResultId);
    // Use a second PASSED run is not needed — high risk attaches to candidate version via run relation.
    // Attach highRisk result to the existing PASSED run so gate 6 fires.
    await prisma.evalResult.create({
      data: {
        id: highRiskResultId,
        runId: evalRunPassedId,
        caseId,
        status: 'FAIL',
        highRisk: true,
        resolved: false,
        evidence: 't06 high risk fixture',
      },
    });
    const countBefore6 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: artifactValidatedId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'highRisk activate throws conflict',
      isConflict,
    );
    const countAfter6 = await deploymentCount();
    check(countAfter6 === countBefore6, 'highRisk: zero new rows', `before=${countBefore6} after=${countAfter6}`);
    // Resolve so later cases can proceed if needed.
    await prisma.evalResult.update({
      where: { id: highRiskResultId },
      data: { resolved: true },
    });

    // ── 7. same-family (CODEX/CODEX) ─────────────────────────────────────
    console.log('\n── [7] same-family → reject ──');
    const svSame = await createSkillVersion(skillId, contentV1 + '\n## same family\n');
    skillVersionSameFamilyId = svSame.id;
    const sameArt = await createFlowArtifact({
      skillVersionId: skillVersionSameFamilyId,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-neg-samefam-${tag}`,
      artifactJson: { nodes: [{ id: 'n3' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    artifactSameFamilyId = sameArt.id;
    await prisma.flowArtifact.update({
      where: { id: artifactSameFamilyId },
      data: { status: 'VALIDATED' },
    });
    evalRunSameFamilyId = ulid();
    trackedEvalRunIds.push(evalRunSameFamilyId);
    await prisma.evalRun.create({
      data: {
        id: evalRunSameFamilyId,
        suiteId,
        skillId,
        candidateVersionId: skillVersionSameFamilyId,
        executeEngine: 'CODEX',
        verifyEngine: 'CODEX',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });
    const countBefore7 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: artifactSameFamilyId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'same-family activate throws conflict',
      (e) => {
        if (!isConflict(e)) return false;
        const msg = e instanceof Error ? e.message : String(e);
        return /family/i.test(msg);
      },
    );
    const countAfter7 = await deploymentCount();
    check(countAfter7 === countBefore7, 'same-family: zero new rows', `before=${countBefore7} after=${countAfter7}`);

    // ── 8. digest drift ──────────────────────────────────────────────────
    console.log('\n── [8] digest drift → reject activate + rollback ──');
    // First establish a good deployment on validated artifact (for rollback target later).
    // Resolve high risk already done; eval is PASSED with different families.
    let goodDeploy: { id: string } | null = null;
    try {
      goodDeploy = (await activateDeployment({
        artifactId: artifactValidatedId,
        environment: 'SANDBOX',
        channel: 'CANARY',
        actorId: ownerId,
        actorRole: 'OWNER',
      })) as { id: string };
      deploymentForDriftId = goodDeploy.id;
      trackedDeploymentIds.push(goodDeploy.id);
      pass('digest-setup: activate good SANDBOX/CANARY', goodDeploy.id);
    } catch (e) {
      fail('digest-setup: activate good SANDBOX/CANARY', String(e));
    }

    // Tamper validated artifact
    await prisma.flowArtifact.update({
      where: { id: artifactValidatedId },
      data: {
        artifactJson: {
          nodes: [{ id: 'TAMPERED' }],
          edges: [],
          kind: 'native',
          evil: true,
        },
      },
    });
    const countBefore8 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: artifactValidatedId,
          environment: 'STAGING',
          channel: 'STABLE',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'digest drift activate throws (digest mismatch)',
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        return /digest/i.test(msg) && (isConflict(e) || true);
      },
    );
    const countAfter8 = await deploymentCount();
    check(countAfter8 === countBefore8, 'digest drift activate: zero new rows', `before=${countBefore8} after=${countAfter8}`);

    if (deploymentForDriftId) {
      await throwsAsync(
        () =>
          rollbackDeployment({
            deploymentId: deploymentForDriftId,
            actorId: ownerId,
            actorRole: 'OWNER',
          }),
        'digest drift rollback throws',
        (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          return /digest/i.test(msg);
        },
      );
    }

    // Restore artifactJson would be complex; leave tampered — not used further for activate.
    // Status must remain VALIDATED (not mutated by failed gates).
    const drifted = await prisma.flowArtifact.findUnique({ where: { id: artifactValidatedId } });
    check(drifted?.status === 'VALIDATED', 'digest drift: status still VALIDATED', `status=${drifted?.status}`);

    // ── 9. illegal environment/channel ───────────────────────────────────
    console.log('\n── [9] illegal environment/channel → 400 ──');
    // Use compiled artifact path for lib (won't reach status check if enum fails first).
    // Create a fresh un-tampered validated artifact for HTTP body validation.
    const cleanArt = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-neg-illegal-${tag}`,
      artifactJson: { nodes: [{ id: 'n4' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    await prisma.flowArtifact.update({
      where: { id: cleanArt.id },
      data: { status: 'VALIDATED' },
    });
    const countBefore9 = await deploymentCount();
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: cleanArt.id,
          environment: 'PROD' as 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'illegal environment PROD throws badRequest',
      isBadRequest,
    );
    await throwsAsync(
      () =>
        activateDeployment({
          artifactId: cleanArt.id,
          environment: 'PRODUCTION',
          channel: 'BLUE' as 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        }),
      'illegal channel BLUE throws badRequest',
      isBadRequest,
    );
    const r9 = await json(`${BASE}/api/runtime/deployments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        artifactId: cleanArt.id,
        environment: 'PROD',
        channel: 'BLUE',
      }),
    });
    check(
      r9.response.status === 400 || r9.response.status === 409,
      'illegal env/channel HTTP 4xx',
      `HTTP ${r9.response.status} body=${JSON.stringify(r9.body)}`,
    );
    const countAfter9 = await deploymentCount();
    check(countAfter9 === countBefore9, 'illegal enum: zero new rows', `before=${countBefore9} after=${countAfter9}`);

    // ── 10. Engine enum no LANGFLOW ──────────────────────────────────────
    console.log('\n── [10] Engine enum excludes LANGFLOW ──');
    const engineVals = Object.values(Engine).sort();
    const runtimeVals = Object.values(RuntimeKind).sort();
    check(
      engineVals.length === 3 &&
        engineVals.includes('CLAUDE_CODE') &&
        engineVals.includes('CODEX') &&
        engineVals.includes('GROK') &&
        !engineVals.includes('LANGFLOW' as Engine),
      'Engine values exactly CLAUDE_CODE/CODEX/GROK (no LANGFLOW)',
      `got ${JSON.stringify(engineVals)}`,
    );
    check(
      runtimeVals.includes('NATIVE') && runtimeVals.includes('LANGFLOW'),
      'RuntimeKind includes NATIVE/LANGFLOW',
      `got ${JSON.stringify(runtimeVals)}`,
    );
    const schemaPath = resolve(process.cwd(), 'prisma/schema.prisma');
    const schemaText = readFileSync(schemaPath, 'utf8');
    const engineBlockMatch = schemaText.match(/enum Engine \{[^}]+\}/);
    check(!!engineBlockMatch, 'schema has enum Engine block', 'not found');
    if (engineBlockMatch) {
      check(
        !engineBlockMatch[0].includes('LANGFLOW'),
        'schema enum Engine block has no LANGFLOW',
        engineBlockMatch[0],
      );
    }
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    // Deployments first (FK Restrict on artifact)
    if (trackedDeploymentIds.length) {
      await (prisma as any).runtimeDeployment
        ?.deleteMany?.({ where: { id: { in: trackedDeploymentIds } } })
        .catch(() => undefined);
    }
    // Also delete any deployments for our skill if model exists
    try {
      await (prisma as any).runtimeDeployment.deleteMany({ where: { skillId } });
    } catch {
      /* model may not exist yet */
    }
    if (trackedEvalResultIds.length) {
      await prisma.evalResult.deleteMany({ where: { id: { in: trackedEvalResultIds } } }).catch(() => undefined);
    }
    if (trackedEvalRunIds.length) {
      await prisma.evalResult.deleteMany({ where: { runId: { in: trackedEvalRunIds } } }).catch(() => undefined);
      await prisma.evalRun.deleteMany({ where: { id: { in: trackedEvalRunIds } } }).catch(() => undefined);
    }
    await prisma.evalResult.deleteMany({ where: { caseId } }).catch(() => undefined);
    await prisma.evalCase.deleteMany({ where: { suiteId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { suiteId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);

    const versionIds = [skillVersionId, skillVersionSameFamilyId].filter(Boolean);
    if (versionIds.length) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId: { in: versionIds } } }).catch(() => undefined);
    }
    await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [memberId, ownerId] } } }).catch(() => undefined);
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
