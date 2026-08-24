/**
 * Agent Builder — abandon unsubmitted drafts (soft delete).
 * Run: npx tsx .scratch/agent-build-abandon/tests/t-abandon.test.ts
 *
 * Seams: abandonBuilderSession, listBuilderSessions, getLatestBuilderSession,
 * POST /api/agent-builder/sessions/:id/abandon, src/scripts/abandon-stale-builds.ts
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import type { AgentBuildSessionStatus, Prisma } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError, sendError } from '../../../src/lib/http.js';
import { agentBuilderRoutes } from '../../../src/routes/agentbuilder.js';
import {
  abandonBuilderSession,
  getLatestBuilderSession,
  listBuilderSessions,
} from '../../../src/lib/agentbuilder.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectApi(
  fn: () => Promise<unknown>,
  opts: { status: number; code: string; message?: RegExp },
  label: string,
): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof ApiError, `${label}: expected ApiError, got ${String(error)}`);
    assert(error.statusCode === opts.status, `${label}: status ${error.statusCode} != ${opts.status}`);
    assert(error.code === opts.code, `${label}: code ${error.code} != ${opts.code}`);
    if (opts.message) {
      assert(opts.message.test(error.message), `${label}: message ${error.message}`);
    }
    return error;
  }
  throw new Error(`ASSERT FAIL: ${label}: expected throw`);
}

async function seedSession(opts: {
  userId: string;
  status: AgentBuildSessionStatus;
  draftSkillIds?: string[];
  builtAgentId?: string | null;
  createdAt?: Date;
  brief?: Prisma.InputJsonValue;
  transcript?: Prisma.InputJsonValue;
}): Promise<string> {
  const id = ulid();
  await prisma.agentBuildSession.create({
    data: {
      id,
      userId: opts.userId,
      status: opts.status,
      draftSkillIds: opts.draftSkillIds ?? [],
      builtAgentId: opts.builtAgentId ?? null,
      createdAt: opts.createdAt,
      brief: opts.brief ?? { objective: '捨棄草稿測試' },
      transcript: opts.transcript ?? [
        { role: 'user', content: '請幫我建一個員工', at: new Date().toISOString() },
      ],
    },
  });
  await prisma.agentBuildIteration.create({
    data: {
      id: ulid(),
      sessionId: id,
      sequence: 1,
      triggerKind: 'message',
      triggerSummary: 'seed iteration — must survive soft delete',
    },
  });
  return id;
}

async function main() {
  const tag = ulid().slice(-10).toLowerCase();
  const ownerId = ulid();
  const foreignId = ulid();
  const sessionIds: string[] = [];

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => sendError(reply, error));
  await app.register(agentBuilderRoutes);

  try {
    const [owner, foreign] = await Promise.all([
      prisma.user.create({
        data: {
          id: ownerId,
          email: `abandon-owner-${tag}@test.local`,
          displayName: 'Abandon Owner',
          passwordHash: 'x',
          role: 'MEMBER',
        },
      }),
      prisma.user.create({
        data: {
          id: foreignId,
          email: `abandon-foreign-${tag}@test.local`,
          displayName: 'Abandon Foreign',
          passwordHash: 'x',
          role: 'MEMBER',
        },
      }),
    ]);
    const ownerToken = await signAccess({
      sub: owner.id,
      email: owner.email,
      role: owner.role,
    });

    const discoveryId = await seedSession({ userId: owner.id, status: 'DISCOVERY' });
    const keepListedId = await seedSession({ userId: owner.id, status: 'DISCOVERY' });
    const awaitingId = await seedSession({ userId: owner.id, status: 'AWAITING_FDE' });
    const withSkillsId = await seedSession({
      userId: owner.id,
      status: 'DISCOVERY',
      draftSkillIds: [ulid()],
    });
    const scriptDryRunId = await seedSession({ userId: owner.id, status: 'PLAN_READY' });
    sessionIds.push(discoveryId, keepListedId, awaitingId, withSkillsId, scriptDryRunId);

    console.log('── [2] owner abandons DISCOVERY → ABANDONED, abandonedAt set, iterations kept');
    const abandoned = await abandonBuilderSession({
      sessionId: discoveryId,
      userId: owner.id,
      confirmSessionId: discoveryId,
    });
    assert(abandoned.status === 'ABANDONED', `status ${abandoned.status}`);
    assert(abandoned.abandonedAt != null && abandoned.abandonedAt.length > 0, 'abandonedAt missing on DTO');
    assert(abandoned.iterations.length >= 1, 'iterations must survive soft delete');
    const persisted = await prisma.agentBuildSession.findUnique({
      where: { id: discoveryId },
      include: { iterations: true },
    });
    assert(persisted, 'row must still exist');
    assert(persisted.status === 'ABANDONED', `db status ${persisted.status}`);
    assert(persisted.abandonedAt instanceof Date, 'db abandonedAt missing');
    assert(persisted.iterations.length >= 1, `db iterations ${persisted.iterations.length}`);
    console.log('  ✓ soft delete kept the row and its iterations');

    console.log('── [3] listBuilderSessions / getLatestBuilderSession exclude ABANDONED');
    const listed = await listBuilderSessions({ userId: owner.id });
    assert(
      listed.every((session) => session.id !== discoveryId),
      'abandoned session leaked into listBuilderSessions',
    );
    assert(
      listed.some((session) => session.id === keepListedId),
      'sibling DISCOVERY session disappeared from the list',
    );
    const latest = await getLatestBuilderSession({ userId: owner.id });
    assert(latest?.id !== discoveryId, 'getLatestBuilderSession resumed an abandoned draft');
    console.log('  ✓ lists no longer return the abandoned session');

    console.log('── [4] non-owner abandon → notFound and row unchanged');
    const beforeForeign = await prisma.agentBuildSession.findUniqueOrThrow({
      where: { id: keepListedId },
    });
    await expectApi(
      () => abandonBuilderSession({ sessionId: keepListedId, userId: foreign.id }),
      { status: 404, code: 'NOT_FOUND', message: /Session not found/ },
      'foreign abandon',
    );
    const afterForeign = await prisma.agentBuildSession.findUniqueOrThrow({
      where: { id: keepListedId },
    });
    assert(afterForeign.status === beforeForeign.status, 'foreign caller mutated status');
    assert(afterForeign.abandonedAt == null, 'foreign caller wrote abandonedAt');
    console.log('  ✓ non-owner is indistinguishable from missing');

    console.log('── [5] AWAITING_FDE cannot be abandoned');
    await expectApi(
      () => abandonBuilderSession({ sessionId: awaitingId, userId: owner.id }),
      {
        status: 403,
        code: 'FORBIDDEN',
        message: /已進入審核流程的建置不可自行捨棄/,
      },
      'awaiting FDE',
    );
    const stillAwaiting = await prisma.agentBuildSession.findUniqueOrThrow({
      where: { id: awaitingId },
    });
    assert(stillAwaiting.status === 'AWAITING_FDE', `status became ${stillAwaiting.status}`);
    assert(stillAwaiting.abandonedAt == null, 'AWAITING_FDE wrote abandonedAt');
    console.log('  ✓ governed session stays in FDE flow');

    console.log('── [6] DISCOVERY with draftSkillIds is refused');
    await expectApi(
      () => abandonBuilderSession({ sessionId: withSkillsId, userId: owner.id }),
      {
        status: 403,
        code: 'FORBIDDEN',
        message: /已產生員工或技能草稿/,
      },
      'draft skills',
    );
    const stillDraft = await prisma.agentBuildSession.findUniqueOrThrow({
      where: { id: withSkillsId },
    });
    assert(stillDraft.status === 'DISCOVERY', `status became ${stillDraft.status}`);
    console.log('  ✓ draft-skill sessions cannot be abandoned');

    console.log('── [7] repeating abandon is idempotent');
    const again = await abandonBuilderSession({
      sessionId: discoveryId,
      userId: owner.id,
      confirmSessionId: discoveryId,
    });
    assert(again.status === 'ABANDONED', `repeat status ${again.status}`);
    assert(again.abandonedAt === abandoned.abandonedAt, 'idempotent abandon mutated abandonedAt');
    console.log('  ✓ second abandon returns current row');

    console.log('── HTTP confirm mismatch + owner abandon');
    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/agent-builder/sessions/${keepListedId}/abandon`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      payload: { confirmSessionId: 'not-the-session' },
    });
    assert(mismatch.statusCode === 400, `confirm mismatch expected 400, got ${mismatch.statusCode}`);
    const httpAbandon = await app.inject({
      method: 'POST',
      url: `/api/agent-builder/sessions/${keepListedId}/abandon`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      payload: { confirmSessionId: keepListedId },
    });
    assert(httpAbandon.statusCode === 200, `http abandon ${httpAbandon.statusCode}`);
    const httpBody = httpAbandon.json() as { success: boolean; data: { status: string } };
    assert(httpBody.success && httpBody.data.status === 'ABANDONED', 'http envelope');
    console.log('  ✓ REST abandon route');

    console.log('── [8] dry-run script lists but does not mutate');
    const beforeScript = await prisma.agentBuildSession.findUniqueOrThrow({
      where: { id: scriptDryRunId },
    });
    assert(beforeScript.status === 'PLAN_READY', 'script fixture drifted');
    const dryRunOut = execFileSync(
      'npx',
      ['tsx', 'src/scripts/abandon-stale-builds.ts', '--user', owner.email],
      { cwd: SERVER_ROOT, encoding: 'utf8' },
    );
    console.log(dryRunOut);
    assert(/將捨棄 \d+ 筆/.test(dryRunOut), 'dry-run did not print the confirmation line');
    assert(dryRunOut.includes(scriptDryRunId.slice(0, 10)), 'dry-run table missed PLAN_READY row');
    const afterScript = await prisma.agentBuildSession.findUniqueOrThrow({
      where: { id: scriptDryRunId },
    });
    assert(afterScript.status === 'PLAN_READY', `dry-run mutated status to ${afterScript.status}`);
    assert(afterScript.abandonedAt == null, 'dry-run wrote abandonedAt');
    console.log('  ✓ dry-run is read-only');

    console.log('── all abandon-builder tests passed ──');
  } finally {
    if (sessionIds.length) {
      await prisma.agentBuildIteration.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.agentBuildSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, foreignId] } } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
