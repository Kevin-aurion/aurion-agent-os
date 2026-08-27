import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });
const remoteMcpUrl = process.env.TEST_MCP_URL || 'https://aurion-aios-mcp.lazyoffice.app/mcp';
const { config: serverConfig } = await import('../../aios-server/src/config.js');
const { signAccess } = await import('../../aios-server/src/lib/auth.js');
const { prisma } = await import('../../aios-server/src/lib/db.js');

const user = await prisma.user.findFirstOrThrow({
  where: { email: process.env.AIOS_OWNER_EMAIL || 'fde@aios.test', deletedAt: null },
  select: { id: true, email: true },
});
const token = await signAccess({
  sub: user.id,
  email: user.email,
  role: 'MEMBER',
  scope: 'aios:agent-builder',
  audience: serverConfig.remoteMcp.resourceUrl,
});
const client = new Client({ name: 'aurion-remote-e2e', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(
  new URL(remoteMcpUrl),
  { requestInit: { headers: { authorization: `Bearer ${token}` } } },
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const required of [
    'start_agent_build',
    'upload_agent_build_file',
    'guard_agent_build_stop',
    'list_agent_builds',
    'list_testable_agents',
    'chat_with_test_agent',
    'list_available_agents',
    'get_agent_capabilities',
    'invoke_agent',
    'get_agent_run',
    'list_agent_schedules',
    'request_agent_schedule',
    'request_agent_archive',
  ]) {
    assert(names.includes(required), `Remote MCP is missing ${required}; exposed: ${names.join(', ')}`);
  }
  assert.equal(names.length, 22, 'Builder profile must expose exactly 22 least-privilege tools');
  const prompts = await client.listPrompts();
  assert(prompts.prompts.some((prompt) => prompt.name === 'use-aios-agent'), 'Remote MCP is missing use-aios-agent prompt');

  const listed = await client.callTool({ name: 'list_agent_builds', arguments: {} });
  const builds = (listed.structuredContent as { result?: Array<{ id: string }> } | undefined)?.result;
  assert(Array.isArray(builds), 'account-scoped Agent build list is not an array');

  const testableListed = await client.callTool({ name: 'list_testable_agents', arguments: {} });
  assert(!testableListed.isError, 'testable Agent list must succeed without FDE approval');
  const testableAgents = (
    testableListed.structuredContent as { result?: Array<{ sessionId: string; mode: string }> } | undefined
  )?.result;
  assert(Array.isArray(testableAgents), 'testable Agent list is not an array');
  assert(testableAgents.every((agent) => agent.mode === 'SAFE_SHADOW_CHAT'));

  const runtimeListed = await client.callTool({ name: 'list_available_agents', arguments: {} });
  assert(!runtimeListed.isError, 'runtime Agent list must succeed through the public domain');
  const runtimeAgents = (
    runtimeListed.structuredContent as { result?: Array<{ id: string; name: string }> } | undefined
  )?.result;
  assert(Array.isArray(runtimeAgents) && runtimeAgents.length > 0, 'runtime Agent list is empty');
  const capability = await client.callTool({
    name: 'get_agent_capabilities',
    arguments: { agentId: runtimeAgents[0].id },
  });
  assert(!capability.isError, 'runtime capability card must load through the public domain');

  const internalConversationId = `remote-internal-${Date.now()}`;
  const guarded = await client.callTool({
    name: 'prepare_agent_build_prompt',
    arguments: {
      externalConversationId: internalConversationId,
      prompt: '請把「今天陽光很好」翻譯成英文。',
      source: 'CLAUDE_CODE',
    },
  });
  const guardResult = guarded.structuredContent as { matched?: boolean } | undefined;
  assert.equal(guardResult?.matched, false);
  const leaked = await prisma.agentBuildSession.findMany({
    where: { userId: user.id },
    select: { id: true, brief: true },
  });
  assert(!leaked.some((row) => (
    row.brief && typeof row.brief === 'object' && !Array.isArray(row.brief)
      ? (row.brief as Record<string, unknown>).externalConversationId === internalConversationId
      : false
  )));

  console.log(JSON.stringify({
    passed: true,
    remoteMcpUrl,
    toolCount: names.length,
    ownerScopedBuilds: builds.length,
    testableAgents: testableAgents.length,
    callableAgents: runtimeAgents.length,
    runtimeCapabilityRead: true,
    internalTestIgnored: true,
  }, null, 2));
} finally {
  await client.close().catch(() => {});
  await prisma.$disconnect();
}
