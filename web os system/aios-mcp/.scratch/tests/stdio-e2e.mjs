import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(packageRoot, 'dist', 'index.js')],
  cwd: packageRoot,
  stderr: 'pipe',
});
const stderr = [];
transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
const client = new Client({ name: 'aios-mcp-e2e', version: '1.0.0' }, { capabilities: {} });

function resultJson(result) {
  if (result.isError) {
    throw new Error(result.content?.map((item) => item.type === 'text' ? item.text : '').join('\n'));
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(text, 'MCP tool returned no JSON text');
  return JSON.parse(text);
}

let sessionId;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    'start_agent_build',
    'sync_agent_build_turn',
    'sync_agent_build_artifact',
    'upload_agent_build_file',
    'guard_agent_build_stop',
    'get_agent_build',
    'list_agent_builds',
    'submit_agent_build_for_fde_review',
    'submit_agent_build_test_data',
    'run_agent_build_test',
    'list_available_agents',
    'get_agent_capabilities',
    'invoke_agent',
    'get_agent_run',
    'list_agent_schedules',
    'request_agent_schedule',
  ]) assert(names.has(required), `missing MCP tool: ${required}`);

  const prompts = await client.listPrompts();
  assert(prompts.prompts.some((prompt) => prompt.name === 'build-aios-agent'));
  assert(prompts.prompts.some((prompt) => prompt.name === 'use-aios-agent'));
  const prompt = await client.getPrompt({
    name: 'build-aios-agent',
    arguments: { request: '建立一位客戶回饋整理員工', source: 'CLAUDE_DESKTOP' },
  });
  assert(JSON.stringify(prompt).includes('start_agent_build'));

  const runId = randomUUID();
  const conversationId = `stdio-e2e-${runId}`;
  const started = resultJson(await client.callTool({
    name: 'start_agent_build',
    arguments: {
      initialRequest: '建立一位每天整理客戶回饋並提出改善建議的 AI 員工。',
      source: 'CLAUDE_DESKTOP',
      externalConversationId: conversationId,
      externalConversationTitle: 'MCP stdio E2E',
      requestedAgentName: 'stdio 測試員工',
    },
  }));
  sessionId = started.session.id;
  assert.equal(started.deduplicated, false);
  assert.equal(started.session.status, 'DISCOVERY');

  const synced = resultJson(await client.callTool({
    name: 'sync_agent_build_turn',
    arguments: {
      sessionId,
      source: 'CLAUDE_DESKTOP',
      externalEventId: `turn-${runId}`,
      turns: [
        { role: 'user', content: '每天早上九點整理昨天的客服回饋。' },
        { role: 'assistant', content: '我會先確認回饋來源，以及沒有資料時應如何回報。' },
      ],
    },
  }));
  assert.equal(synced.deduplicated, false);

  const duplicate = resultJson(await client.callTool({
    name: 'sync_agent_build_turn',
    arguments: {
      sessionId,
      source: 'CLAUDE_DESKTOP',
      externalEventId: `turn-${runId}`,
      turns: [{ role: 'user', content: '同一事件重試' }],
    },
  }));
  assert.equal(duplicate.deduplicated, true);

  const synchronizedStop = resultJson(await client.callTool({
    name: 'guard_agent_build_stop',
    arguments: {
      externalConversationId: conversationId,
      lastAssistantMessage: '我會先確認回饋來源，以及沒有資料時應如何回報。',
      stopHookActive: false,
      source: 'CLAUDE_CODE',
    },
  }));
  assert.equal(synchronizedStop.matched, true);
  assert.equal(synchronizedStop.finalMessageSynced, true);
  assert.equal(synchronizedStop.artifactFresh, false);
  assert.equal(synchronizedStop.decision, undefined, 'Stop must not wait for artifact generation');

  const upload = resultJson(await client.callTool({
    name: 'upload_agent_build_file',
    arguments: {
      sessionId,
      filename: 'feedback-rules.md',
      mimeType: 'text/markdown',
      textContent: '# 客戶回饋規則\n\n沒有資料時明確回報，不可編造。',
    },
  }));
  assert.equal(upload.uploaded.filename, 'feedback-rules.md');
  assert(upload.uploaded.bytes > 0);

  const artifact = resultJson(await client.callTool({
    name: 'sync_agent_build_artifact',
    arguments: {
      sessionId,
      source: 'CLAUDE_DESKTOP',
      externalEventId: `artifact-${runId}`,
      artifact: {
        identity: {
          name: 'stdio 測試員工',
          purpose: '每天整理客服回饋並提出三個有證據的改善建議。',
          workingStyle: ['引用原文', '區分事實和推論'],
        },
        agentMarkdown: '# stdio 測試員工\n\n只使用已同步的回饋。',
        skills: [{
          name: '客服回饋歸納',
          contentMd: '---\nname: feedback-summary\n---\n\n# 客服回饋歸納\n\n產出三個附引文的改善項目。',
          inputs: ['客服回饋'],
          outputs: ['三個改善項目'],
          edgeCases: ['無資料時不得編造'],
        }],
        memory: {
          facts: ['每天早上九點執行'],
          documents: [{ path: 'rules/feedback.md', contentMd: '# 規則\n\n不得編造。' }],
        },
        tools: [{ name: '客服資料來源', purpose: '讀取回饋', status: 'AVAILABLE' }],
        policies: {
          allowed: ['讀取已授權回饋'],
          forbidden: ['捏造回饋'],
        },
        workflows: [{
          name: '每日客服回饋整理',
          trigger: { type: 'schedule', cron: '0 9 * * *' },
          steps: [{
            stepKey: 'summarize',
            type: 'DO',
            config: { instruction: '整理三個改善項目' },
            verifyRubric: '每個項目都有原始引文。',
          }],
        }],
        tests: [{ name: '空資料', input: '今天沒有回饋', expected: '回報沒有資料且不產生建議' }],
      },
    },
  }));
  assert.equal(artifact.iteration.status, 'READY');
  assert.equal(artifact.iteration.harness.tools[0].status, 'NEEDS_FDE');

  const allowedStop = resultJson(await client.callTool({
    name: 'guard_agent_build_stop',
    arguments: {
      externalConversationId: conversationId,
      lastAssistantMessage: '完整草稿已同步。',
      stopHookActive: true,
      source: 'CLAUDE_CODE',
    },
  }));
  assert.equal(allowedStop.matched, true);
  assert.equal(allowedStop.artifactFresh, true);
  assert.equal(allowedStop.decision, undefined);

  const build = resultJson(await client.callTool({
    name: 'get_agent_build',
    arguments: { sessionId },
  }));
  assert.equal(build.session.id, sessionId);
  assert(build.session.transcript.length >= 3);

  const resource = await client.readResource({ uri: `aios-build://${sessionId}` });
  assert(JSON.stringify(resource).includes(sessionId));

  const submitted = resultJson(await client.callTool({
    name: 'submit_agent_build_for_fde_review',
    arguments: { sessionId, strategy: 'create' },
  }));
  assert.equal(submitted.session.status, 'AWAITING_FDE');
  assert.equal(submitted.session.builtAgentId, null);
  assert.deepEqual(submitted.session.draftSkillIds, []);

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    toolCount: tools.tools.length,
    checks: [
      'stdio initialize/list tools',
      'prompt discovery',
      'start build',
      'turn sync and idempotent retry',
      'file upload',
      'complete artifact sync',
      'Stop hook synchronizes without blocking before and after artifact sync',
      'build resource read',
      'submit stops at FDE review',
    ],
  }, null, 2));
} catch (error) {
  if (stderr.length) console.error(stderr.join(''));
  throw error;
} finally {
  await client.close().catch(() => {});
}
