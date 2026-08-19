/**
 * Ticket 05 — A2A fail-closed + card/trace redaction negatives + route auth.
 * Run: npx tsx .scratch/skill-production-platform/tests/t05-a2a-neg.ts
 *
 * - submitTask on disabled peer → 403 (lib fail-closed)
 * - Agent Card whitelist/redaction
 * - RunTrace secret redaction + trajectory dedupe single proposal
 * - MEMBER receives HTTP 403 on Agent Card, peer card, submit, status, cancel
 *   (Fastify inject — never reaches network dispatch)
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { registerPeer, submitTask } from '../../../src/lib/a2a.js';
import { projectAgentCard } from '../../../src/lib/agentcard.js';
import {
  ingestRunTrace,
  maybeProposeTrajectoryDedupe as maybeDedupe,
  TRAJECTORY_MIN_OCCURRENCES as TRACE_MIN,
} from '../../../src/lib/trace.js';
import { a2aRoutes } from '../../../src/routes/a2a.js';
import type { CompiledManifest, RunOutcome } from '../../../src/engine/types.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<unknown> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ASSERT FAIL: expected throw')) throw e;
    return e;
  }
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  let member = await prisma.user.findFirst({
    where: { deletedAt: null, role: 'MEMBER' },
  });
  let createdMemberId: string | null = null;
  if (!member) {
    createdMemberId = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMemberId,
        email: `t05-a2a-member-${createdMemberId.slice(-6)}@test.local`,
        displayName: 'T05 A2A Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const skillId = ulid();
  const FAKE_SECRET = 'sk-a2aneg0123456789ABCDEF';
  const ROLE_PROMPT = 'A2A_NEG_ROLE_PROMPT_LEAK_ME';
  const RESTRICTION_NOTE = 'A2A_NEG_RESTRICTION_PRIVATE';
  let peerRowId: string | undefined;
  let peerLogicalId: string | undefined;
  const runIds: string[] = [];

  // Fastify harness for route-level requireTrainer proofs
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
    return reply
      .code(500)
      .send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(a2aRoutes);

  const memberToken = await signAccess({
    sub: member.id,
    email: member.email,
    role: 'MEMBER',
  });
  const trainerToken = await signAccess({
    sub: user.id,
    email: user.email,
    role: user.role,
  });

  console.log('── setup agent + skill ──');
  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t05-a2a-${tag}`,
        name: 'T05 A2A Neg Agent',
        description: 'a2a negative test',
        rolePrompt: ROLE_PROMPT,
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
          notes: RESTRICTION_NOTE,
        },
        identityCard: {
          oneLiner: 'safe one liner',
          purpose: 'test',
          canDo: ['answer'],
          cannotDo: ['exfiltrate'],
          servedAudience: 'qa',
          exampleCommands: [],
        },
        riskTier: 'high',
        createdBy: user.id,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t05-a2a-skill-${tag}`,
        name: 'T05 A2A Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# body ${FAKE_SECRET}\n`,
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    await prisma.agentSkill.create({ data: { agentId, skillId } });

    // ── 1) submitTask on disabled peer → forbidden ──
    console.log('── submitTask disabled peer → reject ──');
    peerLogicalId = `peer-${tag}`;
    const peer = await registerPeer(
      {
        peerId: peerLogicalId,
        name: `Peer ${tag}`,
        // Deliberately unreachable — MEMBER route tests must 403 before fetch.
        baseUrl: 'http://127.0.0.1:9',
        enabled: false,
        credentialRef: 'env:A2A_TEST_TOKEN_NONEXIST',
      },
      user.id,
    );
    peerRowId = peer.id;
    assert(peer.enabled === false, 'peer starts disabled');
    assert(peer.credentialRef === 'env:A2A_TEST_TOKEN_NONEXIST', 'credentialRef stored as ref');

    const e1 = await expectThrow(
      () =>
        submitTask({
          peerId: peer.peerId,
          agentId,
          payload: { hello: 'world' },
          submittedBy: user.id,
        }),
      'submit on disabled peer',
    );
    assert(e1 instanceof ApiError, 'expect ApiError');
    assert((e1 as ApiError).statusCode === 403, `expect 403, got ${(e1 as ApiError).statusCode}`);

    // ── 2) card projection must not leak private fields ──
    console.log('── card projection whitelist ──');
    const card = await projectAgentCard(agentId);
    const cardJson = JSON.stringify(card);
    assert(!cardJson.includes(ROLE_PROMPT), 'card must not contain rolePrompt value');
    assert(!cardJson.includes(RESTRICTION_NOTE), 'card must not contain restrictions text');
    assert(!cardJson.includes('rolePrompt'), 'card keys must not include rolePrompt');
    assert(!cardJson.includes('restrictions'), 'card keys must not include restrictions');
    assert(!cardJson.includes('memory'), 'card must not mention memory');
    assert(!cardJson.includes('credential'), 'card must not mention credential');
    assert(!cardJson.includes(FAKE_SECRET), 'card must not contain skill secret');

    // ── 3) trace redacts injected secret ──
    console.log('── trace redaction ──');
    const runId = ulid();
    runIds.push(runId);
    const manifest = {
      agentSlug: `t05-a2a-${tag}`,
      agentId,
      agentDir: '/tmp/t05-a2a',
      engineExecute: 'CLAUDE_CODE',
      engineVerify: 'GROK',
      maxRounds: 2,
      rolePrompt: ROLE_PROMPT,
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
      skills: [
        {
          name: `t05-a2a-skill-${tag}`,
          contentMd: `secret ${FAKE_SECRET}`,
          metadata: {
            description: 'x',
            whenToUse: '',
            whenNotToUse: '',
            requiredTools: [],
            conflictsWith: [],
            sideEffects: [],
            riskTier: 'low',
            tokenBudget: 100,
            evalSuiteId: null,
            version: 1,
          },
          relPath: 'skills/x/SKILL.md',
        },
      ],
      steps: [],
      memoryCore: '',
      identityCard: null,
    } as unknown as CompiledManifest;

    const makeOk = (rid: string): RunOutcome =>
      ({
        ok: true,
        runId: rid,
        runDir: `/tmp/${rid}`,
        status: 'SUCCEEDED',
        results: [
          {
            ok: true,
            stepKey: 's1',
            type: 'DO',
            output: `prompt with ${FAKE_SECRET}`,
            rounds: 1,
            approved: true,
            reason: `done ${FAKE_SECRET}`,
            lastVerdict: `ok ${FAKE_SECRET}`,
            records: [{ round: 1, approved: true, verdict: `v ${FAKE_SECRET}` }],
          },
        ],
        reworkHistory: [],
      }) as RunOutcome;

    await ingestRunTrace({
      agent: { id: agentId },
      manifest,
      outcome: makeOk(runId),
    });
    const tr = await prisma.runTrace.findUnique({ where: { runId } });
    assert(tr, 'runTrace created');
    const trJson = JSON.stringify(tr);
    assert(!trJson.includes(FAKE_SECRET), 'RunTrace must redact secret');

    // ── 4) trajectory dedupe: only ONE proposal after threshold + re-call ──
    console.log('── trajectory dedupe single proposal ──');
    for (let i = 1; i < TRACE_MIN; i++) {
      const rid = ulid();
      runIds.push(rid);
      await ingestRunTrace({
        agent: { id: agentId },
        manifest,
        outcome: makeOk(rid),
      });
    }
    const key = (
      await prisma.runTrace.findFirst({
        where: { agentId, trajectoryKey: { not: null } },
      })
    )?.trajectoryKey;
    assert(key, 'trajectoryKey set');

    await maybeDedupe(agentId, key!);
    await maybeDedupe(agentId, key!);

    const props = await prisma.changeProposal.findMany({
      where: { agentId, source: 'TRAJECTORY', status: 'PENDING' },
    });
    assert(props.length === 1, `expect exactly 1 TRAJECTORY proposal, got ${props.length}`);

    // ── 5) MEMBER HTTP 403 on FDE-only A2A routes (no network dispatch) ──
    // Peer baseUrl is 127.0.0.1:9; if requireTrainer failed open, peer card /
    // submit would attempt fetch and hang/error differently. We assert 403
    // immediately with FORBIDDEN body, proving the guard short-circuits.
    console.log('── MEMBER route-level 403 (requireTrainer) ──');
    const authHeader = { authorization: `Bearer ${memberToken}` };
    const fakeTaskId = ulid();

    const cases: Array<{ label: string; method: 'GET' | 'POST'; url: string; payload?: unknown }> =
      [
        {
          label: 'GET agent card',
          method: 'GET',
          url: `/a2a/agents/${agentId}/card`,
        },
        {
          label: 'GET peer card',
          method: 'GET',
          url: `/a2a/peers/${peerLogicalId}/card`,
        },
        {
          label: 'POST task submit',
          method: 'POST',
          url: '/a2a/tasks',
          payload: { peerId: peerLogicalId, agentId, payload: { x: 1 } },
        },
        {
          label: 'GET task status',
          method: 'GET',
          url: `/a2a/tasks/${fakeTaskId}`,
        },
        {
          label: 'POST task cancel',
          method: 'POST',
          url: `/a2a/tasks/${fakeTaskId}/cancel`,
        },
      ];

    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: authHeader,
        payload: c.payload as Record<string, unknown> | undefined,
      });
      console.log(`  MEMBER ${c.label}: ${res.statusCode} ${res.body.slice(0, 120)}`);
      assert(res.statusCode === 403, `${c.label}: expect 403, got ${res.statusCode}`);
      const body = JSON.parse(res.body) as {
        success: boolean;
        error?: { code?: string };
      };
      assert(body.success === false, `${c.label}: success false`);
      assert(
        body.error?.code === 'FORBIDDEN',
        `${c.label}: code FORBIDDEN, got ${body.error?.code}`,
      );
    }

    // FDE can still list peers (boundary preserved for trainers).
    const rListFde = await app.inject({
      method: 'GET',
      url: '/a2a/peers',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    assert(rListFde.statusCode === 200, `FDE list peers expect 200, got ${rListFde.statusCode}`);
    const listBody = JSON.parse(rListFde.body) as { success: boolean; data: unknown[] };
    assert(listBody.success === true, 'FDE list success');
    assert(
      Array.isArray(listBody.data) &&
        listBody.data.some(
          (p) =>
            p &&
            typeof p === 'object' &&
            'peerId' in p &&
            (p as { peerId: string }).peerId === peerLogicalId,
        ),
      'FDE list includes registered peer',
    );

    // MEMBER list also 403
    const rListMember = await app.inject({
      method: 'GET',
      url: '/a2a/peers',
      headers: authHeader,
    });
    assert(
      rListMember.statusCode === 403,
      `MEMBER list peers expect 403, got ${rListMember.statusCode}`,
    );

    console.log('PASS t05-a2a-neg');
  } finally {
    console.log('── cleanup ──');
    await app.close().catch(() => {});
    await prisma.changeProposal.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.runTrace.deleteMany({ where: { agentId } }).catch(() => {});
    if (peerRowId) {
      await prisma.a2ATask.deleteMany({ where: { peerId: peerRowId } }).catch(() => {});
      await prisma.a2APeer.deleteMany({ where: { id: peerRowId } }).catch(() => {});
    }
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    if (createdMemberId) {
      await prisma.user.deleteMany({ where: { id: createdMemberId } }).catch(() => {});
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL t05-a2a-neg', e);
    process.exit(1);
  });
