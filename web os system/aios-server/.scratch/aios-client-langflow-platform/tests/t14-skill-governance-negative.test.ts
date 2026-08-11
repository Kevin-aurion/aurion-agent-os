/**
 * Ticket 14 — FDE Skill versions / promote-gate (negative / fail-closed).
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t14-skill-governance-negative.test.ts
 *
 * Real DB + Fastify inject. Does NOT delete AuditLog.
 * Token is signed JWT only (no User row). FK fields reuse existing OWNER/TRAINER user.id.
 * Eval runs use injected EvalRunnerDeps (no real LLM).
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  createSuite,
  addCase,
  runSuite,
  type EvalRunnerDeps,
} from '../../../src/lib/eval.js';
import { evalRoutes } from '../../../src/routes/evals.js';

let passed = 0;
let failed = 0;

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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

type GateCheck = {
  key: string;
  ok: boolean;
  reason?: string;
  evalRunId?: string;
};

type GatePayload = {
  canPromote: boolean;
  checks: GateCheck[];
};

function parseGate(body: string): GatePayload | undefined {
  try {
    return (JSON.parse(body) as { data?: GatePayload }).data;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log('── t14-skill-governance-negative ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  if (!owner) {
    fail('setup', 'need existing OWNER/TRAINER user for FK fields');
    console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
    process.exit(1);
  }

  const tag = ulid().slice(-8).toLowerCase();
  const skillIds: string[] = [];
  const suiteIds: string[] = [];

  // Shared CONFIRMED skill for MEMBER promote zero-change
  const confirmedSkillId = ulid();
  skillIds.push(confirmedSkillId);
  let confirmedVersionId = '';

  // AWAITING_USER_CONFIRM skill
  const awaitingSkillId = ulid();
  skillIds.push(awaitingSkillId);
  let awaitingVersionId = '';
  let awaitingSuiteId = '';

  // High-risk unresolved skill
  const highRiskSkillId = ulid();
  skillIds.push(highRiskSkillId);
  let highRiskVersionId = '';
  let highRiskSuiteId = '';
  let highRiskRunId = '';
  let highRiskCaseId = '';

  // No PASSED run skill
  const noRunSkillId = ulid();
  skillIds.push(noRunSkillId);
  let noRunVersionId = '';

  const memberToken = await signAccess({
    sub: 't14-member',
    email: 't14-member@test.local',
    role: 'MEMBER',
  });
  const trainerToken = await signAccess({
    sub: 't14-trainer',
    email: 't14-trainer@test.local',
    role: 'TRAINER',
  });

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
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL', message: String(err) },
    });
  });
  await app.register(evalRoutes);

  const deps: EvalRunnerDeps = {
    runCandidate: async ({ kind }) => {
      if (kind === 'PROMPT_INJECTION' || kind === 'RED_TEAM') {
        return {
          output: 'I will not override system policy. Continuing normal skill flow.',
          latencyMs: 5,
        };
      }
      return {
        output: 'APPROVED\n\nConcise summary for t14 negative.',
        latencyMs: 8,
      };
    },
    judge: async () => ({
      approved: true,
      rationale: 'injected judge APPROVED for t14-neg',
    }),
  };

  try {
    // ── Setup shared CONFIRMED skill (for MEMBER promote zero-change) ────
    await prisma.skill.create({
      data: {
        id: confirmedSkillId,
        slug: `t14n-conf-${tag}`,
        name: `T14N Confirmed ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# t14n confirmed\n',
        reviewStatus: 'CONFIRMED',
        confirmedBy: owner.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    const confV = await createSkillVersion(confirmedSkillId, '# t14n confirmed\n', owner.id);
    confirmedVersionId = confV.id;

    // ── [1] MEMBER GET /versions → 403 ───────────────────────────────────
    console.log('\n── [1] MEMBER GET /versions → 403 ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: `/api/skills/${confirmedSkillId}/versions`,
        headers: auth(memberToken),
      });
      check(r.statusCode === 403, '1 MEMBER GET /versions → 403', `got ${r.statusCode}`);
    }

    // ── [2] MEMBER GET /promote-gate → 403 ───────────────────────────────
    console.log('\n── [2] MEMBER GET /promote-gate → 403 ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: `/api/skills/${confirmedSkillId}/promote-gate?versionId=${encodeURIComponent(confirmedVersionId)}`,
        headers: auth(memberToken),
      });
      check(r.statusCode === 403, '2 MEMBER GET /promote-gate → 403', `got ${r.statusCode}`);
    }

    // ── [3] MEMBER POST /promote → 403, stableVersionId zero change ──────
    console.log('\n── [3] MEMBER POST /promote → 403 + zero change ──');
    {
      const before = await prisma.skill.findUniqueOrThrow({ where: { id: confirmedSkillId } });
      check(before.stableVersionId === null, '3 pre: stableVersionId null', `got ${before.stableVersionId}`);

      const r = await app.inject({
        method: 'POST',
        url: `/api/skills/${confirmedSkillId}/promote`,
        headers: auth(memberToken),
        payload: { versionId: confirmedVersionId },
      });
      check(r.statusCode === 403, '3a MEMBER POST /promote → 403', `got ${r.statusCode}`);

      const after = await prisma.skill.findUniqueOrThrow({ where: { id: confirmedSkillId } });
      check(
        after.stableVersionId === null,
        '3b stableVersionId still null',
        `got ${after.stableVersionId}`,
      );
    }

    // ── [4] AWAITING_USER_CONFIRM → gate fail + promote 409 ──────────────
    console.log('\n── [4] AWAITING_USER_CONFIRM skill_confirmed fail ──');
    {
      await prisma.skill.create({
        data: {
          id: awaitingSkillId,
          slug: `t14n-await-${tag}`,
          name: `T14N Awaiting ${tag}`,
          origin: 'UPLOADED',
          kind: 'PROMPT_MANUAL',
          contentMd: '# t14n awaiting\n',
          reviewStatus: 'AWAITING_USER_CONFIRM',
          executionEnv: 'CLI',
        },
      });
      const av = await createSkillVersion(awaitingSkillId, '# t14n awaiting\n', owner.id);
      awaitingVersionId = av.id;

      const suite = await createSuite({
        skillId: awaitingSkillId,
        name: `t14n-await-suite-${tag}`,
        createdBy: owner.id,
      });
      awaitingSuiteId = suite.id;
      suiteIds.push(suite.id);

      await addCase({
        suiteId: suite.id,
        kind: 'POSITIVE_TRIGGER',
        name: 'pos',
        input: { phrase: 'please generate a quote for the client' },
        expected: {
          shouldTrigger: true,
          triggerKeywords: ['quote', '報價'],
        },
      });

      const run = await runSuite({
        suiteId: suite.id,
        candidateVersionId: awaitingVersionId,
        executeEngine: 'CLAUDE_CODE',
        triggeredBy: owner.id,
        deps,
      });
      check(run.status === 'PASSED', '4 pre: PASSED run on awaiting skill', `got ${run.status}`);

      const rGate = await app.inject({
        method: 'GET',
        url: `/api/skills/${awaitingSkillId}/promote-gate?versionId=${encodeURIComponent(awaitingVersionId)}`,
        headers: auth(trainerToken),
      });
      check(rGate.statusCode === 200, '4a GET promote-gate → 200', `got ${rGate.statusCode}`);
      const gate = parseGate(rGate.body);
      check(gate?.canPromote === false, '4b canPromote false', `got ${gate?.canPromote}`);
      const conf = gate?.checks.find((c) => c.key === 'skill_confirmed');
      check(conf?.ok === false, '4c skill_confirmed.ok false', `got ${JSON.stringify(conf)}`);
      check(
        typeof conf?.reason === 'string' && conf.reason.includes('尚未經 FDE 確認'),
        '4d skill_confirmed reason 繁中',
        `got ${conf?.reason}`,
      );

      const before = await prisma.skill.findUniqueOrThrow({ where: { id: awaitingSkillId } });
      check(before.stableVersionId === null, '4e pre stable null', `got ${before.stableVersionId}`);
      check(
        before.reviewStatus === 'AWAITING_USER_CONFIRM',
        '4f still AWAITING_USER_CONFIRM',
        `got ${before.reviewStatus}`,
      );

      const rPromo = await app.inject({
        method: 'POST',
        url: `/api/skills/${awaitingSkillId}/promote`,
        headers: auth(trainerToken),
        payload: { versionId: awaitingVersionId },
      });
      check(rPromo.statusCode === 409, '4g trainer POST promote → 409', `got ${rPromo.statusCode} body=${rPromo.body.slice(0, 200)}`);

      const after = await prisma.skill.findUniqueOrThrow({ where: { id: awaitingSkillId } });
      check(after.stableVersionId === null, '4h stableVersionId still null', `got ${after.stableVersionId}`);
      check(
        after.reviewStatus === 'AWAITING_USER_CONFIRM',
        '4i reviewStatus not auto-confirmed',
        `got ${after.reviewStatus}`,
      );
    }

    // ── [5] unresolved highRisk → gate fail + promote 409 ────────────────
    console.log('\n── [5] unresolved highRisk → fail-closed ──');
    {
      await prisma.skill.create({
        data: {
          id: highRiskSkillId,
          slug: `t14n-hr-${tag}`,
          name: `T14N HighRisk ${tag}`,
          origin: 'UPLOADED',
          kind: 'PROMPT_MANUAL',
          contentMd: '# t14n highrisk\n',
          reviewStatus: 'CONFIRMED',
          confirmedBy: owner.id,
          confirmedAt: new Date(),
          executionEnv: 'CLI',
        },
      });
      const hv = await createSkillVersion(highRiskSkillId, '# t14n highrisk\n', owner.id);
      highRiskVersionId = hv.id;

      const suite = await createSuite({
        skillId: highRiskSkillId,
        name: `t14n-hr-suite-${tag}`,
        createdBy: owner.id,
      });
      highRiskSuiteId = suite.id;
      suiteIds.push(suite.id);

      const c = await addCase({
        suiteId: suite.id,
        kind: 'POSITIVE_TRIGGER',
        name: 'pos-hr',
        input: { phrase: 'please generate a quote for the client' },
        expected: {
          shouldTrigger: true,
          triggerKeywords: ['quote', '報價'],
        },
      });
      highRiskCaseId = c.id;

      const run = await runSuite({
        suiteId: suite.id,
        candidateVersionId: highRiskVersionId,
        executeEngine: 'CLAUDE_CODE',
        triggeredBy: owner.id,
        deps,
      });
      check(run.status === 'PASSED', '5 pre: PASSED run', `got ${run.status}`);
      highRiskRunId = run.id;

      // Manually inject unresolved high-risk result on this run
      await prisma.evalResult.create({
        data: {
          id: ulid(),
          runId: highRiskRunId,
          caseId: highRiskCaseId,
          status: 'FAIL',
          evidence: 't14 injected high-risk unresolved',
          highRisk: true,
          resolved: false,
          deterministic: true,
        },
      });

      const rGate = await app.inject({
        method: 'GET',
        url: `/api/skills/${highRiskSkillId}/promote-gate?versionId=${encodeURIComponent(highRiskVersionId)}`,
        headers: auth(trainerToken),
      });
      check(rGate.statusCode === 200, '5a GET promote-gate → 200', `got ${rGate.statusCode}`);
      const gate = parseGate(rGate.body);
      check(gate?.canPromote === false, '5b canPromote false', `got ${gate?.canPromote}`);
      const hr = gate?.checks.find((c) => c.key === 'no_unresolved_high_risk');
      check(hr?.ok === false, '5c no_unresolved_high_risk.ok false', `got ${JSON.stringify(hr)}`);
      check(
        typeof hr?.reason === 'string' && (hr.reason.includes('高風險') || /\d+/.test(hr.reason)),
        '5d reason mentions high-risk / count',
        `got ${hr?.reason}`,
      );

      const before = await prisma.skill.findUniqueOrThrow({ where: { id: highRiskSkillId } });
      check(before.stableVersionId === null, '5e pre stable null', `got ${before.stableVersionId}`);

      const rPromo = await app.inject({
        method: 'POST',
        url: `/api/skills/${highRiskSkillId}/promote`,
        headers: auth(trainerToken),
        payload: { versionId: highRiskVersionId },
      });
      check(rPromo.statusCode === 409, '5f trainer POST promote → 409', `got ${rPromo.statusCode} body=${rPromo.body.slice(0, 200)}`);

      const after = await prisma.skill.findUniqueOrThrow({ where: { id: highRiskSkillId } });
      check(after.stableVersionId === null, '5g stableVersionId still null', `got ${after.stableVersionId}`);
    }

    // ── [6] no PASSED run → eval_passed fail + promote 409 ───────────────
    console.log('\n── [6] no PASSED run → eval_passed fail ──');
    {
      await prisma.skill.create({
        data: {
          id: noRunSkillId,
          slug: `t14n-norun-${tag}`,
          name: `T14N NoRun ${tag}`,
          origin: 'UPLOADED',
          kind: 'PROMPT_MANUAL',
          contentMd: '# t14n norun\n',
          reviewStatus: 'CONFIRMED',
          confirmedBy: owner.id,
          confirmedAt: new Date(),
          executionEnv: 'CLI',
        },
      });
      const nv = await createSkillVersion(noRunSkillId, '# t14n norun\n', owner.id);
      noRunVersionId = nv.id;

      const rGate = await app.inject({
        method: 'GET',
        url: `/api/skills/${noRunSkillId}/promote-gate?versionId=${encodeURIComponent(noRunVersionId)}`,
        headers: auth(trainerToken),
      });
      check(rGate.statusCode === 200, '6a GET promote-gate → 200', `got ${rGate.statusCode}`);
      const gate = parseGate(rGate.body);
      check(gate?.canPromote === false, '6b canPromote false', `got ${gate?.canPromote}`);
      const ep = gate?.checks.find((c) => c.key === 'eval_passed');
      check(ep?.ok === false, '6c eval_passed.ok false', `got ${JSON.stringify(ep)}`);
      check(
        typeof ep?.reason === 'string' && ep.reason.includes('評測'),
        '6d eval_passed reason 繁中',
        `got ${ep?.reason}`,
      );

      const rPromo = await app.inject({
        method: 'POST',
        url: `/api/skills/${noRunSkillId}/promote`,
        headers: auth(trainerToken),
        payload: { versionId: noRunVersionId },
      });
      check(rPromo.statusCode === 409, '6e trainer POST promote → 409', `got ${rPromo.statusCode}`);

      const after = await prisma.skill.findUniqueOrThrow({ where: { id: noRunSkillId } });
      check(after.stableVersionId === null, '6f stableVersionId still null', `got ${after.stableVersionId}`);
    }

    // ── [7] missing skill → GET /versions 404 ────────────────────────────
    console.log('\n── [7] nonexistent skill → 404 ──');
    {
      const missingId = ulid();
      const r = await app.inject({
        method: 'GET',
        url: `/api/skills/${missingId}/versions`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 404, '7 GET /versions missing skill → 404', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
    }

    // ── [8] missing versionId query → 400 ────────────────────────────────
    console.log('\n── [8] missing versionId query → 400 ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: `/api/skills/${confirmedSkillId}/promote-gate`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 400, '8 GET promote-gate missing versionId → 400', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
    }
  } finally {
    // Cleanup order: evalResult → evalRun → evalCase → evalSuite → skillVersion → skill
    // Never delete users or AuditLog.
    try {
      for (const suiteId of suiteIds) {
        await prisma.evalResult.deleteMany({ where: { run: { suiteId } } });
        await prisma.evalRun.deleteMany({ where: { suiteId } });
        await prisma.evalCase.deleteMany({ where: { suiteId } });
        await prisma.evalSuite.deleteMany({ where: { id: suiteId } });
      }
      // safety: any leftover suites on our skills
      for (const skillId of skillIds) {
        const suites = await prisma.evalSuite.findMany({ where: { skillId }, select: { id: true } });
        for (const s of suites) {
          await prisma.evalResult.deleteMany({ where: { run: { suiteId: s.id } } });
          await prisma.evalRun.deleteMany({ where: { suiteId: s.id } });
          await prisma.evalCase.deleteMany({ where: { suiteId: s.id } });
          await prisma.evalSuite.deleteMany({ where: { id: s.id } });
        }
        await prisma.skillVersion.deleteMany({ where: { skillId } });
        await prisma.skill.deleteMany({ where: { id: skillId } });
      }
    } catch (e) {
      console.error('cleanup error:', e instanceof Error ? e.message : e);
    }
    await app.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  // silence unused locals (tracked for readability)
  void awaitingSuiteId;
  void highRiskSuiteId;
  void highRiskCaseId;

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => {});
});
