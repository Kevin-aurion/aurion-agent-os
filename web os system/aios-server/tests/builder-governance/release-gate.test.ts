/**
 * Builder production-release gate: historical builtAgentId Agents stay
 * hidden until every training session bound to them is ACTIVE. Ordinary
 * Agents are unaffected.
 *
 * No paid CLI. Run from `web os system/aios-server/`:
 *   npx tsx tests/builder-governance/release-gate.test.ts
 */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma, disconnectDb } from '../../src/lib/db.ts';
import { signAccess } from '../../src/lib/auth.ts';
import { ApiError, sendError } from '../../src/lib/http.ts';
import {
  assertBuilderAgentReleased,
  isBuilderAgentReleased,
  listUnreleasedBuilderAgentIds,
} from '../../src/lib/builderrelease.ts';
import { requireVisibleAgent } from '../../src/lib/agentaccess.ts';
import { runAgent } from '../../src/engine/runner.ts';
import { agentRoutes } from '../../src/routes/agents.ts';
import { agentRuntimeRoutes } from '../../src/routes/agentruntime.ts';
import { dashboardRoutes } from '../../src/routes/dashboard.ts';

const TEST_PREFIX = 'gov-release-gate-';

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

async function createMember() {
  const id = ulid();
  return prisma.user.create({
    data: {
      id,
      email: `${TEST_PREFIX}${id.slice(-8)}@test.local`,
      displayName: 'Release Gate MEMBER',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });
}

async function createAgent(opts: {
  userId: string;
  name: string;
  riskTier?: string;
  status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
}) {
  const id = ulid();
  return prisma.agent.create({
    data: {
      id,
      slug: `${TEST_PREFIX}${id.slice(-10)}`.toLowerCase(),
      name: opts.name,
      description: 'release-gate test agent',
      department: '測試',
      rolePrompt: '整理對帳草稿，不得寄信。',
      engineExecute: 'CLAUDE_CODE',
      restrictions: { webSearch: false, sendEmail: false, shell: false },
      riskTier: opts.riskTier ?? 'high',
      status: opts.status ?? 'ACTIVE',
      createdBy: opts.userId,
    },
  });
}

async function createBuilderSession(opts: {
  userId: string;
  builtAgentId: string;
  status?: 'ACTIVE' | 'PASSED' | 'DISCOVERY';
}) {
  const id = ulid();
  return prisma.agentBuildSession.create({
    data: {
      id,
      userId: opts.userId,
      status: opts.status ?? 'DISCOVERY',
      builtAgentId: opts.builtAgentId,
      strategy: 'create',
      transcript: [],
    },
  });
}

async function attachConfirmedBuilderSkill(agentId: string, userId: string): Promise<string> {
  const id = ulid();
  await prisma.skill.create({
    data: {
      id,
      slug: `${TEST_PREFIX}skill-${id.slice(-10)}`.toLowerCase(),
      name: '已確認 Builder 技能',
      origin: 'CLI_GENERATED',
      kind: 'PROMPT_MANUAL',
      contentMd: '# 已確認 Builder 技能\n',
      generator: 'agent-builder',
      reviewStatus: 'CONFIRMED',
      confirmedBy: userId,
      confirmedAt: new Date(),
      agents: { create: { agentId } },
    },
  });
  return id;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => sendError(reply, err));
  await app.register(agentRoutes);
  await app.register(agentRuntimeRoutes);
  await app.register(dashboardRoutes);
  return app;
}

async function authHeader(user: { id: string; email: string; role: string }) {
  const token = await signAccess({ sub: user.id, email: user.email, role: user.role });
  return { authorization: `Bearer ${token}` };
}

function envelopeIds(body: { success?: boolean; data?: unknown }): string[] {
  assert.equal(body.success, true);
  const data = body.data;
  assert.ok(Array.isArray(data), 'expected list envelope');
  return data.map((row) => {
    assert.ok(row && typeof row === 'object' && 'id' in row);
    return String((row as { id: string }).id);
  });
}

