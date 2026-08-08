import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const conversationId = `claude-code-hook-live-${Date.now()}`;
const client = new Client({ name: 'aios-hook-live-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, AIOS_MCP_PROFILE: 'builder' },
  stderr: 'pipe',
});

function parsed(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(text, 'MCP tool returned no JSON text');
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === 'prepare_agent_build_prompt'));
  assert(tools.tools.some((tool) => tool.name === 'guard_agent_build_stop'));

  const unrelated = parsed(await client.callTool({
    name: 'prepare_agent_build_prompt',
    arguments: {
      externalConversationId: `${conversationId}-unrelated`,
      prompt: '請解釋這段程式碼。',
      source: 'CLAUDE_CODE',
    },
  }));
  assert.equal(unrelated.matched, false);

  const started = parsed(await client.callTool({
    name: 'prepare_agent_build_prompt',
    arguments: {
      externalConversationId: conversationId,
      prompt: '請幫我建立一位 MCP Hook 驗證用的 AI 員工，負責整理每日客戶回饋並提出三項可執行改善建議。',
      source: 'CLAUDE_CODE',
    },
  }));
  assert.equal(started.matched, true);
  assert.equal(started.created, true);
  assert.equal(started.userMessageSynced, true);
  assert.equal(started.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');

  const stopped = parsed(await client.callTool({
    name: 'guard_agent_build_stop',
    arguments: {
      externalConversationId: conversationId,
      lastAssistantMessage: '我會先確認回饋來源與判斷改善建議成功的標準，再逐步把這位員工訓練完整。',
      stopHookActive: false,
      source: 'CLAUDE_CODE',
    },
  }));
  assert.equal(stopped.matched, true);
  assert.equal(stopped.finalMessageSynced, true);
  assert.equal(stopped.decision, undefined, 'Stop must not block waiting for an artifact');

  const build = parsed(await client.callTool({
    name: 'get_agent_build',
    arguments: { sessionId: started.sessionId },
  }));
  assert.equal(build.session.id, started.sessionId);
  assert(build.session.transcript.length >= 2);

  console.log(JSON.stringify({
    ok: true,
    conversationId,
    sessionId: started.sessionId,
    toolCount: tools.tools.length,
    checks: [
      'unrelated prompt no-op',
      'UserPromptSubmit auto-start',
      'hook additionalContext',
      'Stop auto-sync without block',
      'durable transcript readable through MCP',
    ],
  }, null, 2));
} finally {
  await client.close().catch(() => {});
}
