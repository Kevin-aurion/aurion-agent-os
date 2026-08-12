import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db.js';
import { audit, verifyAuditChain } from '../src/lib/audit.js';
import { deepRedactSecrets } from '../src/memory/deepredact.js';
import {
  importExternalBuilderArtifact,
  submitExternalBuilderForReview,
  type ExternalArtifactInput,
} from '../src/lib/externalagentbuilder.js';

const SOURCE_BUILD_ID = '01KZKJQ5VX86TCA0XWRHJ4ZNEZ';
const OWNER_EMAIL = 'kevin@lazyoffice.app';

const purpose = 'Aurion的提案報價 AI 員工：把客戶會議逐字稿（SRT）或需求文件（PDF）轉成專業報價單、擬真互動 Dashboard 示意與嵌入截圖的功能總覽提案頁，並負責後續多輪修訂，讓提案可在會議當天交付。';

const skills: NonNullable<ExternalArtifactInput['skills']> = [
  {
    name: '逐字稿／需求文件 → 功能模組彙整',
    purpose: '完整讀取逐字稿與需求文件，建立可追溯的功能模組清單。',
    instructions: [
      '先讀完全部來源；逐字稿逐段、PDF 逐頁並包含圖片與截圖。',
      '以客戶正式文件為主要事實來源，口頭整理為輔。',
      '動工前一次確認功能範圍、金額與交付工時，不逐題反覆追問。',
    ],
    inputs: ['SRT 逐字稿', 'PDF 需求文件', '使用者補充說明'],
    outputs: ['功能模組清單', '待確認事項清單'],
    edgeCases: ['來源互相矛盾時標示差異並要求確認', '金額或工時未確認時不得推測'],
  },
  {
    name: '報價單產出（Aurion模板）',
    purpose: '依確認範圍產出可人工審核的 HTML 報價單。',
    instructions: [
      '沿用Aurion的報價模板、付款條件、驗收條款與附件結構。',
      '未確認金額一律標示待報價，未確認工時一律標示待確認。',
      '補金額後重算未稅、稅額、含稅總額與分期金額。',
    ],
    inputs: ['功能模組清單', '已確認金額與工時', '合約條款'],
    outputs: ['獨立 HTML 報價單'],
    edgeCases: ['重大範圍異動須另存新日期版本', '不得自行變更驗收或付款條款'],
  },
  {
    name: 'Dashboard 示意與截圖（dashboard-proposal-builder）',
    purpose: '以擬真假資料製作互動 Dashboard 示意並輸出高解析截圖。',
    instructions: [
      '所有 Demo 資料必須為擬真假資料，並清楚標示示意。',
      '依客戶回饋調整版面，客服工作台採左列表、中回覆、右功能綁定的三欄結構。',
      '輸出前實際渲染，檢查 CJK 字型、排版、圖片與佔位符。',
    ],
    inputs: ['功能模組與介面需求', '設計偏好'],
    outputs: ['互動 Dashboard HTML', '高解析 PNG 截圖'],
    edgeCases: ['不得使用客戶真實個資', '不得把示意畫面宣稱為正式上線系統'],
  },
  {
    name: '功能總覽提案頁組裝',
    purpose: '把痛點、解法、功能、流程與 Dashboard 截圖組成單檔提案頁。',
    instructions: [
      '每個模組都要說明客戶痛點與功能價值。',
      '將核對過的截圖嵌入提案頁，輸出可獨立交付的單檔 HTML。',
      '保持報價單、Dashboard 與提案頁的模組命名一致。',
    ],
    inputs: ['功能模組', 'Dashboard 截圖', '報價資訊'],
    outputs: ['功能總覽提案頁 HTML'],
    edgeCases: ['截圖或模組版本不一致時先停止交付並修正'],
  },
  {
    name: '多輪修訂管理',
    purpose: '處理金額、條款、範圍與介面回饋，保持所有交付物一致。',
    instructions: [
      '同日小幅迭代可覆蓋；縮小範圍或重大改版時建立新日期版本並保留舊版。',
      '每輪修訂後主動檢查其他檔案的一致性問題，只提出建議，不擅自擴大修改。',
      '交付前渲染檢查字型、排版、佔位符與金額加總。',
    ],
    inputs: ['使用者修訂指示', '現有交付物'],
    outputs: ['修訂後版本', '跨檔案一致性提醒'],
    edgeCases: ['條款、金額、範圍與對外承諾須人工核准'],
  },
];

