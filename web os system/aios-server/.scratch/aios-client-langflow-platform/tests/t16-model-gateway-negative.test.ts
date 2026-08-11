/**
 * Ticket 16 — AIOS Model Gateway negative matrix (Phase 1: RED expected).
 *
 * Run:
 *   npx tsx .scratch/aios-client-langflow-platform/tests/t16-model-gateway-negative.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. Fastify inject (no live :8700).
 * Cleanup deletes only test-owned rows.
 *
 * Phase 1: src/lib/modelgateway.ts / src/routes/modelgateway.ts do not exist yet
 * → import failure is the expected RED.
 */
import path from 'node:path';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { ApiError, sendError } from '../../../src/lib/http.js';
import { paths } from '../../../src/config.js';

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

function isApiForbiddenBudget(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.statusCode === 403 && (e.code === 'BUDGET_EXCEEDED' || /budget|預算/i.test(e.message));
  }
  const any = e as { statusCode?: number; code?: string; message?: string };
  return (
    any?.statusCode === 403 &&
    (any?.code === 'BUDGET_EXCEEDED' || /budget|預算/i.test(String(any?.message ?? e)))
  );
}

async function costCount(agentId: string): Promise<number> {
  return prisma.costLog.count({ where: { agentId } });
}

async function main(): Promise<void> {
  console.log('── t16-model-gateway-negative ──');

  const tag = ulid().slice(-8).toLowerCase();
  const TOKEN = `t16-secret-${tag}`;
  const prevToken = process.env.AIOS_MODEL_GATEWAY_TOKEN;
  process.env.AIOS_MODEL_GATEWAY_TOKEN = TOKEN;

  const ownerId = ulid();
  const agentId = ulid();
  const agentSameFamilyId = ulid();
  const agentBudgetId = ulid();
  const skillId = ulid();
  const deploymentId = ulid();
  const inactiveDeploymentId = ulid();
  const runId = ulid();
  const runMismatchId = ulid();
  const runNativeId = ulid();
  const runEvilDirId = ulid();
  const runBudgetId = ulid();
  const runSameFamilyId = ulid();
  const artifactAltId = ulid();
  const budgetCostLogId = ulid();

  let skillVersionId = '';
  let artifactId = '';
  let artifactAltRealId = '';

  const contentMd = `# t16 model gateway negative ${tag}\n`;
  const trackedRunIds: string[] = [];
  const trackedAgentIds = [agentId, agentSameFamilyId, agentBudgetId];
  const trackedDeploymentIds = [deploymentId, inactiveDeploymentId];
  const trackedCostLogIds = [budgetCostLogId];

  // Spy for lib-layer cases (must not be called on reject paths).
  const spyCalls: unknown[] = [];
  const spyDispatch = async (args: {
    engine: string;
    kind: string;
    prompt: string;
    cwd: string;
    timeoutMs: number;
    restrictions: unknown;
    threadId?: string | null;
  }) => {
    spyCalls.push(args);
    return {
      text: '## Verdict\nAPPROVED',
      threadId: null as string | null,
      costInput: args.prompt,
    };
  };

  try {
    // ── Fixtures ──────────────────────────────────────────────────────────
    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t16-neg-owner-${tag}@aios.test`,
        displayName: 'T16 Neg Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t16-neg-agent-${tag}`,
        name: `T16 Neg Agent ${tag}`,
        description: 't16 negative primary',
        rolePrompt: 't16 test agent',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentSameFamilyId,
        slug: `t16-neg-samefam-${tag}`,
        name: `T16 SameFamily ${tag}`,
        description: 'engineVerify === engineExecute',
        rolePrompt: 't16 same family',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'CLAUDE_CODE',
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentBudgetId,
        slug: `t16-neg-budget-${tag}`,
        name: `T16 Budget ${tag}`,
        description: 'budget exhausted',
        rolePrompt: 't16 budget',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: { dailyBudgetUsd: 0.000001, hardStop: true },
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    // Seed spend over daily budget so guardBudget fails.
    await prisma.costLog.create({
      data: {
        id: budgetCostLogId,
        agentId: agentBudgetId,
        engine: 'CLAUDE_CODE',
        inputTokens: 100_000,
        outputTokens: 100_000,
        costUsd: new Prisma.Decimal('1.000000'),
        stepKey: 'seed',
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t16-neg-skill-${tag}`,
        name: `T16 Neg Skill ${tag}`,
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

    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 't16-neg-langflow',
      compilerVersion: `t16-neg-${tag}`,
      artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'langflow', tag },
      createdBy: ownerId,
    });
    artifactId = art.id;
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: { status: 'VALIDATED' },
    });

    // Second artifact for mismatch / inactive deployment uniqueness.
    const artAlt = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 't16-neg-langflow-alt',
      compilerVersion: `t16-neg-alt-${tag}`,
      artifactJson: { nodes: [{ id: 'n2' }], edges: [], kind: 'langflow', tag, alt: true },
      createdBy: ownerId,
    });
    artifactAltRealId = artAlt.id;
    await prisma.flowArtifact.update({
      where: { id: artifactAltRealId },
      data: { status: 'VALIDATED' },
    });
    void artifactAltId; // reserved id not used; real id from createFlowArtifact

    await prisma.runtimeDeployment.create({
      data: {
        id: deploymentId,
        artifactId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        runtimeBinding: {},
        active: true,
        deployedBy: ownerId,
      },
    });

    await prisma.runtimeDeployment.create({
      data: {
        id: inactiveDeploymentId,
        artifactId: artifactAltRealId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'STABLE',
        runtimeBinding: {},
        active: false,
        deployedBy: ownerId,
        deactivatedAt: new Date(),
      },
    });

    const goodRunDir = path.join(paths.runs, runId);
    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: goodRunDir,
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });
    trackedRunIds.push(runId);

    await prisma.run.create({
      data: {
        id: runMismatchId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runMismatchId),
        runtimeKind: 'LANGFLOW',
        // points at alt artifact; deployment still uses primary artifactId
        artifactId: artifactAltRealId,
      },
    });
    trackedRunIds.push(runMismatchId);

    await prisma.run.create({
      data: {
        id: runNativeId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runNativeId),
        runtimeKind: null,
        artifactId: null,
      },
    });
    trackedRunIds.push(runNativeId);

    await prisma.run.create({
      data: {
        id: runEvilDirId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: '/tmp/t16-evil',
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });
    trackedRunIds.push(runEvilDirId);

    await prisma.run.create({
      data: {
        id: runBudgetId,
        agentId: agentBudgetId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runBudgetId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });
    trackedRunIds.push(runBudgetId);

    await prisma.run.create({
      data: {
        id: runSameFamilyId,
        agentId: agentSameFamilyId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runSameFamilyId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });
    trackedRunIds.push(runSameFamilyId);

    const ownerJwt = await signAccess({
      sub: ownerId,
      email: `t16-neg-owner-${tag}@aios.test`,
      role: 'OWNER',
    });

    // ── Dynamic import (expected RED in Phase 1) ─────────────────────────
    let assertServiceRequest: typeof import('../../../src/lib/modelgateway.js').assertServiceRequest;
    let chooseVerifyEngine: typeof import('../../../src/lib/modelgateway.js').chooseVerifyEngine;
    let gatewayExecute: typeof import('../../../src/lib/modelgateway.js').gatewayExecute;
    let gatewayVerify: typeof import('../../../src/lib/modelgateway.js').gatewayVerify;
    let modelGatewayRoutes: typeof import('../../../src/routes/modelgateway.js').modelGatewayRoutes;

    try {
      const lib = await import('../../../src/lib/modelgateway.js');
      assertServiceRequest = lib.assertServiceRequest;
      chooseVerifyEngine = lib.chooseVerifyEngine;
      gatewayExecute = lib.gatewayExecute;
      gatewayVerify = lib.gatewayVerify;
    } catch (e) {
      fail('import src/lib/modelgateway.js', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit: missing lib module) ──`);
      return;
    }

    try {
      const routes = await import('../../../src/routes/modelgateway.js');
      modelGatewayRoutes = routes.modelGatewayRoutes;
    } catch (e) {
      fail('import src/routes/modelgateway.js', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit: missing routes module) ──`);
      return;
    }

    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    await app.register(modelGatewayRoutes);
    await app.ready();

    const baselineCost = await costCount(agentId);
    const baselineRun = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    check(
      baselineRun.executionModelFamily == null,
      'fixture: run.executionModelFamily is null',
      `got ${baselineRun.executionModelFamily}`,
    );

    async function assertNoSideEffects(label: string, spyBefore = 0): Promise<void> {
      const afterCost = await costCount(agentId);
      check(
        afterCost === baselineCost,
        `${label}: CostLog count unchanged`,
        `before=${baselineCost} after=${afterCost}`,
      );
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      check(
        run.executionModelFamily == null,
        `${label}: executionModelFamily still null`,
        `got ${run.executionModelFamily}`,
      );
      check(
        spyCalls.length === spyBefore,
        `${label}: spy dispatch not called`,
        `spyCalls=${spyCalls.length} expected=${spyBefore}`,
      );
    }

    const executePayload = {
      runId,
      deploymentId,
      agentId,
      prompt: 't16 negative probe',
    };

    // ── [1] unset token → 403 ────────────────────────────────────────────
    console.log('\n── [1] unset AIOS_MODEL_GATEWAY_TOKEN → 403 ──');
    {
      delete process.env.AIOS_MODEL_GATEWAY_TOKEN;
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: executePayload,
      });
      process.env.AIOS_MODEL_GATEWAY_TOKEN = TOKEN;
      check(r.statusCode === 403, '1 unset token HTTP 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('1');
    }

    // ── [2] missing Authorization → 401 ──────────────────────────────────
    console.log('\n── [2] missing Authorization → 401 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        payload: executePayload,
      });
      check(r.statusCode === 401, '2 missing auth HTTP 401', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('2');
    }

    // ── [3] wrong bearer → 403 ───────────────────────────────────────────
    console.log('\n── [3] wrong bearer → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: 'Bearer totally-wrong-token' },
        payload: executePayload,
      });
      check(r.statusCode === 403, '3 wrong bearer HTTP 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('3');
    }

    // ── [4] real OWNER JWT as bearer → 403 ───────────────────────────────
    console.log('\n── [4] OWNER JWT as bearer → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${ownerJwt}` },
        payload: executePayload,
      });
      check(r.statusCode === 403, '4 OWNER JWT HTTP 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('4');
    }

    // ── [5] non-loopback remoteAddress → 403 ─────────────────────────────
    console.log('\n── [5] remoteAddress 192.168.1.9 → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '192.168.1.9',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: executePayload,
      });
      check(r.statusCode === 403, '5 non-loopback HTTP 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('5');
    }

    // ── [6] strict body: extra engine / restrictions / modelFamily → 400 ─
    console.log('\n── [6] strict body extras → 400 ──');
    {
      const rEngine = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...executePayload, engine: 'GROK' },
      });
      check(rEngine.statusCode === 400, '6a extra engine → 400', `got ${rEngine.statusCode} body=${rEngine.body.slice(0, 200)}`);

      const rRest = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...executePayload, restrictions: {} },
      });
      check(rRest.statusCode === 400, '6b extra restrictions → 400', `got ${rRest.statusCode}`);

      const rFam = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...executePayload, modelFamily: 'openai' },
      });
      check(rFam.statusCode === 400, '6c extra modelFamily → 400', `got ${rFam.statusCode}`);
      await assertNoSideEffects('6');
    }

    // ── [7] forged ids → 404 ─────────────────────────────────────────────
    console.log('\n── [7] forged runId / deploymentId → 404 ──');
    {
      const rRun = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...executePayload, runId: ulid() },
      });
      check(rRun.statusCode === 404, '7a forged runId → 404', `got ${rRun.statusCode} body=${rRun.body.slice(0, 200)}`);

      const rDep = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...executePayload, deploymentId: ulid() },
      });
      check(rDep.statusCode === 404, '7b forged deploymentId → 404', `got ${rDep.statusCode} body=${rDep.body.slice(0, 200)}`);
      await assertNoSideEffects('7');
    }

    // ── [8] inactive deployment → 403 ────────────────────────────────────
    console.log('\n── [8] inactive deployment → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          runId: runMismatchId, // has artifactAlt; pair with inactive on that artifact
          deploymentId: inactiveDeploymentId,
          agentId,
          prompt: 'inactive',
        },
      });
      check(r.statusCode === 403, '8 inactive deployment → 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('8');
    }

    // ── [9] run.artifactId ≠ deployment.artifactId → 403 ─────────────────
    console.log('\n── [9] artifactId mismatch → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          runId: runMismatchId,
          deploymentId,
          agentId,
          prompt: 'mismatch',
        },
      });
      check(r.statusCode === 403, '9 artifact mismatch → 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('9');
    }

    // ── [10] caller agentId ≠ run.agentId → 403 ──────────────────────────
    console.log('\n── [10] agentId spoof → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          runId,
          deploymentId,
          agentId: agentSameFamilyId, // not the run's agent
          prompt: 'spoof agent',
        },
      });
      check(r.statusCode === 403, '10 agentId spoof → 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('10');
    }

    // ── [11] native run (runtimeKind null) → 403 ─────────────────────────
    console.log('\n── [11] native run → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          runId: runNativeId,
          deploymentId,
          agentId,
          prompt: 'native',
        },
      });
      check(r.statusCode === 403, '11 native run → 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('11');
    }

    // ── [12] runDir outside paths.runs → 403 ─────────────────────────────
    console.log('\n── [12] evil runDir → 403 ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          runId: runEvilDirId,
          deploymentId,
          agentId,
          prompt: 'evil dir',
        },
      });
      check(r.statusCode === 403, '12 evil runDir → 403', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      await assertNoSideEffects('12');
    }

    // ── [13] budget exhausted → lib gatewayExecute rejects; spy 0 ────────
    console.log('\n── [13] budget exhausted → BUDGET_EXCEEDED, spy=0 ──');
    {
      const budgetCostBefore = await costCount(agentBudgetId);
      spyCalls.length = 0;
      await throwsAsync(
        () =>
          gatewayExecute(
            {
              runId: runBudgetId,
              deploymentId,
              agentId: agentBudgetId,
              prompt: 'should not dispatch',
            },
            { dispatch: spyDispatch as never },
          ),
        '13 gatewayExecute throws BUDGET_EXCEEDED',
        isApiForbiddenBudget,
      );
      check(spyCalls.length === 0, '13 spy not called', `spyCalls=${spyCalls.length}`);
      const budgetCostAfter = await costCount(agentBudgetId);
      check(
        budgetCostAfter === budgetCostBefore,
        '13 CostLog count unchanged (budget agent)',
        `before=${budgetCostBefore} after=${budgetCostAfter}`,
      );
    }

    // ── [14] same-family engineVerify → server forces CODEX ──────────────
    console.log('\n── [14] same-family verify → spy engine=CODEX ──');
    {
      spyCalls.length = 0;
      try {
        const res = await gatewayVerify(
          {
            runId: runSameFamilyId,
            deploymentId,
            agentId: agentSameFamilyId,
            artifact: 'artifact text',
            rubric: 'must be ok',
          },
          { dispatch: spyDispatch as never },
        );
        const call = spyCalls[0] as { engine?: string } | undefined;
        check(
          call?.engine === 'CODEX',
          '14 spy received engine=CODEX',
          `engine=${call?.engine} spyCalls=${spyCalls.length} res=${JSON.stringify(res).slice(0, 120)}`,
        );
      } catch (e) {
        // If it throws before dispatch for some other reason, still fail clearly.
        const call = spyCalls[0] as { engine?: string } | undefined;
        if (call?.engine === 'CODEX') {
          pass('14 spy received engine=CODEX', 'even though gatewayVerify threw after dispatch');
        } else {
          fail('14 same-family verify', `threw: ${String(e)}; spy engine=${call?.engine}`);
        }
      }
    }

    // ── [15] chooseVerifyEngine unit matrix ──────────────────────────────
    console.log('\n── [15] chooseVerifyEngine unit ──');
    {
      check(
        chooseVerifyEngine('CLAUDE_CODE', 'CLAUDE_CODE') === 'CODEX',
        "15a chooseVerifyEngine('CLAUDE_CODE','CLAUDE_CODE')→CODEX",
        `got ${chooseVerifyEngine('CLAUDE_CODE', 'CLAUDE_CODE')}`,
      );
      check(
        chooseVerifyEngine('CODEX', null) === 'CLAUDE_CODE',
        "15b chooseVerifyEngine('CODEX',null)→CLAUDE_CODE",
        `got ${chooseVerifyEngine('CODEX', null)}`,
      );
      check(
        chooseVerifyEngine('GROK', null) === 'CLAUDE_CODE',
        "15c chooseVerifyEngine('GROK',null)→CLAUDE_CODE",
        `got ${chooseVerifyEngine('GROK', null)}`,
      );
      check(
        chooseVerifyEngine('CLAUDE_CODE', 'GROK') === 'GROK',
        "15d chooseVerifyEngine('CLAUDE_CODE','GROK')→GROK",
        `got ${chooseVerifyEngine('CLAUDE_CODE', 'GROK')}`,
      );
    }

    // Silence unused assertServiceRequest if only routes use it.
    void assertServiceRequest;

    await app.close().catch(() => undefined);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    if (prevToken === undefined) delete process.env.AIOS_MODEL_GATEWAY_TOKEN;
    else process.env.AIOS_MODEL_GATEWAY_TOKEN = prevToken;

    // CostLog (budget seed + any accidental writes)
    if (trackedCostLogIds.length) {
      await prisma.costLog.deleteMany({ where: { id: { in: trackedCostLogIds } } }).catch(() => undefined);
    }
    await prisma.costLog
      .deleteMany({ where: { agentId: { in: trackedAgentIds } } })
      .catch(() => undefined);

    if (trackedRunIds.length) {
      await prisma.run.deleteMany({ where: { id: { in: trackedRunIds } } }).catch(() => undefined);
    }

    if (trackedDeploymentIds.length) {
      await prisma.runtimeDeployment
        .deleteMany({ where: { id: { in: trackedDeploymentIds } } })
        .catch(() => undefined);
    }
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);

    if (skillVersionId) {
      await prisma.flowArtifact
        .deleteMany({ where: { skillVersionId } })
        .catch(() => undefined);
    }
    await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);

    await prisma.agent.deleteMany({ where: { id: { in: trackedAgentIds } } }).catch(() => undefined);
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
