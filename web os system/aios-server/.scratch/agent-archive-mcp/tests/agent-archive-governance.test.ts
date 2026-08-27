/**
 * Governed Agent archival through the account-scoped Runtime API.
 * Run: npx tsx .scratch/agent-archive-mcp/tests/agent-archive-governance.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { config } from '../../../src/config.js';
import { sendError } from '../../../src/lib/http.js';
import { agentRuntimeRoutes } from '../../../src/routes/agentruntime.js';
import { proposalRoutes } from '../../../src/routes/proposals.js';
import { runAgent } from '../../../src/engine/index.js';
import { runWorkflow } from '../../../src/workflow/runner.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

async function expectRejected(run: () => Promise<unknown>, pattern: RegExp, message: string) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof Error && pattern.test(error.message), message);
    return;
  }
  throw new Error(`ASSERT FAIL: ${message}`);
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
  const foreignAgentId = ulid();
  const workflowId = ulid();
  const stepId = ulid();
  const scheduleId = ulid();
  const agentName = `Archive Target ${tag}`;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => sendError(reply, error));
  await app.register(agentRuntimeRoutes);
  await app.register(proposalRoutes);

  try {
    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          id: userAId,
          email: `archive-a-${tag}@test.local`,
          displayName: 'Archive A',
          passwordHash: 'x',
          role: 'MEMBER',
        },
      }),
      prisma.user.create({
        data: {
          id: userBId,
          email: `archive-b-${tag}@test.local`,
          displayName: 'Archive B',
          passwordHash: 'x',
          role: 'MEMBER',
        },
      }),
    ]);
    await prisma.agent.createMany({
      data: [
        {
          id: agentAId,
          slug: `archive-target-${tag}`,
          name: agentName,
          description: 'Owned Agent that will be archived',
          rolePrompt: 'Do only the selected test task.',
          createdBy: userA.id,
          status: 'ACTIVE',
          riskTier: 'low',
        },
        {
          id: foreignAgentId,
          slug: `archive-foreign-${tag}`,
          name: `Foreign ${tag}`,
          description: 'Must never be archived by account A',
          rolePrompt: 'foreign',
          createdBy: userB.id,
          status: 'ACTIVE',
        },
      ],
    });
    await prisma.workflow.create({
      data: {
        id: workflowId,
        agentId: agentAId,
        name: 'Archive test workflow',
        description: 'Must be disabled with the Agent',
        enabled: true,
        trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Taipei' },
      },
    });
    await prisma.workflowStep.create({
      data: {
        id: stepId,
        workflowId,
        position: 0,
        stepKey: 'only-step',
        type: 'DO',
        config: { task: 'test' },
      },
    });
    await prisma.schedule.create({
      data: {
        id: scheduleId,
        workflowId,
        cron: '0 9 * * *',
        timezone: 'Asia/Taipei',
        enabled: true,
        nextFireAt: new Date(Date.now() + 60_000),
      },
    });

    const webA = await signAccess({ sub: userA.id, email: userA.email, role: userA.role });
    const scopedA = await signAccess({
      sub: userA.id,
      email: userA.email,
      role: userA.role,
      scope: 'aios:agent-builder',
      audience: config.remoteMcp.resourceUrl,
    });
    const fdeToken = await signAccess({ sub: fde.id, email: fde.email, role: fde.role });
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    console.log('── [1] ambiguous and cross-account archive requests fail closed');
    const wrongName = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/archive-proposals`,
      headers: auth(scopedA),
      payload: { confirmAgentName: 'Wrong Agent', requestKey: `wrong-${tag}` },
    });
    assert(wrongName.statusCode === 400, `wrong name expected 400, got ${wrongName.statusCode}`);

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${foreignAgentId}/archive-proposals`,
      headers: auth(scopedA),
      payload: { confirmAgentName: `Foreign ${tag}`, requestKey: `foreign-${tag}` },
    });
    assert(foreign.statusCode === 404, `foreign Agent expected 404, got ${foreign.statusCode}`);
    assert(
      (await prisma.changeProposal.count({ where: { agentId: { in: [agentAId, foreignAgentId] } } })) === 0,
      'rejected requests create no proposal',
    );
    console.log('PASS [1]');

    console.log('── [2] proposal is idempotent and inert until FDE approval');
    const request = { confirmAgentName: agentName, requestKey: `archive-${tag}` };
    const concurrentRequest = { confirmAgentName: agentName, requestKey: `archive-concurrent-${tag}` };
    const concurrentResponses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/agent-runtime/agents/${agentAId}/archive-proposals`,
        headers: auth(scopedA),
        payload: request,
      }),
      app.inject({
        method: 'POST',
        url: `/api/agent-runtime/agents/${agentAId}/archive-proposals`,
        headers: auth(scopedA),
        payload: concurrentRequest,
      }),
    ]);
    const proposed = concurrentResponses.find((response) => response.statusCode === 202);
    const concurrentDuplicate = concurrentResponses.find((response) => response.statusCode === 200);
    assert(proposed, 'one concurrent archive request creates the proposal');
    assert(concurrentDuplicate, 'the other concurrent archive request deduplicates');
    assert(proposed.statusCode === 202, `archive proposal expected 202, got ${proposed.statusCode}`);
    const proposalId = String(proposed.json().data.proposalId);
    assert(concurrentDuplicate.json().data.proposalId === proposalId, 'concurrent requests return one proposal id');
    const saved = await prisma.changeProposal.findUnique({ where: { id: proposalId } });
    assert(saved?.status === 'PENDING', 'proposal is PENDING');
    assert(saved?.severity === 'high', 'archive proposal is high severity');
    const savedChange = saved?.proposedChange as Record<string, unknown>;
    assert(savedChange.action === 'archive_agent', 'archive action is persisted');
    assert(!JSON.stringify(savedChange).includes(request.requestKey), 'raw requestKey is never persisted');
    assert(!JSON.stringify(savedChange).includes(concurrentRequest.requestKey), 'concurrent raw requestKey is never persisted');
    assert(
      (await prisma.changeProposal.count({
        where: { agentId: agentAId, targetType: 'AGENT', status: 'PENDING' },
      })) === 1,
      'concurrent requests create exactly one pending archive proposal',
    );

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/archive-proposals`,
      headers: auth(scopedA),
      payload: request,
    });
    assert(duplicate.statusCode === 200, 'retry returns 200');
    assert(duplicate.json().data.deduplicated === true, 'retry is marked deduplicated');
    assert(duplicate.json().data.proposalId === proposalId, 'retry returns the same proposal');

    const beforeApproval = await prisma.agent.findUniqueOrThrow({ where: { id: agentAId } });
    assert(beforeApproval.status === 'ACTIVE', 'proposal alone does not archive Agent');
    assert((await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } })).enabled, 'workflow remains enabled');
    assert((await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).enabled, 'schedule remains enabled');
    const callableBefore = await app.inject({
      method: 'GET',
      url: `/api/agent-runtime/agents/${agentAId}`,
      headers: auth(scopedA),
    });
    assert(callableBefore.statusCode === 200, 'Agent remains callable before approval');

    const memberApprove = await app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: auth(webA),
    });
    assert(memberApprove.statusCode === 403, 'MEMBER cannot approve archive proposal');
    assert((await prisma.agent.findUniqueOrThrow({ where: { id: agentAId } })).status === 'ACTIVE', 'failed member approval is inert');
    console.log('PASS [2]');

    console.log('── [3] FDE approval archives without deleting and closes every runtime gate');
    const approved = await app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: auth(fdeToken),
    });
    assert(approved.statusCode === 200, `FDE approval expected 200, got ${approved.statusCode}: ${approved.body}`);
    const archived = await prisma.agent.findUniqueOrThrow({ where: { id: agentAId } });
    assert(archived.status === 'ARCHIVED', 'Agent status becomes ARCHIVED');
    assert(archived.deletedAt === null, 'Agent is retained rather than hard/soft deleted');
    assert(!(await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } })).enabled, 'workflow is disabled');
    const disabledSchedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    assert(!disabledSchedule.enabled, 'schedule is disabled');
    assert(disabledSchedule.nextFireAt === null, 'disabled schedule has no next fire time');

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/agent-runtime/agents',
      headers: auth(scopedA),
    });
    assert(
      !(listAfter.json().data as Array<{ id: string }>).some((agent) => agent.id === agentAId),
      'archived Agent disappears from callable list',
    );
    for (const url of [
      `/api/agent-runtime/agents/${agentAId}`,
      `/api/agent-runtime/agents/${agentAId}/schedules`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: auth(scopedA) });
      assert(response.statusCode === 404, `${url} rejects archived Agent`);
    }
    const directInvoke = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/invoke`,
      headers: auth(scopedA),
      payload: { input: {}, idempotencyKey: `archived-${tag}` },
    });
    assert(directInvoke.statusCode === 404, 'direct ID invocation rejects archived Agent');
    const repeatArchive = await app.inject({
      method: 'POST',
      url: `/api/agent-runtime/agents/${agentAId}/archive-proposals`,
      headers: auth(scopedA),
      payload: { confirmAgentName: agentName, requestKey: `again-${tag}` },
    });
    assert(repeatArchive.statusCode === 409, 'already archived Agent cannot be proposed again');
    await expectRejected(
      () => runAgent({ agentId: agentAId, input: {}, triggeredBy: userA.id }),
      /not active/i,
      'direct engine call rejects archived Agent',
    );
    await expectRejected(
      () => runWorkflow(workflowId, {}, userA.id),
      /not enabled|not active/i,
      'direct workflow call rejects archived Agent',
    );

    const duplicateApproval = await app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: auth(fdeToken),
    });
    assert(duplicateApproval.statusCode === 409, 'proposal cannot be approved twice');
    assert(
      (await prisma.agent.findUniqueOrThrow({ where: { id: foreignAgentId } })).status === 'ACTIVE',
      'foreign Agent remains untouched',
    );
    console.log('PASS [3]');
    console.log('ALL PASS: owner isolation, FDE governance, soft archival and runtime denial');
  } finally {
    await prisma.changeProposal.deleteMany({ where: { agentId: { in: [agentAId, foreignAgentId] } } });
    await prisma.agent.deleteMany({ where: { id: { in: [agentAId, foreignAgentId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