const facts = [
  '公司：Aurion股份有限公司（乙方）；對外品牌：Aurion・AI 落地師。',
  '聯絡人：吳文凱 Kevin／0975059080／kevin@lazyoffice.app。',
  '匯款：玉山銀行（808）三和分行；戶名Aurion股份有限公司；帳號由正式資料確認。',
  '現行客戶：克拉拉旅遊（Clara Travel）；窗口思羽 Sophie、老闆背鴻；每月約 80–100 組訂單；ERP 為 Galaxy 系統；使用 104 打卡。',
  '克拉拉專案一旅遊訂單自動化：7 模組版 20260703；三模組第一階段版 20260713，未稅 100,000、含稅 105,000、22 個工作天。',
  '克拉拉專案二 LINE 客服與行銷自動化：6 模組、QUO20260723001，金額與工時待確認；介面為三欄式工作台。',
  '使用者提供 dashboard-proposal-builder_SKILL.md 作為可重用參考範本。',
  '金額未確認先留待報價、工時留待確認，之後一次補上。',
  '驗收機制：7 個工作天回饋期，逾期視為驗收通過。',
  '客服系統介面：左聊天列表、中回覆內容、右功能綁定區；客戶記事本與指派歸屬整合右欄；數據與回覆分開。',
  '每個畫面與提案模組都要有痛點與功能說明。',
  '偏好先提供 Demo 確認方向，再正式報價。',
  '團控大表＝旅行社訂單總表（旅客、日期、度假村、確認號）。',
  '出遊清單＝提供給客人的行程確認文件，原先由 PPT 範本手工製作。',
  '功能綁定區＝工作台右欄，隨對話載入功能卡片。',
  '未指派池＝當班人員未上線時，新對話的暫存佇列。',
  'FDE＝AIOS 上線前人工審核閘門。',
];

const workflows: NonNullable<ExternalArtifactInput['workflows']> = [
  {
    name: '新專案：來源→三件套交付',
    description: '從來源解析到報價單、Dashboard 與功能總覽提案頁的完整八步流程。',
    trigger: { type: 'manual' },
    steps: [
      { stepKey: 'read-sources', type: 'DO', config: { task: '完整讀取逐字稿、PDF 與既有交付物' }, verifyRubric: '來源必須完整讀取且可追溯' },
      { stepKey: 'extract-modules', type: 'DO', config: { task: '彙整功能模組、痛點與待確認事項' }, verifyRubric: '模組命名一致且無臆測' },
      { stepKey: 'confirm-scope', type: 'DO', config: { task: '一次確認金額、工時與功能範圍' }, verifyRubric: '未確認項目標示待報價或待確認' },
      { stepKey: 'build-quotation', type: 'DO', config: { task: '產出 HTML 報價單草稿' }, verifyRubric: '金額、稅額、條款與附件一致' },
      { stepKey: 'build-dashboard', type: 'DO', config: { task: '以假資料產出 Dashboard 示意' }, verifyRubric: '示意標示清楚且不含真實個資' },
      { stepKey: 'render-screenshots', type: 'COMPUTER_CONTROL', config: { task: '實際渲染並擷取高解析截圖' }, verifyRubric: '字型、排版、圖片皆正常' },
      { stepKey: 'assemble-proposal', type: 'DO', config: { task: '組裝功能總覽提案頁' }, verifyRubric: '痛點、解法、功能、流程與截圖完整' },
      { stepKey: 'final-qa', type: 'DO', config: { task: '跨檔案一致性與交付前檢查' }, verifyRubric: '無佔位符、金額正確、版本一致' },
    ],
  },
  {
    name: '修訂：金額／條款／範圍／介面',
    description: '依回饋判斷受影響交付物，完成修訂並做跨檔案一致性檢查。',
    trigger: { type: 'manual' },
    steps: [
      { stepKey: 'classify-revision', type: 'CONDITION', config: { task: '辨認金額、條款、範圍或介面異動' }, verifyRubric: '異動類型與影響檔案清楚' },
      { stepKey: 'apply-revision', type: 'DO', config: { task: '依版本政策修訂相關交付物' }, verifyRubric: '重大改版另存新日期版本且舊版保留' },
      { stepKey: 'cross-file-qa', type: 'DO', config: { task: '重算、重渲染並核對跨檔案一致性' }, verifyRubric: '所有受影響檔案內容一致' },
    ],
  },
];

