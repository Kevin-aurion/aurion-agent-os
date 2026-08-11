import assert from 'node:assert/strict';
import type { ExternalArtifactInput } from '../../src/lib/externalagentbuilder.js';

export function buildKnowledgeShadowArtifact(sourceSessionId: string): ExternalArtifactInput {
  return {
    identity: {
      name: 'AI 知識採集 — Langflow Sandbox',
      purpose: '以無外部副作用的 Langflow Sandbox Flow，驗證知識提問、回傳與 trace 閉環。',
      workingStyle: ['唯讀', '先引用後結論', '資料不足時明確說明', '正式生效前必須經 FDE'],
    },
    skills: [{
      name: '知識查詢輸入輸出閉環驗證',
      purpose: '先驗證 Langflow 原生 Flow 可接收問題並回傳可追蹤結果。',
      instructions: [
        '只處理使用者明確提供的測試輸入。',
        'Sandbox 階段不得下載、排程、執行 Shell、呼叫外部 CLI 或寫入知識庫。',
        '保留輸入、輸出、執行時間與 Flow ID 作為驗收證據。',
      ],
      inputs: ['知識問題或驗證文字（必填）'],
      outputs: ['Langflow 回傳文字', 'Flow ID、環境與執行時間'],
      edgeCases: ['輸入為空時拒絕執行', 'Langflow 無回傳時 fail-closed', '任何寫入需求轉交 FDE'],
    }],
    memory: {
      facts: [
        `來源 AgentBuildSession：${sourceSessionId}`,
        '完整 AI 知識採集仍保留在原始草稿；此複本只做 Langflow 唯讀閉環試驗。',
      ],
      glossary: ['Shadow Draft：不可直接生效的影子草稿', 'Sandbox：與正式環境隔離的測試環境'],
    },
    tools: [{
      name: 'Langflow Native Chat Input / Chat Output',
      purpose: '驗證原生 Langflow Flow API 的輸入、輸出與 trace。',
      status: 'NEEDS_FDE',
    }],
    policies: {
      allowed: ['讀取本次測試輸入', '在 Langflow Sandbox 回傳相同測試內容', '記錄不含密鑰的驗收證據'],
      requiresApproval: ['接入真實知識庫', '啟用網路、檔案、排程或外部工具', '部署到 Production'],
      forbidden: ['Shell', '外部網路', 'YouTube 下載', '檔案寫入', '排程', '雲端同步', 'Production 自動啟用'],
    },
    testInputRequirements: [{
      key: 'knowledge_question',
      label: '知識問題或驗證文字',
      kind: 'TEXT',
      required: true,
      description: '提供一段文字，確認 Langflow 可完整接收並回傳。',
    }],
    tests: [{
      name: 'Langflow 原生閉環',
      input: '查詢：請確認 AI 知識採集 Langflow Sandbox 的唯讀輸入輸出閉環。',
      expected: '回傳相同文字，並記錄 Sandbox、Flow ID 與執行時間。',
    }],
    workflows: [{
      name: 'Sandbox 唯讀輸入輸出驗證',
      description: '不連接真實知識庫的第一階段 Langflow 相容性測試。',
      trigger: { type: 'manual' },
      durable: false,
      steps: [{
        stepKey: 'langflow-readonly-roundtrip',
        type: 'DO',
        config: { environment: 'SANDBOX', sideEffects: false },
        verifyRubric: '輸出需完整保留輸入，且不得發生外部副作用。',
        onFail: { action: 'stop', reason: 'Langflow roundtrip failed' },
      }],
    }],
    userSummary: '已複製一份 Langflow Sandbox 專用影子草稿；原始 AI 知識採集草稿完全不變。',
    fdeSummary: `來源 ${sourceSessionId}。目前只允許原生 Chat Input → Chat Output 閉環，正式知識檢索與採集工具仍需另行審核。`,
  };
}

export function validateKnowledgeShadowArtifact(artifact: ExternalArtifactInput): void {
  assert.equal(artifact.identity.name, 'AI 知識採集 — Langflow Sandbox');
  assert.equal(artifact.skills?.length, 1);
  assert.equal(artifact.testInputRequirements?.[0]?.required, true);
  assert.ok(artifact.policies?.forbidden?.includes('Shell'));
  assert.ok(artifact.policies?.forbidden?.includes('Production 自動啟用'));
  assert.equal(artifact.workflows?.[0]?.trigger?.type, 'manual');
  assert.equal(artifact.workflows?.[0]?.steps?.[0]?.config?.sideEffects, false);
}
