import assert from 'node:assert/strict';

export function validateShadowFlow(flow) {
  assert.equal(flow.access_type, 'PRIVATE');
  assert.equal(flow.name, 'AI 知識採集 — Grounded Langflow Sandbox');
  assert.ok(flow.tags.includes('aios-shadow'));
  assert.ok(flow.tags.includes('sandbox-only'));
  assert.ok(flow.tags.includes('grounded-answer'));
  assert.ok(flow.tags.includes('read-only'));
  assert.equal(flow.mcp_enabled, false);
  assert.equal(flow.webhook, false);
  assert.equal(flow.data.nodes.length, 2);
  assert.equal(flow.data.edges.length, 1);
  const names = flow.data.nodes.map((node) => node.data?.node?.display_name).sort();
  assert.deepEqual(names, ['Chat Input', 'Chat Output']);
  for (const forbidden of ['Web Search', 'File', 'Shell', 'YouTube', 'Scheduler']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be present`);
  }
}
