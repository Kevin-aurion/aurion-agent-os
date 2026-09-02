/**
 * Agent Runtime workflow routing/input contract regression tests.
 *
 * Run from web os system/aios-server:
 *   npx tsx tests/agent-runtime/workflow-input-contract.test.ts
 */
import assert from 'node:assert/strict';
import { formatMcpToolFailure } from '../../src/lib/mcpclient.ts';
import {
  effectiveWorkflowInputSchema,
  prepareWorkflowInput,
  selectAutomaticWorkflow,
} from '../../src/workflow/input.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

const messageSchema = {
  type: 'object',
  required: ['message'],
  properties: { message: { type: 'string', minLength: 1 } },
};

const vincentWorkflow = {
  id: 'vincent-workflow',
  name: 'Vincent 知識庫查詢（MCP）',
  trigger: { type: 'keyword', keywords: ['知識庫', 'PK', '產品', '查詢'] },
  inputSchema: messageSchema,
  steps: [{ config: { args: { query: '{{input.message}}' } } }],
};

await test('legacy {{input.message}} workflow advertises a canonical message schema', () => {
  const schema = effectiveWorkflowInputSchema(null, vincentWorkflow.steps);
  assert.deepEqual(schema?.required, ['message']);
  assert.equal((schema?.properties as Record<string, { type?: string }>).message?.type, 'string');
});

await test('query alias is normalized to message before workflow execution', () => {
  const prepared = prepareWorkflowInput(
    { query: 'PK3050013', organizationRef: 'org_public_ref', spaceRef: 'spc_public_ref' },
    messageSchema,
  );
  assert.equal(prepared.normalizedFrom, 'query');
  assert.equal(prepared.input.message, 'PK3050013');
  assert.equal(prepared.input.query, undefined);
  assert.equal(prepared.input.organizationRef, 'org_public_ref');
  assert.deepEqual(prepared.issues, []);
});

await test('question alias is normalized to message', () => {
  const prepared = prepareWorkflowInput({ question: '請查 PK3050013' }, messageSchema);
  assert.deepEqual(prepared.input, { message: '請查 PK3050013' });
  assert.deepEqual(prepared.issues, []);
});

await test('missing required workflow input fails before a Run is queued', () => {
  const prepared = prepareWorkflowInput({}, messageSchema);
  assert.deepEqual(prepared.issues, [
    { path: 'input.message', code: 'required', message: '缺少必要欄位 message' },
  ]);
});

await test('wrong input type returns a precise field error', () => {
  const prepared = prepareWorkflowInput({ message: 3050013 }, messageSchema);
  assert.equal(prepared.issues[0]?.path, 'input.message');
  assert.match(prepared.issues[0]?.message ?? '', /string/);
});

await test('natural-language invocation automatically selects one matching keyword workflow', () => {
  const selected = selectAutomaticWorkflow([vincentWorkflow], {
    message: '請查詢 PK3050013 的品名與售價',
  });
  assert.equal(selected.workflow?.id, vincentWorkflow.id);
  assert.equal(selected.reason, 'keyword');
});

await test('an omitted workflowId can use the sole declared message workflow', () => {
  const selected = selectAutomaticWorkflow(
    [{ ...vincentWorkflow, trigger: { type: 'manual' } }],
    { question: '幫我整理產品資料' },
  );
  assert.equal(selected.workflow?.id, vincentWorkflow.id);
  assert.equal(selected.reason, 'sole_message_workflow');
});

await test('ambiguous workflow matches fail closed instead of guessing', () => {
  const selected = selectAutomaticWorkflow(
    [vincentWorkflow, { ...vincentWorkflow, id: 'another', name: '另一個查詢流程' }],
    { message: '請查詢 PK3050013' },
  );
  assert.equal(selected.workflow, null);
  assert.equal(selected.reason, 'ambiguous');
  assert.deepEqual(selected.ambiguous.map((item) => item.id), ['vincent-workflow', 'another']);
});

await test('structured MCP errors are redacted and surfaced instead of generic text', () => {
  const message = formatMcpToolFailure({
    isError: true,
    content: [{ type: 'text', text: 'Tool call failed; see structuredContent.' }],
    structuredContent: {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'query is required',
        details: { field: 'query', credential: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      },
    },
  });
  assert.match(message, /invalid_request/);
  assert.match(message, /query is required/);
  assert.match(message, /REDACTED_BEARER/);
  assert.doesNotMatch(message, /abcdefghijklmnopqrstuvwxyz/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
