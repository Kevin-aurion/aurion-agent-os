/**
 * Agent Runtime MCP governance test.
 * Run: npx tsx .scratch/agent-runtime-mcp/tests/runtime-governance.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { config } from '../../../src/config.js';
import { sendError } from '../../../src/lib/http.js';
import { agentRuntimeRoutes } from '../../../src/routes/agentruntime.js';
import { agentRoutes } from '../../../src/routes/agents.js';
import { proposalRoutes } from '../../../src/routes/proposals.js';
import { runAgent } from '../../../src/engine/index.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  for (let index = 0; index < 80; index += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ASSERT FAIL: timed out waiting for ${label}`);
}

async function main() {
  const fde = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(fde, 'an FDE account is required');

  const tag = ulid().slice(-10).toLowerCase();
  const userAId = ulid();
  const userBId = ulid();
  const agentAId = ulid();
  const pausedAId = ulid();
  const foreignBId = ulid();
  const highRiskAId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const createdAgentIds = [agentAId, pausedAId, foreignBId, highRiskAId];

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => sendError(reply, error));
  await app.register(agentRuntimeRoutes);
  await app.register(agentRoutes);
  await app.register(proposalRoutes);

  try {
    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          id: userAId,
          email: `runtime-a-${tag}@test.local`,
          displayName: 'Runtime A',
          passwordHash: 'x',
          role: 'MEMBER',
        },
      }),
      prisma.user.create({
        data: {
          id: userBId,
          email: `runtime-b-${tag}@test.local`,
          displayName: 'Runtime B',
          passwordHash: 'x',
          role: 'MEMBER',
        },
      }),
    ]);

    await prisma.agent.createMany({
      data: [
        {
          id: agentAId,
          slug: `runtime-a-${tag}`,
          name: 'Runtime Active A',
          description: 'Owned callable agent',
          rolePrompt: 'Perform only the requested test task.',
          createdBy: userA.id,
          status: 'ACTIVE',
          riskTier: 'low',
        },
        {
          id: pausedAId,
          slug: `runtime-paused-${tag}`,
          name: 'Runtime Paused A',
          description: 'Must not be callable',
          rolePrompt: 'paused',
          createdBy: userA.id,
          status: 'PAUSED',
          riskTier: 'high',
        },
        {
          id: foreignBId,
          slug: `runtime-b-${tag}`,
          name: 'Runtime Foreign B',
          description: 'Foreign account',
          rolePrompt: 'foreign',
          createdBy: userB.id,
          status: 'ACTIVE',
        },
        {
          id: highRiskAId,
          slug: `runtime-high-${tag}`,
          name: 'Runtime High Risk A',
          description: 'HITL test without an engine call',
          rolePrompt: 'high risk',
          createdBy: userA.id,
          status: 'ACTIVE',
          riskTier: 'high',
        },
      ],
    });
    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId: agentAId,
        name: 'Daily governed report',
        description: 'Produces a governed daily report',
        enabled: true,
        trigger: { type: 'manual' },
        inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepId,
        workflowId,
        position: 0,
        stepKey: 'report',
        type: 'DO',
        config: { task: 'Create the report' },
      },
    });

    const webA = await signAccess({ sub: userA.id, email: userA.email, role: userA.role });
    const webB = await signAccess({ sub: userB.id, email: userB.email, role: userB.role });
    const scopedA = await signAccess({
      sub: userA.id,
      email: userA.email,
      role: userA.role,
      scope: 'aios:agent-builder',
      audience: config.remoteMcp.resourceUrl,
    });
    const fdeToken = await signAccess({ sub: fde.id, email: fde.email, role: fde.role });
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    console.log('── [1] account-scoped ACTIVE list + OAuth route boundary');
    const list = await app.inject({
      method: 'GET',
      url: '/api/agent-runtime/agents',
      headers: auth(scopedA),
    });
    assert(list.statusCode === 200, `runtime list expected 200, got ${list.statusCode}`);
    const listed = list.json().data as Array<{ id: string }>;
    assert(listed.some((row) => row.id === agentAId), 'owned active Agent is listed');
    assert(listed.some((row) => row.id === highRiskAId), 'owned high-risk active Agent is listed');
    assert(!listed.some((row) => row.id === pausedAId), 'paused Agent is hidden');
    assert(!listed.some((row) => row.id === foreignBId), 'foreign Agent is hidden');

    const genericDenied = await app.inject({
      method: 'GET',
      url: '/api/agents',
      headers: auth(scopedA),
    });
    assert(genericDenied.statusCode === 403, 'scoped token cannot call generic Agent admin API');

    const foreignDetail = await app.inject({
      method: 'GET',
      url: `/api/agent-runtime/agents/${foreignBId}`,
      headers: auth(scopedA),
    });
    assert(foreignDetail.statusCode === 404, 'foreign Agent is indistinguishable from missing');

    const pausedInvoke = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${pausedAId}/invoke`,
      headers: auth(scopedA),
      payload: { input: {}, idempotencyKey: 'paused-runtime-test' },
    });
    assert(pausedInvoke.statusCode === 404, 'paused Agent cannot be invoked');

    const builderRunId = ulid();
    const builderOutcome = await runAgent({
      runId: builderRunId,
      agentId: pausedAId,
      input: { test: true },
      triggeredBy: userA.id,
      builderTestSessionId: `shadow-${tag}`,
    });
    assert(builderOutcome.status === 'AWAITING_REVIEW', 'builder test may evaluate a PAUSED draft Agent');
    console.log('PASS [1]');

    console.log('── [2] high-risk invoke stops at real HITL and deduplicates');
    const invokePayload = { input: { task: 'test governance' }, idempotencyKey: `hitl-${tag}` };
    const invoke = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${highRiskAId}/invoke`,
      headers: auth(scopedA),
      payload: invokePayload,
    });
    assert(invoke.statusCode === 202, `invoke expected 202, got ${invoke.statusCode}: ${invoke.body}`);
    const runId = String(invoke.json().data.runId);
    const run = await waitFor(
      () => prisma.run.findUnique({ where: { id: runId } }),
      'high-risk runtime Run',
    );
    assert(run.status === 'AWAITING_REVIEW', `high-risk Run expected AWAITING_REVIEW, got ${run.status}`);
    const approval = await waitFor(
      () => prisma.approvalRequest.findUnique({ where: { runId } }),
      'high-risk ApprovalRequest',
    );
    assert(approval?.status === 'PENDING', 'real ApprovalRequest was created');

    const retry = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${highRiskAId}/invoke`,
      headers: auth(scopedA),
      payload: invokePayload,
    });
    assert(retry.statusCode === 200, 'completed idempotent lookup returns 200');
    assert(retry.json().data.runId === runId, 'retry returns the same runId');
    assert(retry.json().data.deduplicated === true, 'retry is marked deduplicated');

    const ownRun = await app.inject({
      method: 'GET',
      url: `/api/agent-runtime/runs/${runId}`,
      headers: auth(scopedA),
    });
    assert(ownRun.statusCode === 200, 'owner can read runtime result');
    assert(!Object.hasOwn(ownRun.json().data, 'runDir'), 'runtime DTO does not expose host runDir');
    const foreignRun = await app.inject({
      method: 'GET',
      url: `/api/agent-runtime/runs/${runId}`,
      headers: auth(webB),
    });
    assert(foreignRun.statusCode === 404, 'foreign account cannot read run');
    console.log('PASS [2]');

    console.log('── [3] schedule is inert until FDE approval; secrets are redacted');
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/schedule-proposals`,
      headers: auth(scopedA),
      payload: {
        action: 'UPSERT',
        workflowId,
        cron: 'not a cron',
        timezone: 'Asia/Taipei',
        requestKey: `bad-${tag}`,
      },
    });
    assert(invalid.statusCode === 400, `invalid cron expected 400, got ${invalid.statusCode}`);

    const scheduleRequest = {
      action: 'UPSERT',
      workflowId,
      cron: '0 9 * * *',
      timezone: 'Asia/Taipei',
      input: {
        topic: 'AI news',
        email: 'ceo@example.com',
        credential: 'sk-abcdefghijk12345',
      },
      requestKey: `schedule-${tag}`,
    };
    const proposed = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/schedule-proposals`,
      headers: auth(scopedA),
      payload: scheduleRequest,
    });
    assert(proposed.statusCode === 202, `schedule proposal expected 202, got ${proposed.statusCode}`);
    const proposalId = String(proposed.json().data.proposalId);
    assert((await prisma.schedule.count({ where: { workflowId } })) === 0, 'no Schedule exists before FDE approval');
    const savedProposal = await prisma.changeProposal.findUnique({ where: { id: proposalId } });
    const savedJson = JSON.stringify(savedProposal?.proposedChange);
    assert(!savedJson.includes('ceo@example.com'), 'proposal email is redacted');
    assert(!savedJson.includes('sk-abcdefghijk12345'), 'proposal API key is redacted');

    const dedupeProposal = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/schedule-proposals`,
      headers: auth(scopedA),
      payload: scheduleRequest,
    });
    assert(dedupeProposal.statusCode === 200, 'duplicate pending proposal returns 200');
    assert(dedupeProposal.json().data.proposalId === proposalId, 'proposal retry returns same id');

    const memberApprove = await app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: auth(webA),
    });
    assert(memberApprove.statusCode === 403, 'MEMBER cannot approve schedule proposal');
    assert((await prisma.schedule.count({ where: { workflowId } })) === 0, 'failed member approval remains inert');

    const fdeApprove = await app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: auth(fdeToken),
    });
    assert(fdeApprove.statusCode === 200, `FDE approve expected 200, got ${fdeApprove.statusCode}: ${fdeApprove.body}`);
    const schedule = await prisma.schedule.findFirst({ where: { workflowId } });
    assert(schedule?.enabled === true, 'FDE approval creates enabled Schedule');
    assert(schedule?.cron === '0 9 * * *', 'approved cron is persisted');
    assert(schedule?.timezone === 'Asia/Taipei', 'approved timezone is persisted');
    console.log('PASS [3]');

    console.log('── [4] pause is proposal-only, then takes effect after FDE approval');
    const pause = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/schedule-proposals`,
      headers: auth(scopedA),
      payload: {
        action: 'PAUSE',
        workflowId,
        requestKey: `pause-${tag}`,
      },
    });
    assert(pause.statusCode === 202, 'pause proposal accepted');
    assert((await prisma.schedule.findFirst({ where: { workflowId } }))?.enabled === true, 'pause not effective before approval');
    const pauseId = String(pause.json().data.proposalId);
    const approvePause = await app.inject({
      method: 'POST',
      url: `/api/proposals/${pauseId}/approve`,
      headers: auth(fdeToken),
    });
    assert(approvePause.statusCode === 200, 'FDE approves pause');
    assert((await prisma.schedule.findFirst({ where: { workflowId } }))?.enabled === false, 'schedule paused after approval');

    const schedules = await app.inject({
      method: 'GET',
      url: `/api/agent-runtime/agents/${agentAId}/schedules`,
      headers: auth(scopedA),
    });
    assert(schedules.statusCode === 200, 'schedule state is visible through runtime API');
    const workflow = (schedules.json().data as Array<{ id: string; schedule: { enabled: boolean } | null }>).find(
      (row) => row.id === workflowId,
    );
    assert(workflow?.schedule?.enabled === false, 'runtime DTO reports paused state');
    console.log('PASS [4]');

    console.log('ALL PASS: Agent Runtime ownership, HITL, idempotency and FDE schedule governance');
  } finally {
    const runIds = await prisma.run.findMany({
      where: { agentId: { in: createdAgentIds } },
      select: { id: true },
    });
    if (runIds.length > 0) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: runIds.map((row) => row.id) } } });
    }
    await prisma.changeProposal.deleteMany({ where: { agentId: { in: createdAgentIds } } });
    await prisma.run.deleteMany({ where: { agentId: { in: createdAgentIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