function orgAgentIds(body: { success?: boolean; data?: unknown }): string[] {
  assert.equal(body.success, true);
  const data = body.data;
  assert.ok(data && typeof data === 'object' && 'departments' in data);
  const departments = (data as { departments: Array<{ agents?: Array<{ id?: string }> }> }).departments;
  assert.ok(Array.isArray(departments), 'expected org departments');
  return departments.flatMap((dept) => (dept.agents ?? []).map((row) => String(row.id)));
}

async function cleanupUser(userId: string): Promise<void> {
  const agents = await prisma.agent.findMany({
    where: { createdBy: userId },
    select: { id: true },
  });
  const agentIds = agents.map((row) => row.id);
  const skillLinks = agentIds.length
    ? await prisma.agentSkill.findMany({ where: { agentId: { in: agentIds } }, select: { skillId: true } })
    : [];
  const skillIds = [...new Set(skillLinks.map((row) => row.skillId))];
  const sessions = await prisma.agentBuildSession.findMany({
    where: { OR: [{ userId }, ...(agentIds.length ? [{ builtAgentId: { in: agentIds } }] : [])] },
    select: { id: true },
  });
  const sessionIds = sessions.map((row) => row.id);
  if (sessionIds.length) {
    // AuditLog is an append-only hash chain. Never delete test audit rows:
    // removing a non-tail row while the live service appends concurrently
    // would invalidate every later prevHash link.
    await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
  }
  if (agentIds.length) {
    await prisma.run.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
  }
  if (skillIds.length) {
    await prisma.skill.deleteMany({ where: { id: { in: skillIds } } }).catch(() => {});
  }
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
}

async function sweepLeftovers(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  for (const user of users) await cleanupUser(user.id);
}

await sweepLeftovers();

