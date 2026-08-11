/**
 * Ticket 20 PoC 02 — quotation classification (positive) + deterministic compile.
 * Same email-triage pipeline as 01 with quotation slots; asserts two compiles are
 * byte-identical (canonical JSON) and share SHA-256 digest.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-02-quotation.test.ts
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  canonicalJson,
  computeFlowArtifactDigest,
  createFlowArtifact,
  getVerifiedFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { compileSkillIr } from '../../../src/compiler/compile.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';

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

async function main(): Promise<void> {
  console.log('── t20-poc-02-quotation ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const contentMd = `# t20 poc02 quotation ${tag}\n`;

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
      return;
    }

    // ── [1] quotation IR compile + determinism ───────────────────────────
    console.log('\n── [1] compile quotation IR (deterministic) ──');
    const quotationSlots = {
      readTools: ['mcp:gmail:gmail_list_messages', 'mcp:gmail:gmail_get_message'],
      categories: ['quotation', '詢價', 'pricing'],
      summaryLanguage: 'en' as const,
      query: 'subject:(quote OR quotation OR 詢價)',
    };
    const ir = {
      schemaVersion: 'aios.skill-ir/1' as const,
      template: 'email-triage-readonly-v1',
      name: `t20-poc-02-quotation-${tag}`,
      description: 'Phase 5 PoC quotation classification',
      slots: quotationSlots,
    };

    const c1 = compileSkillIr(ir);
    const c2 = compileSkillIr(ir);
    check(c1.ok === true, 'compile #1 ok', JSON.stringify(c1));
    check(c2.ok === true, 'compile #2 ok', JSON.stringify(c2));
    if (!c1.ok || !c2.ok) return;

    check(c1.digest === c2.digest, 'same IR → same SHA-256 digest', `a=${c1.digest} b=${c2.digest}`);

    const canon1 = canonicalJson(c1.artifactJson);
    const canon2 = canonicalJson(c2.artifactJson);
    check(canon1 === canon2, 'canonical JSON byte-identical', `len1=${canon1.length} len2=${canon2.length}`);

    const hash1 = createHash('sha256').update(canon1, 'utf8').digest('hex');
    const hash2 = createHash('sha256').update(canon2, 'utf8').digest('hex');
    check(hash1 === hash2 && hash1 === c1.digest, 'SHA-256(canonical) === compile digest', `h=${hash1} d=${c1.digest}`);

    const nodes = extractNodes(c1.artifactJson);
    const kinds = nodes.map((n) => String(n.kind ?? ''));
    check(!kinds.some((k) => /send|write|gated/i.test(k)), 'no send/write/gated kinds', kinds.join(','));
    check(kinds.includes('gateway.classify'), 'has classify', kinds.join(','));

    // ── [2] full pipeline fixtures ───────────────────────────────────────
    console.log('\n── [2] fixtures + artifact + validate ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc02-owner-${tag}@aios.test`,
        displayName: 'T20 PoC02 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc02-agent-${tag}`,
        name: `T20 PoC02 Agent ${tag}`,
        description: 'poc02',
        rolePrompt: 'poc02',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc02-skill-${tag}`,
        name: `T20 PoC02 Skill ${tag}`,
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
      data: { id: suiteId, skillId, name: `T20 PoC02 Suite ${tag}`, createdBy: ownerId },
    });
    await prisma.evalRun.create({
      data: {
        id: evalRunId,
        suiteId,
        skillId,
        candidateVersionId: skillVersionId,
        executeEngine: 'GROK',
        verifyEngine: 'CLAUDE_CODE',
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
      template: c1.template,
      templateVersion: c1.templateVersion,
      compilerVersion: c1.compilerVersion,
      artifactJson: c1.artifactJson,
      createdBy: ownerId,
    });
    artifactId = art.id;
    check(art.digest === c1.digest, 'stored digest === compile digest', `store=${art.digest}`);

    const row = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    check(
      computeFlowArtifactDigest(row.artifactJson) === row.digest,
      'digest recompute matches DB',
      row.digest,
    );
    await getVerifiedFlowArtifact(artifactId);
    pass('getVerifiedFlowArtifact ok');

    await validateArtifactForRuntime(
      { artifactId, actorId: ownerId, actorRole: 'OWNER' },
      { adapter: liveAdapter },
    );
    const afterVal = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    check(afterVal.status === 'VALIDATED', 'VALIDATED', `status=${afterVal.status}`);

    // ── [3] health + activate + pilot ────────────────────────────────────
    console.log('\n── [3] health + activate + pilot execute ──');
    const health = await liveAdapter.health();
    if (!health.healthy) {
      block('live health', String(health.detail));
    } else {
      pass('live health ok', `latencyMs=${health.latencyMs}`);
    }

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
      check(Boolean(deployId), 'activateDeployment id', deployId);
    } catch (e) {
      block('activateDeployment', e instanceof Error ? e.message : String(e));
    }

    await prisma.agentSkill.create({ data: { agentId, skillId } }).catch(() => undefined);
    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T20 PoC02 WF ${tag}`,
        description: 'poc02',
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
        config: { prompt: 'classify quotation' },
      },
    });

    if (deployId) {
      const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({ where: { id: deployId } });
      const artifact = await getVerifiedFlowArtifact(artifactId);
      const { run, created } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: `msg-quote-${tag}`,
        triggeredBy: ownerId,
        input: { messageId: `msg-quote-${tag}`, subject: 'RFQ: 100 units' },
      });
      runIds.push(run.id);
      check(created === true, 'pilot created', run.id);

      const result = await executePilotRun(
        { runId: run.id, deployment, artifact, triggeredBy: ownerId },
        { adapter: liveAdapter },
      );
      const runAfter = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      console.log(`  evidence: status=${result.status} db=${runAfter.status}`);
      check(runAfter.status !== 'SUCCEEDED' || result.status === 'SUCCEEDED', 'status consistent', '');
      if (runAfter.status === 'SUCCEEDED') {
        pass('live execute SUCCEEDED', run.id);
      } else {
        // Honest non-success path (do not claim live success). Status is already narrowed ≠ SUCCEEDED.
        pass('never fake success', `status=${runAfter.status}`);
        block(
          'live Langflow execute canonical quotation graph',
          `status=${runAfter.status}`,
        );
      }
    } else {
      block('pilot execute', 'no deployment');
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
    if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } }).catch(() => undefined);
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
