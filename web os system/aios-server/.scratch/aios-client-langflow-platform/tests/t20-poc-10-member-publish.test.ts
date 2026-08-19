/**
 * Ticket 20 PoC 10 — MEMBER publish (negative, live HTTP :8700).
 * MEMBER token → 403 on runtime activate/rollback/deactivate and other trainer
 * runtime routes; RuntimeDeployment count unchanged; confirm skill / approve
 * proposal also 403.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-10-member-publish.test.ts
 * Requires live server http://127.0.0.1:8700.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';

const BASE = 'http://127.0.0.1:8700';

let failed = 0;
let passed = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
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

async function main(): Promise<void> {
  console.log('── t20-poc-10-member-publish ──');

  const tag = ulid().slice(-8).toLowerCase();
  const memberId = ulid();
  const ownerId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const agentId = ulid();
  const proposalId = ulid();
  const contentMd = `# t20 poc10 member ${tag}\n`;

  let skillVersionId = '';
  let artifactId = '';
  let deploymentId = '';
  let memberToken = '';
  let awaitingSkillId = '';

  try {
    // Live server probe
    try {
      const health = await fetch(`${BASE}/api/health`);
      check(health.ok || health.status < 500, 'live server :8700 reachable', `status=${health.status}`);
    } catch (e) {
      fail('live server :8700 reachable', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (server down) ──`);
      return;
    }

    console.log('── setup MEMBER + fixtures ──');
    await prisma.user.create({
      data: {
        id: memberId,
        email: `t20-poc10-member-${tag}@aios.test`,
        displayName: 'T20 PoC10 Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc10-owner-${tag}@aios.test`,
        displayName: 'T20 PoC10 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    memberToken = await signAccess({
      sub: memberId,
      email: `t20-poc10-member-${tag}@aios.test`,
      role: 'MEMBER',
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc10-agent-${tag}`,
        name: `T20 PoC10 Agent ${tag}`,
        description: 'poc10',
        rolePrompt: 'poc10',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: { shell: false },
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc10-skill-${tag}`,
        name: `T20 PoC10 Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, contentMd, ownerId);
    skillVersionId = sv.id;
    await prisma.evalSuite.create({
      data: { id: suiteId, skillId, name: `T20 PoC10 Suite ${tag}`, createdBy: ownerId },
    });
    await prisma.evalRun.create({
      data: {
        id: evalRunId,
        suiteId,
        skillId,
        candidateVersionId: skillVersionId,
        executeEngine: 'CLAUDE_CODE',
        verifyEngine: 'CODEX',
        status: 'PASSED',
        totalCases: 1,
        passedCases: 1,
        finishedAt: new Date(),
        triggeredBy: ownerId,
      },
    });

    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t20-poc10-${tag}`,
      artifactJson: {
        nodes: [{ id: 'n1', kind: 'input', config: {} }],
        edges: [],
      },
      createdBy: ownerId,
    });
    artifactId = art.id;
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: { status: 'VALIDATED' },
    });

    // Pre-existing deployment target for rollback/deactivate attempts
    deploymentId = ulid();
    await prisma.runtimeDeployment.create({
      data: {
        id: deploymentId,
        artifactId,
        skillId,
        environment: 'STAGING',
        channel: 'CANARY',
        runtimeBinding: { kind: 'LANGFLOW', bindingRef: 't20-poc10-fixture' },
        active: true,
        deployedBy: ownerId,
      },
    });

    awaitingSkillId = ulid();
    await prisma.skill.create({
      data: {
        id: awaitingSkillId,
        slug: `t20-poc10-await-${tag}`,
        name: `T20 PoC10 Await ${tag}`,
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# awaiting confirm\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });

    await prisma.changeProposal.create({
      data: {
        id: proposalId,
        agentId,
        source: 'OPERATOR',
        proposedBy: memberId,
        targetType: 'RESTRICTION',
        targetId: agentId,
        proposedChange: { t20poc10: true, note: 'member must not approve' },
        severity: 'low',
        status: 'PENDING',
      },
    });

    const bearer = { authorization: `Bearer ${memberToken}` };
    const jsonAuth = { ...bearer, 'content-type': 'application/json' };
    const countBefore = await prisma.runtimeDeployment.count({ where: { skillId } });
    const globalBefore = await prisma.runtimeDeployment.count();
    console.log(`  evidence: RuntimeDeployment skill before=${countBefore} global=${globalBefore}`);

    // ── [1] MEMBER activate ──────────────────────────────────────────────
    console.log('\n── [1] MEMBER POST /api/runtime/deployments → 403 ──');
    const rActivate = await json(`${BASE}/api/runtime/deployments`, {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({
        artifactId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
      }),
    });
    check(rActivate.response.status === 403, 'MEMBER activate HTTP 403', `HTTP ${rActivate.response.status} ${JSON.stringify(rActivate.body)}`);

    // ── [2] MEMBER rollback ──────────────────────────────────────────────
    // Note: body-less POST must NOT send content-type: application/json
    // (Fastify otherwise 500s before requireTrainer).
    console.log('\n── [2] MEMBER POST rollback → 403 ──');
    const rRollback = await json(`${BASE}/api/runtime/deployments/${deploymentId}/rollback`, {
      method: 'POST',
      headers: bearer,
    });
    check(rRollback.response.status === 403, 'MEMBER rollback HTTP 403', `HTTP ${rRollback.response.status} ${JSON.stringify(rRollback.body)}`);

    // ── [3] MEMBER deactivate ────────────────────────────────────────────
    console.log('\n── [3] MEMBER POST deactivate → 403 ──');
    const rDeact = await json(`${BASE}/api/runtime/deployments/${deploymentId}/deactivate`, {
      method: 'POST',
      headers: bearer,
    });
    check(rDeact.response.status === 403, 'MEMBER deactivate HTTP 403', `HTTP ${rDeact.response.status} ${JSON.stringify(rDeact.body)}`);

    // ── [4] other runtime trainer routes ─────────────────────────────────
    console.log('\n── [4] other MEMBER runtime trainer routes → 403 ──');
    const rValidate = await json(`${BASE}/api/runtime/artifacts/${artifactId}/validate`, {
      method: 'POST',
      headers: bearer,
    });
    check(rValidate.response.status === 403, 'MEMBER validate HTTP 403', `HTTP ${rValidate.response.status} ${JSON.stringify(rValidate.body)}`);

    const rList = await json(`${BASE}/api/runtime/deployments?skillId=${encodeURIComponent(skillId)}`, {
      headers: bearer,
    });
    check(rList.response.status === 403, 'MEMBER list deployments HTTP 403', `HTTP ${rList.response.status}`);

    const rArtList = await json(`${BASE}/api/runtime/artifacts`, {
      headers: bearer,
    });
    check(rArtList.response.status === 403, 'MEMBER list artifacts HTTP 403', `HTTP ${rArtList.response.status}`);

    const countAfter = await prisma.runtimeDeployment.count({ where: { skillId } });
    const globalAfter = await prisma.runtimeDeployment.count();
    console.log(`  evidence: RuntimeDeployment skill after=${countAfter} global=${globalAfter}`);
    check(countAfter === countBefore, 'skill deployment count unchanged', `before=${countBefore} after=${countAfter}`);
    check(globalAfter === globalBefore, 'global deployment count unchanged', `before=${globalBefore} after=${globalAfter}`);

    const depStill = await prisma.runtimeDeployment.findUniqueOrThrow({ where: { id: deploymentId } });
    check(depStill.active === true, 'fixture deployment still active (no deactivate)', `active=${depStill.active}`);

    // ── [5] MEMBER confirm skill / approve proposal ──────────────────────
    console.log('\n── [5] MEMBER confirm skill + approve proposal → 403 ──');
    const skillBefore = await prisma.skill.findUniqueOrThrow({ where: { id: awaitingSkillId } });
    check(skillBefore.reviewStatus === 'AWAITING_USER_CONFIRM', 'fixture skill awaiting', skillBefore.reviewStatus);

    const rConfirm = await json(`${BASE}/api/skills/${awaitingSkillId}/confirm`, {
      method: 'POST',
      headers: bearer,
    });
    check(rConfirm.response.status === 403, 'MEMBER skill confirm HTTP 403', `HTTP ${rConfirm.response.status} ${JSON.stringify(rConfirm.body)}`);
    const skillAfter = await prisma.skill.findUniqueOrThrow({ where: { id: awaitingSkillId } });
    check(
      skillAfter.reviewStatus === 'AWAITING_USER_CONFIRM',
      'skill stays AWAITING_USER_CONFIRM',
      `status=${skillAfter.reviewStatus}`,
    );

    const propBefore = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
    check(propBefore.status === 'PENDING', 'proposal PENDING before', propBefore.status);

    const rApprove = await json(`${BASE}/api/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: bearer,
    });
    check(rApprove.response.status === 403, 'MEMBER proposal approve HTTP 403', `HTTP ${rApprove.response.status} ${JSON.stringify(rApprove.body)}`);
    const propAfter = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
    check(propAfter.status === 'PENDING', 'proposal stays PENDING', `status=${propAfter.status}`);

    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const restrictions = JSON.stringify(agentAfter.restrictions ?? {});
    check(
      !restrictions.includes('t20poc10'),
      'MEMBER approve must not write proposal payload into agent.restrictions',
      restrictions,
    );
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.changeProposal.deleteMany({ where: { id: proposalId } }).catch(() => undefined);
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: evalRunId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: { in: [skillId, awaitingSkillId].filter(Boolean) } } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [memberId, ownerId] } } }).catch(() => undefined);
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('FATAL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
