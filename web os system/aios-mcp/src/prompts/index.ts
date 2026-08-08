import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerAllPrompts(server: McpServer): void {
  server.registerPrompt(
    'build-aios-agent',
    {
      title: 'Build an AIOS AI employee',
      description: 'Run an adaptive interview and continuously synchronize the resulting Agent draft to AIOS.',
      argsSchema: {
        request: z.string().min(1).describe('What the user wants the AI employee to accomplish.'),
        source: z.enum(['CLAUDE_DESKTOP', 'CLAUDE_CODE', 'CHATGPT', 'CURSOR', 'OTHER']).default('CHATGPT'),
      },
    },
    async ({ request, source }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `請幫我建立一位 AIOS AI 員工：${request}`,
            '',
            `這次來源是 ${source}。先呼叫 list_my_agents，判斷是續訓既有員工還是建立新人。`,
            '若續訓對象不唯一，先列出候選並詢問；若建立新人且尚未命名，先讓使用者決定名稱。',
            '確認後才呼叫 start_agent_build；續訓要帶 targetAgentId，新建要帶使用者決定的 requestedAgentName。',
            '採用動態 Grill-me 訪談：一次只問一個最重要、最貼近情境的問題，並附上具體建議；不要照固定 SOP 問卷。',
            '沒有 lifecycle hook 時，每輪在送出回答前呼叫 upsert_agent_build_snapshot，同步原話、完整答覆與完整 shadow draft。',
            '有 lifecycle hook 時遵循 hook，只有高精度完整草稿才另呼叫 sync_agent_build_artifact；檔案使用 upload_agent_build_file。',
            '除非使用者明確確認送審，否則不要呼叫 submit_agent_build_for_fde_review。',
            '任何同步失敗都要明確告知，不得聲稱 AIOS 已收到。',
          ].join('\n'),
        },
      }],
    }),
  );
}
