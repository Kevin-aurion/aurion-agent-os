/**
 * Ticket 01 — Progressive skill disclosure (path safety + gates, negative).
 * Run: npx tsx .scratch/skill-production-platform/tests/t01-pathsafety.ts
 *
 * 1. Malicious slugs / resource paths throw (fail-closed).
 * 2. Unconfirmed skills excluded from compileManifest catalog.
 * 3. conflictsWith: later skill marked conflicted; its body not in system prompt.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { materializeAgent } from '../../../src/engine/materialize.js';
import { compileManifest, buildSystemPrompt } from '../../../src/engine/runner.js';
import {
  safeSkillRelPath,
  readSkillResource,
  buildAgentSkillCatalog,
} from '../../../src/lib/skillmanifest.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function assertThrows(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `${label} must throw`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, label: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, `${label} must throw`);
}

async function main() {
  console.log('── 1) safeSkillRelPath rejects path traversal ──');
  assertThrows(() => safeSkillRelPath('../evil'), "safeSkillRelPath('../evil')");
  assertThrows(() => safeSkillRelPath('/abs'), "safeSkillRelPath('/abs')");
  assertThrows(() => safeSkillRelPath('a\\b'), "safeSkillRelPath('a\\\\b')");
  assertThrows(() => safeSkillRelPath('C:\\x'), "safeSkillRelPath('C:\\\\x')");
  assertThrows(() => safeSkillRelPath('..'), "safeSkillRelPath('..')");

  // Valid slug works
  const okRel = safeSkillRelPath('my-skill');
  assert(okRel === 'skills/my-skill/SKILL.md', `expected skills/my-skill/SKILL.md, got ${okRel}`);

  console.log('── 2) readSkillResource rejects escapes ──');
  const tag = ulid().slice(-8).toLowerCase();
  const tmpAgentDir = path.join('/tmp', `aios-t01-path-${tag}`);
  const safeSlug = `safe-skill-${tag}`;
  const skillDir = path.join(tmpAgentDir, 'skills', safeSlug);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '# safe\n', 'utf8');
  await writeFile(path.join(skillDir, 'note.txt'), 'ok', 'utf8');

  await assertThrowsAsync(
    () => readSkillResource(tmpAgentDir, safeSlug, '../../../etc/passwd'),
    "readSkillResource('../../../etc/passwd')",
  );
  await assertThrowsAsync(
    () => readSkillResource(tmpAgentDir, safeSlug, '/etc/passwd'),
    "readSkillResource('/etc/passwd')",
  );
  // Positive: legitimate resource
  const note = await readSkillResource(tmpAgentDir, safeSlug, 'note.txt');
  assert(note.toString('utf8') === 'ok', 'legitimate resource must be readable');

  console.log('── 3) unconfirmed skill excluded from catalog ──');
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  const agentId = ulid();
  const skillPendingId = ulid();
  const skillAId = ulid();
  const skillBId = ulid();
  const slugPending = `t01-pending-${tag}`;
  const slugA = `t01-conf-a-${tag}`;
  const slugB = `t01-conf-b-${tag}`;
  const MARKER_A = '__CONFLICT_BODY_A__';
  const MARKER_B = '__CONFLICT_BODY_B__';

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t01-path-agent-${tag}`,
        name: 'T01 Path Agent',
        description: 'temp t01 path safety',
        rolePrompt: 'test agent',
        engineExecute: 'CLAUDE_CODE',
        createdBy: user.id,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillPendingId,
        slug: slugPending,
        name: 'Pending Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# pending\n__PENDING_MARKER__\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });

    // Mutual conflictsWith via assets.metadata
    await prisma.skill.create({
      data: {
        id: skillAId,
        slug: slugA,
        name: 'Conflict A',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# A\n${MARKER_A}\n`,
        assets: { metadata: { conflictsWith: [slugB], riskTier: 'low', tokenBudget: 500 } },
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillBId,
        slug: slugB,
        name: 'Conflict B',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# B\n${MARKER_B}\n`,
        assets: { metadata: { conflictsWith: [slugA], riskTier: 'low', tokenBudget: 500 } },
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    // Order: pending, A, B — first appearance wins for conflicts (A kept, B conflicted)
    await prisma.agentSkill.create({ data: { agentId, skillId: skillPendingId } });
    await prisma.agentSkill.create({ data: { agentId, skillId: skillAId } });
    await prisma.agentSkill.create({ data: { agentId, skillId: skillBId } });

    const agentDir = await materializeAgent(agentId);
    const manifest = await compileManifest(agentId, undefined, agentDir, 'hi');
    const systemPrompt = buildSystemPrompt(manifest);

    const slugs = manifest.skills.map((s) => s.name);
    assert(!slugs.includes(slugPending), 'unconfirmed skill must not appear in compiled skills');
    assert(!systemPrompt.includes(slugPending), 'unconfirmed skill must not appear in catalog text');
    assert(!systemPrompt.includes('__PENDING_MARKER__'), 'unconfirmed body must not be injected');

    assert(slugs.includes(slugA), 'skill A must be in compiled skills');
    assert(slugs.includes(slugB), 'skill B still listed in compiled skills (catalog shows conflicted)');

    // Neither body marker in system prompt (progressive disclosure)
    assert(!systemPrompt.includes(MARKER_A), 'body A must not be injected');
    assert(!systemPrompt.includes(MARKER_B), 'body B must not be injected');

    // Catalog marks conflicted for the later skill (B)
    const catalog = buildAgentSkillCatalog(
      (
        await prisma.skill.findMany({
          where: { id: { in: [skillAId, skillBId] } },
          orderBy: { createdAt: 'asc' },
        })
      ).sort((a, b) => {
        // Match agent.skills order: A then B
        if (a.id === skillAId) return -1;
        if (b.id === skillAId) return 1;
        return 0;
      }),
    );
    const entryA = catalog.find((c) => c.slug === slugA);
    const entryB = catalog.find((c) => c.slug === slugB);
    assert(entryA && !entryA.conflicted, 'skill A (first) must not be conflicted');
    assert(entryB && entryB.conflicted, 'skill B (later) must be conflicted');
    assert(
      systemPrompt.includes('衝突') || systemPrompt.toLowerCase().includes('conflict'),
      'system prompt catalog must note conflict',
    );

    console.log('ALL PASS');
  } finally {
    try {
      await prisma.agentSkill.deleteMany({ where: { agentId } });
    } catch {
      /* ignore */
    }
    try {
      await prisma.skill.deleteMany({
        where: { id: { in: [skillPendingId, skillAId, skillBId] } },
      });
    } catch {
      /* ignore */
    }
    try {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    } catch {
      /* ignore */
    }
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  return prisma.$disconnect().catch(() => undefined);
});
