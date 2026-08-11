/**
 * Ticket 15 — FDE Runtime admin (negative / MEMBER gate + digest drift + filters).
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t15-runtime-admin-negative.test.ts
 *
 * Real DB + Fastify inject. Does NOT delete AuditLog.
 * Token is signed JWT only (no User row). FK fields reuse existing OWNER/TRAINER user.id.
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

async function main(): Promise<void> {
  console.log('── t15-runtime-admin-negative ──');

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
  const contentMd = `# t15 neg ${tag}\n`;

  const memberToken = await signAccess({
    sub: 't15-member',
    email: 't15-member@test.local',
    role: 'MEMBER',
  });
  const trainerToken = await signAccess({
    sub: 't15-trainer',
    email: 't15-trainer@test.local',
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
    // ── Setup: skill + version + artifact ────────────────────────────────
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t15-neg-${tag}`,
        name: `T15 Neg ${tag}`,
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
        specJson: { kind: 't15-neg', tag },
      },
    });

    await prisma.evalSuite.create({
      data: {
        id: suiteId,
        skillId,
        name: `T15 Neg Suite ${tag}`,
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
      compilerVersion: `t15-neg-${tag}`,
      artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'native', tag },
      createdBy: owner.id,
    });
    artifactId = art.id;

    const countArtBefore = await prisma.flowArtifact.count();
    const countDepBefore = await prisma.runtimeDeployment.count();

    // ── [1] MEMBER all reject + zero change ──────────────────────────────
    console.log('\n── [1] MEMBER all runtime admin routes → 403, zero change ──');
    {
      const paths: Array<{ method: 'GET' | 'POST'; url: string; body?: object }> = [
        { method: 'GET', url: '/api/runtime/artifacts' },
        { method: 'GET', url: `/api/runtime/artifacts/${artifactId}` },
        { method: 'GET', url: '/api/runtime/deployments' },
        { method: 'POST', url: `/api/runtime/artifacts/${artifactId}/validate` },
        {
          method: 'POST',
          url: '/api/runtime/deployments',
          body: {
            artifactId,
            environment: 'PRODUCTION',
            channel: 'CANARY',
          },
        },
        { method: 'POST', url: `/api/runtime/deployments/${ulid()}/deactivate` },
        { method: 'POST', url: `/api/runtime/deployments/${ulid()}/rollback` },
      ];

      for (let i = 0; i < paths.length; i++) {
        const p = paths[i]!;
        const r = await app.inject({
          method: p.method,
          url: p.url,
          headers: {
            ...auth(memberToken),
            ...(p.body ? { 'content-type': 'application/json' } : {}),
          },
          payload: p.body,
        });
        check(
          r.statusCode === 403,
          `1.${i + 1} MEMBER ${p.method} ${p.url.split('?')[0]} → 403`,
          `got ${r.statusCode} body=${r.body.slice(0, 180)}`,
        );
      }

      const countArtAfter = await prisma.flowArtifact.count();
      const countDepAfter = await prisma.runtimeDeployment.count();
      check(
        countArtAfter === countArtBefore,
        '1z flowArtifact count unchanged',
        `before=${countArtBefore} after=${countArtAfter}`,
      );
      check(
        countDepAfter === countDepBefore,
        '1z runtimeDeployment count unchanged',
        `before=${countDepBefore} after=${countDepAfter}`,
      );

      const artRow = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
      check(
        artRow.status === 'COMPILED',
        '1z artifact still COMPILED',
        `status=${artRow.status}`,
      );
    }

    // ── [2] digest drift: list/detail show digestOk false; activate rejects ─
    console.log('\n── [2] digest drift projection + activate reject ──');
    {
      // Tamper artifactJson in DB (simulates drift) without updating digest
      await prisma.flowArtifact.update({
        where: { id: artifactId },
        data: {
          artifactJson: {
            nodes: [{ id: 'n1-tampered' }],
            edges: [],
            kind: 'native',
            tag,
            tampered: true,
          },
        },
      });

      const rList = await app.inject({
        method: 'GET',
        url: '/api/runtime/artifacts',
        headers: auth(trainerToken),
      });
      check(rList.statusCode === 200, '2a TRAINER list → 200', `got ${rList.statusCode}`);
      const listBody = JSON.parse(rList.body) as {
        success?: boolean;
        data?: Array<{ id: string; digestOk: boolean }>;
      };
      const row = listBody.data?.find((x) => x.id === artifactId);
      check(Boolean(row), '2b list contains artifact', 'missing');
      check(row?.digestOk === false, '2c list digestOk=false', `got ${row?.digestOk}`);

      const rDetail = await app.inject({
        method: 'GET',
        url: `/api/runtime/artifacts/${artifactId}`,
        headers: auth(trainerToken),
      });
      check(rDetail.statusCode === 200, '2d TRAINER detail → 200', `got ${rDetail.statusCode}`);
      const detailBody = JSON.parse(rDetail.body) as {
        success?: boolean;
        data?: {
          artifact: { digestOk: boolean };
          readiness: { canActivate: boolean; checks: Array<{ key: string; ok: boolean; reason: string }> };
        };
      };
      check(
        detailBody.data?.artifact.digestOk === false,
        '2e detail digestOk=false',
        `got ${detailBody.data?.artifact.digestOk}`,
      );
      const digestCheck = detailBody.data?.readiness.checks.find((c) => c.key === 'digest_ok');
      check(digestCheck?.ok === false, '2f readiness digest_ok=false', JSON.stringify(digestCheck));
      check(
        Boolean(digestCheck?.reason && digestCheck.reason.length > 0),
        '2g readiness digest reason visible',
        String(digestCheck?.reason),
      );
      check(
        detailBody.data?.readiness.canActivate === false,
        '2h canActivate=false',
        `got ${detailBody.data?.readiness.canActivate}`,
      );

      const depCountBeforeActivate = await prisma.runtimeDeployment.count({
        where: { skillId },
      });
      const rAct = await app.inject({
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
      check(
        rAct.statusCode === 409 || rAct.statusCode === 400,
        '2i activate drift → 4xx/409',
        `got ${rAct.statusCode} body=${rAct.body.slice(0, 200)}`,
      );
      const depCountAfterActivate = await prisma.runtimeDeployment.count({
        where: { skillId },
      });
      check(
        depCountAfterActivate === depCountBeforeActivate,
        '2j zero deployment write on drift',
        `before=${depCountBeforeActivate} after=${depCountAfterActivate}`,
      );
    }

    // ── [3] deactivate missing → 404 ─────────────────────────────────────
    console.log('\n── [3] deactivate missing id → 404 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/runtime/deployments/${ulid()}/deactivate`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 404, '3a TRAINER deactivate missing → 404', `got ${r.statusCode}`);
    }

    // ── [4] illegal status filter → 400 ──────────────────────────────────
    console.log('\n── [4] illegal status filter ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: '/api/runtime/artifacts?status=HACK',
        headers: auth(trainerToken),
      });
      check(r.statusCode === 400, '4a status=HACK → 400', `got ${r.statusCode} body=${r.body.slice(0, 180)}`);
    }
  } finally {
    // Cleanup only test-owned rows (no AuditLog)
    try {
      await prisma.runtimeDeployment.deleteMany({ where: { skillId } });
      await prisma.flowArtifact.deleteMany({
        where: { skillVersionId },
      });
      await prisma.evalResult.deleteMany({
        where: { run: { skillId } },
      });
      await prisma.evalRun.deleteMany({ where: { skillId } });
      await prisma.evalCase.deleteMany({
        where: { suite: { skillId } },
      });
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
