import assert from 'node:assert/strict';
import test from 'node:test';
import { canSaveEnginePair, formatRuntimeDuration, isKnowledgePilotReady, statusTone, studioSections } from './presentation';

test('cross-model verification cannot save the same engine', () => {
  assert.equal(canSaveEnginePair('CODEX', 'CODEX'), false);
  assert.equal(canSaveEnginePair('CODEX', 'CLAUDE_CODE'), true);
  assert.equal(canSaveEnginePair('CODEX', null), true);
});

test('governed states remain visually distinct', () => {
  assert.equal(statusTone('ACTIVE'), 'positive');
  assert.equal(statusTone('AWAITING_FDE'), 'warning');
  assert.equal(statusTone('FAILED'), 'danger');
});

test('all configuration surfaces are present including Graph 工程', () => {
  const labels = studioSections.map((item) => item.label);
  for (const label of ['Agent', '模型', 'Tool 與 MCP', 'Knowledge', 'Skill', 'Graph 工程', 'Deployment']) {
    assert.ok(labels.includes(label as never));
  }
  const graph = studioSections.find((s) => s.href === '/studio/graph');
  assert.equal(graph?.group, '治理與執行');
});

test('knowledge pilot readiness requires both index and Langflow', () => {
  assert.equal(isKnowledgePilotReady({ knowledgeIndex: { ready: true }, langflow: { healthy: true } }), true);
  assert.equal(isKnowledgePilotReady({ knowledgeIndex: { ready: true }, langflow: { healthy: false } }), false);
  assert.equal(formatRuntimeDuration(34), '34 ms');
  assert.equal(formatRuntimeDuration(1250), '1.25 s');
});
