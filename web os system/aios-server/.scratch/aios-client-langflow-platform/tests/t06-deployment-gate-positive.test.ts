/**
 * Ticket 06 — FDE Runtime Deployment Gate positive (lib + live HTTP).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t06-deployment-gate-positive.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. Live HTTP http://127.0.0.1:8700.
 * Cleanup deletes only test-owned rows. At least one path uses real NativeAdapter.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';

const BASE = 'http://127.0.0.1:8700';
/** Fixture secret — createFlowArtifact deep-redacts; also assert binding never has plaintext. */
const SECRET_FIXTURE = 'sk-test-t06-plaintext-secret-xyz';

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

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function main(): Promise<void> {
  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const suiteId = ulid();
  const caseId = ulid();
  const ownerId = ulid();
  const slug = `t06-dep-pos-${tag}`;
  const contentV1 = '# t06 deployment gate positive\n\nv1\n';
  const contentV2 = '# t06 deployment gate positive\n\nv2\n';

  let skillVersion1Id = '';
  let skillVersion2Id = '';
  let artifact1Id = '';
  let artifact2Id = '';
  let evalRun1Id = '';
  let evalRun2Id = '';
  let deploy1Id = '';
  let deploy2Id = '';
  let ownerToken = '';

  // HTTP path skill (separate so cleanup is clean)
  const httpSkillId = ulid();
  const httpSuiteId = ulid();
  let httpSkillVersionId = '';
  let httpArtifactId = '';
  let httpEvalRunId = '';
  let httpDeployId = '';
  let httpDeploy2Id = '';

  console.log('── setup: t06 positive fixtures ──');
  try {
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t06-pos-owner-${tag}@aios.test`,
        displayName: 'T06 Pos Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    ownerToken = await signAccess({
      sub: ownerId,
      email: `t06-pos-owner-${tag}@aios.test`,
      role: 'OWNER',
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: `T06 Deploy Pos ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: contentV1,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv1 = await createSkillVersion(skillId, contentV1);
    skillVersion1Id = sv1.id;

    await prisma.evalSuite.create({
      data: {
        id: suiteId,
        skillId,
        name: `T06 Pos Suite ${tag}`,
        createdBy: ownerId,
      },
    });
    await prisma.evalCase.create({
      data: {
        id: caseId,
        suiteId,
        kind: 'POSITIVE_TRIGGER',
        name: 'pos case',
        input: { q: 'hi' },
      },
    });

    evalRun1Id = ulid();
    await prisma.evalRun.create({
      data: {
        id: evalRun1Id,
        suiteId,
        skillId,
        candidateVersionId: skillVersion1Id,
        executeEngine: 'CLAUDE_CODE',
        verifyEngine: 'CODEX',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });

    const art1 = await createFlowArtifact({
      skillVersionId: skillVersion1Id,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-pos-a1-${tag}`,
      artifactJson: {
        nodes: [{ id: 'n1' }],
        edges: [],
        kind: 'native',
        meta: { token: SECRET_FIXTURE },
      },
      metadata: { apiKey: SECRET_FIXTURE },
      createdBy: ownerId,
    });
    artifact1Id = art1.id;
    check(art1.status === 'COMPILED', 'artifact1 created COMPILED', `status=${art1.status}`);

    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let rollbackDeployment: typeof import('../../../src/lib/runtimedeployment.js').rollbackDeployment;
    let listDeployments: typeof import('../../../src/lib/runtimedeployment.js').listDeployments;
    try {
      const mod = await import('../../../src/lib/runtimedeployment.js');
      validateArtifactForRuntime = mod.validateArtifactForRuntime;
      activateDeployment = mod.activateDeployment;
      rollbackDeployment = mod.rollbackDeployment;
      listDeployments = mod.listDeployments;
    } catch (e) {
      fail('import runtimedeployment module', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit) ──`);
      return;
    }

    // ── 1. validate → activate CANARY ────────────────────────────────────
    console.log('\n── [1] validate + activate PRODUCTION/CANARY ──');
    const validated = await validateArtifactForRuntime({
      artifactId: artifact1Id,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    check(
      validated.status === 'VALIDATED',
      'validate: COMPILED → VALIDATED',
      `status=${(validated as { status?: string }).status}`,
    );
    const rowAfterValidate = await prisma.flowArtifact.findUnique({ where: { id: artifact1Id } });
    check(rowAfterValidate?.status === 'VALIDATED', 'DB status VALIDATED', `status=${rowAfterValidate?.status}`);

    const dep1 = await activateDeployment({
      artifactId: artifact1Id,
      environment: 'PRODUCTION',
      channel: 'CANARY',
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    deploy1Id = (dep1 as { id: string }).id;
    check(Boolean(deploy1Id), 'activate returns deployment id', String(deploy1Id));
    check(
      (dep1 as { active?: boolean }).active === true,
      'deployment1 active=true',
      `active=${(dep1 as { active?: boolean }).active}`,
    );
    const bindingStr = JSON.stringify((dep1 as { runtimeBinding?: unknown }).runtimeBinding ?? {});
    check(
      !bindingStr.includes(SECRET_FIXTURE),
      'runtimeBinding has no plaintext secret fixture',
      bindingStr,
    );
    check(
      bindingStr.includes('NATIVE') || bindingStr.includes('native'),
      'runtimeBinding from NativeAdapter',
      bindingStr,
    );

    const auditActivate = await prisma.auditLog.findFirst({
      where: {
        action: 'runtime.deployment.activate',
        entity: 'RuntimeDeployment',
        entityId: deploy1Id,
      },
      orderBy: { createdAt: 'desc' },
    });
    check(Boolean(auditActivate), 'AuditLog runtime.deployment.activate', 'missing');

    // ── 2. idempotent re-activate ────────────────────────────────────────
    console.log('\n── [2] idempotent re-activate ──');
    const countBeforeIdem = await (prisma as any).runtimeDeployment.count({
      where: { skillId },
    });
    const dep1b = await activateDeployment({
      artifactId: artifact1Id,
      environment: 'PRODUCTION',
      channel: 'CANARY',
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    const countAfterIdem = await (prisma as any).runtimeDeployment.count({
      where: { skillId },
    });
    check(countAfterIdem === countBeforeIdem, 'idempotent: count unchanged', `before=${countBeforeIdem} after=${countAfterIdem}`);
    check(
      (dep1b as { reused?: boolean }).reused === true || (dep1b as { id: string }).id === deploy1Id,
      'idempotent: reused or same id',
      JSON.stringify(dep1b),
    );

    // ── 3. second artifact → pointer switch ──────────────────────────────
    console.log('\n── [3] second artifact active pointer unique ──');
    const sv2 = await createSkillVersion(skillId, contentV2);
    skillVersion2Id = sv2.id;
    evalRun2Id = ulid();
    await prisma.evalRun.create({
      data: {
        id: evalRun2Id,
        suiteId,
        skillId,
        candidateVersionId: skillVersion2Id,
        executeEngine: 'GROK',
        verifyEngine: 'CLAUDE_CODE',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });
    const art2 = await createFlowArtifact({
      skillVersionId: skillVersion2Id,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-pos-a2-${tag}`,
      artifactJson: { nodes: [{ id: 'n2' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    artifact2Id = art2.id;
    await validateArtifactForRuntime({
      artifactId: artifact2Id,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    const dep2 = await activateDeployment({
      artifactId: artifact2Id,
      environment: 'PRODUCTION',
      channel: 'CANARY',
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    deploy2Id = (dep2 as { id: string }).id;
    check((dep2 as { active?: boolean }).active === true, 'deployment2 active=true', '');
    check(deploy2Id !== deploy1Id, 'deployment2 is new row', `d1=${deploy1Id} d2=${deploy2Id}`);

    const d1row = await (prisma as any).runtimeDeployment.findUnique({ where: { id: deploy1Id } });
    const d2row = await (prisma as any).runtimeDeployment.findUnique({ where: { id: deploy2Id } });
    check(d1row?.active === false, 'old deployment active=false', `active=${d1row?.active}`);
    check(d2row?.active === true, 'new deployment active=true', `active=${d2row?.active}`);
    check(Boolean(d1row?.deactivatedAt), 'old has deactivatedAt', `deactivatedAt=${d1row?.deactivatedAt}`);

    // ── 4. rollback to first ─────────────────────────────────────────────
    console.log('\n── [4] rollback to first deployment ──');
    const rb = await rollbackDeployment({
      deploymentId: deploy1Id,
      actorId: ownerId,
      actorRole: 'OWNER',
    });
    check((rb as { active?: boolean }).active === true, 'rollback target active=true', '');
    const d1after = await (prisma as any).runtimeDeployment.findUnique({ where: { id: deploy1Id } });
    const d2after = await (prisma as any).runtimeDeployment.findUnique({ where: { id: deploy2Id } });
    check(d1after?.active === true, 'after rollback d1 active', `active=${d1after?.active}`);
    check(d2after?.active === false, 'after rollback d2 inactive', `active=${d2after?.active}`);
    // Both rows still exist
    const stillBoth = await (prisma as any).runtimeDeployment.count({
      where: { id: { in: [deploy1Id, deploy2Id] } },
    });
    check(stillBoth === 2, 'rollback keeps both deployment rows', `count=${stillBoth}`);

    const auditRb = await prisma.auditLog.findFirst({
      where: {
        action: 'runtime.deployment.rollback',
        entity: 'RuntimeDeployment',
        entityId: deploy1Id,
      },
      orderBy: { createdAt: 'desc' },
    });
    check(Boolean(auditRb), 'AuditLog runtime.deployment.rollback', 'missing');

    const listed = await listDeployments({ skillId, environment: 'PRODUCTION', channel: 'CANARY' });
    check(Array.isArray(listed) && listed.length >= 2, 'listDeployments returns rows', `len=${Array.isArray(listed) ? listed.length : 'n/a'}`);

    // ── 5. HTTP happy path ───────────────────────────────────────────────
    console.log('\n── [5] HTTP validate + activate + rollback + GET list ──');
    await prisma.skill.create({
      data: {
        id: httpSkillId,
        slug: `t06-dep-http-${tag}`,
        name: `T06 Deploy HTTP ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: contentV1,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const httpSv = await createSkillVersion(httpSkillId, contentV1);
    httpSkillVersionId = httpSv.id;
    await prisma.evalSuite.create({
      data: {
        id: httpSuiteId,
        skillId: httpSkillId,
        name: `T06 HTTP Suite ${tag}`,
        createdBy: ownerId,
      },
    });
    httpEvalRunId = ulid();
    await prisma.evalRun.create({
      data: {
        id: httpEvalRunId,
        suiteId: httpSuiteId,
        skillId: httpSkillId,
        candidateVersionId: httpSkillVersionId,
        executeEngine: 'CLAUDE_CODE',
        verifyEngine: 'GROK',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });
    const httpArt = await createFlowArtifact({
      skillVersionId: httpSkillVersionId,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-http-${tag}`,
      artifactJson: { nodes: [{ id: 'h1' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    httpArtifactId = httpArt.id;

    const hv = await json(`${BASE}/api/runtime/artifacts/${httpArtifactId}/validate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    check(hv.response.status === 200 && (hv.body as { success?: boolean })?.success === true, 'HTTP validate 200', `HTTP ${hv.response.status} ${JSON.stringify(hv.body)}`);

    const ha = await json(`${BASE}/api/runtime/deployments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        artifactId: httpArtifactId,
        environment: 'STAGING',
        channel: 'STABLE',
      }),
    });
    check(ha.response.status === 200 && (ha.body as { success?: boolean })?.success === true, 'HTTP activate 200', `HTTP ${ha.response.status} ${JSON.stringify(ha.body)}`);
    httpDeployId = String((ha.body as { data?: { id?: string } })?.data?.id ?? '');
    check(Boolean(httpDeployId), 'HTTP activate returns id', httpDeployId);

    // Second version + deploy then rollback via HTTP
    const httpSv2 = await createSkillVersion(httpSkillId, contentV1 + '\nhttp v2\n');
    const httpEval2 = ulid();
    await prisma.evalRun.create({
      data: {
        id: httpEval2,
        suiteId: httpSuiteId,
        skillId: httpSkillId,
        candidateVersionId: httpSv2.id,
        executeEngine: 'CODEX',
        verifyEngine: 'GROK',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });
    const httpArt2 = await createFlowArtifact({
      skillVersionId: httpSv2.id,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t06-http2-${tag}`,
      artifactJson: { nodes: [{ id: 'h2' }], edges: [], kind: 'native' },
      createdBy: ownerId,
    });
    await json(`${BASE}/api/runtime/artifacts/${httpArt2.id}/validate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const ha2 = await json(`${BASE}/api/runtime/deployments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        artifactId: httpArt2.id,
        environment: 'STAGING',
        channel: 'STABLE',
      }),
    });
    httpDeploy2Id = String((ha2.body as { data?: { id?: string } })?.data?.id ?? '');
    check(Boolean(httpDeploy2Id), 'HTTP second activate id', httpDeploy2Id);

    const hrb = await json(`${BASE}/api/runtime/deployments/${httpDeployId}/rollback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    check(hrb.response.status === 200 && (hrb.body as { success?: boolean })?.success === true, 'HTTP rollback 200', `HTTP ${hrb.response.status} ${JSON.stringify(hrb.body)}`);

    const hlist = await json(
      `${BASE}/api/runtime/deployments?skillId=${encodeURIComponent(httpSkillId)}&environment=STAGING&channel=STABLE`,
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    check(hlist.response.status === 200 && (hlist.body as { success?: boolean })?.success === true, 'HTTP list 200', `HTTP ${hlist.response.status}`);
    const listData = (hlist.body as { data?: unknown[] })?.data;
    check(Array.isArray(listData) && listData.length >= 2, 'HTTP list has >=2 rows', `len=${Array.isArray(listData) ? listData.length : 'n/a'}`);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    const skillIds = [skillId, httpSkillId];
    try {
      await (prisma as any).runtimeDeployment.deleteMany({
        where: { skillId: { in: skillIds } },
      });
    } catch {
      /* model may not exist */
    }
    const evalRunIds = [evalRun1Id, evalRun2Id, httpEvalRunId].filter(Boolean);
    if (evalRunIds.length) {
      await prisma.evalResult.deleteMany({ where: { runId: { in: evalRunIds } } }).catch(() => undefined);
      await prisma.evalRun.deleteMany({ where: { id: { in: evalRunIds } } }).catch(() => undefined);
    }
    await prisma.evalRun.deleteMany({ where: { suiteId: { in: [suiteId, httpSuiteId] } } }).catch(() => undefined);
    await prisma.evalCase.deleteMany({ where: { suiteId: { in: [suiteId, httpSuiteId] } } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: { in: [suiteId, httpSuiteId] } } }).catch(() => undefined);

    for (const sid of skillIds) {
      const versions = await prisma.skillVersion.findMany({ where: { skillId: sid }, select: { id: true } }).catch(() => []);
      const vids = versions.map((v) => v.id);
      if (vids.length) {
        await prisma.flowArtifact.deleteMany({ where: { skillVersionId: { in: vids } } }).catch(() => undefined);
      }
      await prisma.skillVersion.deleteMany({ where: { skillId: sid } }).catch(() => undefined);
      await prisma.skill.deleteMany({ where: { id: sid } }).catch(() => undefined);
    }
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
