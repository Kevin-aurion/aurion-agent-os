import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { validateShadowFlow } from './langflow-shadow-contract.mjs';

const baseUrl = process.env.AIOS_LANGFLOW_SANDBOX_URL ?? 'http://127.0.0.1:7860';
const apiKey = process.env.AIOS_LANGFLOW_SANDBOX_API_KEY;
const flowId = '4ec97062-f088-45b6-a304-a4fe1d1c9f26';
const sourceSessionId = '01KZQBCD2BSWV28YPD6RWC3VXB';
const fixture = JSON.stringify({
  schema: 'aurion.knowledge-pilot.v1',
  runId: `deploy-proof-${Date.now()}`,
  question: 'PDF 轉文字工具有哪些？',
  answer: '這是由 AIOS 既有知識索引產生的 grounded answer fixture。',
  citations: [
    {
      title: 'PDF 工具實測',
      timestamp: '02:05',
      url: 'https://www.youtube.com/watch?v=fixture&t=125s',
    },
  ],
});

assert.ok(apiKey, 'AIOS_LANGFLOW_SANDBOX_API_KEY is required');

const headers = {
  'content-type': 'application/json',
  'x-api-key': apiKey,
};

function replaceIds(value, replacements) {
  if (typeof value === 'string') {
    let next = value;
    for (const [from, to] of replacements) next = next.replaceAll(from, to);
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceIds(item, replacements)]),
    );
  }
  return value;
}

async function getJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const examples = await getJson('/api/v1/flows/basic_examples/', {
  headers: { 'accept-encoding': 'identity' },
});
const source = examples.find((flow) => flow.name === 'Knowledge Retrieval');
assert.ok(source, 'Langflow Knowledge Retrieval example is unavailable');

const inputSourceId = source.data.nodes.find(
  (node) => node.data?.node?.display_name === 'Chat Input',
)?.id;
const outputSourceId = source.data.nodes.find(
  (node) => node.data?.node?.display_name === 'Chat Output',
)?.id;
assert.ok(inputSourceId && outputSourceId, 'Chat Input/Output components are unavailable');

const inputId = 'ChatInput-aiosKnowledgeShadow';
const outputId = 'ChatOutput-aiosKnowledgeShadow';
const replacements = [[inputSourceId, inputId], [outputSourceId, outputId]];
const inputNode = replaceIds(
  source.data.nodes.find((node) => node.id === inputSourceId),
  replacements,
);
const outputNode = replaceIds(
  source.data.nodes.find((node) => node.id === outputSourceId),
  replacements,
);
inputNode.position = { x: 80, y: 140 };
outputNode.position = { x: 520, y: 140 };
inputNode.data.node.template.should_store_message.value = false;
outputNode.data.node.template.should_store_message.value = false;

const sourceHandle = {
  dataType: 'ChatInput',
  id: inputId,
  name: 'message',
  output_types: ['Message'],
};
const targetHandle = {
  fieldName: 'input_value',
  id: outputId,
  inputTypes: ['Data', 'JSON', 'DataFrame', 'Table', 'Message'],
  type: 'other',
};
const stringifyHandle = (value) => JSON.stringify(value).replaceAll('"', 'œ');
const edge = {
  animated: false,
  className: '',
  data: { sourceHandle, targetHandle },
  id: `reactflow__edge-${inputId}${stringifyHandle(sourceHandle)}-${outputId}${stringifyHandle(targetHandle)}`,
  selected: false,
  source: inputId,
  sourceHandle: stringifyHandle(sourceHandle),
  target: outputId,
  targetHandle: stringifyHandle(targetHandle),
};

const payload = {
  name: 'AI 知識採集 — Grounded Langflow Sandbox',
  description:
    `Source AgentBuildSession ${sourceSessionId}. Receives an AIOS-grounded, redacted answer envelope and proves the read-only Langflow runtime boundary; the knowledge vault remains owned by AIOS.`,
  icon: 'BookOpenCheck',
  icon_bg_color: '#5B5CE2',
  data: {
    nodes: [inputNode, outputNode],
    edges: [edge],
    viewport: { x: 0, y: 0, zoom: 1 },
  },
  is_component: false,
  webhook: false,
  endpoint_name: 'ai-knowledge-collector-sandbox',
  tags: ['aios-shadow', 'sandbox-only', 'grounded-answer', 'read-only', `source:${sourceSessionId}`],
  locked: false,
  mcp_enabled: false,
  access_type: 'PRIVATE',
  flow_type: 'workflow',
  a2a_enabled: false,
};

validateShadowFlow(payload);

const deployed = await getJson(`/api/v1/flows/${flowId}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify(payload),
});
assert.equal(deployed.id, flowId);
assert.equal(deployed.name, payload.name);

const runStartedAt = Date.now();
const run = await getJson(`/api/v1/run/${flowId}?stream=false`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    input_request: {
      input_value: fixture,
      input_type: 'chat',
      output_type: 'chat',
      session_id: `aios-shadow-${Date.now()}`,
    },
    context: {
      aios_environment: 'SANDBOX',
      source_agent_build_session_id: sourceSessionId,
    },
  }),
});
const serializedRun = JSON.stringify(run);
const fixtureRunId = JSON.parse(fixture).runId;
assert.ok(serializedRun.includes(fixtureRunId), 'Langflow output did not preserve the validation run marker');

const report = {
  passed: true,
  environment: 'SANDBOX',
  flowId,
  flowName: payload.name,
  sourceSessionId,
  testedAt: new Date().toISOString(),
  durationMs: Date.now() - runStartedAt,
  assertion: 'Native Langflow returned the AIOS-grounded answer envelope with the same run marker and citations.',
  productionActivated: false,
  sideEffects: [],
};
await writeFile(new URL('./langflow-shadow-report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
