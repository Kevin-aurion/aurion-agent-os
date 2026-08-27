import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../../src/http/client.js';
import type { AgentBuildSession } from '../../src/types.js';
import { registerAgentBuilderTools } from '../../src/tools/agentbuilder.js';

const now = new Date().toISOString();
const ready: AgentBuildSession = {
  id: '01TESTREADYSESSION0000000000',
  status: 'DISCOVERY',
  brief: { objective: '整理每週產業新聞' },
  plan: { proposedAgentName: '產業情報測試員' },
  strategy: null,
  targetAgentId: null,
  builtAgentId: null,
  draftSkillIds: [],
  hasTestData: false,
  testResult: null,
  lastRunId: null,
  transcript: [],
  iterations: [],
  latestIteration: {
    id: '01READYITERATION00000000000',
    sequence: 2,
    triggerKind: 'turn',
    triggerSummary: 'ready',
    status: 'READY',
    understanding: null,
    changes: [],
    harness: { identity: { name: '產業情報測試員' }, skills: [] },
    userSummary: null,
    fdeSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

const notReady: AgentBuildSession = {
  ...ready,
  id: '01QUEUEDSESSION000000000000',
  latestIteration: ready.latestIteration ? { ...ready.latestIteration, status: 'BUILDING' } : null,
};

const calls: Array<{ path: string; body?: unknown }> = [];
const fakeClient = {
  async get(path: string) {
    assert.equal(path, '/api/agent-builder/sessions');
    return [ready, notReady];
  },
  async post(path: string, options?: { body?: unknown }) {
    calls.push({ path, body: options?.body });
    return {
      sessionId: ready.id,
      iterationId: ready.latestIteration?.id,
      reply: '這是安全測試回覆。',
      reflectionQueued: true,
    };
  },
} as unknown as HttpClient;

const server = new McpServer({ name: 'no-fde-shadow-test', version: '1.0.0' });
registerAgentBuilderTools(server, fakeClient);
const client = new Client({ name: 'no-fde-shadow-test-client', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.callTool({ name: 'list_testable_agents', arguments: {} });
  assert.equal(listed.isError, undefined);
  const rows = (listed.structuredContent as { result: Array<Record<string, unknown>> }).result;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, ready.id);
  assert.equal(rows[0].name, '產業情報測試員');
  assert.equal(rows[0].mode, 'SAFE_SHADOW_CHAT');
  assert.deepEqual(rows[0].restrictions, [
    'no_tools',
    'no_network',
    'no_shell',
    'no_computer_use',
    'no_external_writes',
  ]);

  const chatted = await client.callTool({
    name: 'chat_with_test_agent',
    arguments: { sessionId: ready.id, message: '幫我整理今天的 AI 新聞' },
  });
  assert.equal(chatted.isError, undefined);
  assert.equal(chatted.structuredContent?.mode, 'SAFE_SHADOW_CHAT');
  assert.equal(chatted.structuredContent?.productionApproved, false);
  assert.equal(chatted.structuredContent?.reply, '這是安全測試回覆。');
  assert.deepEqual(calls, [{
    path: `/api/agent-builder/sessions/${ready.id}/shadow-chat`,
    body: { message: '幫我整理今天的 AI 新聞' },
  }]);

  console.log(JSON.stringify({ passed: true, testableAgents: rows.length, mode: rows[0].mode }));
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
}
