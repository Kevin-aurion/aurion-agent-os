/**
 * Ticket 20 PoC 05 — duplicate messageId (negative / idempotency).
 * Same messageId twice → created=false, same Run id; concurrent Promise.all → one Run.
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-05-duplicate.test.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';

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
  console.log('── t20-poc-05-duplicate ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const workflowId = ulid();
  let skillVersionId = '';
  let artifactId = '';
  const runIds: string[] = [];

  try {
    let getOrCreatePilotRun: typeof import('../../../src/lib/runtimeexecution.js').getOrCreatePilotRun;
    let buildPilotIdempotencyKey: typeof import('../../../src/lib/runtimeexecution.js').buildPilotIdempotencyKey;
    try {
      const exec = await import('../../../src/lib/runtimeexecution.js');
      getOrCreatePilotRun = exec.getOrCreatePilotRun;
      buildPilotIdempotencyKey = exec.buildPilotIdempotencyKey;
    } catch (e) {
      fail('import runtimeexecution', String(e));
      return;
    }

    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t20-poc05-owner-${tag}@aios.test`,
        displayName: 'T20 PoC05 Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t20-poc05-agent-${tag}`,
        name: `T20 PoC05 Agent ${tag}`,
        description: 'poc05',
        rolePrompt: 'poc05',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });
    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t20-poc05-skill-${tag}`,
        name: `T20 PoC05 Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# t20 poc05 ${tag}\n`,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, `# t20 poc05 ${tag}\n`, ownerId);
    skillVersionId = sv.id;
    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: `t20-poc05-${tag}`,
      artifactJson: {
        schemaVersion: 'aios.flow-graph/1',
        template: 'email-triage-readonly-v1',
        nodes: [{ id: 'n_input', kind: 'input', config: {} }],
        edges: [],
      },
      createdBy: ownerId,
    });
    artifactId = art.id;

    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId,
        name: `T20 PoC05 WF ${tag}`,
        description: 'poc05',
        enabled: true,
        trigger: { type: 'manual' },
      },
    });

    // ── [1] sequential duplicate messageId ───────────────────────────────
    console.log('\n── [1] sequential getOrCreatePilotRun same messageId ──');
    const messageId = `msg-dup-${tag}`;
    const countBefore1 = await prisma.run.count({ where: { agentId } });
    console.log(`  evidence: Run count before first create=${countBefore1}`);

    const r1 = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId,
      triggeredBy: ownerId,
      input: { messageId, subject: 'first' },
    });
    runIds.push(r1.run.id);
    check(r1.created === true, 'first call created=true', `id=${r1.run.id}`);
    const countAfter1 = await prisma.run.count({ where: { agentId } });
    console.log(`  evidence: Run count after first create=${countAfter1}`);
    check(countAfter1 === countBefore1 + 1, 'exactly one new Run', `before=${countBefore1} after=${countAfter1}`);

    const r2 = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId,
      triggeredBy: ownerId,
      input: { messageId, subject: 'second-should-dedupe' },
    });
    runIds.push(r2.run.id);
    check(r2.created === false, 'second call created=false', `created=${String(r2.created)}`);
    check(r2.run.id === r1.run.id, 'second call same Run id', `r1=${r1.run.id} r2=${r2.run.id}`);

    const key = buildPilotIdempotencyKey(workflowId, messageId);
    const countKey = await prisma.run.count({ where: { idempotencyKey: key } });
    console.log(`  evidence: Run count for key ${key} = ${countKey}`);
    check(countKey === 1, 'DB: single Run for idempotencyKey', `count=${countKey}`);

    const countAfter2 = await prisma.run.count({ where: { agentId } });
    check(countAfter2 === countAfter1, 'second call zero new rows', `before=${countAfter1} after=${countAfter2}`);

    // ── [2] concurrent double-create (P2002 path) ────────────────────────
    console.log('\n── [2] concurrent Promise.all double-create ──');
    const messageId2 = `msg-concurrent-${tag}`;
    const countBeforeC = await prisma.run.count({ where: { agentId } });
    console.log(`  evidence: Run count before concurrent=${countBeforeC}`);

    const [c1, c2] = await Promise.all([
      getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: messageId2,
        triggeredBy: ownerId,
        input: { messageId: messageId2, n: 1 },
      }),
      getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: messageId2,
        triggeredBy: ownerId,
        input: { messageId: messageId2, n: 2 },
      }),
    ]);
    runIds.push(c1.run.id, c2.run.id);

    const key2 = buildPilotIdempotencyKey(workflowId, messageId2);
    const concurrentCount = await prisma.run.count({ where: { idempotencyKey: key2 } });
    console.log(`  evidence: concurrent Run count for key=${concurrentCount}`);
    check(concurrentCount === 1, 'concurrent → single Run row', `count=${concurrentCount}`);
    check(c1.run.id === c2.run.id, 'concurrent same run id', `c1=${c1.run.id} c2=${c2.run.id}`);
    // Exactly one of the two may report created=true
    const createdFlags = [c1.created, c2.created].filter(Boolean).length;
    check(
      createdFlags === 1 || (createdFlags === 0 && c1.run.id === c2.run.id),
      'at most one created=true (P2002 loser returns existing)',
      `c1.created=${c1.created} c2.created=${c2.created}`,
    );
    const countAfterC = await prisma.run.count({ where: { agentId } });
    check(
      countAfterC === countBeforeC + 1,
      'concurrent: net +1 Run only',
      `before=${countBeforeC} after=${countAfterC}`,
    );

    // ── [3] different messageId → different runs ─────────────────────────
    console.log('\n── [3] different messageIds → different Runs ──');
    const d1 = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId: `msg-a-${tag}`,
      triggeredBy: ownerId,
      input: { messageId: `msg-a-${tag}` },
    });
    const d2 = await getOrCreatePilotRun({
      workflowId,
      agentId,
      artifactId,
      messageId: `msg-b-${tag}`,
      triggeredBy: ownerId,
      input: { messageId: `msg-b-${tag}` },
    });
    runIds.push(d1.run.id, d2.run.id);
    check(
      d1.run.id !== d2.run.id,
      'different messageId → different Run ids',
      `d1=${d1.run.id} d2=${d2.run.id}`,
    );
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    const leftover = await prisma.run
      .findMany({ where: { agentId }, select: { id: true } })
      .catch(() => []);
    const ids = [...new Set([...runIds, ...leftover.map((r) => r.id)].filter(Boolean))];
    if (ids.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runStep.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.costLog.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.runTrace.deleteMany({ where: { runId: { in: ids } } }).catch(() => undefined);
      await prisma.run.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await prisma.workflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
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
