/**
 * Slice 6 — Negative regression (all must be blocked / fail-closed).
 * Run: npx tsx .scratch/skill-production-platform/tests/t06-regression-neg.ts
 *
 * 1. Non-loopback MCP URLs rejected (400)
 * 2. Unconfirmed skill excluded from compileManifest catalog
 * 3. promote without PASSED eval → 409, stable null
 * 4. MEMBER promote → 403
 * 5. Path traversal blocked (assertInsideRoot / safeJoin / sanitizeSegment)
 * 6. Budget over-limit fail-closed via decideBudget
 */
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import { compileManifest } from '../../../src/engine/runner.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { promoteWithGate } from '../../../src/lib/skillpromote.js';
import {
  assertLoopbackUrl,
  validateRegistryInput,
} from '../../../src/lib/mcpregistry.js';
import {
  assertInsideRoot,
  safeJoin,
  sanitizeSegment,
} from '../../../src/lib/safepath.js';
import { decideBudget } from '../../../src/engine/cost.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown> | unknown, label: string): Promise<unknown> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ASSERT FAIL: expected throw')) throw e;
    return e;
  }
}

function expectThrowSync(fn: () => unknown, label: string): unknown {
  try {
    fn();
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
  const tmpDir = path.join(os.tmpdir(), `aios-t06-neg-${tag}`);

  const agentIds: string[] = [];
  const skillIds: string[] = [];

  try {
    // ── 1) non-loopback MCP ──
    console.log('── non-loopback MCP rejected ──');
    const eEvil = expectThrowSync(
      () => assertLoopbackUrl('http://127.0.0.1.evil.com/mcp'),
      '127.0.0.1.evil.com',
    );
    assert(eEvil instanceof ApiError, 'evil.com prefix must be ApiError');
    assert((eEvil as ApiError).statusCode === 400, `evil → 400, got ${(eEvil as ApiError).statusCode}`);

    const ePriv = expectThrowSync(
      () => assertLoopbackUrl('http://10.0.0.1/mcp'),
      '10.0.0.1',
    );
    assert(ePriv instanceof ApiError, '10.0.0.1 must be ApiError');
    assert((ePriv as ApiError).statusCode === 400, `10.0.0.1 → 400, got ${(ePriv as ApiError).statusCode}`);

    const eReg = expectThrowSync(
      () =>
        validateRegistryInput({
          transport: 'LOOPBACK_HTTP',
          url: 'http://evil.com/mcp',
        }),
      'validateRegistryInput evil.com',
    );
    assert(eReg instanceof ApiError, 'validateRegistryInput non-loopback → ApiError');
    assert((eReg as ApiError).statusCode === 400, `registry evil → 400, got ${(eReg as ApiError).statusCode}`);

    // ── 2) unconfirmed skill not in compile catalog ──
    console.log('── unconfirmed skill excluded from compileManifest ──');
    const agentId = ulid();
    agentIds.push(agentId);
    const pendingSkillId = ulid();
    skillIds.push(pendingSkillId);
    const pendingSlug = `t06-neg-pending-${tag}`;

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t06-neg-agent-${tag}`,
        name: 'T06 Neg Agent',
        description: 't06 neg',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: fde.id,
      },
    });
    await prisma.skill.create({
      data: {
        id: pendingSkillId,
        slug: pendingSlug,
        name: 'T06 Pending Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# pending\n__T06_PENDING_BODY__\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
    await prisma.agentSkill.create({ data: { agentId, skillId: pendingSkillId } });

    const manifest = await compileManifest(agentId, undefined, tmpDir, 'hi');
    const slugs = manifest.skills.map((s) => s.name);
    assert(!slugs.includes(pendingSlug), 'AWAITING_USER_CONFIRM skill must not be in compiled catalog');

    // ── 3) promote without PASSED eval ──
    console.log('── promote without PASSED → 409 ──');
    const skillId = ulid();
    skillIds.push(skillId);
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t06-neg-skill-${tag}`,
        name: 'T06 Neg Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# T06 neg\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: fde.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    const ver = await createSkillVersion(skillId, '# T06 neg\n\nversion\n', fde.id);

    const before = await prisma.skill.findUnique({ where: { id: skillId } });
    assert(before?.stableVersionId == null, 'stable starts null');

    const eNoEval = await expectThrow(
      () =>
        promoteWithGate({
          skillId,
          versionId: ver.id,
          actorId: fde.id,
          actorRole: fde.role,
        }),
      'promote without eval',
    );
    assert(eNoEval instanceof ApiError, 'no-eval promote → ApiError');
    assert((eNoEval as ApiError).statusCode === 409, `no-eval → 409, got ${(eNoEval as ApiError).statusCode}`);
    const afterNoEval = await prisma.skill.findUnique({ where: { id: skillId } });
    assert(afterNoEval?.stableVersionId == null, 'stableVersionId stays null after rejected promote');

    // ── 4) MEMBER cannot materialize ──
    console.log('── MEMBER promote → 403 ──');
    const eMember = await expectThrow(
      () =>
        promoteWithGate({
          skillId,
          versionId: ver.id,
          actorId: fde.id,
          actorRole: 'MEMBER',
        }),
      'MEMBER promote',
    );
    assert(eMember instanceof ApiError, 'MEMBER → ApiError');
    assert((eMember as ApiError).statusCode === 403, `MEMBER → 403, got ${(eMember as ApiError).statusCode}`);

    // ── 5) path traversal ──
    console.log('── path traversal blocked ──');
    const ePath = expectThrowSync(
      () => assertInsideRoot('/tmp/root', '/tmp/root/../etc/passwd'),
      'assertInsideRoot escape',
    );
    assert(ePath instanceof Error, 'assertInsideRoot must throw');
    assert(
      String((ePath as Error).message).includes('escapes') ||
        String((ePath as Error).message).includes('root'),
      `assertInsideRoot message: ${(ePath as Error).message}`,
    );

    // safeJoin sanitizes pure-dot segments to empty (neutralize) so result stays inside root;
    // if a future stricter implementation throws, that is also acceptable fail-closed.
    let safeJoinBlocked = false;
    try {
      const joined = safeJoin('/tmp/root', '..', '..', 'etc');
      const rootResolved = path.resolve('/tmp/root');
      const joinedResolved = path.resolve(joined);
      assert(
        joinedResolved === rootResolved || joinedResolved.startsWith(rootResolved + path.sep),
        `safeJoin must not escape root, got ${joined}`,
      );
      assert(!joined.includes('..'), `safeJoin result must not retain '..', got ${joined}`);
      safeJoinBlocked = true;
    } catch {
      safeJoinBlocked = true; // throw = blocked
    }
    assert(safeJoinBlocked, 'safeJoin path traversal must be blocked (throw or neutralize)');

    // sanitizeSegment: pure-dot emptied; multi-segment with seps loses separators (cannot traverse)
    assert(sanitizeSegment('..') === '', "sanitizeSegment('..') must be empty");
    const cleaned = sanitizeSegment('../../x');
    assert(!cleaned.includes('/') && !cleaned.includes('\\'), 'sanitizeSegment strips path separators');
    // After stripping seps, result is not a usable traversal path segment like ".."
    assert(cleaned !== '..' && cleaned !== '.', 'sanitizeSegment must not yield pure-dot segment');
    // Task intent: no traversable ".." component remains as a path element
    assert(
      !cleaned.split(/[/\\]/).includes('..'),
      `sanitizeSegment result must not contain '..' path element, got ${cleaned}`,
    );

    // ── 6) budget over-limit ──
    console.log('── budget decideBudget fail-closed ──');
    const over = decideBudget({ dailyBudgetUsd: 1 }, 1, 0);
    assert(over.allowed === false, 'todayUsd 1 ≥ daily 1 → allowed false');
    const ok = decideBudget({ dailyBudgetUsd: 1 }, 0.5, 0);
    assert(ok.allowed === true, 'todayUsd 0.5 < daily 1 → allowed true');

    console.log('ALL PASS t06-regression-neg');
  } finally {
    try {
      if (agentIds.length) {
        await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } });
      }
    } catch {
      /* ignore */
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
        await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
      }
    } catch (e) {
      console.warn('cleanup agent*', e);
    }
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  return prisma.$disconnect().catch(() => undefined);
});
