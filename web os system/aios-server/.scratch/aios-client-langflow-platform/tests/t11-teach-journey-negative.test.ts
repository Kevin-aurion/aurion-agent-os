/**
 * Ticket 11 — teach journey negative matrix (live HTTP + real DB).
 * Run (cwd=aios-server):
 *   npx tsx .scratch/aios-client-langflow-platform/tests/t11-teach-journey-negative.test.ts
 *
 * Proves:
 * 1) MEMBER cannot confirm skill (403, zero status change)
 * 2) MEMBER cannot skills/upload (403)
 * 3) recording/to-skill across agents → 409, session.skillId stays null, no new Skill
 * 4) MEMBER can propose confirm_skill → 200 PENDING proposal, skill still AWAITING
 *
 * Only seeds/deletes rows created in this run. Never deletes users.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { hashPassword } from '../../../src/lib/auth.js';

const BASE = 'http://127.0.0.1:8700';
const MEMBER_EMAIL = 'member11@aios.test';
const MEMBER_PASSWORD = 'aios-t11-member!';
const FDE_EMAIL = 'fde11@aios.test';
const FDE_PASSWORD = 'aios-t11-fde!';

let failed = 0;

function pass(label: string, detail = ''): void {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function ensureUser(
  email: string,
  password: string,
  role: 'MEMBER' | 'TRAINER' | 'OWNER',
  displayName: string,
): Promise<{ id: string; email: string }> {
  const existing = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  if (existing) {
    if (existing.role !== role) {
      await prisma.user.update({ where: { id: existing.id }, data: { role } });
    }
    // Always refresh password so constants stay usable across re-runs.
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash: await hashPassword(password) },
    });
    return { id: existing.id, email: existing.email };
  }
  const id = ulid();
  await prisma.user.create({
    data: {
      id,
      email,
      displayName,
      passwordHash: await hashPassword(password),
      role,
    },
  });
  return { id, email };
}

async function login(email: string, password: string): Promise<string> {
  const res = await json(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.response.status !== 200) {
    throw new Error(`login failed for ${email}: HTTP ${res.response.status}`);
  }
  const access = String((res.body as { data?: { access?: string } })?.data?.access ?? '');
  if (!access) throw new Error(`login missing access for ${email}`);
  return access;
}

async function main(): Promise<void> {
  const createdSkillIds: string[] = [];
  const createdAgentIds: string[] = [];
  const createdSessionIds: string[] = [];
  const createdProposalIds: string[] = [];

  try {
    console.log('── setup users ──');
    const member = await ensureUser(MEMBER_EMAIL, MEMBER_PASSWORD, 'MEMBER', 'T11 Member');
    const fde = await ensureUser(FDE_EMAIL, FDE_PASSWORD, 'TRAINER', 'T11 FDE');
    pass('ensure member + fde users');

    const memberToken = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    pass('MEMBER login');

    // Shared fixtures: skill + two agents + stopped recording session on agent A
    const skillId = ulid();
    const skillSlug = `t11-skill-${skillId.slice(0, 8)}`;
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: skillSlug,
        name: 'T11 Teach Draft',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# T11 Teach Draft\n\nAwaiting FDE confirm.\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
    createdSkillIds.push(skillId);
    pass('seed skill AWAITING_USER_CONFIRM', skillId);

    const agentAId = ulid();
    const agentBId = ulid();
    await prisma.agent.create({
      data: {
        id: agentAId,
        slug: `t11-agent-a-${agentAId.slice(0, 8)}`,
        name: 'T11 Agent A',
        description: 't11 fixture agent A',
        rolePrompt: 'fixture',
        status: 'ACTIVE',
        createdBy: fde.id,
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
        },
      },
    });
    createdAgentIds.push(agentAId);
    await prisma.agent.create({
      data: {
        id: agentBId,
        slug: `t11-agent-b-${agentBId.slice(0, 8)}`,
        name: 'T11 Agent B',
        description: 't11 fixture agent B',
        rolePrompt: 'fixture',
        status: 'ACTIVE',
        createdBy: fde.id,
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
        },
      },
    });
    createdAgentIds.push(agentBId);
    pass('seed agent A + agent B');

    const sessionId = ulid();
    await prisma.recordingSession.create({
      data: {
        id: sessionId,
        userId: member.id,
        agentId: agentAId,
        status: 'STOPPED',
        skillId: null,
        stoppedAt: new Date(),
      },
    });
    createdSessionIds.push(sessionId);
    pass('seed RecordingSession STOPPED on agent A', sessionId);

    const skillCountBefore = await prisma.skill.count();

    // ── 1. MEMBER confirm → 403, zero change ─────────────────────────────
    console.log('\n── [1] MEMBER confirm skill → 403 ──');
    const confirm = await json(`${BASE}/api/skills/${skillId}/confirm`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    check(confirm.response.status === 403, 'MEMBER confirm → 403', `HTTP ${confirm.response.status}`);
    const skillAfterConfirm = await prisma.skill.findUnique({ where: { id: skillId } });
    check(
      skillAfterConfirm?.reviewStatus === 'AWAITING_USER_CONFIRM',
      'skill still AWAITING_USER_CONFIRM after MEMBER confirm',
      String(skillAfterConfirm?.reviewStatus),
    );
    check(skillAfterConfirm?.confirmedAt == null, 'confirmedAt still null', String(skillAfterConfirm?.confirmedAt));

    // ── 2. MEMBER skills/upload → 403 ────────────────────────────────────
    console.log('\n── [2] MEMBER skills/upload → 403 ──');
    const upload = await json(`${BASE}/api/skills/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    check(upload.response.status === 403, 'MEMBER upload → 403', `HTTP ${upload.response.status}`);

    // ── 3. recording to-skill on wrong agent → 409, zero change ──────────
    console.log('\n── [3] recording/to-skill cross-agent → 409 ──');
    const toSkill = await json(`${BASE}/api/agents/${agentBId}/recording/to-skill`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId }),
    });
    check(
      toSkill.response.status === 409,
      'cross-agent to-skill → 409',
      `HTTP ${toSkill.response.status} body=${JSON.stringify(toSkill.body)}`,
    );
    const sessionAfter = await prisma.recordingSession.findUnique({ where: { id: sessionId } });
    check(sessionAfter?.skillId == null, 'session.skillId still null', String(sessionAfter?.skillId));
    const skillCountAfter = await prisma.skill.count();
    check(
      skillCountAfter === skillCountBefore,
      'no new Skill created on cross-agent import',
      `before=${skillCountBefore} after=${skillCountAfter}`,
    );

    // ── 4. MEMBER propose confirm_skill → 200 PENDING, skill unchanged ───
    console.log('\n── [4] MEMBER propose confirm_skill → 200 ──');
    const propose = await json(`${BASE}/api/agents/${agentAId}/proposals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetType: 'SKILL',
        targetId: skillId,
        proposedChange: {
          action: 'confirm_skill',
          skillId,
          name: 't11',
          note: 't11',
        },
        severity: 'medium',
      }),
    });
    check(
      propose.response.status === 200,
      'MEMBER propose → 200',
      `HTTP ${propose.response.status} body=${JSON.stringify(propose.body)}`,
    );
    const proposalId = String(
      (propose.body as { data?: { id?: string } })?.data?.id ?? '',
    );
    if (proposalId) createdProposalIds.push(proposalId);
    check(Boolean(proposalId), 'proposal id returned', 'empty');

    if (proposalId) {
      const prop = await prisma.changeProposal.findUnique({ where: { id: proposalId } });
      check(prop?.status === 'PENDING', 'ChangeProposal PENDING', String(prop?.status));
      check(prop?.agentId === agentAId, 'proposal agentId is A', String(prop?.agentId));
      check(prop?.proposedBy === member.id, 'proposal by member', String(prop?.proposedBy));
    }

    const skillAfterPropose = await prisma.skill.findUnique({ where: { id: skillId } });
    check(
      skillAfterPropose?.reviewStatus === 'AWAITING_USER_CONFIRM',
      'skill still draft after propose',
      String(skillAfterPropose?.reviewStatus),
    );
  } finally {
    console.log('\n── cleanup (precise ids only) ──');
    for (const id of createdProposalIds) {
      try {
        await prisma.changeProposal.delete({ where: { id } });
      } catch {
        /* already gone */
      }
    }
    for (const id of createdSessionIds) {
      try {
        await prisma.recordingSession.delete({ where: { id } });
      } catch {
        /* already gone */
      }
    }
    for (const id of createdSkillIds) {
      try {
        await prisma.skill.delete({ where: { id } });
      } catch {
        /* already gone */
      }
    }
    for (const id of createdAgentIds) {
      try {
        await prisma.agent.delete({ where: { id } });
      } catch {
        /* already gone */
      }
    }
    // users intentionally retained
    pass('cleanup seeded Skill/Agent/RecordingSession/ChangeProposal');
  }

  console.log(`\n── summary: ${failed === 0 ? 'ALL PASS' : `${failed} FAIL`} ──`);
  if (failed > 0) throw new Error(`T11 teach journey negative finished with ${failed} failure(s)`);
}

main().catch((err) => {
  process.exitCode = 1;
  console.error(err);
});
