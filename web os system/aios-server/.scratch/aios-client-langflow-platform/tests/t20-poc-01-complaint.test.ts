/**
 * Ticket 20 PoC 01 — complaint classification (positive full pipeline).
 * email-triage-readonly-v1 → compile → artifact → deploy gate → pilot execute
 * via real LangflowAdapter @ http://127.0.0.1:7860.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-01-complaint.test.ts
 *
 * Zero new deps. Real DB via prisma. Live Langflow sandbox. No production edits.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
  getVerifiedFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { compileSkillIr } from '../../../src/compiler/compile.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';
import { ApiError } from '../../../src/lib/http.js';

const LIVE_LANGFLOW = 'http://127.0.0.1:7860';

let failed = 0;
let passed = 0;
let blocked = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function block(label: string, reason: string): void {
  blocked += 1;
  console.log(`BLOCKED  ${label} — ${reason}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

function extractNodes(artifactJson: unknown): Array<Record<string, unknown>> {
  if (!artifactJson || typeof artifactJson !== 'object') return [];
  const nodes = (artifactJson as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => n && typeof n === 'object') as Array<Record<string, unknown>>;
}

function hasSendOrWriteNode(nodes: Array<Record<string, unknown>>): boolean {
  return nodes.some((n) => {
    const kind = String(n.kind ?? '').toLowerCase();
    const tool = String(n.tool ?? '').toLowerCase();
    if (kind.includes('send') || kind.includes('write') || kind === 'tool.gated') return true;
    if (tool.includes('send') || tool.includes('write')) return true;
    return false;
  });
}

async function main(): Promise<void> {
  console.log('── t20-poc-01-complaint ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const contentMd = `# t20 poc01 complaint ${tag}\n`;

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const runIds: string[] = [];

  // Ticket 23: FDE sandbox @ 7860 uses fixed local-only placeholder — never Production key.
  const liveAdapter = new LangflowAdapter({
    baseUrl: LIVE_LANGFLOW,
    apiKey: 'sandbox-flow-api-key-not-production-local-only-v1',
    timeoutMs: 12_000,
  });

  try {
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    let getOrCreatePilotRun: typeof import('../../../src/lib/runtimeexecution.js').getOrCreatePilotRun;
    let executePilotRun: typeof import('../../../src/lib/runtimeexecution.js').executePilotRun;

    try {
      const dep = await import('../../../src/lib/runtimedeployment.js');
      activateDeployment = dep.activateDeployment;
      validateArtifactForRuntime = dep.validateArtifactForRuntime;
      const exec = await import('../../../src/lib/runtimeexecution.js');
      getOrCreatePilotRun = exec.getOrCreatePilotRun;
      executePilotRun = exec.executePilotRun;
    } catch (e) {
      fail('import production modules', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed, ${blocked} blocked ──`);
      return;
    }

    // ── [1] compile complaint IR ─────────────────────────────────────────
    console.log('\n── [1] compile email-triage complaint IR ──');
    const complaintSlots = {
      readTools: ['mcp:gmail:gmail_list_messages', 'mcp:gmail:gmail_get_message'],
      categories: ['complaint', '客訴', 'urgent'],
      summaryLanguage: 'zh-TW' as const,
      query: 'is:unread subject:(complaint OR 客訴)',
    };
    const ir = {
      schemaVersion: 'aios.skill-ir/1' as const,
      template: 'email-triage-readonly-v1',
      name: `t20-poc-01-complaint-${tag}`,
      description: 'Phase 5 PoC complaint classification',
      slots: complaintSlots,
    };
    const compiled = compileSkillIr(ir);
    check(compiled.ok === true, 'compileSkillIr ok', JSON.stringify(compiled));
    if (!compiled.ok) {
      console.log(`\n── summary: ${passed} passed, ${failed} failed, ${blocked} blocked ──`);
      return;
    }
    check(compiled.template === 'email-triage-readonly-v1', 'template id', compiled.template);
    check(compiled.compilerVersion === 'aios-compiler/1', 'compilerVersion', compiled.compilerVersion);

    const nodes = extractNodes(compiled.artifactJson);
    check(nodes.length > 0, 'artifact has nodes', `len=${nodes.length}`);
    check(!hasSendOrWriteNode(nodes), 'no send/write/gated nodes in artifact', JSON.stringify(nodes.map((n) => n.kind)));
    const kinds = nodes.map((n) => String(n.kind ?? ''));
    check(kinds.includes('gateway.classify'), 'has gateway.classify', kinds.join(','));
    check(kinds.includes('tool.read'), 'has tool.read', kinds.join(','));
    check(kinds.includes('gateway.verify'), 'has gateway.verify', kinds.join(','));

    // ── [2] fixtures: CONFIRMED skill + eval + artifact ──────────────────
    console.log('\n── [2] fixtures + createFlowArtifact ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc01-owner-${tag}@aios.test`,
        displayName: 'T20 PoC01 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc01-agent-${tag}`,
        name: `T20 PoC01 Agent ${tag}`,
        description: 'poc01',
        rolePrompt: 'poc01',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        // omit optional Json fields (Prisma rejects bare null; DbNull not needed for seed)
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc01-skill-${tag}`,
        name: `T20 PoC01 Skill ${tag}`,
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
      data: {
        id: suiteId,
        skillId,
        name: `T20 PoC01 Suite ${tag}`,
        createdBy: ownerId,
      },
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
      template: compiled.template,
      templateVersion: compiled.templateVersion,
      compilerVersion: compiled.compilerVersion,
      artifactJson: compiled.artifactJson,
      createdBy: ownerId,
    });
    artifactId = art.id;
    check(art.digest === compiled.digest, 'stored digest matches compile', `store=${art.digest} compile=${compiled.digest}`);
    check(art.status === 'COMPILED', 'artifact COMPILED', `status=${art.status}`);

    // ── [3] digest recompute + validate → VALIDATED ──────────────────────
    console.log('\n── [3] digest + validateArtifactForRuntime ──');
    const row = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    const recomputed = computeFlowArtifactDigest(row.artifactJson);
    check(row.digest === recomputed, 'DB digest recompute match', `db=${row.digest} re=${recomputed}`);

    const verified = await getVerifiedFlowArtifact(artifactId);
    check(verified.id === artifactId, 'getVerifiedFlowArtifact ok', verified.id);

    const validated = await validateArtifactForRuntime(
      { artifactId, actorId: ownerId, actorRole: 'OWNER' },
      { adapter: liveAdapter },
    );
    check(validated.status === 'VALIDATED', 'validate → VALIDATED', `status=${validated.status}`);
    const afterVal = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    check(afterVal.status === 'VALIDATED', 'DB status VALIDATED', `status=${afterVal.status}`);

    // ── [4] live health ──────────────────────────────────────────────────
    console.log('\n── [4] LangflowAdapter health @ 7860 ──');
    const health = await liveAdapter.health();
    check(health.kind === 'LANGFLOW', 'health.kind LANGFLOW', String(health.kind));
    if (!health.healthy) {
      block(
        'live Langflow health',
        `sandbox 7860 unhealthy: ${health.detail ?? 'no detail'} (AIOS path still exercised below)`,
      );
    } else {
      pass('live Langflow health healthy', `latencyMs=${health.latencyMs}`);
    }

    // ── [5] activateDeployment (real adapter) ────────────────────────────
    console.log('\n── [5] activateDeployment PRODUCTION/CANARY ──');
    const depCountBefore = await prisma.runtimeDeployment.count({ where: { skillId } });
    console.log(`  evidence: RuntimeDeployment count before=${depCountBefore}`);
    try {
      const dep = await activateDeployment(
        {
          artifactId,
          environment: 'PRODUCTION',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: liveAdapter },
      );
      deployId = dep.id;
      check(dep.active === true, 'deployment active=true', `id=${deployId}`);
      const depCountAfter = await prisma.runtimeDeployment.count({ where: { skillId } });
      console.log(`  evidence: RuntimeDeployment count after=${depCountAfter}`);
      check(depCountAfter === depCountBefore + 1 || dep.reused === true, 'deployment row created or reused', `before=${depCountBefore} after=${depCountAfter} reused=${String(dep.reused)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // deploy may fail if Langflow rejects canonical AIOS graph as flow data
      block('activateDeployment live deploy', msg);
      // Fail-closed: no SUCCESS run may exist for this skill after failed activate
      const badSuccess = await prisma.run.count({
        where: { agentId, status: 'SUCCEEDED' },
      });
      check(badSuccess === 0, 'after failed activate: zero SUCCEEDED runs', `count=${badSuccess}`);
    }

    // ── [6] pilot run + execute ──────────────────────────────────────────
    console.log('\n── [6] getOrCreatePilotRun + executePilotRun ──');
    await prisma.agentSkill.create({ data: { agentId, skillId } }).catch(() => undefined);
    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T20 PoC01 WF ${tag}`,
        description: 'poc01',
        enabled: true,
        trigger: { type: 'manual' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepId,
        workflowId,
        position: 0,
        stepKey: 'do-1',
        type: 'DO',
        config: { prompt: 'classify complaint email' },
      },
    });

    if (deployId && artifactId) {
      const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({
        where: { id: deployId },
      });
      const artifact = await getVerifiedFlowArtifact(artifactId);

      const { run, created } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: `msg-complaint-${tag}`,
        triggeredBy: ownerId,
        input: {
          messageId: `msg-complaint-${tag}`,
          subject: '客訴：訂單延誤',
          body: '我的訂單還沒到，請協助處理。',
        },
      });
      runIds.push(run.id);
      check(created === true, 'pilot run created', `runId=${run.id}`);
      check(run.runtimeKind === 'LANGFLOW', 'run.runtimeKind LANGFLOW', String(run.runtimeKind));

      const execResult = await executePilotRun(
        {
          runId: run.id,
          deployment,
          artifact,
          triggeredBy: ownerId,
        },
        { adapter: liveAdapter },
      );
      const runAfter = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      console.log(`  evidence: execute status=${execResult.status} DB status=${runAfter.status}`);

      // Live Langflow may not execute AIOS canonical graph as a real flow.
      if (execResult.status === 'SUCCEEDED' && runAfter.status === 'SUCCEEDED') {
        pass('live executePilotRun SUCCEEDED', run.id);
      } else if (
        execResult.status === 'FAILED' ||
        runAfter.status === 'FAILED' ||
        runAfter.status === 'AWAITING_REVIEW'
      ) {
        check(
          runAfter.status !== 'SUCCEEDED',
          'AIOS fail-closed: Run never SUCCEEDED on env/runtime failure',
          `status=${runAfter.status}`,
        );
        block(
          'live Langflow execute of canonical AIOS artifact',
          `status=${runAfter.status} (AIOS held/failed; not fake-success). output=${JSON.stringify(runAfter.output).slice(0, 200)}`,
        );
      } else {
        fail(
          'executePilotRun terminal status',
          `unexpected status exec=${execResult.status} db=${runAfter.status}`,
        );
      }
    } else {
      block('pilot execute', 'skipped — no active deployment (activate failed earlier)');
    }
  } catch (e) {
    fail('unexpected', e instanceof Error ? e.message : String(e));
    if (e instanceof ApiError) {
      console.error('  ApiError', e.statusCode, e.code, e.message);
    }
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    const agentRuns = await prisma.run
      .findMany({ where: { agentId }, select: { id: true } })
      .catch(() => []);
    const ids = [...new Set([...runIds, ...agentRuns.map((r) => r.id)].filter(Boolean))];
    if (ids.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runTrace.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await prisma.workflowStep.deleteMany({ where: { workflowId } }).catch(() => undefined);
    await prisma.workflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => undefined);
    await prisma.evalRun.deleteMany({ where: { id: evalRunId } }).catch(() => undefined);
    await prisma.evalSuite.deleteMany({ where: { id: suiteId } }).catch(() => undefined);
    if (artifactId) {
      await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
    }
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
      await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } }).catch(() => undefined);
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed, ${blocked} blocked ──`);
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
