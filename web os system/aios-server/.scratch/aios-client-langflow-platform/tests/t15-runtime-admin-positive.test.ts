/**
 * Ticket 15 — FDE Runtime admin happy path (list/detail/validate/activate/kill/rollback).
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t15-runtime-admin-positive.test.ts
 *
 * Real DB + Fastify inject. Does NOT delete AuditLog.
 * Token is signed JWT only. FK fields reuse existing OWNER/TRAINER user.id.
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { runtimeRoutes } from '../../../src/routes/runtime.js';

let passed = 0;
let failed = 0;

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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

type Envelope<T> = { success?: boolean; data?: T; error?: { message?: string } };

function parseBody<T>(body: string): Envelope<T> {
  try {
    return JSON.parse(body) as Envelope<T>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  console.log('── t15-runtime-admin-positive ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  if (!owner) {
    fail('setup', 'need existing OWNER/TRAINER user for FK fields');
    console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
    process.exit(1);
  }

  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  let skillVersionId = '';
  let artifactId = '';
  let canaryDepId = '';
  let stableDepId = '';
  const contentMd = `# t15 pos skill ${tag}\n\nemail triage\n`;
  const specJson = {
    schema: 'aios.skill-ir/1',
    name: `t15-pos-${tag}`,
    steps: [{ id: 'triage', action: 'readonly' }],
  };

  const trainerToken = await signAccess({
    sub: 't15-pos-trainer',
    email: 't15-pos-trainer@test.local',
    role: 'TRAINER',
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400) {
      return reply.code(anyErr.statusCode).send({
        success: false,
        error: { code: anyErr.code ?? 'ERROR', message: anyErr.message ?? 'error' },
      });
    }
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL', message: String(err) },
    });
  });
  await app.register(runtimeRoutes);

  try {
    // ── Setup fixtures ───────────────────────────────────────────────────
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t15-pos-${tag}`,
        name: `T15 Pos ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: owner.id,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, contentMd, owner.id);
    skillVersionId = sv.id;
    await prisma.skillVersion.update({
      where: { id: skillVersionId },
      data: {
        schemaVersion: 'aios.skill-ir/1',
        specJson,
      },
    });

    await prisma.evalSuite.create({
      data: {
        id: suiteId,
        skillId,
        name: `T15 Pos Suite ${tag}`,
        createdBy: owner.id,
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
        triggeredBy: owner.id,
      },
    });

    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'NATIVE',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t15-pos-${tag}`,
      artifactJson: {
        nodes: [{ id: 'n1', type: 'readonly' }],
        edges: [],
        kind: 'native',
        tag,
      },
      createdBy: owner.id,
    });
    artifactId = art.id;
    check(art.status === 'COMPILED', 'setup: artifact COMPILED', `status=${art.status}`);

    // ── [1] list ─────────────────────────────────────────────────────────
    console.log('\n── [1] GET artifacts list ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: '/api/runtime/artifacts',
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '1a list 200', `got ${r.statusCode}`);
      const body = parseBody<
        Array<{
          id: string;
          digestOk: boolean;
          template: string;
          skill: { name: string; version: number } | null;
        }>
      >(r.body);
      const row = body.data?.find((x) => x.id === artifactId);
      check(Boolean(row), '1b list contains our artifact', 'missing');
      check(row?.digestOk === true, '1c digestOk=true', `got ${row?.digestOk}`);
      check(
        row?.template === 'email-triage-readonly-v1',
        '1d template',
        `got ${row?.template}`,
      );
      check(
        Boolean(row?.skill?.name?.includes('T15 Pos')),
        '1e skill name',
        JSON.stringify(row?.skill),
      );
    }

    // ── [2] detail pre-validate readiness ────────────────────────────────
    console.log('\n── [2] GET detail (pre-validate) ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: `/api/runtime/artifacts/${artifactId}`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '2a detail 200', `got ${r.statusCode}`);
      const body = parseBody<{
        skillIr: { schemaVersion: string | null; specJson: unknown } | null;
        readiness: {
          canActivate: boolean;
          checks: Array<{ key: string; ok: boolean; reason: string }>;
        };
        artifact: { status: string; digestOk: boolean };
      }>(r.body);
      check(
        body.data?.skillIr?.schemaVersion === 'aios.skill-ir/1',
        '2b skillIr.schemaVersion',
        String(body.data?.skillIr?.schemaVersion),
      );
      check(
        body.data?.skillIr?.specJson != null,
        '2c skillIr.specJson present',
        String(body.data?.skillIr?.specJson),
      );
      check(body.data?.artifact.digestOk === true, '2d digestOk', `got ${body.data?.artifact.digestOk}`);
      const statusCheck = body.data?.readiness.checks.find((c) => c.key === 'status_validated');
      check(
        statusCheck?.ok === false,
        '2e status_validated false before validate',
        JSON.stringify(statusCheck),
      );
      check(
        body.data?.readiness.canActivate === false,
        '2f canActivate false pre-validate',
        `got ${body.data?.readiness.canActivate}`,
      );
    }

    // ── [3] validate → VALIDATED ─────────────────────────────────────────
    console.log('\n── [3] POST validate ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/runtime/artifacts/${artifactId}/validate`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '3a validate 200', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      const body = parseBody<{ status: string }>(r.body);
      check(body.data?.status === 'VALIDATED', '3b status VALIDATED', `got ${body.data?.status}`);
      const db = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
      check(db.status === 'VALIDATED', '3c DB VALIDATED', `got ${db.status}`);
    }

    // ── [4] readiness all ok ─────────────────────────────────────────────
    console.log('\n── [4] readiness after validate ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: `/api/runtime/artifacts/${artifactId}`,
        headers: auth(trainerToken),
      });
      const body = parseBody<{
        readiness: {
          canActivate: boolean;
          checks: Array<{ key: string; ok: boolean }>;
        };
      }>(r.body);
      check(
        body.data?.readiness.canActivate === true,
        '4a canActivate true',
        `got ${body.data?.readiness.canActivate}`,
      );
      const keys = [
        'digest_ok',
        'status_validated',
        'skill_confirmed',
        'eval_passed',
        'no_unresolved_high_risk',
        'model_family_distinct',
      ];
      for (const key of keys) {
        const c = body.data?.readiness.checks.find((x) => x.key === key);
        check(c?.ok === true, `4b ${key} ok`, JSON.stringify(c));
      }
    }

    // ── [5] activate CANARY then STABLE ──────────────────────────────────
    console.log('\n── [5] activate CANARY + STABLE ──');
    {
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/runtime/deployments',
        headers: {
          ...auth(trainerToken),
          'content-type': 'application/json',
        },
        payload: {
          artifactId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
        },
      });
      check(r1.statusCode === 200, '5a activate CANARY 200', `got ${r1.statusCode} ${r1.body.slice(0, 200)}`);
      const b1 = parseBody<{ id: string; active: boolean; channel: string }>(r1.body);
      canaryDepId = b1.data?.id ?? '';
      check(Boolean(canaryDepId), '5b canary id', canaryDepId);
      check(b1.data?.active === true, '5c canary active', `got ${b1.data?.active}`);
      check(b1.data?.channel === 'CANARY', '5d channel CANARY', `got ${b1.data?.channel}`);

      const r2 = await app.inject({
        method: 'POST',
        url: '/api/runtime/deployments',
        headers: {
          ...auth(trainerToken),
          'content-type': 'application/json',
        },
        payload: {
          artifactId,
          environment: 'PRODUCTION',
          channel: 'STABLE',
        },
      });
      check(r2.statusCode === 200, '5e activate STABLE 200', `got ${r2.statusCode} ${r2.body.slice(0, 200)}`);
      const b2 = parseBody<{ id: string; active: boolean; channel: string }>(r2.body);
      stableDepId = b2.data?.id ?? '';
      check(Boolean(stableDepId), '5f stable id', stableDepId);
      check(stableDepId !== canaryDepId, '5g distinct deployment rows', `${canaryDepId} vs ${stableDepId}`);
      check(b2.data?.active === true, '5h stable active', `got ${b2.data?.active}`);
    }

    // ── [6] list deployments filter ──────────────────────────────────────
    console.log('\n── [6] GET deployments filter ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: `/api/runtime/deployments?skillId=${skillId}&environment=PRODUCTION`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '6a list dep 200', `got ${r.statusCode}`);
      const body = parseBody<Array<{ id: string; channel: string; active: boolean }>>(r.body);
      const ids = (body.data ?? []).map((d) => d.id);
      check(ids.includes(canaryDepId), '6b includes canary', ids.join(','));
      check(ids.includes(stableDepId), '6c includes stable', ids.join(','));
      check((body.data ?? []).length >= 2, '6d at least 2 rows', `len=${body.data?.length}`);
    }

    // ── [7] kill switch deactivate ───────────────────────────────────────
    console.log('\n── [7] POST deactivate (kill switch) ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/runtime/deployments/${canaryDepId}/deactivate`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '7a deactivate 200', `got ${r.statusCode} ${r.body.slice(0, 200)}`);
      const body = parseBody<{ id: string; active: boolean; deactivatedAt: string | null }>(r.body);
      check(body.data?.active === false, '7b active=false', `got ${body.data?.active}`);
      check(Boolean(body.data?.deactivatedAt), '7c deactivatedAt set', String(body.data?.deactivatedAt));

      const row = await prisma.runtimeDeployment.findUniqueOrThrow({
        where: { id: canaryDepId },
      });
      check(row.active === false, '7d DB still exists inactive', `active=${row.active}`);
      check(Boolean(row.deactivatedAt), '7e DB deactivatedAt', String(row.deactivatedAt));

      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'runtime.deployment.deactivate',
          entity: 'RuntimeDeployment',
          entityId: canaryDepId,
        },
        orderBy: { createdAt: 'desc' },
      });
      check(Boolean(audit), '7f AuditLog runtime.deployment.deactivate', 'missing');
    }

    // ── [8] rollback re-activates same row ───────────────────────────────
    console.log('\n── [8] POST rollback ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/runtime/deployments/${canaryDepId}/rollback`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '8a rollback 200', `got ${r.statusCode} ${r.body.slice(0, 200)}`);
      const body = parseBody<{ id: string; active: boolean }>(r.body);
      check(body.data?.id === canaryDepId, '8b same deployment id', String(body.data?.id));
      check(body.data?.active === true, '8c active again', `got ${body.data?.active}`);

      const row = await prisma.runtimeDeployment.findUniqueOrThrow({
        where: { id: canaryDepId },
      });
      check(row.active === true, '8d DB active=true', `active=${row.active}`);
      // Both canary + stable rows still exist
      const still = await prisma.runtimeDeployment.count({
        where: { id: { in: [canaryDepId, stableDepId] } },
      });
      check(still === 2, '8e both rows retained', `count=${still}`);
    }
  } finally {
    try {
      await prisma.runtimeDeployment.deleteMany({ where: { skillId } });
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } });
      await prisma.evalResult.deleteMany({ where: { run: { skillId } } });
      await prisma.evalRun.deleteMany({ where: { skillId } });
      await prisma.evalCase.deleteMany({ where: { suite: { skillId } } });
      await prisma.evalSuite.deleteMany({ where: { skillId } });
      await prisma.skillVersion.deleteMany({ where: { skillId } });
      await prisma.skill.deleteMany({ where: { id: skillId } });
    } catch (e) {
      console.warn('cleanup warning:', e);
    }
    await app.close();
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
