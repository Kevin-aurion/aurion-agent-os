/**
 * Ticket 01 — Progressive skill disclosure (positive).
 * Run: npx tsx .scratch/skill-production-platform/tests/t01-catalog.ts
 *
 * 1. CONFIRMED ~100KB skill body is NOT injected into system prompt (catalog only).
 * 2. L2 readSkillBody after materialize returns full body with marker.
 * 3. Legacy skill (no frontmatter) gets deterministic safe defaults.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { materializeAgent } from '../../../src/engine/materialize.js';
import { compileManifest, buildSystemPrompt } from '../../../src/engine/runner.js';
import { parseSkillManifest, readSkillBody } from '../../../src/lib/skillmanifest.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const skillBigId = ulid();
  const skillLegacyId = ulid();
  const slugBig = `t01-big-${tag}`;
  const slugLegacy = `t01-legacy-${tag}`;
  const MARKER = '__SKILL_BODY_MARKER__';

  // ~100KB body with unique marker buried in the middle/end.
  const pad = 'x'.repeat(100_000);
  const bigBody = `# Big Skill Manual\n\n${pad}\n\n${MARKER}\n\nEnd of skill.\n`;
  assert(bigBody.length >= 100_000, `big body should be >= 100KB, got ${bigBody.length}`);
  assert(bigBody.includes(MARKER), 'big body must contain marker');

  console.log('── setup: agent + 100KB CONFIRMED skill + legacy skill ──');
  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t01-agent-${tag}`,
        name: 'T01 Catalog Agent',
        description: 'temp t01 progressive disclosure',
        rolePrompt: 'You are a test agent for progressive skill disclosure.',
        engineExecute: 'CLAUDE_CODE',
        createdBy: user.id,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillBigId,
        slug: slugBig,
        name: 'T01 Big Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: bigBody,
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
        version: 3,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillLegacyId,
        slug: slugLegacy,
        name: 'T01 Legacy Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# Just a plain skill\n\nNo frontmatter here.\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    await prisma.agentSkill.create({ data: { agentId, skillId: skillBigId } });
    await prisma.agentSkill.create({ data: { agentId, skillId: skillLegacyId } });

    console.log('── materialize + compileManifest + buildSystemPrompt ──');
    const agentDir = await materializeAgent(agentId);
    const manifest = await compileManifest(agentId, undefined, agentDir, 'hello');
    const systemPrompt = buildSystemPrompt(manifest);

    console.log(`system prompt length: ${systemPrompt.length}`);
    console.log(`skills in manifest: ${manifest.skills.map((s) => s.name).join(', ')}`);

    // 1) Body marker must NOT appear in system prompt
    assert(
      !systemPrompt.includes(MARKER),
      'system prompt must NOT contain skill body marker (body not injected)',
    );

    // Catalog must include slug + relPath
    assert(systemPrompt.includes(slugBig), `system prompt must contain skill slug ${slugBig}`);
    assert(
      systemPrompt.includes(`skills/${slugBig}/SKILL.md`),
      `system prompt must contain relPath skills/${slugBig}/SKILL.md`,
    );
    assert(
      systemPrompt.includes('技能目錄') || systemPrompt.toLowerCase().includes('catalog'),
      'system prompt must include catalog heading',
    );

    // Length far below 100KB
    assert(
      systemPrompt.length < 20_000,
      `system prompt must be < 20KB (catalog only), got ${systemPrompt.length}`,
    );

    // Manifest still holds contentMd for L2 fallback, but catalog path is set
    const bigCompiled = manifest.skills.find((s) => s.name === slugBig);
    assert(bigCompiled, 'big skill must be in compiled skills');
    assert(bigCompiled.relPath === `skills/${slugBig}/SKILL.md`, 'relPath must match');
    assert(bigCompiled.contentMd.includes(MARKER), 'CompiledSkill.contentMd still holds full body for L2');
    assert(bigCompiled.metadata, 'metadata must be present');

    // 2) L2 readSkillBody after materialize
    console.log('── L2 readSkillBody ──');
    const body = await readSkillBody(agentDir, slugBig);
    assert(body.includes(MARKER), 'readSkillBody must return full body with marker');
    assert(body.length >= 100_000, `readSkillBody length should be >= 100KB, got ${body.length}`);

    // 3) Legacy defaults
    console.log('── legacy parseSkillManifest defaults ──');
    const legacy = await prisma.skill.findUnique({ where: { id: skillLegacyId } });
    assert(legacy, 'legacy skill exists');
    const meta = parseSkillManifest(legacy);
    assert(meta.riskTier === 'high', `legacy riskTier must be high, got ${meta.riskTier}`);
    assert(meta.tokenBudget === 2000, `legacy tokenBudget must be 2000, got ${meta.tokenBudget}`);
    assert(meta.evalSuiteId === null, `legacy evalSuiteId must be null, got ${meta.evalSuiteId}`);
    assert(Array.isArray(meta.requiredTools) && meta.requiredTools.length === 0, 'requiredTools empty');
    assert(Array.isArray(meta.conflictsWith) && meta.conflictsWith.length === 0, 'conflictsWith empty');
    assert(Array.isArray(meta.sideEffects) && meta.sideEffects.length === 0, 'sideEffects empty');

    // Also present in catalog without body injection of legacy (no special marker)
    assert(systemPrompt.includes(slugLegacy), 'legacy slug in catalog');

    console.log('ALL PASS');
  } finally {
    // best-effort cleanup
    try {
      await prisma.agentSkill.deleteMany({ where: { agentId } });
    } catch {
      /* ignore */
    }
    try {
      await prisma.skill.deleteMany({ where: { id: { in: [skillBigId, skillLegacyId] } } });
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