const tests: NonNullable<ExternalArtifactInput['tests']> = [
  { name: '逐字稿→報價單（金額留白）', input: '提供完整逐字稿但未確認金額與工時。', expected: '一次確認範圍；產出含全部模組的報價單，金額標待報價、工時標待確認，含驗收與附件，並回報模組清單。' },
  { name: '補金額重算', input: '三列合計未稅 100,000，含稅 105,000，分兩期。', expected: '移除待報價並正確顯示兩期各 52,500，同時提醒其他版本是否同步。' },
  { name: '縮範圍出新版', input: '將專案縮成三個模組。', expected: '建立當日新版本的報價單、Dashboard 與提案頁；重編模組、同步附件與總計，舊版保留。' },
  { name: '介面回饋改版', input: '客服 Dashboard 改為左列表、中回覆、右功能綁定；效率分析獨立頁。', expected: '只重構 Dashboard、重截圖並更新提案頁導覽，不修改報價單。' },
];

const fullArtifact: ExternalArtifactInput = {
  identity: {
    name: 'AI 落地提案師',
    purpose,
    workingStyle: [
      '先完整讀取來源再動手',
      '一次問完必要確認事項',
      '不編造金額、工時或事實',
      '主動檢查跨檔案一致性',
      '重大改版保留舊版',
      '交付前實際渲染檢查',
    ],
  },
  skills,
  memory: { facts },
  tools: [
    { name: 'meeting-transcript skill', purpose: '逐字稿轉會議記錄與報價單範本' },
    { name: 'dashboard-proposal-builder skill', purpose: 'Dashboard 示意、截圖與提案頁組裝' },
    { name: 'headless Chromium (Playwright)', purpose: '高解析渲染與截圖' },
    { name: 'quotation-html skill', purpose: '獨立 HTML 報價單產生' },
  ],
  policies: {
    allowed: ['讀取工作資料夾內的逐字稿、PDF 與既有交付物', '產出與修改 HTML／PNG 交付物', '使用擬真假資料製作並標示 Demo 畫面'],
    requiresApproval: ['正式金額與交付工時', '合約條款變更', '縮放專案範圍', '以公司名義對外承諾時程'],
    forbidden: ['未經確認猜測金額、工時或折扣', '直接把文件發送給終端客戶', '將 Demo 宣稱為正式系統或使用客戶真實個資', '刪除舊版本交付物'],
  },
  tests,
  workflows,
  understanding: {
    northStar: purpose,
    painPoints: ['會議後要人工重做報價、Demo 與提案頁', '多輪修訂容易造成跨檔案內容不一致', '未確認金額與條款可能被誤寫成正式承諾'],
    confidence: 92,
  },
  userSummary: '已把從逐字稿與需求文件到報價單、Dashboard、提案頁及多輪修訂的完整方法整理成 AI 員工草稿。',
  fdeSummary: '由舊 Aurion Build 01KZKJQ5VX86TCA0XWRHJ4ZNEZ 遷移；共 5 技能、2 流程、17 記憶、4 工具與 4 測試。所有工具均為 NEEDS_FDE，內容維持 shadow draft，未建立或啟用正式資源。',
};

function versionArtifact(version: number): ExternalArtifactInput {
  if (version === 1) return { ...fullArtifact, skills: skills.slice(0, 3), memory: { facts: facts.slice(0, 6) }, workflows: workflows.slice(0, 1), tests: tests.slice(0, 1) };
  if (version === 2) return { ...fullArtifact, skills: skills.slice(0, 4), memory: { facts: facts.slice(0, 10) }, workflows, tests: tests.slice(0, 2) };
  if (version === 3) return { ...fullArtifact, memory: { facts: facts.slice(0, 16) }, tests: tests.slice(0, 3) };
  return fullArtifact;
}

