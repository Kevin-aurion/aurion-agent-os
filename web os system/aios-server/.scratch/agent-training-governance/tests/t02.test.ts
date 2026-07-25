/**
 * Ticket 02 — FDE single change-proposal queue.
 * Run: npx tsx .scratch/agent-training-governance/tests/t02.test.ts
 *
 * Seams: lib/changeproposal public API + REST /api/proposals* + requireTrainer gate.
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { requireTrainer } from '../../../src/lib/guard.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  createProposal,
  listPendingProposals,
  approveProposal,
  rejectProposal,
} from '../../../src/lib/changeproposal.js';
import { getActiveContent, promoteToStable, rollbackStable } from '../../../src/lib/skillversion.js';
import { proposalRoutes } from '../../../src/routes/proposals.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<Error> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ASSERT FAIL: expected throw')) throw e;
    return e as Error;
  }
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER user');

  // MEMBER for operator tests — create temp if none
  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMemberId: string | null = null;
  if (!member) {
    createdMemberId = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMemberId,
        email: `t02-member-${createdMemberId.slice(-6).toLowerCase()}@test.local`,
        displayName: 'T02 Member',
        passwordHash: 'x', // not used for JWT tests
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const skillId = ulid();
  const proposalIds: string[] = [];

  console.log('── setup: agent + skill ──');
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `t02-agent-${tag}`,
      name: 'T02 Proposal Agent',
      description: 'temp t02',
      rolePrompt: 'test',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
      identityCard: {
        oneLiner: 'old line',
        purpose: 'old purpose',
        canDo: ['answer'],
        cannotDo: [],
        servedAudience: 'ops',
        exampleCommands: ['hi'],
      },
    },
  });
  await prisma.skill.create({
    data: {
      id: skillId,
      slug: `t02-skill-${tag}`,
      name: 'T02 Skill',
      origin: 'UPLOADED',
      kind: 'PROMPT_MANUAL',
      contentMd: '# v1 original content\n',
      reviewStatus: 'CONFIRMED',
      confirmedBy: owner.id,
      confirmedAt: new Date(),
      executionEnv: 'CLI',
    },
  });

  const app = Fastify({ logger: false });
  // Minimal guard-error handler so inject returns status codes
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    // Fastify may wrap thrown ApiError from preHandler
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400) {
      return reply.code(anyErr.statusCode).send({
        success: false,
        error: { code: anyErr.code ?? 'ERROR', message: anyErr.message ?? 'error' },
      });
    }
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(proposalRoutes);

  try {
    // ── [1] createProposal (lib) ─────────────────────────────────────────
    console.log('\n── [1] createProposal stores PENDING OPERATOR proposal ──');
    const p1 = await createProposal({
      agentId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: skillId,
      proposedChange: { contentMd: '# v2 improved content\n' },
      severity: 'medium',
    });
    proposalIds.push(p1.id);
    assert(p1.status === 'PENDING', `status PENDING, got ${p1.status}`);
    assert(p1.source === 'OPERATOR', 'source OPERATOR');
    assert(p1.targetType === 'SKILL', 'target SKILL');
    assert(p1.agentId === agentId, 'agentId');
    assert(p1.proposedBy === member.id, 'proposedBy');
    const row1 = await prisma.changeProposal.findUnique({ where: { id: p1.id } });
    assert(!!row1, 'row exists in DB');
    console.log('PASS [1] createProposal');

    // ── [2] listPendingProposals includes agent name ─────────────────────
    console.log('\n── [2] listPendingProposals includes agent info ──');
    const pending = await listPendingProposals();
    const found = pending.find((p) => p.id === p1.id);
    assert(!!found, 'proposal in pending list');
    assert(
      found && 'agent' in found && (found as { agent?: { name?: string } }).agent?.name === 'T02 Proposal Agent',
      'should include agent name',
    );
    console.log('PASS [2] listPending with agent name');

    // ── [3] MEMBER create via REST ───────────────────────────────────────
    console.log('\n── [3] MEMBER POST /api/agents/:id/proposals ──');
    const memberToken = await signAccess({ sub: member.id, email: member.email, role: 'MEMBER' });
    const rCreate = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/proposals`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {
        targetType: 'RESTRICTION',
        proposedChange: { sendEmail: true },
        severity: 'low',
      },
    });
    console.log('create status:', rCreate.statusCode, rCreate.body.slice(0, 200));
    assert(rCreate.statusCode === 200, `expected 200, got ${rCreate.statusCode}`);
    const createBody = JSON.parse(rCreate.body);
    assert(createBody.success === true, 'success');
    assert(createBody.data?.source === 'OPERATOR', 'source OPERATOR');
    assert(createBody.data?.status === 'PENDING', 'PENDING');
    assert(createBody.data?.proposedBy === member.id, 'proposedBy = member');
    proposalIds.push(createBody.data.id);
    console.log('PASS [3] MEMBER can create proposal via REST');

    // ── [4] MEMBER approve → forbidden (requireTrainer) ──────────────────
    console.log('\n── [4] negative: MEMBER cannot approve (requireTrainer) ──');
    // Direct guard evidence
    const fakeReq = {
      headers: { authorization: `Bearer ${memberToken}` },
      user: undefined as { sub: string; email: string; role: string } | undefined,
    };
    const guardErr = await expectThrow(
      () => requireTrainer(fakeReq as any),
      'requireTrainer for MEMBER',
    );
    assert(guardErr instanceof ApiError, 'should be ApiError');
    assert((guardErr as ApiError).statusCode === 403, `expected 403, got ${(guardErr as ApiError).statusCode}`);
    console.log('requireTrainer MEMBER →', (guardErr as ApiError).message);

    // REST also rejects
    const rApproveMember = await app.inject({
      method: 'POST',
      url: `/api/proposals/${p1.id}/approve`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    console.log('MEMBER approve status:', rApproveMember.statusCode, rApproveMember.body.slice(0, 200));
    assert(rApproveMember.statusCode === 403, `expected 403, got ${rApproveMember.statusCode}`);
    const stillPending = await prisma.changeProposal.findUnique({ where: { id: p1.id } });
    assert(stillPending?.status === 'PENDING', 'proposal must remain PENDING');
    console.log('PASS [4] MEMBER approve rejected');

    // ── [5] FDE approve SKILL → new SkillVersion (rollbackable) ──────────
    console.log('\n── [5] FDE approve SKILL proposal → SkillVersion ──');
    const beforeVersions = await prisma.skillVersion.count({ where: { skillId } });
    const approved = await approveProposal(p1.id, owner.id);
    assert(approved.proposal.status === 'APPROVED', 'APPROVED');
    assert(!!approved.resultingVersionId, 'resultingVersionId set');
    assert(approved.proposal.resultingVersionId === approved.resultingVersionId, 'stored on proposal');
    const afterVersions = await prisma.skillVersion.count({ where: { skillId } });
    assert(afterVersions === beforeVersions + 1 || afterVersions > beforeVersions, 'new version created');
    const canaryContent = await getActiveContent(skillId, 'canary');
    assert(canaryContent === '# v2 improved content\n', `canary content mismatch: ${canaryContent}`);
    // Promote then rollback to prove version lineage is real
    await promoteToStable(skillId, approved.resultingVersionId!);
    // Create another version so we can roll back
    const pSkill2 = await createProposal({
      agentId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: skillId,
      proposedChange: { contentMd: '# v3 later\n' },
    });
    proposalIds.push(pSkill2.id);
    const a2 = await approveProposal(pSkill2.id, owner.id);
    await promoteToStable(skillId, a2.resultingVersionId!);
    await rollbackStable(skillId, approved.resultingVersionId!);
    const afterRollback = await getActiveContent(skillId, 'stable');
    assert(afterRollback === '# v2 improved content\n', `rollback should restore v2, got ${afterRollback}`);
    console.log('PASS [5] SKILL approve + rollbackable SkillVersion');

    // ── [6] FDE approve RESTRICTION → Agent.restrictions updated ──────────
    console.log('\n── [6] FDE approve RESTRICTION proposal ──');
    const beforeRest = await prisma.agent.findUnique({ where: { id: agentId } });
    const beforeShell = (beforeRest?.restrictions as Record<string, unknown>)?.shell;
    assert(beforeShell === false, 'shell was false');

    const pRest = await createProposal({
      agentId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'RESTRICTION',
      proposedChange: { shell: true, notes: 'allow for debug' },
    });
    proposalIds.push(pRest.id);
    await approveProposal(pRest.id, owner.id);
    const afterRest = await prisma.agent.findUnique({ where: { id: agentId } });
    const rest = afterRest?.restrictions as Record<string, unknown>;
    assert(rest?.shell === true, `shell should be true, got ${rest?.shell}`);
    assert(rest?.sendEmail === false, 'sendEmail unchanged false');
    assert(rest?.notes === 'allow for debug', 'notes merged');
    console.log('PASS [6] RESTRICTION merge applied');

    // ── [7] FDE reject → target unchanged ────────────────────────────────
    console.log('\n── [7] FDE reject leaves target untouched ──');
    const beforeRejectAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    const snapRestrictions = JSON.stringify(beforeRejectAgent?.restrictions);
    const snapIdentity = JSON.stringify(beforeRejectAgent?.identityCard);

    const pReject = await createProposal({
      agentId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'RESTRICTION',
      proposedChange: { webSearch: true, shell: false },
    });
    proposalIds.push(pReject.id);
    const rejected = await rejectProposal(pReject.id, owner.id);
    assert(rejected.status === 'REJECTED', 'REJECTED');
    assert(rejected.decidedBy === owner.id, 'decidedBy');
    assert(!!rejected.decidedAt, 'decidedAt');

    const afterRejectAgent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(JSON.stringify(afterRejectAgent?.restrictions) === snapRestrictions, 'restrictions unchanged');
    assert(JSON.stringify(afterRejectAgent?.identityCard) === snapIdentity, 'identityCard unchanged');
    console.log('PASS [7] reject is no-op on target');

    // ── [8] double decide → throw ────────────────────────────────────────
    console.log('\n── [8] negative: re-approve / re-reject throws ──');
    const e1 = await expectThrow(() => approveProposal(p1.id, owner.id), 're-approve');
    console.log('re-approve error:', e1.message);
    assert(
      e1 instanceof ApiError || /PENDING|already|decided|決議/i.test(e1.message),
      `should refuse double decide: ${e1.message}`,
    );
    const e2 = await expectThrow(() => rejectProposal(pReject.id, owner.id), 're-reject');
    console.log('re-reject error:', e2.message);
    assert(
      e2 instanceof ApiError || /PENDING|already|decided|決議/i.test(e2.message),
      `should refuse double reject: ${e2.message}`,
    );
    console.log('PASS [8] double decide rejected');

    // ── [9] IDENTITY_CARD approve path ───────────────────────────────────
    console.log('\n── [9] approve IDENTITY_CARD updates agent ──');
    const pId = await createProposal({
      agentId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'IDENTITY_CARD',
      proposedChange: {
        oneLiner: 'new line',
        purpose: 'new purpose',
        canDo: ['help', 'triage'],
        cannotDo: ['refund'],
        servedAudience: 'ops',
        exampleCommands: ['status'],
      },
    });
    proposalIds.push(pId.id);
    await approveProposal(pId.id, owner.id);
    const afterId = await prisma.agent.findUnique({ where: { id: agentId } });
    const card = afterId?.identityCard as Record<string, unknown>;
    assert(card?.oneLiner === 'new line', `oneLiner, got ${card?.oneLiner}`);
    assert(Array.isArray(card?.canDo) && (card.canDo as string[]).includes('triage'), 'canDo');
    console.log('PASS [9] IDENTITY_CARD approve');

    // ── [10] FDE REST list / approve / reject ────────────────────────────
    console.log('\n── [10] FDE REST list + reject ──');
    const fdeToken = await signAccess({ sub: owner.id, email: owner.email, role: owner.role });
    const pRest2 = await createProposal({
      agentId,
      source: 'VIOLATION',
      proposedBy: 'system',
      targetType: 'RESTRICTION',
      proposedChange: { computerUse: true },
      severity: 'high',
    });
    proposalIds.push(pRest2.id);

    const rList = await app.inject({
      method: 'GET',
      url: '/api/proposals',
      headers: { authorization: `Bearer ${fdeToken}` },
    });
    assert(rList.statusCode === 200, `list expected 200, got ${rList.statusCode}`);
    const listBody = JSON.parse(rList.body);
    assert(listBody.success === true, 'list success');
    assert(Array.isArray(listBody.data), 'data array');
    assert(listBody.data.some((p: { id: string }) => p.id === pRest2.id), 'pending includes pRest2');

    const rRej = await app.inject({
      method: 'POST',
      url: `/api/proposals/${pRest2.id}/reject`,
      headers: { authorization: `Bearer ${fdeToken}` },
    });
    assert(rRej.statusCode === 200, `reject expected 200, got ${rRej.statusCode}`);
    const rejBody = JSON.parse(rRej.body);
    assert(rejBody.data?.status === 'REJECTED', 'REJECTED via REST');
    console.log('PASS [10] FDE REST list + reject');

    // ── [11] audit rows written on decide ────────────────────────────────
    console.log('\n── [11] audit written on approve/reject ──');
    const audits = await prisma.auditLog.findMany({
      where: {
        entity: 'ChangeProposal',
        entityId: { in: proposalIds },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const actions = new Set(audits.map((a) => a.action));
    console.log('audit actions:', [...actions]);
    assert(
      [...actions].some((a) => /approv/i.test(a)),
      'expect approve audit action',
    );
    assert(
      [...actions].some((a) => /reject/i.test(a)),
      'expect reject audit action',
    );
    console.log('PASS [11] audit trail');

    console.log('\n══ ALL t02 TESTS PASSED ══');
  } finally {
    console.log('\n── cleanup ──');
    try {
      await prisma.changeProposal.deleteMany({ where: { id: { in: proposalIds } } });
      // also any leftover for this agent
      await prisma.changeProposal.deleteMany({ where: { agentId } });
    } catch {
      /* model may not exist on red run */
    }
    await prisma.skillVersion.deleteMany({ where: { skillId } });
    await prisma.skill.deleteMany({ where: { id: skillId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    if (createdMemberId) {
      await prisma.user.deleteMany({ where: { id: createdMemberId } });
    }
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('\nTEST FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
