import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sessionId = process.argv[2];
assert(sessionId, 'Usage: node .scratch/submit-agent-build-live.mjs <sessionId>');
const client = new Client({ name: 'aios-submit-live-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, AIOS_MCP_PROFILE: 'builder' },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'submit_agent_build_for_fde_review',
    arguments: { sessionId, strategy: 'create' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(text);
  const body = JSON.parse(text);
  assert.equal(body.session.status, 'AWAITING_FDE');
  assert.equal(body.session.builtAgentId, null);
  console.log(JSON.stringify({ ok: true, sessionId, status: body.session.status }, null, 2));
} finally {
  await client.close().catch(() => {});
}
