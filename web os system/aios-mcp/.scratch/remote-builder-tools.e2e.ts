import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });
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
const client = new Client({ name: 'lazyoffice-remote-e2e', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(
  new URL('https://aios-mcp.lazyoffice.app/mcp'),
  { requestInit: { headers: { authorization: `Bearer ${token}` } } },
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const required of [
    'list_my_agents',
    'start_agent_build',
    'set_agent_build_name',
    'request_agent_rename',
    'upload_agent_build_file',
    'guard_agent_build_stop',
  ]) {
    assert(names.includes(required), `Remote MCP is missing ${required}`);
  }
  assert.equal(names.length, 15, 'Builder profile must expose exactly 15 least-privilege tools');

  const listed = await client.callTool({ name: 'list_my_agents', arguments: {} });
  const agents = (listed.structuredContent as { result?: Array<{ id: string; name: string }> } | undefined)?.result;
  assert(Array.isArray(agents));
  assert(agents.some((agent) => agent.id === '01KZGPJ1JS9H33FTVS07JYKGB8' && agent.name === '提案三件套製作專員'));

  const internalConversationId = `remote-internal-${Date.now()}`;
  const guarded = await client.callTool({
    name: 'prepare_agent_build_prompt',
    arguments: {
      externalConversationId: internalConversationId,
      prompt: '[This step\'s task]\n【Agent Builder 試跑】請產出測試資料。',
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
    remoteMcpUrl: 'https://aios-mcp.lazyoffice.app/mcp',
    toolCount: names.length,
    ownerScopedAgents: agents.length,
    renamedAgentVisible: true,
    internalTestIgnored: true,
  }, null, 2));
} finally {
  await client.close().catch(() => {});
  await prisma.$disconnect();
}
