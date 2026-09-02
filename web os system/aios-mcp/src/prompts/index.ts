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
        source: z.enum(['CLAUDE_DESKTOP', 'CLAUDE_CODE', 'CODEX', 'CHATGPT', 'CURSOR', 'OTHER']).default('CHATGPT'),
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
            `這次來源是 ${source}。先呼叫 start_agent_build 保存原始需求。`,
            '採用動態 Grill-me 訪談：一次只問一個最重要、最貼近情境的問題，並附上具體建議；不要照固定 SOP 問卷。',
            '沒有 lifecycle hook 時，每輪在送出回答前呼叫 upsert_agent_build_snapshot，同步原話、完整答覆與完整訓練快照。',
            '有 lifecycle hook 時遵循 hook，只有高精度完整草稿才另呼叫 sync_agent_build_artifact；檔案使用 upload_agent_build_file。',
            '第一份完整訓練快照同步成功後，員工會自動可用；後續快照直接更新同一位員工。一般流程不要要求或呼叫 activate_agent_build。',
            '任何同步失敗都要明確告知，不得聲稱 AIOS 已收到。',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'use-aios-agent',
    {
      title: 'Use or safely try an AIOS employee',
      description: 'Select, invoke, schedule or request archival of an ACTIVE AIOS employee.',
      argsSchema: {
        request: z.string().min(1).describe('The work or recurring cadence the user wants an existing employee to perform.'),
      },
    },
    async ({ request }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `請使用我的 AIOS 員工處理：${request}`,
            '',
            '先呼叫 list_available_agents。',
            '若無法唯一判定員工，列出少量候選並詢問，不要猜測。',
            '選到 ACTIVE 員工後，呼叫 get_agent_capabilities，依輸入規格補齊必要資料，再用穩定 idempotencyKey 呼叫 invoke_agent。',
            '使用 get_agent_run 追蹤到終態；QUEUED/RUNNING 不代表完成。',
            '若需求是定期執行，先呼叫 list_agent_schedules，再以 set_agent_schedule 直接設定，只以後端回傳狀態聲稱成功。',
            '若使用者要刪除、移除、退休或封存員工，重新呼叫 list_available_agents，確認唯一員工並要求使用者確認完整名稱，再呼叫 archive_agent。',
          ].join('\n'),
        },
      }],
    }),
  );
}
