/**
 * Workbench audit — confirm_skill proposal + CODEX confirm gate.
 * Run: npx tsx .scratch/agent-workbench/tests/confirm-skill-proposal.test.ts
 *
 * - action=confirm_skill: validates linked AWAITING skill, confirms on FDE approve
 * - does not trust client contentMd
 * - atomic: no APPROVED without CONFIRMED (and reverse under failure)
 * - RECORDED / COMPUTER_CONTROL on non-CODEX agent: confirm + proposal fail
 * - contentMd path still creates SkillVersion
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  createProposal,
  approveProposal,
} from '../../../src/lib/changeproposal.js';
import { confirmAwaitingSkill } from '../../../src/lib/skillgate.js';
import { proposalRoutes } from '../../../src/routes/proposals.js';
import { skillRoutes } from '../../../src/routes/skills.js';

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
  console.log('── confirm_skill proposal + CODEX gate ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need FDE user');

  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMember: string | null = null;
  if (!member) {
    createdMember = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMember,
        email: `wb-cs-${createdMember.slice(-6)}@test.local`,
        displayName: 'WB CS Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentClaudeId = ulid();
  const agentCodexId = ulid();
  const skillAwaitId = ulid();
  const skillRecId = ulid();
  const skillContentId = ulid();
  const skillIds = [skillAwaitId, skillRecId, skillContentId];
  const agentIds = [agentClaudeId, agentCodexId];
  const proposalIds: string[] = [];

  try {
    await prisma.agent.create({
      data: {
        id: agentClaudeId,
        slug: `wb-cs-claude-${tag}`,
        name: 'WB CS Claude',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
      },
    });
    await prisma.agent.create({
      data: {
        id: agentCodexId,
        slug: `wb-cs-codex-${tag}`,
        name: 'WB CS Codex',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CODEX',
        createdBy: owner.id,
      },
    });

    // AWAITING draft linked to CODEX agent
    await prisma.skill.create({
      data: {
        id: skillAwaitId,
        slug: `wb-cs-await-${tag}`,
        name: 'Awaiting Draft',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# real server content\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
    await prisma.agentSkill.create({
      data: { agentId: agentCodexId, skillId: skillAwaitId },
    });

    // RECORDED draft pre-linked to non-CODEX agent
    await prisma.skill.create({
      data: {
        id: skillRecId,
        slug: `wb-cs-rec-${tag}`,
        name: 'Recorded Draft',
        origin: 'RECORDED',
        kind: 'COMPUTER_CONTROL',
        contentMd: '# recorded\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'DESKTOP_APP',
      },
    });
    await prisma.agentSkill.create({
      data: { agentId: agentClaudeId, skillId: skillRecId },
    });

    // CONFIRMED skill for contentMd path
    await prisma.skill.create({
      data: {
        id: skillContentId,
        slug: `wb-cs-content-${tag}`,
        name: 'Content Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# v1\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: owner.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    // ── [1] confirm_skill proposal → FDE approve confirms skill ──────────
    console.log('\n── [1] confirm_skill approve confirms linked AWAITING skill ──');
    const p1 = await createProposal({
      agentId: agentCodexId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: skillAwaitId,
      proposedChange: {
        action: 'confirm_skill',
        skillId: skillAwaitId,
        name: 'spoofed name',
        contentMd: '# malicious client content should be ignored\n',
        note: 'please confirm',
      },
    });
    proposalIds.push(p1.id);

    const approved = await approveProposal(p1.id, owner.id);
    assert(approved.proposal.status === 'APPROVED', 'proposal APPROVED');
    const skillAfter = await prisma.skill.findUnique({ where: { id: skillAwaitId } });
    assert(skillAfter?.reviewStatus === 'CONFIRMED', `skill CONFIRMED, got ${skillAfter?.reviewStatus}`);
    assert(skillAfter?.confirmedBy === owner.id, 'confirmedBy FDE');
    assert(
      skillAfter?.contentMd === '# real server content\n',
      'must not trust client contentMd',
    );
    console.log('PASS [1] confirm_skill + ignore client content');

    // ── [2] Unlinked skill proposal fails ────────────────────────────────
    console.log('\n── [2] confirm_skill without agent link fails ──');
    const orphanSkillId = ulid();
    skillIds.push(orphanSkillId);
    await prisma.skill.create({
      data: {
        id: orphanSkillId,
        slug: `wb-cs-orphan-${tag}`,
        name: 'Orphan',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# orphan\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
    const pOrphan = await createProposal({
      agentId: agentCodexId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: orphanSkillId,
      proposedChange: { action: 'confirm_skill' },
    });
    proposalIds.push(pOrphan.id);
    const errOrphan = await expectThrow(
      () => approveProposal(pOrphan.id, owner.id),
      'orphan skill',
    );
    assert(errOrphan instanceof ApiError, 'ApiError');
    const stillPending = await prisma.changeProposal.findUnique({ where: { id: pOrphan.id } });
    assert(stillPending?.status === 'PENDING', 'proposal stays PENDING on failure');
    const orphanSkill = await prisma.skill.findUnique({ where: { id: orphanSkillId } });
    assert(orphanSkill?.reviewStatus === 'AWAITING_USER_CONFIRM', 'skill not confirmed');
    console.log('PASS [2] unlinked fails; no APPROVED without mutation');

    // ── [3] CODEX gate: direct confirm RECORDED on non-CODEX ──────────────
    console.log('\n── [3] direct confirm RECORDED on CLAUDE_CODE fails ──');
    const errCodex = await expectThrow(
      () => confirmAwaitingSkill(skillRecId, owner.id),
      'codex gate direct',
    );
    assert(errCodex instanceof ApiError, 'ApiError');
    assert((errCodex as ApiError).statusCode === 400, '400');
    assert(
      (errCodex as ApiError).message.includes('CODEX'),
      `message mentions CODEX: ${(errCodex as ApiError).message}`,
    );
    const recStill = await prisma.skill.findUnique({ where: { id: skillRecId } });
    assert(recStill?.reviewStatus === 'AWAITING_USER_CONFIRM', 'not confirmed');
    console.log('PASS [3] direct confirm CODEX gate');

    // ── [4] CODEX gate: confirm_skill proposal on non-CODEX agent ─────────
    console.log('\n── [4] confirm_skill proposal on non-CODEX linked agent fails ──');
    const pRec = await createProposal({
      agentId: agentClaudeId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: skillRecId,
      proposedChange: { action: 'confirm_skill' },
    });
    proposalIds.push(pRec.id);
    const errPRec = await expectThrow(() => approveProposal(pRec.id, owner.id), 'rec proposal');
    assert(errPRec instanceof ApiError, 'ApiError');
    assert((errPRec as ApiError).message.includes('CODEX'), 'mentions CODEX');
    const pRecRow = await prisma.changeProposal.findUnique({ where: { id: pRec.id } });
    assert(pRecRow?.status === 'PENDING', 'proposal not APPROVED');
    assert(
      (await prisma.skill.findUnique({ where: { id: skillRecId } }))?.reviewStatus ===
        'AWAITING_USER_CONFIRM',
      'skill not confirmed',
    );
    console.log('PASS [4] proposal CODEX gate');

    // ── [5] contentMd path preserved ─────────────────────────────────────
    console.log('\n── [5] contentMd SKILL proposal still creates SkillVersion ──');
    const pContent = await createProposal({
      agentId: agentClaudeId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: skillContentId,
      proposedChange: { contentMd: '# v2 from content path\n' },
    });
    proposalIds.push(pContent.id);
    const aContent = await approveProposal(pContent.id, owner.id);
    assert(aContent.proposal.status === 'APPROVED', 'APPROVED');
    assert(!!aContent.resultingVersionId, 'version id');
    const ver = await prisma.skillVersion.findUnique({
      where: { id: aContent.resultingVersionId! },
    });
    assert(ver?.contentMd === '# v2 from content path\n', 'version content');
    console.log('PASS [5] contentMd path');

    // ── [6] REST: MEMBER cannot approve ──────────────────────────────────
    console.log('\n── [6] REST MEMBER cannot approve confirm_skill ──');
    const skill2 = ulid();
    skillIds.push(skill2);
    await prisma.skill.create({
      data: {
        id: skill2,
        slug: `wb-cs-rest-${tag}`,
        name: 'REST Draft',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# rest\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
    await prisma.agentSkill.create({ data: { agentId: agentCodexId, skillId: skill2 } });
    const pRest = await createProposal({
      agentId: agentCodexId,
      source: 'OPERATOR',
      proposedBy: member.id,
      targetType: 'SKILL',
      targetId: skill2,
      proposedChange: { action: 'confirm_skill' },
    });
    proposalIds.push(pRest.id);

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
      return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
    });
    await app.register(proposalRoutes);
    await app.register(skillRoutes);

    const memberToken = await signAccess({
      sub: member.id,
      email: member.email,
      role: 'MEMBER',
    });
    const rMember = await app.inject({
      method: 'POST',
      url: `/api/proposals/${pRest.id}/approve`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(rMember.statusCode === 403, `expected 403, got ${rMember.statusCode}`);

    // FDE confirm via REST skill confirm for CODEX-linked RECORDED after re-link
    // First fail: RECORDED still on claude
    const trainerToken = await signAccess({
      sub: owner.id,
      email: owner.email,
      role: owner.role,
    });
    const rConfirmRec = await app.inject({
      method: 'POST',
      url: `/api/skills/${skillRecId}/confirm`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    console.log('confirm RECORDED on claude agent:', rConfirmRec.statusCode, rConfirmRec.body.slice(0, 200));
    assert(rConfirmRec.statusCode === 400, `expected 400, got ${rConfirmRec.statusCode}`);
    await app.close();
    console.log('PASS [6]');

    console.log('\n✅ confirm-skill-proposal: all passed');
  } finally {
    await prisma.changeProposal.deleteMany({ where: { id: { in: proposalIds } } }).catch(() => {});
    await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => {});
    await prisma.skillVersion.deleteMany({ where: { skillId: { in: skillIds } } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { id: { in: skillIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
    if (createdMember) await prisma.user.deleteMany({ where: { id: createdMember } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
