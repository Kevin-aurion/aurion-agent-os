/**
 * Ticket 20 PoC 03 — refund escalation (negative / HITL).
 * approval-gated-action-v1: checkpoint before unique write; resume without
 * real APPROVED ApprovalRequest must reject (Langflow-side approve has no authority).
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-03-refund.test.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  createFlowArtifact,
  getVerifiedFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { compileSkillIr } from '../../../src/compiler/compile.js';
import { createApproval } from '../../../src/lib/approval.js';
import { ApiError } from '../../../src/lib/http.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';
import { RuntimeAdapterError } from '../../../src/runtime/adapter.js';
import { paths } from '../../../src/config.js';
import { safeJoin } from '../../../src/lib/safepath.js';

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

function extractEdges(artifactJson: unknown): Array<{ from: string; to: string }> {
  if (!artifactJson || typeof artifactJson !== 'object') return [];
  const edges = (artifactJson as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return [];
  return edges
    .filter(
      (e): e is { from: string; to: string } =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as { from?: unknown }).from === 'string' &&
        typeof (e as { to?: unknown }).to === 'string',
    )
    .map((e) => ({ from: e.from, to: e.to }));
}

function hasAncestor(
  edges: Array<{ from: string; to: string }>,
  nodeId: string,
  ancestorKind: string,
  nodes: Array<Record<string, unknown>>,
): boolean {
  const reverse = new Map<string, string[]>();
  for (const e of edges) {
    const list = reverse.get(e.to) ?? [];
    list.push(e.from);
    reverse.set(e.to, list);
  }
  const visited = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const p of reverse.get(cur) ?? []) {
      const node = nodes.find((n) => String(n.id ?? '') === p);
      if (node && String(node.kind ?? '') === ancestorKind) return true;
      queue.push(p);
    }
  }
  return false;
}

async function main(): Promise<void> {
  console.log('── t20-poc-03-refund ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const suiteId = ulid();
  const evalRunId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const contentMd = `# t20 poc03 refund ${tag}\n`;

  let skillVersionId = '';
  let artifactId = '';
  let deployId = '';
  const runIds: string[] = [];

  // Ticket 23: FDE sandbox @ 7860 uses fixed local-only placeholder — never Production key.
  const liveAdapter = new LangflowAdapter({
    baseUrl: LIVE_LANGFLOW,
    apiKey: 'sandbox-flow-api-key-not-production-local-only-v1',
    timeoutMs: 10_000,
  });

  try {
    let activateDeployment: typeof import('../../../src/lib/runtimedeployment.js').activateDeployment;
    let validateArtifactForRuntime: typeof import('../../../src/lib/runtimedeployment.js').validateArtifactForRuntime;
    let executePilotRun: typeof import('../../../src/lib/runtimeexecution.js').executePilotRun;
    let resumePilotRun: typeof import('../../../src/lib/runtimeexecution.js').resumePilotRun;
    let getOrCreatePilotRun: typeof import('../../../src/lib/runtimeexecution.js').getOrCreatePilotRun;

    try {
      const dep = await import('../../../src/lib/runtimedeployment.js');
      activateDeployment = dep.activateDeployment;
      validateArtifactForRuntime = dep.validateArtifactForRuntime;
      const exec = await import('../../../src/lib/runtimeexecution.js');
      executePilotRun = exec.executePilotRun;
      resumePilotRun = exec.resumePilotRun;
      getOrCreatePilotRun = exec.getOrCreatePilotRun;
    } catch (e) {
      fail('import modules', String(e));
      return;
    }

    // ── [1] compile: checkpoint before unique write ──────────────────────
    console.log('\n── [1] compile approval-gated refund IR ──');
    const ir = {
      schemaVersion: 'aios.skill-ir/1' as const,
      template: 'approval-gated-action-v1',
      name: `t20-poc-03-refund-${tag}`,
      description: 'refund escalation needs FDE approval before write',
      slots: {
        approval: {
          reason: '退款金額超過門檻，需 FDE 核准後才可回覆客戶',
          risk: 'high' as const,
        },
        taskDescription: '讀取退款請求郵件，整理退款金額與原因，經核准後回覆客戶',
        readTools: ['mcp:gmail:gmail_list_messages', 'mcp:gmail:gmail_get_message'],
        writeTool: 'mcp:gmail:gmail_send_reply',
      },
    };
    const compiled = compileSkillIr(ir);
    check(compiled.ok === true, 'refund IR compile ok', JSON.stringify(compiled));
    if (!compiled.ok) return;

    const nodes = extractNodes(compiled.artifactJson);
    const edges = extractEdges(compiled.artifactJson);
    const gated = nodes.filter((n) => n.kind === 'tool.gated');
    const checkpoints = nodes.filter((n) => n.kind === 'approval.checkpoint');
    check(gated.length === 1, 'exactly 1 write (tool.gated)', `count=${gated.length}`);
    check(checkpoints.length === 1, 'exactly 1 approval.checkpoint', `count=${checkpoints.length}`);

    if (gated.length === 1) {
      const gatedId = String(gated[0]!.id ?? '');
      const ok = hasAncestor(edges, gatedId, 'approval.checkpoint', nodes);
      check(ok, 'approval.checkpoint is ancestor of unique write node', `gatedId=${gatedId}`);
      // Order evidence: edge checkpoint → action
      const direct = edges.some(
        (e) => e.from === String(checkpoints[0]?.id ?? '') && e.to === gatedId,
      );
      check(direct, 'edge checkpoint → gated write', JSON.stringify(edges));
    }

    const cp = checkpoints[0];
    if (cp) {
      const cfg = (cp.config ?? {}) as Record<string, unknown>;
      check(cfg.authority === 'AIOS', "checkpoint authority='AIOS'", JSON.stringify(cfg));
      check(cfg.emits === 'approval.required', "emits='approval.required'", JSON.stringify(cfg));
      check(
        cfg.resumeRequires === 'aios.approvalRequest.APPROVED',
        "resumeRequires='aios.approvalRequest.APPROVED'",
        JSON.stringify(cfg),
      );
    }

    // ── [2] fixtures ─────────────────────────────────────────────────────
    console.log('\n── [2] fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc03-owner-${tag}@aios.test`,
        displayName: 'T20 PoC03 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc03-agent-${tag}`,
        name: `T20 PoC03 Agent ${tag}`,
        description: 'poc03',
        rolePrompt: 'poc03',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        createdBy: ownerId,
        riskTier: 'high',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc03-skill-${tag}`,
        name: `T20 PoC03 Skill ${tag}`,
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
      data: { id: suiteId, skillId, name: `T20 PoC03 Suite ${tag}`, createdBy: ownerId },
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
    await validateArtifactForRuntime(
      { artifactId, actorId: ownerId, actorRole: 'OWNER' },
      { adapter: liveAdapter },
    );

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
      pass('activateDeployment ok', deployId);
    } catch (e) {
      block('activateDeployment live', e instanceof Error ? e.message : String(e));
    }

    await prisma.agentSkill.create({ data: { agentId, skillId } }).catch(() => undefined);
    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T20 PoC03 WF ${tag}`,
        description: 'poc03',
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
        config: { prompt: 'refund' },
      },
    });

    // ── [3] execute path: no write before ApprovalRequest ────────────────
    console.log('\n── [3] executePilotRun fail-closed before write ──');
    // approval-gated is NOT in PILOT_READONLY_TEMPLATES → execute fails before adapter write.
    // If deploy exists, prove execute never SUCCEEDS / never dispatches write without approval.
    if (deployId) {
      const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({ where: { id: deployId } });
      const artifact = await getVerifiedFlowArtifact(artifactId);
      const { run, created } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: `msg-refund-exec-${tag}`,
        triggeredBy: ownerId,
        input: { messageId: `msg-refund-exec-${tag}`, body: 'please refund $500' },
      });
      runIds.push(run.id);
      check(created === true, 'pilot run created', run.id);

      const beforeApprovalCount = await prisma.approvalRequest.count({ where: { runId: run.id } });
      console.log(`  evidence: ApprovalRequest count before execute=${beforeApprovalCount}`);

      const result = await executePilotRun(
        { runId: run.id, deployment, artifact, triggeredBy: ownerId },
        { adapter: liveAdapter },
      );
      const runAfter = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      console.log(`  evidence: execute status=${result.status} DB=${runAfter.status}`);

      // Must never succeed without HITL (write side effect gate).
      check(
        runAfter.status !== 'SUCCEEDED',
        'Run never SUCCEEDED without FDE approval (fail-closed)',
        `status=${runAfter.status}`,
      );

      if (runAfter.status === 'AWAITING_REVIEW') {
        const ar = await prisma.approvalRequest.findUnique({ where: { runId: run.id } });
        check(
          ar != null && ar.status === 'PENDING',
          'ApprovalRequest PENDING exists before any write resume',
          `status=${ar?.status}`,
        );
        pass('live path produced AWAITING_REVIEW + ApprovalRequest');
      } else if (runAfter.status === 'FAILED') {
        // Expected when template not in pilot readonly whitelist OR Langflow env.
        const out = JSON.stringify(runAfter.output ?? {});
        if (/whitelist|not in pilot/i.test(out)) {
          pass(
            'pilot whitelist rejects approval-gated before write dispatch',
            out.slice(0, 120),
          );
        } else {
          block(
            'live refund execute (Langflow/env)',
            `status=FAILED output=${out.slice(0, 160)} — AIOS held fail-closed (not SUCCESS)`,
          );
        }
      }
    } else {
      block('execute path', 'no deployment; covering resume gates with fixture Run');
    }

    // ── [4] resume without APPROVED → reject (zero side effect) ──────────
    console.log('\n── [4] resume without APPROVED ApprovalRequest ──');
    // Fixture Run in AWAITING_REVIEW with PENDING (not APPROVED) ApprovalRequest.
    const heldRunId = ulid();
    runIds.push(heldRunId);
    await prisma.run.create({
      data: {
        id: heldRunId,
        agentId,
        workflowId,
        triggeredBy: ownerId,
        status: 'AWAITING_REVIEW',
        input: { body: 'refund hold fixture' },
        runtimeKind: 'LANGFLOW',
        artifactId: artifactId || null,
        runDir: safeJoin(paths.runs, heldRunId),
      },
    });
    const pending = await createApproval({
      runId: heldRunId,
      agentId,
      reason: 'refund fixture pending',
      payload: { source: 't20-poc-03' },
    });
    const pendingRow = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    check(pendingRow.status === 'PENDING', 'fixture ApprovalRequest PENDING', pendingRow.status);

    // 4a resumePilotRun with PENDING
    try {
      await resumePilotRun(
        {
          runId: heldRunId,
          approvalRequestId: pending.id,
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: liveAdapter },
      );
      fail('resumePilotRun PENDING throws', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 403,
        'resumePilotRun PENDING → 403 forbidden',
        String(e),
      );
    }
    const stillHeld = await prisma.run.findUniqueOrThrow({ where: { id: heldRunId } });
    check(
      stillHeld.status === 'AWAITING_REVIEW',
      'Run stays AWAITING_REVIEW after rejected resume',
      `status=${stillHeld.status}`,
    );

    // 4b fake approval id
    try {
      await resumePilotRun(
        {
          runId: heldRunId,
          approvalRequestId: 'fake-not-in-db',
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: liveAdapter },
      );
      fail('resumePilotRun fake id throws', 'no throw');
    } catch (e) {
      check(
        e instanceof ApiError && e.statusCode === 403,
        'resumePilotRun fake id → 403',
        String(e),
      );
    }

    // 4c LangflowAdapter.resumeRun without approved (isRunApproved false)
    try {
      await liveAdapter.resumeRun({
        runId: heldRunId,
        approvalRequestId: pending.id,
      });
      fail('adapter.resumeRun without APPROVED throws', 'no throw');
    } catch (e) {
      const ok =
        e instanceof RuntimeAdapterError &&
        (e.code === 'NOT_APPROVED' || /not approved/i.test(e.message));
      check(ok, 'adapter.resumeRun NOT_APPROVED (Langflow approve has no authority)', String(e));
    }

    // 4d still PENDING in DB — zero approve side effect
    const arAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    check(arAfter.status === 'PENDING', 'ApprovalRequest still PENDING (no write path)', arAfter.status);
    console.log(
      `  evidence: before/after ApprovalRequest status=PENDING id=${pending.id}; Run=${stillHeld.status}`,
    );
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
