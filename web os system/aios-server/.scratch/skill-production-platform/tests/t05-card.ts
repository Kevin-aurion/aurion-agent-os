/**
 * Ticket 05 — Agent Card whitelist projection (positive).
 * Run: npx tsx .scratch/skill-production-platform/tests/t05-card.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { projectAgentCard } from '../../../src/lib/agentcard.js';

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
  const skillId = ulid();
  const ROLE_PROMPT = 'SECRET_ROLE_PROMPT_XYZ_NEVER_LEAK';
  const RESTRICTION_NOTE = 'RESTRICTION_NOTE_PRIVATE_ABC';
  const SKILL_BODY = 'SKILL_BODY_SECRET_CONTENT_MD_999';
  const FAKE_SECRET = 'sk-cardfake0123456789ABCDEF';
  const ONE_LINER = 'Public one-liner for card';

  console.log('── setup ──');
  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t05-card-${tag}`,
        name: 'T05 Card Agent',
        description: 'public description for card',
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
          oneLiner: ONE_LINER,
          purpose: 'help',
          canDo: ['summarize docs'],
          cannotDo: ['leak secrets'],
          servedAudience: 'ops',
          exampleCommands: ['summarize this'],
        },
        riskTier: 'low',
        createdBy: user.id,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t05-card-skill-${tag}`,
        name: 'T05 Card Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# Skill\n${SKILL_BODY}\nkey=${FAKE_SECRET}\n`,
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    await prisma.agentSkill.create({ data: { agentId, skillId } });

    console.log('── projectAgentCard ──');
    const card = await projectAgentCard(agentId);
    const keys = Object.keys(card).sort();
    const allowed = new Set([
      'id',
      'slug',
      'name',
      'description',
      'oneLiner',
      'supportedTasks',
      'inputModes',
      'outputModes',
      'riskTier',
      'availability',
    ]);
    for (const k of keys) {
      assert(allowed.has(k), `unexpected card key: ${k}`);
    }
    assert(card.id === agentId, 'id');
    assert(card.slug === `t05-card-${tag}`, 'slug');
    assert(card.name === 'T05 Card Agent', 'name');
    assert(card.description === 'public description for card', 'description');
    assert(card.oneLiner === ONE_LINER, 'oneLiner');
    assert(Array.isArray(card.supportedTasks), 'supportedTasks array');
    assert(
      card.supportedTasks.some((t) => t.includes('T05 Card Skill') || t.includes('summarize')),
      'supportedTasks includes skill or canDo',
    );
    assert(JSON.stringify(card.inputModes) === JSON.stringify(['text']), 'inputModes');
    assert(JSON.stringify(card.outputModes) === JSON.stringify(['text']), 'outputModes');
    assert(card.riskTier === 'low', 'riskTier');
    assert(card.availability === 'available', 'availability');

    const blob = JSON.stringify(card);
    assert(!blob.includes(ROLE_PROMPT), 'must not contain rolePrompt text');
    assert(!blob.includes(RESTRICTION_NOTE), 'must not contain restrictions text');
    assert(!blob.includes(SKILL_BODY), 'must not contain skill contentMd body');
    assert(!blob.includes(FAKE_SECRET), 'must not contain secret');
    assert(!blob.includes('rolePrompt'), 'must not expose rolePrompt key');
    assert(!blob.includes('restrictions'), 'must not expose restrictions key');
    assert(!blob.includes('contentMd'), 'must not expose contentMd');

    console.log('PASS t05-card');
  } finally {
    console.log('── cleanup ──');
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL t05-card', e);
    process.exit(1);
  });
