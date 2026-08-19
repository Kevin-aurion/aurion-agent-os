/**
 * Google Workspace MCP acceptance + negative security tests.
 * Does NOT read Gmail/Drive content and does NOT perform any Google write.
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { signAccess } from '../../../src/lib/auth.js';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import { openSession } from '../../../src/lib/mcpclient.js';
import { issueMcpCapability } from '../../../src/lib/mcpcapability.js';
import { toTransportConfig } from '../../../src/lib/mcpregistry.js';
import { googleWorkspaceRoutes } from '../../../src/routes/googleworkspace.js';
import { mcpRoutes } from '../../../src/routes/mcp.js';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`ASSERT FAIL: ${message}`);
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'FDE account is required');
  const google = await prisma.connectedAccount.findFirst({
    where: { userId: owner.id, provider: 'GOOGLE', status: 'CONNECTED' },
  });
  assert(google, 'connected Google account is required');

  const agentId = ulid();
  const otherAgentId = ulid();
  const otherRunId = ulid();
  const otherApprovalId = ulid();
  const tag = agentId.slice(-8).toLowerCase();
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `google-mcp-test-${tag}`,
      name: 'Google MCP 安全測試 Agent',
      description: 'ephemeral',
      department: '測試',
      rolePrompt: 'test only',
      engineExecute: 'CLAUDE_CODE',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
        cloudEmbedding: false,
      },
      riskTier: 'high',
      status: 'PAUSED',
      createdBy: owner.id,
    },
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(googleWorkspaceRoutes);
  await app.register(mcpRoutes);
  const token = await signAccess({ sub: owner.id, email: owner.email, role: owner.role });
  const auth = { authorization: `Bearer ${token}` };
  const serverIds: string[] = [];

  try {
    const installed = await app.inject({
      method: 'POST',
      url: '/api/google-workspace/mcp/install',
      headers: auth,
      payload: { accountId: google.id, agentIds: [agentId] },
    });
    assert(installed.statusCode === 200, `install failed: ${installed.body}`);
    const installBody = installed.json() as { success: boolean; data: { installed: Array<{ serverId: string }> } };
    assert(installBody.success, 'install envelope');
    assert(installBody.data.installed.length === 5, 'read/draft/send/write must be split into five registry entries');
    serverIds.push(...installBody.data.installed.map((entry) => entry.serverId));
    console.log('  ✓ five least-privilege registry entries installed');

    for (const serverId of serverIds) {
      const row = await prisma.mcpServerRegistry.findUnique({ where: { serverId } });
      assert(row, `missing registry ${serverId}`);
      const health = await app.inject({
        method: 'GET',
        url: `/mcp/servers/${row.id}/health`,
        headers: auth,
      });
      assert(health.statusCode === 200, `health route failed: ${health.body}`);
      const payload = health.json() as { success: boolean; data: { status: string; tools?: string[]; message?: string } };
      assert(payload.data.status === 'healthy', `health not healthy: ${JSON.stringify(payload.data)}`);
      assert((payload.data.tools?.length ?? 0) === 7, 'internal MCP must advertise seven Google tools');
    }
    console.log('  ✓ all MCP subprocesses initialize and advertise tools');

    const sendEntry = await prisma.mcpServerRegistry.findUnique({
      where: { serverId: serverIds.find((id) => id.includes('gmail-send'))! },
    });
    assert(sendEntry, 'send entry');

    const deniedWrite = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      headers: auth,
      payload: {
        agentId,
        serverId: sendEntry.serverId,
        tool: 'gmail_send',
        args: { to: 'nobody@example.invalid', subject: 'must not send', body: 'test' },
      },
    });
    assert(deniedWrite.statusCode === 403, 'send without restrictions/approval must be blocked');
    assert(deniedWrite.body.includes('restriction sendEmail') || deniedWrite.body.includes('approval required'), 'denial reason');
    console.log('  ✓ Gmail send fails closed before any Google API call');

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: true,
          cloudWrite: false,
          shell: false,
          cloudEmbedding: false,
        },
      },
    });
    await prisma.agent.create({
      data: {
        id: otherAgentId,
        slug: `google-mcp-other-${tag}`,
        name: 'Other approved Agent',
        description: 'ephemeral',
        department: '測試',
        rolePrompt: 'test only',
        engineExecute: 'CLAUDE_CODE',
        restrictions: { sendEmail: true, cloudWrite: true },
        riskTier: 'high',
        status: 'PAUSED',
        createdBy: owner.id,
      },
    });
    await prisma.run.create({
      data: {
        id: otherRunId,
        agentId: otherAgentId,
        triggeredBy: owner.id,
        status: 'SUCCEEDED',
        input: {},
        runDir: `/tmp/${otherRunId}`,
      },
    });
    await prisma.approvalRequest.create({
      data: {
        id: otherApprovalId,
        runId: otherRunId,
        agentId: otherAgentId,
        reason: 'cross-agent negative test',
        payload: {},
        status: 'APPROVED',
        resumeToken: ulid(),
        decidedBy: owner.id,
        decidedAt: new Date(),
      },
    });
    const crossAgent = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      headers: auth,
      payload: {
        agentId,
        runId: otherRunId,
        serverId: sendEntry.serverId,
        tool: 'gmail_send',
        args: { to: 'nobody@example.invalid', subject: 'cross-agent', body: 'must fail' },
      },
    });
    assert(crossAgent.statusCode === 403, 'another Agent’s approved Run must not authorize this Agent');
    assert(crossAgent.body.includes('does not belong to this agent'), 'cross-agent denial reason');
    console.log('  ✓ approved Run is cryptographically/persistently bound to the same Agent');

    const direct = await openSession(toTransportConfig(sendEntry));
    try {
      let denied = false;
      try {
        await direct.call('gmail_send', {
          to: 'nobody@example.invalid',
          subject: 'direct bypass',
          body: 'must fail',
        });
      } catch (e) {
        denied = /capability/i.test(e instanceof Error ? e.message : String(e));
      }
      assert(denied, 'direct subprocess call without signed broker capability must fail');

      const oneTimeCapability = issueMcpCapability({
        agentId,
        serverId: sendEntry.serverId,
        tool: 'unknown_tool',
      });
      try {
        await direct.call('unknown_tool', { __aiosCapability: oneTimeCapability });
      } catch {
        // Expected: valid capability reaches the tool switch, then unknown tool.
      }
      let replayDenied = false;
      try {
        await direct.call('unknown_tool', { __aiosCapability: oneTimeCapability });
      } catch (e) {
        replayDenied = /already used/i.test(e instanceof Error ? e.message : String(e));
      }
      assert(replayDenied, 'signed capability must be single-use');
    } finally {
      direct.close();
    }
    console.log('  ✓ direct bypass fails and signed capabilities cannot be replayed');
  } finally {
    await app.close();
    if (serverIds.length) {
      await prisma.mcpServerRegistry.deleteMany({ where: { serverId: { in: serverIds } } });
    }
    await prisma.approvalRequest.deleteMany({ where: { id: otherApprovalId } });
    await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
