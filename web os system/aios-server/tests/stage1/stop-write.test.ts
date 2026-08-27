/**
 * Stage-1 S1-6: schema stop-write (no drops).
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/stage1/stop-write.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { signAccess } from '../../src/lib/auth.ts';
import { ApiError, sendError } from '../../src/lib/http.ts';
import {
  STAGE1_STOP_WRITE_BODY,
  STAGE1_STOP_WRITE_ERROR,
  STOP_WRITE_ENV,
  STOP_WRITE_HTTP_ROUTES,
  allowWrite,
  assertWriteEnabled,
  resetStopWriteWarningsForTest,
  writesEnabled,
} from '../../src/lib/stopwrite.ts';
import { createSuite } from '../../src/lib/eval.ts';
import { createFlowArtifact } from '../../src/lib/flowartifact.ts';
import { registerPeer } from '../../src/lib/a2a.ts';
import { ingestRunTrace } from '../../src/lib/trace.ts';
import { recordingService } from '../../src/lib/recording.ts';
import { reflectionService } from '../../src/lib/reflection.ts';
import { promoteWithGate } from '../../src/lib/skillpromote.ts';
import { createSkillVersion } from '../../src/lib/skillversion.ts';
import { evalRoutes } from '../../src/routes/evals.ts';
import { runtimeRoutes } from '../../src/routes/runtime.ts';
import { graphRoutes } from '../../src/routes/graph.ts';
import { a2aRoutes } from '../../src/routes/a2a.ts';
import { recordingRoutes } from '../../src/routes/recording.ts';
import { reflectionRoutes } from '../../src/routes/reflections.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_OS = path.resolve(HERE, '../../..');
const SRC_ROOT = path.resolve(HERE, '../../src');
const TEST_PREFIX = 's16-stop-write-';

for (const flag of Object.values(STOP_WRITE_ENV)) {
  delete process.env[flag];
}
resetStopWriteWarningsForTest();

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    });
}

function isStopWriteError(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.statusCode === 501 &&
    e.code === STAGE1_STOP_WRITE_ERROR
  );
}

async function createUser(role: 'TRAINER' | 'MEMBER') {
  const id = ulid();
  return prisma.user.create({
    data: {
      id,
      email: `${TEST_PREFIX}${role.toLowerCase()}-${id.slice(-6)}@test.local`,
      displayName: `S16 ${role}`,
      passwordHash: 'x',
      role,
    },
  });
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => sendError(reply, err));
  await app.register(evalRoutes);
  await app.register(runtimeRoutes);
  await app.register(graphRoutes);
  await app.register(recordingRoutes);
  await app.register(reflectionRoutes);
  await app.register(a2aRoutes, { prefix: '/api' });
  return app;
}

await test('env flags default to stop-write', () => {
  for (const cluster of Object.keys(STOP_WRITE_ENV) as Array<keyof typeof STOP_WRITE_ENV>) {
    assert.equal(writesEnabled(cluster), false, cluster);
  }
});

const fde = await createUser('TRAINER');
const createdUserIds = [fde.id];
const createdSkillIds: string[] = [];
const token = await signAccess({
  sub: fde.id,
  email: fde.email,
  role: 'TRAINER',
});
const authz = { authorization: `Bearer ${token}` };

const app = await buildApp();

await test('(a) each stop-write HTTP entry returns 501 stage1-stop-write', async () => {
  assert.ok(STOP_WRITE_HTTP_ROUTES.length >= 20, 'catalog should list the frozen write surface');
  for (const route of STOP_WRITE_HTTP_ROUTES) {
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: {
        ...authz,
        ...(route.method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
      },
      payload: route.method === 'DELETE' ? undefined : {},
    });
    assert.equal(res.statusCode, 501, `${route.method} ${route.url}`);
    const body = res.json() as { error?: string; hint?: string };
    assert.equal(body.error, STAGE1_STOP_WRITE_BODY.error, `${route.method} ${route.url} error`);
    assert.equal(body.hint, STAGE1_STOP_WRITE_BODY.hint, `${route.method} ${route.url} hint`);
  }
});

await test('(a) read paths remain open', async () => {
  const reads = [
    { method: 'GET' as const, url: '/api/a2a/peers' },
    { method: 'GET' as const, url: '/api/runtime/deployments' },
    { method: 'GET' as const, url: '/api/runtime/dead-letters' },
    { method: 'GET' as const, url: '/api/recording/status' },
    { method: 'GET' as const, url: '/api/skills/s16-dummy/eval-suites' },
  ];
  for (const route of reads) {
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: authz,
    });
    assert.equal(res.statusCode, 200, `${route.method} ${route.url} should stay readable`);
  }
});

await test('(a) internal fail-closed writers throw 501', async () => {
  await assert.rejects(
    () => createSuite({ skillId: 'missing', name: 'x' }),
    isStopWriteError,
  );
  await assert.rejects(
    () =>
      createFlowArtifact({
        runtimeKind: 'NATIVE',
        template: 't',
        compilerVersion: '1',
        artifactJson: { ok: true },
      }),
    isStopWriteError,
  );
  await assert.rejects(
    () =>
      registerPeer(
        { peerId: 'p', name: 'n', baseUrl: 'http://127.0.0.1:9' },
        fde.id,
      ),
    isStopWriteError,
  );
  await assert.rejects(() => recordingService.start(fde.id, 'missing-agent'), isStopWriteError);
  await assert.rejects(
    () => reflectionService.runCycle({ triggeredBy: 'test' }),
    isStopWriteError,
  );
  assert.throws(() => assertWriteEnabled('eval'), isStopWriteError);
});

await test('(a) fail-safe RunTrace ingest no-ops when flag is off', async () => {
  await ingestRunTrace({
    agent: { id: 'missing' },
    manifest: {
      engineExecute: 'GROK',
      engineVerify: 'CLAUDE_CODE',
      skills: [],
    } as never,
    outcome: {
      ok: true,
      runId: `run-${ulid()}`,
      runDir: '/tmp/s16',
      status: 'SUCCEEDED',
      results: [],
      reworkHistory: [],
    },
  });
  const traces = await prisma.runTrace.count({
    where: { agentId: 'missing' },
  });
  assert.equal(traces, 0);
});

await test('(a) env flag re-enables eval writes past the guard', async () => {
  process.env.AIOS_EVAL_WRITES = 'true';
  try {
    assert.equal(writesEnabled('eval'), true);
    await assert.rejects(
      () => createSuite({ skillId: 'missing', name: 'x' }),
      (e: unknown) => e instanceof ApiError && e.statusCode === 404,
    );
  } finally {
    delete process.env.AIOS_EVAL_WRITES;
  }
  assert.equal(writesEnabled('eval'), false);
});

await test('(b) promoteWithGate stays fail-closed without PASSED EvalRun', async () => {
  const tag = ulid().slice(-8).toLowerCase();
  const skill = await prisma.skill.create({
    data: {
      id: `${TEST_PREFIX}skill-${tag}`,
      slug: `${TEST_PREFIX}${tag}`,
      name: `S16 promote ${tag}`,
      origin: 'CLI_GENERATED',
      kind: 'PROMPT_MANUAL',
      contentMd: 's16 promote gate fixture',
      reviewStatus: 'CONFIRMED',
      confirmedBy: fde.id,
      confirmedAt: new Date(),
    },
  });
  createdSkillIds.push(skill.id);
  const ver = await createSkillVersion(skill.id, `# S16 ${tag}\nfixture`, fde.id);
  await assert.rejects(
    () =>
      promoteWithGate({
        skillId: skill.id,
        versionId: ver.id,
        actorId: fde.id,
        actorRole: 'TRAINER',
      }),
    (e: unknown) =>
      e instanceof ApiError &&
      e.statusCode === 409 &&
      /沒有通過的評測執行/.test(e.message),
  );
});

await test('(c) builderlessons is not wired to stop-write', () => {
  const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/builderlessons.ts'), 'utf8');
  assert.doesNotMatch(src, /stopwrite/);
  assert.equal(allowWrite('reflection'), false);
});

await test('(c) lesson-loop suite still green', () => {
  const result = spawnSync(
    'npx',
    ['tsx', 'aios-server/tests/prompt-v2/lesson-loop.test.ts'],
    {
      cwd: WEB_OS,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `lesson-loop failed (status=${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
});

await app.close();

for (const skillId of createdSkillIds) {
  await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => {});
  await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => {});
}
for (const userId of createdUserIds) {
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
}

await disconnectDb();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