async function main() {
  const owner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!owner || !['OWNER', 'TRAINER'].includes(owner.role)) {
    throw new Error(`Migration owner ${OWNER_EMAIL} must exist and be FDE`);
  }

  const existing = await prisma.agentBuildSession.findUnique({ where: { id: SOURCE_BUILD_ID } });
  if (existing) {
    console.log(JSON.stringify({ migrated: false, deduplicated: true, id: existing.id, status: existing.status }));
    return;
  }

  const transcript = deepRedactSecrets([
    { role: 'user', content: '你可以幫我把這個 session 的過程，也就是從逐字稿、生成報價單，以及多次來回的內容，幫我把它訓練成一個 AI 員工嗎？', at: '2026-08-09T15:37:01.000Z', source: 'CLAUDE_CODE', externalEventId: 'aurion:v1:user' },
    { role: 'user', content: '你可以幫我把這個 session 的過程，也就是從逐字稿、生成報價單，以及多次來回的內容，幫我把它訓練成一個 AI 員工嗎？', at: '2026-08-09T15:39:50.000Z', source: 'CLAUDE_CODE', externalEventId: 'aurion:v3:user' },
    { role: 'assistant', content: '已將本 session 的完整工作流程蒸餾為 AI 員工草稿：涵蓋來源解析、開工前確認、報價單產出、Dashboard 示意與截圖、功能總覽提案頁，以及補金額、縮範圍、條款與介面回饋的多輪修訂。', at: '2026-08-09T15:39:50.000Z', source: 'CLAUDE_CODE', externalEventId: 'aurion:v3:assistant' },
    { role: 'assistant', content: '我已讀取 dashboard-proposal-builder_SKILL.md，並把它標記為可重用參考範本。FDE 核准建置後才能建立正式技能；目前仍只是待審草稿。', at: '2026-08-09T15:40:59.000Z', source: 'CLAUDE_CODE', externalEventId: 'aurion:v4:assistant' },
  ]);
  const brief = deepRedactSecrets({
    requestedAgentName: 'AI 落地提案師',
    objective: purpose,
    requestedStrategy: 'create',
    externalSource: 'CLAUDE_CODE',
    externalConversationId: SOURCE_BUILD_ID,
    externalConversationTitle: '從舊 Aurion AIOS 遷移',
    migration: { sourceHost: 'aurion-aios.lazyoffice.app', sourceBuildId: SOURCE_BUILD_ID },
  });

  await prisma.agentBuildSession.create({
    data: {
      id: SOURCE_BUILD_ID,
      userId: owner.id,
      status: 'DISCOVERY',
      transcript: transcript as Prisma.InputJsonValue,
      brief: brief as Prisma.InputJsonValue,
      progress: deepRedactSecrets({ answeredKeys: [], total: 0 }) as Prisma.InputJsonValue,
      createdAt: new Date('2026-08-09T15:37:01.000Z'),
    },
  });
  await audit(owner.id, 'agent_builder.session_migration_started', 'AgentBuildSession', SOURCE_BUILD_ID, {
    source: 'aurion-aios.lazyoffice.app',
    sourceBuildId: SOURCE_BUILD_ID,
  });

  for (let version = 1; version <= 4; version += 1) {
    await importExternalBuilderArtifact({
      sessionId: SOURCE_BUILD_ID,
      userId: owner.id,
      role: owner.role,
      source: 'CLAUDE_CODE',
      externalEventId: `aurion-migration:${SOURCE_BUILD_ID}:v${version}`,
      artifact: versionArtifact(version),
    });
  }
  const session = await submitExternalBuilderForReview({
    sessionId: SOURCE_BUILD_ID,
    userId: owner.id,
    role: owner.role,
    strategy: 'create',
  });
  await audit(owner.id, 'agent_builder.session_migrated', 'AgentBuildSession', SOURCE_BUILD_ID, {
    source: 'aurion-aios.lazyoffice.app',
    sourceBuildId: SOURCE_BUILD_ID,
    targetOwner: OWNER_EMAIL,
    status: session.status,
    iterations: session.iterations.length,
    liveResourcesCreated: false,
  });

  const stored = await prisma.agentBuildSession.findUnique({
    where: { id: SOURCE_BUILD_ID },
    include: { iterations: { orderBy: { sequence: 'asc' } } },
  });
  const latest = stored?.iterations.at(-1)?.artifactSnapshot as Record<string, any> | undefined;
  const chain = await verifyAuditChain();
  console.log(JSON.stringify({
    migrated: true,
    id: stored?.id,
    owner: OWNER_EMAIL,
    status: stored?.status,
    iterations: stored?.iterations.length,
    transcriptTurns: Array.isArray(stored?.transcript) ? stored.transcript.length : 0,
    skills: latest?.skills?.length ?? 0,
    workflows: latest?.workflows?.length ?? 0,
    memoryFacts: latest?.memory?.facts?.length ?? 0,
    tools: latest?.tools?.length ?? 0,
    tests: latest?.testIdeas?.length ?? 0,
    builtAgentId: stored?.builtAgentId ?? null,
    draftSkillIds: stored?.draftSkillIds ?? [],
    auditChainValid: chain.valid,
  }, null, 2));
}

main().finally(async () => prisma.$disconnect());
