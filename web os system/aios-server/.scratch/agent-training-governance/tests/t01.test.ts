/**
 * Ticket 01 — RECORDED origin + CODEX engine gate on skill attach.
 * Run: npx tsx .scratch/agent-training-governance/tests/t01.test.ts
 *
 * External behavior only:
 * - POST /api/agents/:id/skills rejects RECORDED / COMPUTER_CONTROL when engine ≠ CODEX
 * - same skills succeed on CODEX agents
 * - ordinary PROMPT_MANUAL attach still works on non-CODEX agents
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { agentRoutes } from '../../../src/routes/agents.js';
import { ApiError } from '../../../src/lib/http.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  const user = await prisma.user.findFirst({ where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } } });
  assert(user, 'need OWNER/TRAINER user in DB');

  const token = await signAccess({ sub: user.id, email: user.email, role: user.role });
  const auth = { authorization: `Bearer ${token}` };

  const tag = ulid().slice(-8).toLowerCase();
  const agentClaudeId = ulid();
  const agentCodexId = ulid();
  const skillRecordedId = ulid();
  const skillComputerId = ulid();
  const skillManualId = ulid();
  const skillIds = [skillRecordedId, skillComputerId, skillManualId];
  const agentIds = [agentClaudeId, agentCodexId];

  const app = Fastify({ logger: false });
  await app.register(agentRoutes);

  console.log('── setup: agents + skills ──');
  try {
    await prisma.agent.create({
      data: {
        id: agentClaudeId,
        slug: `t01-claude-${tag}`,
        name: 'T01 Claude Agent',
        description: 'temp t01 non-codex',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: user.id,
      },
    });
    await prisma.agent.create({
      data: {
        id: agentCodexId,
        slug: `t01-codex-${tag}`,
        name: 'T01 Codex Agent',
        description: 'temp t01 codex',
        rolePrompt: 'test',
        engineExecute: 'CODEX',
        createdBy: user.id,
      },
    });

    // RECORDED origin (new enum value)
    await prisma.skill.create({
      data: {
        id: skillRecordedId,
        slug: `t01-recorded-${tag}`,
        name: 'T01 Recorded Skill',
        origin: 'RECORDED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# recorded skill\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'DESKTOP_APP',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillComputerId,
        slug: `t01-computer-${tag}`,
        name: 'T01 Computer Control',
        origin: 'UPLOADED',
        kind: 'COMPUTER_CONTROL',
        contentMd: '# computer control\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'DESKTOP_APP',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillManualId,
        slug: `t01-manual-${tag}`,
        name: 'T01 Prompt Manual',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# prompt manual\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    // ── 1. RECORDED → non-CODEX → reject ──────────────────────────────────
    console.log('\n── [1] RECORDED on CLAUDE_CODE agent must be rejected ──');
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentClaudeId}/skills`,
      headers: auth,
      payload: { skillId: skillRecordedId },
    });
    console.log('status:', r1.statusCode, 'body:', r1.body);
    assert(r1.statusCode === 400, `expected 400, got ${r1.statusCode}`);
    const b1 = JSON.parse(r1.body);
    assert(b1.success === false, 'success should be false');
    assert(
      typeof b1.error?.message === 'string' &&
        b1.error.message.includes('CODEX') &&
        (b1.error.message.includes('此類技能只能由 CODEX 引擎驅動') ||
          b1.error.message.includes('CODEX 引擎')),
      `message should explain CODEX requirement, got: ${b1.error?.message}`,
    );
    const link1 = await prisma.agentSkill.findUnique({
      where: { agentId_skillId: { agentId: agentClaudeId, skillId: skillRecordedId } },
    });
    assert(!link1, 'AgentSkill must not be created on reject');
    console.log('PASS [1] RECORDED + non-CODEX rejected');

    // ── 2. COMPUTER_CONTROL → non-CODEX → reject ─────────────────────────
    console.log('\n── [2] COMPUTER_CONTROL on CLAUDE_CODE agent must be rejected ──');
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentClaudeId}/skills`,
      headers: auth,
      payload: { skillId: skillComputerId },
    });
    console.log('status:', r2.statusCode, 'body:', r2.body);
    assert(r2.statusCode === 400, `expected 400, got ${r2.statusCode}`);
    const b2 = JSON.parse(r2.body);
    assert(b2.success === false, 'success should be false');
    assert(
      typeof b2.error?.message === 'string' && b2.error.message.includes('CODEX'),
      `message should mention CODEX, got: ${b2.error?.message}`,
    );
    const link2 = await prisma.agentSkill.findUnique({
      where: { agentId_skillId: { agentId: agentClaudeId, skillId: skillComputerId } },
    });
    assert(!link2, 'AgentSkill must not be created');
    console.log('PASS [2] COMPUTER_CONTROL + non-CODEX rejected');

    // ── 3. RECORDED → CODEX → success ────────────────────────────────────
    console.log('\n── [3] RECORDED on CODEX agent must succeed ──');
    const r3 = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentCodexId}/skills`,
      headers: auth,
      payload: { skillId: skillRecordedId },
    });
    console.log('status:', r3.statusCode, 'body:', r3.body.slice(0, 300));
    assert(r3.statusCode === 200, `expected 200, got ${r3.statusCode}`);
    const b3 = JSON.parse(r3.body);
    assert(b3.success === true, 'success should be true');
    const link3 = await prisma.agentSkill.findUnique({
      where: { agentId_skillId: { agentId: agentCodexId, skillId: skillRecordedId } },
    });
    assert(!!link3, 'AgentSkill should exist');
    console.log('PASS [3] RECORDED + CODEX attached');

    // ── 4. COMPUTER_CONTROL → CODEX → success ────────────────────────────
    console.log('\n── [4] COMPUTER_CONTROL on CODEX agent must succeed ──');
    const r4 = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentCodexId}/skills`,
      headers: auth,
      payload: { skillId: skillComputerId },
    });
    console.log('status:', r4.statusCode);
    assert(r4.statusCode === 200, `expected 200, got ${r4.statusCode}`);
    const link4 = await prisma.agentSkill.findUnique({
      where: { agentId_skillId: { agentId: agentCodexId, skillId: skillComputerId } },
    });
    assert(!!link4, 'AgentSkill should exist');
    console.log('PASS [4] COMPUTER_CONTROL + CODEX attached');

    // ── 5. PROMPT_MANUAL on non-CODEX still works (no regression) ────────
    console.log('\n── [5] PROMPT_MANUAL on CLAUDE_CODE agent still succeeds ──');
    const r5 = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentClaudeId}/skills`,
      headers: auth,
      payload: { skillId: skillManualId },
    });
    console.log('status:', r5.statusCode);
    assert(r5.statusCode === 200, `expected 200, got ${r5.statusCode}`);
    const link5 = await prisma.agentSkill.findUnique({
      where: { agentId_skillId: { agentId: agentClaudeId, skillId: skillManualId } },
    });
    assert(!!link5, 'AgentSkill should exist for ordinary skill');
    console.log('PASS [5] PROMPT_MANUAL attach unchanged');

    // ── 6. DB: SkillOrigin includes RECORDED ─────────────────────────────
    console.log('\n── [6] Skill.origin RECORDED is stored ──');
    const recorded = await prisma.skill.findUnique({ where: { id: skillRecordedId } });
    assert(recorded?.origin === 'RECORDED', `expected origin RECORDED, got ${recorded?.origin}`);
    console.log('PASS [6] RECORDED origin persisted');

    console.log('\n══ ALL t01 TESTS PASSED ══');
  } finally {
    console.log('\n── cleanup ──');
    await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.skill.deleteMany({ where: { id: { in: skillIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('\nTEST FAILED:', e instanceof Error ? e.message : e);
  if (e instanceof ApiError) console.error('ApiError', e.statusCode, e.code, e.message);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
