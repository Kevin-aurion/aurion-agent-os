/**
 * Slice 6 — Positive invariant regression (cross-model / redactor / MEMBER-FDE).
 * Run: npx tsx .scratch/skill-production-platform/tests/t06-invariants.ts
 *
 * 1. compileManifest autoVerify mapping CLAUDE_CODE→CODEX, CODEX/GROK→CLAUDE_CODE
 * 2. engineVerify override when ≠ execute
 * 3. engineVerify === execute ignored → autoVerify
 * 4. isApproved fail-closed oracle
 * 5. redactSecrets landings
 * 6. MEMBER/FDE separation: promote 403/409; proposal stays PENDING; stable null
 */
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import { compileManifest } from '../../../src/engine/runner.js';
import { isApproved } from '../../../src/engine/codex.js';
import { redactSecrets } from '../../../src/memory/redactor.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { promoteWithGate } from '../../../src/lib/skillpromote.js';
import { createProposal } from '../../../src/lib/changeproposal.js';

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
  const fde = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(fde, 'need OWNER/TRAINER user in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const tmpDir = path.join(os.tmpdir(), `aios-t06-inv-${tag}`);

  const agentIds: string[] = [];
  const skillIds: string[] = [];
  const proposalIds: string[] = [];
  let memberId: string | undefined;

  try {
    // Temporary MEMBER for proposedBy (cleaned up in finally)
    memberId = ulid();
    await prisma.user.create({
      data: {
        id: memberId,
        email: `t06-member-${tag}@example.local`,
        displayName: `T06 Member ${tag}`,
        passwordHash: 'not-a-real-hash-t06',
        role: 'MEMBER',
      },
    });

    // ── 1) compileManifest cross-model auto mapping ──
    console.log('── compileManifest autoVerify mapping ──');
    const engines = [
      { execute: 'CLAUDE_CODE' as const, expectVerify: 'CODEX' as const },
      { execute: 'CODEX' as const, expectVerify: 'CLAUDE_CODE' as const },
      { execute: 'GROK' as const, expectVerify: 'CLAUDE_CODE' as const },
    ];
    for (const { execute, expectVerify } of engines) {
      const id = ulid();
      agentIds.push(id);
      await prisma.agent.create({
        data: {
          id,
          slug: `t06-inv-${execute.toLowerCase()}-${tag}`,
          name: `T06 Inv ${execute}`,
          description: 't06 invariant temp agent',
          rolePrompt: 'test',
          engineExecute: execute,
          engineVerify: null,
          createdBy: fde.id,
        },
      });
      const compiled = await compileManifest(id, undefined, tmpDir, 'ping');
      assert(
        compiled.engineExecute === execute,
        `engineExecute must be ${execute}, got ${compiled.engineExecute}`,
      );
      assert(
        compiled.engineVerify === expectVerify,
        `${execute} autoVerify → ${expectVerify}, got ${compiled.engineVerify}`,
      );
      assert(
        compiled.engineVerify !== compiled.engineExecute,
        `engineVerify must !== engineExecute for ${execute}`,
      );
    }

    // ── 2) engineVerify override when ≠ execute ──
    console.log('── engineVerify override GROK ──');
    const overrideId = ulid();
    agentIds.push(overrideId);
    await prisma.agent.create({
      data: {
        id: overrideId,
        slug: `t06-inv-override-${tag}`,
        name: 'T06 Inv Override',
        description: 't06 override',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        createdBy: fde.id,
      },
    });
    const overrideCompiled = await compileManifest(overrideId, undefined, tmpDir, 'ping');
    assert(
      overrideCompiled.engineVerify === 'GROK',
      `override engineVerify must be GROK, got ${overrideCompiled.engineVerify}`,
    );
    assert(
      overrideCompiled.engineVerify !== overrideCompiled.engineExecute,
      'override must still be cross-model',
    );

    // ── 3) engineVerify === execute ignored → auto CODEX ──
    console.log('── engineVerify === execute ignored ──');
    const sameId = ulid();
    agentIds.push(sameId);
    await prisma.agent.create({
      data: {
        id: sameId,
        slug: `t06-inv-same-${tag}`,
        name: 'T06 Inv Same',
        description: 't06 same-engine override ignored',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'CLAUDE_CODE',
        createdBy: fde.id,
      },
    });
    const sameCompiled = await compileManifest(sameId, undefined, tmpDir, 'ping');
    assert(
      sameCompiled.engineVerify === 'CODEX',
      `same-engine override must fall back to CODEX, got ${sameCompiled.engineVerify}`,
    );
    assert(sameCompiled.engineVerify !== sameCompiled.engineExecute, 'never equal execute');

    // ── 4) isApproved fail-closed ──
    console.log('── isApproved oracle ──');
    assert(isApproved('## Verdict\nAPPROVED') === true, 'Verdict APPROVED → true');
    assert(
      isApproved('ISSUES FOUND: x\n## Verdict\nAPPROVED') === false,
      'REJECTED_RE before APPROVED → false',
    );
    assert(isApproved('bla\nAPPROVED') === true, 'bare last APPROVED → true');
    assert(
      isApproved('the plan is APPROVED by all') === false,
      'mid-sentence APPROVED → false',
    );

    // ── 5) redactSecrets ──
    console.log('── redactSecrets ──');
    const raw = 'sk-ABCDEFGH1234567890 mail a@b.com';
    const redacted = redactSecrets(raw);
    assert(!redacted.includes('sk-ABCDEFGH1234567890'), 'raw API key must be gone');
    assert(!redacted.includes('a@b.com'), 'raw email must be gone');
    assert(redacted.includes('[REDACTED_API_KEY]'), 'must contain REDACTED_API_KEY');
    assert(redacted.includes('[REDACTED_EMAIL]'), 'must contain REDACTED_EMAIL');

    // ── 6) MEMBER / FDE separation ──
    console.log('── MEMBER/FDE promote + proposal ──');
    const skillId = ulid();
    skillIds.push(skillId);
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t06-inv-skill-${tag}`,
        name: 'T06 Inv Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# T06 inv skill\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: fde.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    const ver = await createSkillVersion(skillId, '# T06 inv skill\n\nbody\n', fde.id);

    const eMember = await expectThrow(
      () =>
        promoteWithGate({
          skillId,
          versionId: ver.id,
          actorId: memberId!,
          actorRole: 'MEMBER',
        }),
      'MEMBER promote',
    );
    assert(eMember instanceof ApiError, 'MEMBER promote → ApiError');
    assert((eMember as ApiError).statusCode === 403, `MEMBER → 403, got ${(eMember as ApiError).statusCode}`);

    for (const role of ['OWNER', 'TRAINER'] as const) {
      const eFde = await expectThrow(
        () =>
          promoteWithGate({
            skillId,
            versionId: ver.id,
            actorId: fde.id,
            actorRole: role,
          }),
        `FDE ${role} promote without PASSED run`,
      );
      assert(eFde instanceof ApiError, `${role} without eval → ApiError`);
      assert(
        (eFde as ApiError).statusCode === 409,
        `${role} without PASSED → 409, got ${(eFde as ApiError).statusCode}`,
      );
    }

    const proposalAgentId = agentIds[0]!;
    const proposal = await createProposal({
      agentId: proposalAgentId,
      source: 'OPERATOR',
      proposedBy: memberId!,
      targetType: 'SKILL',
      targetId: skillId,
      proposedChange: { note: 't06 member proposal — must stay PENDING' },
    });
    proposalIds.push(proposal.id);
    assert(proposal.status === 'PENDING', `proposal must be PENDING, got ${proposal.status}`);

    const skillAfter = await prisma.skill.findUnique({ where: { id: skillId } });
    assert(skillAfter?.stableVersionId == null, 'stableVersionId must remain null (proposal does not materialize)');

    console.log('ALL PASS t06-invariants');
  } finally {
    try {
      if (proposalIds.length) {
        await prisma.changeProposal.deleteMany({ where: { id: { in: proposalIds } } });
      }
    } catch (e) {
      console.warn('cleanup changeProposal', e);
    }
    try {
      for (const sid of skillIds) {
        await prisma.skillVersion.deleteMany({ where: { skillId: sid } });
        await prisma.skill.deleteMany({ where: { id: sid } });
      }
    } catch (e) {
      console.warn('cleanup skill*', e);
    }
    try {
      if (agentIds.length) {
        await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } });
        await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
      }
    } catch (e) {
      console.warn('cleanup agent*', e);
    }
    try {
      if (memberId) {
        await prisma.user.deleteMany({ where: { id: memberId } });
      }
    } catch (e) {
      console.warn('cleanup member user', e);
    }
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  return prisma.$disconnect().catch(() => undefined);
});
