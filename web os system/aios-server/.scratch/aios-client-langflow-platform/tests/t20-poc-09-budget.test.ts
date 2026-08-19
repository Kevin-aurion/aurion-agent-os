/**
 * Ticket 20 PoC 09 — budget exhausted (negative).
 * costPolicy exhausted → gatewayExecute rejects before dispatch;
 * zero new execution CostLog after reject.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-09-budget.test.ts
 */
import { ulid } from 'ulid';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { ApiError } from '../../../src/lib/http.js';
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

async function main(): Promise<void> {
  console.log('── t20-poc-09-budget ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const deploymentId = ulid();
  const runId = ulid();
  const seedCostId = ulid();
  let skillVersionId = '';
  let artifactId = '';

  const spyCalls: unknown[] = [];
  const spyDispatch = async (args: {
    engine: string;
    kind: string;
    prompt: string;
    cwd: string;
    timeoutMs: number;
    restrictions: unknown;
  }) => {
    spyCalls.push(args);
    return {
      text: 'should-not-be-reached',
      threadId: null as string | null,
      costInput: args.prompt,
    };
  };

  try {
    let gatewayExecute: typeof import('../../../src/lib/modelgateway.js').gatewayExecute;
    try {
      const gw = await import('../../../src/lib/modelgateway.js');
      gatewayExecute = gw.gatewayExecute;
    } catch (e) {
      fail('import modelgateway', String(e));
      return;
    }

    console.log('── setup budget-exhausted agent ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc09-owner-${tag}@aios.test`,
        displayName: 'T20 PoC09 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc09-agent-${tag}`,
        name: `T20 PoC09 Agent ${tag}`,
        description: 'budget exhausted',
        rolePrompt: 'poc09',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        costPolicy: { dailyBudgetUsd: 0.01, monthlyBudgetUsd: 0.01, hardStop: true },
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    // Seed spend well over budget BEFORE any gateway call.
    await prisma.costLog.create({
      data: {
        id: seedCostId,
        agentId,
        engine: 'CLAUDE_CODE',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: new Prisma.Decimal('999.000000'),
        stepKey: 'seed-pre-budget',
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc09-skill-${tag}`,
        name: `T20 PoC09 Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# t20 poc09 ${tag}\n`,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, `# t20 poc09 ${tag}\n`, ownerId);
    skillVersionId = sv.id;
    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t20-poc09-${tag}`,
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

    await prisma.runtimeDeployment.create({
      data: {
        id: deploymentId,
        artifactId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        runtimeBinding: { kind: 'LANGFLOW', bindingRef: 't20-poc09' },
        active: true,
        deployedBy: ownerId,
      },
    });

    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: ownerId,
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });

    const costBefore = await prisma.costLog.count({ where: { agentId } });
    const execCostBefore = await prisma.costLog.count({
      where: { agentId, stepKey: { not: 'seed-pre-budget' } },
    });
    console.log(
      `  evidence: CostLog total before=${costBefore} non-seed=${execCostBefore} spyCalls=${spyCalls.length}`,
    );

    // ── [1] gatewayExecute rejects before dispatch ───────────────────────
    console.log('\n── [1] gatewayExecute budget fail-closed ──');
    try {
      await gatewayExecute(
        {
          runId,
          deploymentId,
          agentId,
          prompt: 't20 poc09 should be rejected before model dispatch',
          stepKey: 'poc09-attempt',
        },
        { dispatch: spyDispatch },
      );
      fail('gatewayExecute throws BUDGET_EXCEEDED', 'no throw — dispatch may have run');
    } catch (e) {
      const ok =
        e instanceof ApiError &&
        e.statusCode === 403 &&
        (e.code === 'BUDGET_EXCEEDED' || /budget|預算/i.test(e.message));
      check(ok, 'gatewayExecute → 403 BUDGET_EXCEEDED', String(e));
    }

    check(spyCalls.length === 0, 'spy dispatch NOT called (reject before dispatch)', `spyCalls=${spyCalls.length}`);

    const costAfter = await prisma.costLog.count({ where: { agentId } });
    const execCostAfter = await prisma.costLog.count({
      where: { agentId, NOT: { id: seedCostId } },
    });
    console.log(
      `  evidence: CostLog total after=${costAfter} non-seed=${execCostAfter} spyCalls=${spyCalls.length}`,
    );
    check(costAfter === costBefore, 'CostLog total unchanged after reject', `before=${costBefore} after=${costAfter}`);
    check(
      execCostAfter === 0,
      'zero new execution CostLog (only seed remains)',
      `non-seed count=${execCostAfter}`,
    );

    // ── [2] pilot executePilotRun also budget-fails ──────────────────────
    console.log('\n── [2] executePilotRun budget path ──');
    let executePilotRun: typeof import('../../../src/lib/runtimeexecution.js').executePilotRun;
    try {
      const exec = await import('../../../src/lib/runtimeexecution.js');
      executePilotRun = exec.executePilotRun;
    } catch (e) {
      fail('import runtimeexecution', String(e));
      return;
    }

    // Real LangflowAdapter dead port — if budget check runs first, adapter never called.
    const { LangflowAdapter } = await import('../../../src/runtime/langflow.js');
    // Ticket 23: prefer live control-plane key from env; dummy fallback for offline (never log).
    const testApiKey =
      process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY?.trim() ||
      'sk-test-t20-langflow-control-plane-not-real';
    const deadAdapter = new LangflowAdapter({
      baseUrl: 'http://127.0.0.1:7997',
      apiKey: testApiKey,
      timeoutMs: 1_500,
    });

    const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({
      where: { id: deploymentId },
    });
    const artifact = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });

    const pilotRunId = ulid();
    await prisma.run.create({
      data: {
        id: pilotRunId,
        agentId,
        triggeredBy: ownerId,
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, pilotRunId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });

    const costBeforePilot = await prisma.costLog.count({ where: { agentId } });
    const pilotResult = await executePilotRun(
      {
        runId: pilotRunId,
        deployment,
        artifact,
        triggeredBy: ownerId,
      },
      { adapter: deadAdapter },
    );
    const pilotRun = await prisma.run.findUniqueOrThrow({ where: { id: pilotRunId } });
    console.log(`  evidence: pilot status=${pilotResult.status} DB=${pilotRun.status}`);
    check(pilotResult.status === 'FAILED', 'pilot execute FAILED on budget', `status=${pilotResult.status}`);
    check(pilotRun.status === 'FAILED', 'DB pilot FAILED', `status=${pilotRun.status}`);
    check(pilotRun.status !== 'SUCCEEDED', 'pilot never SUCCEEDED', `status=${pilotRun.status}`);

    const out = JSON.stringify(pilotRun.output ?? {});
    check(
      /BUDGET|budget|預算/i.test(out),
      'pilot output records BUDGET_EXCEEDED (before adapter dispatch)',
      out.slice(0, 200),
    );

    const costAfterPilot = await prisma.costLog.count({ where: { agentId } });
    check(
      costAfterPilot === costBeforePilot,
      'pilot budget reject: CostLog count unchanged',
      `before=${costBeforePilot} after=${costAfterPilot}`,
    );

    // cleanup pilot run in finally via agentId sweep
    void pilotRunId;
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.costLog.deleteMany({ where: { agentId } }).catch(() => undefined);
    await prisma.run.deleteMany({ where: { agentId } }).catch(() => undefined);
    await prisma.runtimeDeployment.deleteMany({ where: { id: deploymentId } }).catch(() => undefined);
    if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
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
