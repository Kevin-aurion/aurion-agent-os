/** Public-domain MCP E2E for governed Agent archival. */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const { config } = await import('../../aios-server/src/config.js');
const { signAccess } = await import('../../aios-server/src/lib/auth.js');
const { prisma } = await import('../../aios-server/src/lib/db.js');
const { approveProposal } = await import('../../aios-server/src/lib/changeproposal.js');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function jsonText(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(typeof text === 'string', 'MCP result has no text payload');
  return JSON.parse(text) as Record<string, unknown>;
}

const remoteMcpUrl = process.env.TEST_MCP_URL || 'https://aurion-aios-mcp.lazyoffice.app/mcp';
const fde = await prisma.user.findFirst({
  where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
});
assert(fde, 'an FDE account is required');

const tag = randomUUID().replaceAll('-', '').slice(-10).toLowerCase();
const userId = randomUUID();
const agentId = randomUUID();
const workflowId = randomUUID();
const scheduleId = randomUUID();
const agentName = `Remote Archive ${tag}`;
let client: Client | undefined;

try {
  const user = await prisma.user.create({
    data: {
      id: userId,
      email: `remote-archive-${tag}@test.local`,
      displayName: 'Remote Archive E2E',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `remote-archive-${tag}`,
      name: agentName,
      description: 'Temporary public MCP archival fixture',
      rolePrompt: 'fixture',
      createdBy: user.id,
      status: 'ACTIVE',
      riskTier: 'low',
    },
  });
  await prisma.workflow.create({
    data: {
      id: workflowId,
      agentId,
      name: 'Remote archive fixture workflow',
      description: 'fixture',
      enabled: true,
      trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Taipei' },
    },
  });
  await prisma.schedule.create({
    data: {
      id: scheduleId,
      workflowId,
      cron: '0 9 * * *',
      timezone: 'Asia/Taipei',
      enabled: true,
    },
  });

  const token = await signAccess({
    sub: user.id,
    email: user.email,
    role: user.role,
    scope: 'aios:agent-builder',
    audience: config.remoteMcp.resourceUrl,
  });
  const transport = new StreamableHTTPClientTransport(new URL(remoteMcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  client = new Client({ name: 'aurion-agent-archive-e2e', version: '1.0.0' });
  await client.connect(transport);

  const before = await client.callTool({ name: 'list_available_agents', arguments: {} });
  assert(!before.isError && JSON.stringify(jsonText(before)).includes(agentId), 'fixture Agent is listed before archival');

  const wrongName = await client.callTool({
    name: 'request_agent_archive',
    arguments: { agentId, confirmAgentName: 'Wrong Agent', requestKey: `wrong-${tag}` },
  });
  assert(wrongName.isError && JSON.stringify(wrongName.content).includes('does not match'), 'wrong name fails through public MCP');

  const proposed = await client.callTool({
    name: 'request_agent_archive',
    arguments: { agentId, confirmAgentName: agentName, requestKey: `remote-${tag}` },
  });
  assert(!proposed.isError, 'archive proposal succeeds through public MCP');
  const proposalPayload = jsonText(proposed);
  const proposalId = String(proposalPayload.proposalId);
  assert(proposalPayload.status === 'PENDING', 'public MCP returns PENDING');
  assert((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).status === 'ACTIVE', 'proposal remains inert');

  await approveProposal(proposalId, fde.id);
  const archived = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(archived.status === 'ARCHIVED' && archived.deletedAt === null, 'FDE approval archives without deleting');
  assert(!(await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } })).enabled, 'workflow is disabled');
  assert(!(await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).enabled, 'schedule is disabled');

  const after = await client.callTool({ name: 'list_available_agents', arguments: {} });
  assert(!after.isError && !JSON.stringify(jsonText(after)).includes(agentId), 'archived Agent is removed from public MCP list');
  const invoke = await client.callTool({
    name: 'invoke_agent',
    arguments: { agentId, input: {}, idempotencyKey: `invoke-${tag}` },
  });
  assert(invoke.isError && JSON.stringify(invoke.content).includes('NOT_FOUND'), 'archived Agent cannot be invoked through public MCP');

  console.log(JSON.stringify({
    ok: true,
    remoteMcpUrl,
    tool: 'request_agent_archive',
    pendingBeforeFde: true,
    archivedAfterFde: true,
    retainedRecord: true,
    workflowDisabled: true,
    scheduleDisabled: true,
    invokeDenied: true,
  }, null, 2));
} finally {
  await client?.close().catch(() => {});
  await prisma.changeProposal.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
