/**
 * Ticket 20 PoC 08 — same model family (negative).
 * Deployment gate: execute/verify same family → reject (zero new deployment).
 * Model gateway: chooseVerifyEngine never returns same family; payload extras ignored/rejected.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-08-same-family.test.ts
 */
import { ulid } from 'ulid';
import type { Engine } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { ApiError } from '../../../src/lib/http.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';

const LIVE_LANGFLOW = 'http://127.0.0.1:7860';

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

async function throwsAsync(
  fn: () => Promise<unknown>,
  label: string,
  pred: (err: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    fail(label, 'expected throw, got none');
  } catch (e) {
    if (pred(e)) pass(label);
    else fail(label, `threw but predicate failed: ${String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log('── t20-poc-08-same-family ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const contentMd = `# t20 poc08 samefam ${tag}\n`;
  let skillVersionId = '';
  let artifactId = '';

  // Ticket 23: targets FDE sandbox @ 7860 — fixed sandbox placeholder only (never Production key).
  const liveAdapter = new LangflowAdapter({
    baseUrl: LIVE_LANGFLOW,
    apiKey: 'sandbox-flow-api-key-not-production-local-only-v1',
    timeoutMs: 8_000,
  });

  try {
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    let ENGINE_MODEL_FAMILY: typeof import('../../../src/lib/runtimedeployment.js').ENGINE_MODEL_FAMILY;
    let chooseVerifyEngine: typeof import('../../../src/lib/modelgateway.js').chooseVerifyEngine;

    try {
      const dep = await import('../../../src/lib/runtimedeployment.js');
      activateDeployment = dep.activateDeployment;
      validateArtifactForRuntime = dep.validateArtifactForRuntime;
      ENGINE_MODEL_FAMILY = dep.ENGINE_MODEL_FAMILY;
      const gw = await import('../../../src/lib/modelgateway.js');
      chooseVerifyEngine = gw.chooseVerifyEngine;
    } catch (e) {
      fail('import modules', String(e));
      return;
    }

    // ── [1] ENGINE_MODEL_FAMILY map ──────────────────────────────────────
    console.log('\n── [1] ENGINE_MODEL_FAMILY ──');
    check(ENGINE_MODEL_FAMILY.CLAUDE_CODE === 'anthropic', 'CLAUDE_CODE → anthropic', ENGINE_MODEL_FAMILY.CLAUDE_CODE);
    check(ENGINE_MODEL_FAMILY.CODEX === 'openai', 'CODEX → openai', ENGINE_MODEL_FAMILY.CODEX);
    check(ENGINE_MODEL_FAMILY.GROK === 'xai', 'GROK → xai', ENGINE_MODEL_FAMILY.GROK);

    // ── [2] chooseVerifyEngine never same family ─────────────────────────
    console.log('\n── [2] chooseVerifyEngine ──');
    const engines: Engine[] = ['CLAUDE_CODE', 'CODEX', 'GROK'];
    for (const ex of engines) {
      const auto = chooseVerifyEngine(ex, null);
      check(
        ENGINE_MODEL_FAMILY[auto] !== ENGINE_MODEL_FAMILY[ex],
        `chooseVerifyEngine(${ex}, null) different family`,
        `verify=${auto} fam=${ENGINE_MODEL_FAMILY[auto]} vs ${ENGINE_MODEL_FAMILY[ex]}`,
      );
      // configured same as execute → ignored, falls back to opposite
      const same = chooseVerifyEngine(ex, ex);
      check(
        ENGINE_MODEL_FAMILY[same] !== ENGINE_MODEL_FAMILY[ex],
        `chooseVerifyEngine(${ex}, ${ex}) ignores same-family config`,
        `verify=${same}`,
      );
    }
    // configured opposite is accepted
    const v = chooseVerifyEngine('CLAUDE_CODE', 'CODEX');
    check(v === 'CODEX', 'configured opposite CODEX accepted', v);
    const v2 = chooseVerifyEngine('CODEX', 'GROK');
    check(v2 === 'GROK', 'configured GROK for CODEX accepted', v2);

    // ── [3] deployment gate same-family eval ─────────────────────────────
    console.log('\n── [3] activateDeployment same-family → reject ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc08-owner-${tag}@aios.test`,
        displayName: 'T20 PoC08 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc08-skill-${tag}`,
        name: `T20 PoC08 Skill ${tag}`,
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
      data: { id: suiteId, skillId, name: `T20 PoC08 Suite ${tag}`, createdBy: ownerId },
    });
    // Same family: CODEX/CODEX both openai
    await prisma.evalRun.create({
      data: {
        id: evalRunId,
        suiteId,
        skillId,
        candidateVersionId: skillVersionId,
        executeEngine: 'CODEX',
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
      compilerVersion: `t20-poc08-${tag}`,
      artifactJson: {
        schemaVersion: 'aios.flow-graph/1',
        template: 'email-triage-readonly-v1',
        nodes: [
          { id: 'n1', kind: 'input', config: {} },
          { id: 'n2', kind: 'output', config: {} },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      },
      createdBy: ownerId,
    });
    artifactId = art.id;
    await validateArtifactForRuntime(
      { artifactId, actorId: ownerId, actorRole: 'OWNER' },
      { adapter: liveAdapter },
    );

    const countBefore = await prisma.runtimeDeployment.count({ where: { skillId } });
    console.log(`  evidence: RuntimeDeployment count before=${countBefore}`);
    await throwsAsync(
      () =>
        activateDeployment(
          {
            artifactId,
            environment: 'PRODUCTION',
            channel: 'CANARY',
            actorId: ownerId,
            actorRole: 'OWNER',
          },
          { adapter: liveAdapter },
        ),
      'same-family activate throws conflict',
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/family/i.test(msg)) return false;
        if (e instanceof ApiError) return e.statusCode === 409 || e.code === 'CONFLICT';
        return true;
      },
    );
    const countAfter = await prisma.runtimeDeployment.count({ where: { skillId } });
    console.log(`  evidence: RuntimeDeployment count after=${countAfter}`);
    check(countAfter === countBefore, 'same-family: zero new deployment rows', `before=${countBefore} after=${countAfter}`);

    // ── [4] request payload hard-stuff same family ignored by chooseVerifyEngine ──
    console.log('\n── [4] hard-stuff same family via configured engine ──');
    // Caller cannot pass modelFamily to chooseVerifyEngine; agent.engineVerify same as execute
    // is the production equivalent of "request hard-stuff same family".
    for (const ex of engines) {
      const chosen = chooseVerifyEngine(ex, ex);
      check(
        ENGINE_MODEL_FAMILY[chosen] !== ENGINE_MODEL_FAMILY[ex],
        `payload-equivalent same-family config ignored for ${ex}`,
        `chosen=${chosen}`,
      );
    }
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: evalRunId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
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