try {
  await test('unreleased historical ACTIVE builder Agent is excluded and 404s', async () => {
    const member = await createMember();
    const app = await buildApp();
    try {
      const unreleased = await createAgent({ userId: member.id, name: '未釋出對帳員工' });
      const ordinary = await createAgent({ userId: member.id, name: '一般對帳員工' });
      await createBuilderSession({ userId: member.id, builtAgentId: unreleased.id });
      const headers = await authHeader(member);

      assert.equal(await isBuilderAgentReleased(unreleased.id), false);
      assert.equal(await isBuilderAgentReleased(ordinary.id), true);
      const blocked = await listUnreleasedBuilderAgentIds([unreleased.id, ordinary.id]);
      assert.ok(blocked.includes(unreleased.id));
      assert.ok(!blocked.includes(ordinary.id));

      const list = await app.inject({ method: 'GET', url: '/api/agents', headers });
      assert.equal(list.statusCode, 200);
      const listed = envelopeIds(list.json());
      assert.ok(!listed.includes(unreleased.id), 'employee list leaked unreleased builder Agent');
      assert.ok(listed.includes(ordinary.id), 'ordinary Agent missing from employee list');

      const detail = await app.inject({ method: 'GET', url: `/api/agents/${unreleased.id}`, headers });
      assert.equal(detail.statusCode, 404);
      const ordinaryDetail = await app.inject({ method: 'GET', url: `/api/agents/${ordinary.id}`, headers });
      assert.equal(ordinaryDetail.statusCode, 200);

      const runtimeList = await app.inject({ method: 'GET', url: '/api/agent-runtime/agents', headers });
      assert.equal(runtimeList.statusCode, 200);
      const runtimeIds = envelopeIds(runtimeList.json());
      assert.ok(!runtimeIds.includes(unreleased.id), 'runtime list leaked unreleased builder Agent');
      assert.ok(runtimeIds.includes(ordinary.id));

      const runtimeDetail = await app.inject({
        method: 'GET',
        url: `/api/agent-runtime/agents/${unreleased.id}`,
        headers,
      });
      assert.equal(runtimeDetail.statusCode, 404);

      const invoke = await app.inject({
        method: 'POST',
        url: `/api/agent-runtime/agents/${unreleased.id}/invoke`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: { input: { message: '請整理對帳草稿' } },
      });
      assert.equal(invoke.statusCode, 404);

      const schedules = await app.inject({
        method: 'GET',
        url: `/api/agent-runtime/agents/${unreleased.id}/schedules`,
        headers,
      });
      assert.equal(schedules.statusCode, 404);

      await assert.rejects(
        () => requireVisibleAgent(unreleased.id, { sub: member.id, role: member.role }),
        (error: unknown) => error instanceof ApiError && error.statusCode === 404,
      );
      const visible = await requireVisibleAgent(ordinary.id, { sub: member.id, role: member.role });
      assert.equal(visible.id, ordinary.id);

      const org = await app.inject({ method: 'GET', url: '/api/org', headers });
      assert.equal(org.statusCode, 200);
      const orgIds = orgAgentIds(org.json());
      assert.ok(!orgIds.includes(unreleased.id), 'org leaked unreleased builder Agent');
      assert.ok(orgIds.includes(ordinary.id), 'ordinary Agent missing from org');

      const rawActive = await prisma.agent.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      const unreleasedActiveIds = new Set(
        await listUnreleasedBuilderAgentIds(rawActive.map((row) => row.id)),
      );
      const expectedActive = rawActive.filter((row) => !unreleasedActiveIds.has(row.id)).length;
      const summary = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers });
      assert.equal(summary.statusCode, 200);
      const summaryBody = summary.json() as {
        success?: boolean;
        data?: { agents?: { active?: number } };
      };
      assert.equal(summaryBody.success, true);
      const summaryActive = summaryBody.data?.agents?.active;
      assert.equal(typeof summaryActive, 'number');
      assert.equal(summaryActive, expectedActive);
      assert.ok(
        rawActive.length >= (summaryActive as number) + 1,
        `raw ACTIVE count (${rawActive.length}) must exceed summary (${summaryActive}) by at least 1`,
      );
      assert.ok(unreleasedActiveIds.has(unreleased.id));
      assert.ok(!unreleasedActiveIds.has(ordinary.id));
    } finally {
      await app.close();
      await cleanupUser(member.id);
    }
  });

  await test('runAgent rejects unreleased builder Agent before a Run row or CLI', async () => {
    const member = await createMember();
    try {
      const agent = await createAgent({
        userId: member.id,
        name: '未釋出高風險員工',
        riskTier: 'high',
      });
      await createBuilderSession({ userId: member.id, builtAgentId: agent.id });
      const before = await prisma.run.count({ where: { agentId: agent.id } });
      await assert.rejects(
        () =>
          runAgent({
            agentId: agent.id,
            input: { message: '這次不該碰到引擎' },
            triggeredBy: member.id,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError, 'expected ApiError');
          assert.equal(error.statusCode, 403);
          assert.match(error.message, /not active/i);
          return true;
        },
      );
      const after = await prisma.run.count({ where: { agentId: agent.id } });
      assert.equal(after, before, 'runAgent created a Run row for an unreleased builder Agent');
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('ACTIVE training session releases only a complete builder Agent with a confirmed Skill', async () => {
    const member = await createMember();
    const app = await buildApp();
    try {
      const agent = await createAgent({ userId: member.id, name: '已 Finalize 員工' });
      const session = await createBuilderSession({ userId: member.id, builtAgentId: agent.id });
      assert.equal(await isBuilderAgentReleased(agent.id), false);
      await prisma.agentBuildSession.update({ where: { id: session.id }, data: { status: 'ACTIVE' } });
      assert.equal(await isBuilderAgentReleased(agent.id), false, 'empty historical working Agent leaked');
      await attachConfirmedBuilderSkill(agent.id, member.id);
      assert.equal(await isBuilderAgentReleased(agent.id), true);
      const blocked = await listUnreleasedBuilderAgentIds([agent.id]);
      assert.ok(!blocked.includes(agent.id));

      const headers = await authHeader(member);
      const list = await app.inject({ method: 'GET', url: '/api/agents', headers });
      assert.equal(list.statusCode, 200);
      assert.ok(envelopeIds(list.json()).includes(agent.id));
      const detail = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}`, headers });
      assert.equal(detail.statusCode, 200);
      const runtime = await app.inject({
        method: 'GET',
        url: `/api/agent-runtime/agents/${agent.id}`,
        headers,
      });
      assert.equal(runtime.statusCode, 200);
    } finally {
      await app.close();
      await cleanupUser(member.id);
    }
  });

  await test('ordinary ACTIVE Agent that was never a builtAgentId remains released', async () => {
    const member = await createMember();
    try {
      const agent = await createAgent({ userId: member.id, name: '手建員工' });
      assert.equal(await isBuilderAgentReleased(agent.id), true);
      const blocked = await listUnreleasedBuilderAgentIds([agent.id]);
      assert.deepEqual(blocked, []);
      await assert.doesNotReject(() => assertBuilderAgentReleased({ agentId: agent.id }));
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('duplicate corrupt sessions cannot accidentally release an Agent', async () => {
    const member = await createMember();
    try {
      const agent = await createAgent({ userId: member.id, name: '重複 session 員工' });
      const good = await createBuilderSession({ userId: member.id, builtAgentId: agent.id, status: 'ACTIVE' });
      await createBuilderSession({ userId: member.id, builtAgentId: agent.id });
      assert.ok(good.id);
      assert.equal(await isBuilderAgentReleased(agent.id), false);
      const blocked = await listUnreleasedBuilderAgentIds([agent.id]);
      assert.ok(blocked.includes(agent.id));
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('audit evidence alone does not release a non-ACTIVE session', async () => {
    const member = await createMember();
    try {
      const agent = await createAgent({ userId: member.id, name: '錯 entityId 員工' });
      await createBuilderSession({ userId: member.id, builtAgentId: agent.id });
      assert.equal(await isBuilderAgentReleased(agent.id), false);
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('builderTestSessionId skips the production release gate', async () => {
    const member = await createMember();
    try {
      const agent = await createAgent({ userId: member.id, name: '隔離測試員工' });
      await createBuilderSession({ userId: member.id, builtAgentId: agent.id });
      assert.equal(await isBuilderAgentReleased(agent.id), false);
      await assert.doesNotReject(() =>
        assertBuilderAgentReleased({
          agentId: agent.id,
          builderTestSessionId: 'isolated-builder-test',
        }),
      );
      await assert.rejects(
        () => assertBuilderAgentReleased({ agentId: agent.id }),
        (error: unknown) => error instanceof ApiError && error.statusCode === 403,
      );
    } finally {
      await cleanupUser(member.id);
    }
  });

  await test('DB lookup errors fail closed', async () => {
    const member = await createMember();
    const originalSessions = prisma.agentBuildSession.findMany;
    try {
      const builder = await createAgent({ userId: member.id, name: '查詢失敗 builder' });
      const ordinary = await createAgent({ userId: member.id, name: '查詢失敗 ordinary' });
      await createBuilderSession({ userId: member.id, builtAgentId: builder.id });

      prisma.agentBuildSession.findMany = (async () => {
        throw new Error('simulated session lookup failure');
      }) as typeof prisma.agentBuildSession.findMany;
      try {
        const hidden = await listUnreleasedBuilderAgentIds([builder.id, ordinary.id]);
        assert.ok(hidden.includes(builder.id));
        assert.ok(hidden.includes(ordinary.id), 'session lookup error must treat every candidate as unreleased');
        assert.equal(await isBuilderAgentReleased(builder.id), false);
        assert.equal(await isBuilderAgentReleased(ordinary.id), false);
        await assert.rejects(
          () => listUnreleasedBuilderAgentIds(),
          (error: unknown) => error instanceof Error && /simulated session lookup failure/.test(error.message),
        );
      } finally {
        prisma.agentBuildSession.findMany = originalSessions;
      }
    } finally {
      prisma.agentBuildSession.findMany = originalSessions;
      await cleanupUser(member.id);
    }
  });
} finally {
  await sweepLeftovers();
  await disconnectDb();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
