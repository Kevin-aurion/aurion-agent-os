/**
 * Ticket 17 — Production artifact digest loader (Phase 1: RED tests).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t17-artifact-load.test.ts
 *
 * Target module (Phase 2): aios-server/src/runtime/productionloader.ts
 *   - ProductionLoadError (NOT_FOUND|NOT_ACTIVE|WRONG_ENVIRONMENT|NOT_VALIDATED|DIGEST_MISMATCH)
 *   - loadProductionArtifact(deploymentId)
 *   - listLoadableProductionArtifacts()
 *
 * Zero new deps. Real DB via prisma singleton. Fixtures self-owned + precise cleanup.
 * No Prisma schema changes. Does not implement productionloader.ts.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
} from '../../../src/lib/flowartifact.js';

// Phase 2 target — expected RED until module exists
import {
  ProductionLoadError,
  loadProductionArtifact,
  listLoadableProductionArtifacts,
} from '../../../src/runtime/productionloader.js';

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

function isCode(e: unknown, code: string): boolean {
  if (e instanceof ProductionLoadError) return e.code === code;
  const any = e as { code?: string; message?: string };
  if (any?.code === code) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes(code);
}

async function snapshotDurable(
  ids: {
    deploymentIds: string[];
    artifactIds: string[];
  },
): Promise<{
  depCount: number;
  artCount: number;
  deps: Array<{ id: string; updatedAt: Date; active: boolean }>;
  arts: Array<{ id: string; updatedAt: Date; digest: string; status: string }>;
}> {
  const depCount = await prisma.runtimeDeployment.count();
  const artCount = await prisma.flowArtifact.count();
  const deps = await prisma.runtimeDeployment.findMany({
    where: { id: { in: ids.deploymentIds } },
    select: { id: true, updatedAt: true, active: true },
  });
  const arts = await prisma.flowArtifact.findMany({
    where: { id: { in: ids.artifactIds } },
    select: { id: true, updatedAt: true, digest: true, status: true },
  });
  return { depCount, artCount, deps, arts };
}

function sameSnapshot(
  a: Awaited<ReturnType<typeof snapshotDurable>>,
  b: Awaited<ReturnType<typeof snapshotDurable>>,
): boolean {
  if (a.depCount !== b.depCount || a.artCount !== b.artCount) return false;
  if (a.deps.length !== b.deps.length || a.arts.length !== b.arts.length) return false;
  const depMap = new Map(a.deps.map((d) => [d.id, d]));
  for (const d of b.deps) {
    const prev = depMap.get(d.id);
    if (!prev) return false;
    if (prev.active !== d.active) return false;
    if (prev.updatedAt.getTime() !== d.updatedAt.getTime()) return false;
  }
  const artMap = new Map(a.arts.map((x) => [x.id, x]));
  for (const x of b.arts) {
    const prev = artMap.get(x.id);
    if (!prev) return false;
    if (prev.digest !== x.digest || prev.status !== x.status) return false;
    if (prev.updatedAt.getTime() !== x.updatedAt.getTime()) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const tag = ulid().slice(-8).toLowerCase();
  const userId = ulid();
  const skillId = ulid();
  const slug = `t17-prod-load-${tag}`;
  const contentV1 = '# t17 production artifact load\n\ntest\n';

  let skillVersionId = '';
  let artifactOkId = '';
  let artifactCompiledId = '';
  let depOkId = '';
  let depInactiveId = '';
  let depSandboxId = '';
  let depCompiledId = '';
  let depDriftId = '';
  let artifactDriftId = '';

  console.log('Ticket 17 — production artifact digest loader tests');
  console.log('── setup: t17 fixtures ──');

  try {
    await prisma.user.create({
      data: {
        id: userId,
        email: `t17-trainer-${tag}@aios.test`,
        displayName: `T17 Trainer ${tag}`,
        passwordHash: 'x',
        role: 'TRAINER',
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: `T17 Prod Load ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: contentV1,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: userId,
        executionEnv: 'CLI',
      },
    });

    const sv = await createSkillVersion(skillId, contentV1);
    skillVersionId = sv.id;

    const baseJson = {
      nodes: [{ id: 'n1', type: 'read', label: 't17-ok' }],
      edges: [],
      meta: { ticket: 't17', tag },
    };

    const createdOk = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t17-load-ok-${tag}`,
      artifactJson: baseJson,
      createdBy: userId,
    });
    artifactOkId = createdOk.id;
    // Ensure VALIDATED + digest matches stored artifactJson (createFlowArtifact may redact)
    const okRow = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactOkId } });
    const okDigest = computeFlowArtifactDigest(okRow.artifactJson);
    await prisma.flowArtifact.update({
      where: { id: artifactOkId },
      data: { status: 'VALIDATED', digest: okDigest },
    });

    // Inactive PRODUCTION deployment (same artifact ok for pointer uniqueness? unique is artifactId+env+channel)
    // Use separate artifacts per deployment where unique constraint requires it.
    depOkId = ulid();
    await prisma.runtimeDeployment.create({
      data: {
        id: depOkId,
        artifactId: artifactOkId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        runtimeBinding: { kind: 'LANGFLOW', note: 't17-ok' },
        deployedBy: userId,
        active: true,
      },
    });

    // ── positive ───────────────────────────────────────────────────────
    console.log('\n── [positive] loadProductionArtifact + listLoadable ──');
    try {
      const loaded = await loadProductionArtifact(depOkId);
      check(
        loaded?.deployment?.id === depOkId,
        'loadProductionArtifact returns deployment',
        `got ${JSON.stringify(loaded?.deployment?.id)}`,
      );
      check(
        loaded?.artifact?.id === artifactOkId,
        'loadProductionArtifact returns artifact',
        `got ${JSON.stringify(loaded?.artifact?.id)}`,
      );
      const artJson = loaded?.artifact?.artifactJson;
      const d = loaded?.artifact?.digest;
      if (artJson != null && typeof d === 'string') {
        try {
          const recomputed = computeFlowArtifactDigest(artJson);
          check(
            recomputed === d,
            'returned artifact digest matches recomputed SHA-256',
            `digest=${d} recomputed=${recomputed}`,
          );
        } catch (e) {
          fail('returned artifact digest matches recomputed SHA-256', String(e));
        }
      } else {
        fail('returned artifact digest matches recomputed SHA-256', 'missing artifactJson/digest');
      }
    } catch (e) {
      fail('loadProductionArtifact success path', String(e));
    }

    try {
      const listed = await listLoadableProductionArtifacts();
      const loadable = listed?.loadable ?? [];
      const ids = loadable.map(
        (x: { deployment?: { id?: string }; deploymentId?: string }) =>
          x?.deployment?.id ?? x?.deploymentId ?? (x as { id?: string }).id,
      );
      check(
        ids.includes(depOkId),
        'listLoadableProductionArtifacts includes active PRODUCTION deployment',
        `ids=${JSON.stringify(ids)}`,
      );
    } catch (e) {
      fail('listLoadableProductionArtifacts success path', String(e));
    }

    // ── negative 1: inactive ───────────────────────────────────────────
    console.log('\n── [neg1] inactive deployment → NOT_ACTIVE ──');
    const inactiveArtifact = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t17-load-inactive-${tag}`,
      artifactJson: { nodes: [{ id: 'inactive' }], edges: [], meta: { tag } },
      createdBy: userId,
    });
    const inactiveArtRow = await prisma.flowArtifact.findUniqueOrThrow({
      where: { id: inactiveArtifact.id },
    });
    await prisma.flowArtifact.update({
      where: { id: inactiveArtifact.id },
      data: {
        status: 'VALIDATED',
        digest: computeFlowArtifactDigest(inactiveArtRow.artifactJson),
      },
    });
    depInactiveId = ulid();
    await prisma.runtimeDeployment.create({
      data: {
        id: depInactiveId,
        artifactId: inactiveArtifact.id,
        skillId,
        environment: 'PRODUCTION',
        channel: 'STABLE',
        runtimeBinding: { kind: 'LANGFLOW', note: 't17-inactive' },
        deployedBy: userId,
        active: false,
        deactivatedAt: new Date(),
      },
    });

    const snap1Before = await snapshotDurable({
      deploymentIds: [depInactiveId],
      artifactIds: [inactiveArtifact.id],
    });
    await throwsAsync(
      () => loadProductionArtifact(depInactiveId),
      'inactive: loadProductionArtifact throws NOT_ACTIVE',
      (e) => isCode(e, 'NOT_ACTIVE'),
    );
    const snap1After = await snapshotDurable({
      deploymentIds: [depInactiveId],
      artifactIds: [inactiveArtifact.id],
    });
    check(
      sameSnapshot(snap1Before, snap1After),
      'inactive: zero DB writes (counts + updatedAt)',
      `before=${JSON.stringify(snap1Before)} after=${JSON.stringify(snap1After)}`,
    );

    // ── negative 2: digest drift ───────────────────────────────────────
    console.log('\n── [neg2] digest drift → DIGEST_MISMATCH ──');
    const driftCreated = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t17-load-drift-${tag}`,
      artifactJson: { nodes: [{ id: 'drift-orig' }], edges: [], meta: { tag } },
      createdBy: userId,
    });
    artifactDriftId = driftCreated.id;
    const driftRow = await prisma.flowArtifact.findUniqueOrThrow({
      where: { id: artifactDriftId },
    });
    const driftDigest = computeFlowArtifactDigest(driftRow.artifactJson);
    await prisma.flowArtifact.update({
      where: { id: artifactDriftId },
      data: { status: 'VALIDATED', digest: driftDigest },
    });
    depDriftId = ulid();
    await prisma.runtimeDeployment.create({
      data: {
        id: depDriftId,
        artifactId: artifactDriftId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        // unique is artifactId+env+channel — different artifact so ok even if CANARY
        runtimeBinding: { kind: 'LANGFLOW', note: 't17-drift' },
        deployedBy: userId,
        active: true,
      },
    });
    // Tamper artifactJson without updating digest
    await prisma.flowArtifact.update({
      where: { id: artifactDriftId },
      data: {
        artifactJson: {
          nodes: [{ id: 'drift-TAMPERED' }],
          edges: [],
          meta: { tag, tampered: true },
        },
      },
    });

    const snap2Before = await snapshotDurable({
      deploymentIds: [depDriftId],
      artifactIds: [artifactDriftId],
    });
    await throwsAsync(
      () => loadProductionArtifact(depDriftId),
      'drift: loadProductionArtifact throws DIGEST_MISMATCH',
      (e) => isCode(e, 'DIGEST_MISMATCH'),
    );
    const snap2After = await snapshotDurable({
      deploymentIds: [depDriftId],
      artifactIds: [artifactDriftId],
    });
    check(
      sameSnapshot(snap2Before, snap2After),
      'drift: zero DB writes from loadProductionArtifact',
      `before depCount=${snap2Before.depCount} after=${snap2After.depCount}`,
    );

    try {
      const listed = await listLoadableProductionArtifacts();
      const loadableIds = (listed?.loadable ?? []).map(
        (x: { deployment?: { id?: string }; deploymentId?: string }) =>
          x?.deployment?.id ?? x?.deploymentId ?? (x as { id?: string }).id,
      );
      const skipped = listed?.skipped ?? [];
      const skippedHit = skipped.some(
        (s: { deploymentId?: string; code?: string }) =>
          s.deploymentId === depDriftId &&
          (s.code === 'DIGEST_MISMATCH' || /DIGEST_MISMATCH/i.test(String(s.code))),
      );
      check(
        !loadableIds.includes(depDriftId),
        'drift: listLoadable does NOT include drifted deployment in loadable',
        `loadable=${JSON.stringify(loadableIds)}`,
      );
      check(
        skippedHit,
        'drift: listLoadable puts drifted deployment in skipped with DIGEST_MISMATCH',
        `skipped=${JSON.stringify(skipped)}`,
      );
    } catch (e) {
      fail('drift: listLoadable skips drifted artifact', String(e));
    }

    // ── negative 3: wrong environment ──────────────────────────────────
    console.log('\n── [neg3] SANDBOX environment → WRONG_ENVIRONMENT ──');
    const sandboxArt = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t17-load-sandbox-${tag}`,
      artifactJson: { nodes: [{ id: 'sandbox' }], edges: [], meta: { tag } },
      createdBy: userId,
    });
    const sandboxArtRow = await prisma.flowArtifact.findUniqueOrThrow({
      where: { id: sandboxArt.id },
    });
    await prisma.flowArtifact.update({
      where: { id: sandboxArt.id },
      data: {
        status: 'VALIDATED',
        digest: computeFlowArtifactDigest(sandboxArtRow.artifactJson),
      },
    });
    depSandboxId = ulid();
    await prisma.runtimeDeployment.create({
      data: {
        id: depSandboxId,
        artifactId: sandboxArt.id,
        skillId,
        environment: 'SANDBOX',
        channel: 'CANARY',
        runtimeBinding: { kind: 'LANGFLOW', note: 't17-sandbox-env' },
        deployedBy: userId,
        active: true,
      },
    });
    await throwsAsync(
      () => loadProductionArtifact(depSandboxId),
      'sandbox env: loadProductionArtifact throws WRONG_ENVIRONMENT',
      (e) => isCode(e, 'WRONG_ENVIRONMENT'),
    );

    // ── negative 4: not validated ──────────────────────────────────────
    console.log('\n── [neg4] COMPILED artifact → NOT_VALIDATED ──');
    const compiled = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t17-load-compiled-${tag}`,
      artifactJson: { nodes: [{ id: 'compiled' }], edges: [], meta: { tag } },
      createdBy: userId,
    });
    artifactCompiledId = compiled.id;
    // leave status COMPILED (default)
    depCompiledId = ulid();
    await prisma.runtimeDeployment.create({
      data: {
        id: depCompiledId,
        artifactId: artifactCompiledId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'STABLE',
        runtimeBinding: { kind: 'LANGFLOW', note: 't17-compiled' },
        deployedBy: userId,
        active: true,
      },
    });
    await throwsAsync(
      () => loadProductionArtifact(depCompiledId),
      'compiled: loadProductionArtifact throws NOT_VALIDATED',
      (e) => isCode(e, 'NOT_VALIDATED'),
    );

    // ── negative 5: not found ──────────────────────────────────────────
    console.log('\n── [neg5] missing id → NOT_FOUND ──');
    const bogusId = ulid();
    await throwsAsync(
      () => loadProductionArtifact(bogusId),
      'missing: loadProductionArtifact throws NOT_FOUND',
      (e) => isCode(e, 'NOT_FOUND'),
    );

    // Track extra artifact ids for cleanup
    // inactiveArtifact, sandboxArt already created — clean via skillVersion cascade? No, delete by id.
    // Store on locals already: we delete all deployments for skillId and artifacts for skillVersionId carefully.

  } finally {
    console.log('\n── cleanup test-owned rows only (precise ids) ──');
    const deploymentIds = [
      depOkId,
      depInactiveId,
      depSandboxId,
      depCompiledId,
      depDriftId,
    ].filter(Boolean);

    for (const id of deploymentIds) {
      await prisma.runtimeDeployment.delete({ where: { id } }).catch(() => undefined);
    }

    // Any other deployments for this skill created unexpectedly — only if we know skillId
    // Do NOT deleteMany without filter; only delete by skillId scoped to our fixtures is ok as skill is ours
    await prisma.runtimeDeployment
      .deleteMany({ where: { skillId } })
      .catch(() => undefined);

    if (skillVersionId) {
      await prisma.flowArtifact
        .deleteMany({ where: { skillVersionId } })
        .catch(() => undefined);
    }

    // Explicit artifact ids (belt)
    for (const id of [
      artifactOkId,
      artifactCompiledId,
      artifactDriftId,
    ].filter(Boolean)) {
      await prisma.flowArtifact.delete({ where: { id } }).catch(() => undefined);
    }

    if (skillVersionId) {
      await prisma.skillVersion.delete({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.skill.delete({ where: { id: skillId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
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
