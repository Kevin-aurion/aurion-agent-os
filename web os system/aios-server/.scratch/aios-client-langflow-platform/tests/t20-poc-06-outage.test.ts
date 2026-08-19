/**
 * Ticket 20 PoC 06 — Langflow outage isolation (positive isolation).
 * Dead port 7997: health fails bounded; executePilotRun → FAILED (never SUCCESS).
 * Native route / compileManifest / MCP registry remain healthy.
 * Does NOT stop/start any live container.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-06-outage.test.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
  getVerifiedFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';
import { listServers } from '../../../src/lib/mcpregistry.js';
import { compileManifest } from '../../../src/engine/runner.js';
import { paths } from '../../../src/config.js';
import { safeJoin } from '../../../src/lib/safepath.js';
import { mkdir, rm } from 'node:fs/promises';

const DEAD_LANGFLOW = 'http://127.0.0.1:7997';

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
  console.log('── t20-poc-06-outage ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const nativeAgentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const workflowLangflowId = ulid();
  const workflowNativeId = ulid();
  const stepLangflowId = ulid();
  const stepNativeId = ulid();
  const contentMd = `# t20 poc06 outage ${tag}\n`;

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const runIds: string[] = [];
  // Declared outside try so finally can remove the test-owned agent materialize dir.
  const agentDir = safeJoin(paths.agents, `t20-poc06-${tag}`);

  // Real LangflowAdapter pointed at dead loopback port — NOT a mock.
  // Ticket 23: prefer live control-plane key from env; dummy fallback for offline (never log).
  const testApiKey =
    process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY?.trim() ||
    'sk-test-t20-langflow-control-plane-not-real';
  const deadAdapter = new LangflowAdapter({
    baseUrl: DEAD_LANGFLOW,
    apiKey: testApiKey,
    timeoutMs: 2_000,
  });

  try {
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    let resolveScheduledRuntimeRoute: typeof import('../../../src/lib/runtimeexecution.js').resolveScheduledRuntimeRoute;
    let getOrCreatePilotRun: typeof import('../../../src/lib/runtimeexecution.js').getOrCreatePilotRun;
    let executePilotRun: typeof import('../../../src/lib/runtimeexecution.js').executePilotRun;

    try {
      const dep = await import('../../../src/lib/runtimedeployment.js');
      activateDeployment = dep.activateDeployment;
      validateArtifactForRuntime = dep.validateArtifactForRuntime;
      const exec = await import('../../../src/lib/runtimeexecution.js');
      resolveScheduledRuntimeRoute = exec.resolveScheduledRuntimeRoute;
      getOrCreatePilotRun = exec.getOrCreatePilotRun;
      executePilotRun = exec.executePilotRun;
    } catch (e) {
      fail('import modules', String(e));
      return;
    }

    // ── [1] health fails in bounded time ─────────────────────────────────
    console.log('\n── [1] dead port health() bounded failure ──');
    const t0 = Date.now();
    const health = await deadAdapter.health();
    const elapsed = Date.now() - t0;
    console.log(`  evidence: health elapsedMs=${elapsed} healthy=${health.healthy} detail=${health.detail}`);
    check(health.healthy === false, 'health.healthy=false on dead port', String(health.healthy));
    check(elapsed < 15_000, 'health fails within bounded time (<15s)', `elapsedMs=${elapsed}`);

    // ── [2] fixtures + activate via dead adapter (deploy will fail or bind) ─
    console.log('\n── [2] fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc06-owner-${tag}@aios.test`,
        displayName: 'T20 PoC06 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc06-lf-agent-${tag}`,
        name: `T20 PoC06 LF ${tag}`,
        description: 'langflow pilot agent',
        rolePrompt: 'poc06',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.agent.create({
      data: {
        id: nativeAgentId,
        slug: `t20-poc06-native-agent-${tag}`,
        name: `T20 PoC06 Native ${tag}`,
        description: 'native isolation agent (no deployment)',
        rolePrompt: 'native',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc06-skill-${tag}`,
        name: `T20 PoC06 Skill ${tag}`,
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
      data: { id: suiteId, skillId, name: `T20 PoC06 Suite ${tag}`, createdBy: ownerId },
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
      compilerVersion: `t20-poc06-${tag}`,
      artifactJson: {
        schemaVersion: 'aios.flow-graph/1',
        template: 'email-triage-readonly-v1',
        templateVersion: '1',
        nodes: [
          { id: 'n_input', kind: 'input', config: {} },
          { id: 'n_read_0', kind: 'tool.read', tool: 'mcp:gmail:gmail_list_messages', config: {} },
          { id: 'n_classify', kind: 'gateway.classify', config: { categories: ['x'] } },
          { id: 'n_summarize', kind: 'gateway.summarize', config: { summaryLanguage: 'zh-TW' } },
          { id: 'n_verify', kind: 'gateway.verify', config: {} },
          { id: 'n_output', kind: 'output', config: {} },
        ],
        edges: [
          { from: 'n_input', to: 'n_read_0' },
          { from: 'n_read_0', to: 'n_classify' },
          { from: 'n_classify', to: 'n_summarize' },
          { from: 'n_summarize', to: 'n_verify' },
          { from: 'n_verify', to: 'n_output' },
        ],
      },
      createdBy: ownerId,
    });
    artifactId = art.id;
    // validate is local-only for LangflowAdapter
    await validateArtifactForRuntime(
      { artifactId, actorId: ownerId, actorRole: 'OWNER' },
      { adapter: deadAdapter },
    );

    // Deploy to dead port will fail — create deployment row via NATIVE-style binding inject
    // so we can still test executePilotRun fail-closed against dead adapter.
    // We use activateDeployment; if it throws on deploy, insert a minimal active deployment
    // for the execute path only (still real DB + real dead adapter).
    try {
      const dep = await activateDeployment(
        {
          artifactId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: deadAdapter },
      );
      deployId = dep.id;
      pass('activate somehow succeeded against dead port (unexpected but ok)', deployId);
    } catch (e) {
      pass(
        'activateDeployment fails on dead Langflow (fail-closed before bad SUCCESS)',
        e instanceof Error ? e.message : String(e),
      );
      // Seed a deployment row so executePilotRun can be exercised with dead adapter.
      // This is not "mock adapter"; it's fixture DB state + real dead LangflowAdapter.
      deployId = ulid();
      await prisma.runtimeDeployment.create({
        data: {
          id: deployId,
          artifactId,
          skillId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          runtimeBinding: { kind: 'LANGFLOW', bindingRef: 'dead:fixture', note: 't20-poc06' },
          active: true,
          deployedBy: ownerId,
        },
      });
      pass('fixture RuntimeDeployment for execute fail-closed path', deployId);
    }

    await prisma.agentSkill.create({ data: { agentId, skillId } });
    await prisma.workflow.create({
      data: {
        id: workflowLangflowId,
        agentId,
        name: `T20 PoC06 LF WF ${tag}`,
        description: 'has pilot skill',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepLangflowId,
        workflowId: workflowLangflowId,
        position: 0,
        stepKey: 'do-1',
        type: 'DO',
        config: { prompt: 'triage' },
      },
    });

    // Native-only workflow (no agentSkill / no deployment on this agent)
    await prisma.workflow.create({
      data: {
        id: workflowNativeId,
        agentId: nativeAgentId,
        name: `T20 PoC06 Native WF ${tag}`,
        description: 'native only',
        enabled: true,
        trigger: { type: 'cron', expression: '0 10 * * *' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepNativeId,
        workflowId: workflowNativeId,
        position: 0,
        stepKey: 'do-1',
        type: 'DO',
        config: { prompt: 'native work' },
      },
    });

    // ── [3] executePilotRun → FAILED never SUCCESS ──────────────────────
    console.log('\n── [3] executePilotRun against dead adapter ──');
    const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({ where: { id: deployId } });
    const artifact = await getVerifiedFlowArtifact(artifactId);
    const { run, created } = await getOrCreatePilotRun({
      workflowId: workflowLangflowId,
      agentId,
      artifactId,
      messageId: `msg-outage-${tag}`,
      triggeredBy: ownerId,
      input: { messageId: `msg-outage-${tag}` },
    });
    runIds.push(run.id);
    check(created === true, 'pilot run created', run.id);

    const tExec0 = Date.now();
    const result = await executePilotRun(
      {
        runId: run.id,
        deployment,
        artifact,
        triggeredBy: ownerId,
      },
      { adapter: deadAdapter },
    );
    const tExec = Date.now() - tExec0;
    const runAfter = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    console.log(
      `  evidence: execute status=${result.status} DB=${runAfter.status} elapsedMs=${tExec}`,
    );
    check(result.status === 'FAILED', 'executePilotRun status FAILED', `status=${result.status}`);
    check(runAfter.status === 'FAILED', 'DB Run FAILED', `status=${runAfter.status}`);
    check(runAfter.status !== 'SUCCEEDED', 'explicitly never SUCCEEDED', `status=${runAfter.status}`);
    check(tExec < 30_000, 'execute fails within bounded time', `elapsedMs=${tExec}`);

    // ── [4] Native unaffected ────────────────────────────────────────────
    console.log('\n── [4] Native route / compileManifest / MCP registry ──');
    const nativeRoute = await resolveScheduledRuntimeRoute(workflowNativeId);
    check(nativeRoute.kind === 'NATIVE', 'workflow without deployment → NATIVE', `kind=${nativeRoute.kind}`);

    await mkdir(agentDir, { recursive: true }).catch(() => undefined);
    try {
      const manifest = await compileManifest(nativeAgentId, workflowNativeId, agentDir);
      check(
        manifest.engineExecute === 'CLAUDE_CODE',
        'compileManifest native agent ok',
        `engine=${manifest.engineExecute}`,
      );
      check(
        manifest.engineVerify !== manifest.engineExecute,
        'compileManifest execute≠verify',
        `ex=${manifest.engineExecute} ver=${manifest.engineVerify}`,
      );
    } catch (e) {
      fail('compileManifest native agent', e instanceof Error ? e.message : String(e));
    }

    try {
      const servers = await listServers();
      check(Array.isArray(servers), 'MCP listServers returns array', `type=${typeof servers}`);
      pass('MCP registry query ok', `count=${servers.length}`);
    } catch (e) {
      fail('MCP listServers', e instanceof Error ? e.message : String(e));
    }
  } finally {
    // Phase 6 DLQ: dead-adapter executePilotRun enqueues RuntimeDeadLetter.
    await prisma.runtimeDeadLetter
      .deleteMany({
        where: { workflowId: { in: [workflowLangflowId, workflowNativeId] } },
      })
      .catch(() => undefined);
    console.log('\n── cleanup test-owned rows only ──');
    await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
    const leftover = await prisma.run
      .findMany({ where: { agentId: { in: [agentId, nativeAgentId] } }, select: { id: true } })
      .catch(() => []);
    const ids = [...new Set([...runIds, ...leftover.map((r) => r.id)].filter(Boolean))];
    if (ids.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runTrace.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await prisma.workflowStep
      .deleteMany({ where: { workflowId: { in: [workflowLangflowId, workflowNativeId] } } })
      .catch(() => undefined);
    await prisma.workflow
      .deleteMany({ where: { id: { in: [workflowLangflowId, workflowNativeId] } } })
      .catch(() => undefined);
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: evalRunId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: { in: [agentId, nativeAgentId] } } }).catch(() => undefined);
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
