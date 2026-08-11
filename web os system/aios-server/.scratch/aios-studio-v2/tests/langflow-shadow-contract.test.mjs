import assert from 'node:assert/strict';
import test from 'node:test';
import { validateShadowFlow } from '../langflow-shadow-contract.mjs';

test('shadow flow is private, deterministic and side-effect free', () => {
  const sample = {
    name: 'AI 知識採集 — Grounded Langflow Sandbox',
    access_type: 'PRIVATE',
    tags: ['aios-shadow', 'sandbox-only', 'grounded-answer', 'read-only'],
    mcp_enabled: false,
    webhook: false,
    data: {
      nodes: [
        { data: { node: { display_name: 'Chat Input' } } },
        { data: { node: { display_name: 'Chat Output' } } },
      ],
      edges: [{}],
    },
  };
  validateShadowFlow(sample);
});
