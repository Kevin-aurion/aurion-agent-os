export const meta = {
  name: 'aios-client-langflow-platform',
  description: 'Codex spec/tickets → Fable ticket orchestration → Grok CLI implementation → Fable integration review',
  phases: [
    { title: 'Baseline' },
    { title: 'Phase 1' },
    { title: 'Phase 2' },
    { title: 'Phase 3' },
    { title: 'Phase 4' },
    { title: 'Phase 5' },
    { title: 'Phase 6' },
    { title: 'Integration' },
  ],
}

const ROOT = '/Users/kaikaiwu/Desktop/LazyOffice/AI OS Langflow'
const SERVER = ROOT + '/web os system/aios-server'
const WEB = ROOT + '/web os system/aios-web'
const MCP = ROOT + '/web os system/aios-mcp'
const FEATURE = SERVER + '/.scratch/aios-client-langflow-platform'
const SPEC = FEATURE + '/spec.md'
const GROK = '/Users/kaikaiwu/.grok/bin/grok'
const NODE22 = '/opt/homebrew/opt/node@22/bin'

const TICKETS = [
  ['04', 'skillversion-ir-fields', 'Phase 3'],
  ['05', 'flowartifact-model-and-digest', 'Phase 3'],
  ['06', 'runtime-deployment-gate', 'Phase 3'],
  ['07', 'compiler-email-triage', 'Phase 3'],
  ['08', 'template-scheduled-report', 'Phase 3'],
  ['09', 'template-approval-gated-action', 'Phase 3'],
  ['10', 'workbench-assign-work', 'Phase 4'],
  ['11', 'workbench-teach-new-task', 'Phase 4'],
  ['12', 'workbench-scheduled-work', 'Phase 4'],
  ['13', 'fde-proposal-approval-journey', 'Phase 4'],
  ['14', 'fde-skill-governance', 'Phase 4'],
  ['15', 'fde-flow-deployment-governance', 'Phase 4'],
  ['16', 'model-gateway', 'Phase 5'],
  ['17', 'langflow-production-isolation', 'Phase 5'],
  ['18', 'production-rollout-idempotency', 'Phase 5'],
  ['19', 'observability-slo', 'Phase 5'],
  ['20', 'poc-negative-suite', 'Phase 5'],
  ['21', 'phase6-hardening', 'Phase 6'],
  ['22', 'fde-registry-api-prefix', 'Phase 6'],
]

const PRECOMPLETED_RESULTS = [
  {
    pass: true,
    ticket: '01-cherry-companion-spike',
    grokSessionId: '52D85902-B011-41CD-8F1B-4DC5AD2D3AF1',
    filesTouched: [
      SERVER + '/.scratch/aios-client-langflow-platform/tests/t01-builder-scope-negative.test.ts',
      SERVER + '/.scratch/aios-client-langflow-platform/tests/t01-builder-scope-positive.test.ts',
      SERVER + '/.scratch/aios-client-langflow-platform/reports/01-cherry-spike-report.md',
    ],
    verification: 'Grok and root Codex independently passed the live OAuth/DB negative matrix, the shadow-draft positive journey, and server tsc on Node 22.23.2.',
    findings: [],
    blocked: ['Real external Companion GUI OAuth screenshots remain a root Codex Browser handoff; API and DB security acceptance is complete.'],
  },
  {
    pass: true,
    ticket: '02-langflow-sandbox-docker',
    grokSessionId: '7308F03B-26BF-4DD0-9C4F-13552A312C41',
    filesTouched: [
      ROOT + '/web os system/docker-compose.langflow-sandbox.yml',
      ROOT + '/web os system/README.langflow-sandbox.md',
      SERVER + '/.scratch/aios-client-langflow-platform/tests/t02-langflow-sandbox.test.ts',
    ],
    verification: 'Fable and root Codex verified deterministic secret/loopback/project-scope negatives, live compose health 200, 127.0.0.1:7860 binding, safe cleanup, and server tsc on Node 22.23.2.',
    findings: ['The public image pull required a temporary Docker client config without the Desktop credential helper; ~/.docker/config.json was not modified.'],
    blocked: [],
  },
  {
    pass: true,
    ticket: '03-runtime-adapter-contract',
    grokSessionId: '7E4F2C1A-9B3D-4E5F-8A6C-D1B2E3F4A5C6',
    preTree: '7fdf433f69b019ecbd8c0eec13403d633a3ee124',
    postTree: '474d68370af154a2f3d97cdb7b1e3c119851b7b2',
    filesTouched: [
      SERVER + '/src/runtime/adapter.ts',
      SERVER + '/src/runtime/native.ts',
      SERVER + '/src/runtime/langflow.ts',
      SERVER + '/.scratch/aios-client-langflow-platform/tests/t03-adapter-contract.test.ts',
      SERVER + '/.scratch/aios-client-langflow-platform/tests/t03-url-timeout-negative.test.ts',
    ],
    verification: 'Grok and Fable independently passed server tsc, the shared Native/Langflow adapter contract (45/45), and URL/timeout/outage negatives (20/20). The delta contains exactly the five allowed new files; Runtime remains separate from Engine and wire events stay private.',
    findings: ['A later optional persistent-sandbox probe left Docker Desktop API unresponsive after the already-passing t02 live health run; the adapter outage/timeout behavior remained deterministic and green.'],
    blocked: ['Docker Desktop must recover before the optional persistent Langflow live probe and container teardown can be repeated; this is an environment issue, not a code acceptance failure.'],
  },
]

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['pass', 'ticket', 'grokSessionId', 'filesTouched', 'verification', 'findings', 'blocked'],
  properties: {
    pass: { type: 'boolean' },
    ticket: { type: 'string' },
    grokSessionId: { type: 'string' },
    preTree: { type: 'string' },
    postTree: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'array', items: { type: 'string' } },
  },
}

const INTEGRATION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['pass', 'summary', 'server', 'web', 'mcp', 'security', 'browserHandoff', 'blockers'],
  properties: {
    pass: { type: 'boolean' },
    summary: { type: 'string' },
    server: { type: 'string' },
    web: { type: 'string' },
    mcp: { type: 'string' },
    security: { type: 'string' },
    browserHandoff: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

function redLines() {
  return [
    'AGENTS.md 五條紅線全部是 release blocker：execute != verify；程式碼層限制/預算 fail-closed；redactSecrets 永遠生效；Skill 永不自動確認；只有 FDE 讓變更生效。',
    'Runtime != Engine，LANGFLOW 不可加入 Engine enum。Langflow 不得持有 Production provider credentials。',
    '不得複製/參考 Cherry source、asset、CSS token、文案或套件；只能依 spec 的乾淨室行為描述獨立實作。',
    '不得修改 lazyoffice-system-main；不得 commit/push；不得 restore/checkout/reset 使用者 WIP。',
    '閘門類 fail-closed；附屬記錄類 fail-safe。所有外部路徑用 safepath；ESM relative import 帶 .js；Prisma 只新增 migration。',
    '所有 Node/npm/npx/Prisma 指令前固定 `export PATH="' + NODE22 + ':$PATH"`，並先確認 `node -v` 為 v22；禁止用 Node 23 跑 Prisma。Prisma 每項驗證只做一次有界嘗試，超時即列 blocked，不可換參數無限重試。',
  ].join('\n')
}

function ticketPrompt(id, slug) {
  const ticket = FEATURE + '/issues/' + id + '-' + slug + '.md'
  const fgRule = Number(id) >= 9
    ? '執行紀律（重要）：每次 Grok 呼叫都必須在你的工具回合內以前景方式同步完成（單次 Bash 呼叫、設定有界 timeout，最長 10 分鐘）；絕對不要把 Grok 放到背景任務後結束回合去等待——workflow 會在你結束回合時立刻強制 StructuredOutput，導致整票 fail。若 Grok 超時，kill 該次呼叫、確認 ~/.cursor/mcp.json 已復原，再以同一 session `-r` 開下一輪。'
    : ''
  const resume09 = id === '09'
    ? '接續前輪：上一個 ticket 09 agent 已被中斷。Grok session 111A65C7-A6B0-403F-954F-D9654CDADAC7（存於 /tmp/aios_client_langflow_09_uuid.txt）round 1 被 kill、/tmp/aios_client_langflow_09_out1.json 為空；t09-approval-gated.test.ts 與 t09-approval-negative.test.ts 已存在於 feature tests/，compiler/registry.ts 與 templates/ 可能已含部分 09 變更。PRE tree 5866081f0eb517aa754276f91aa8e4dabdf40d93。先盤點現有 diff 與測試現況，再決定用 `-r` 續接舊 session 或開新 session 完成剩餘工作；不可重複啟動並行 Grok。'
    : ''
  return [
    '你是本票 Fable 實作編排與獨立審查者。主要程式一律交給本機 Grok CLI 寫；你負責讀碼、建立精準 prompt、檢查 diff、實跑測試、把缺陷用同一 Grok session 修到通過。',
    '',
    '先完整讀：' + ROOT + '/AGENTS.md、' + ROOT + '/CONTEXT.md、' + ROOT + '/docs/adr/0013-clean-room-client-and-langflow-runtime.md、' + SPEC + '、' + ticket + '，以及票提到的 nested CLAUDE.md 與現有實作。',
    '',
    redLines(),
    '',
    '保護 dirty work：先用 alternate index 取 PRE tree（GIT_INDEX_FILE=/tmp/aios_client_langflow_' + id + '_pre.idx；git add -A；git write-tree；unset），不得碰真 index。讀 `git status --porcelain` 與相關 diff，確認票的 must-not-modify。',
    '',
    'TDD：先指示 Grok 建立票要求的負向/正向測試，先觀察合理失敗，再寫最小實作，最後 refactor。安全負向測試必須實際看到 403/throw/refuse/零資料變更。外部服務不可達時，先完成 deterministic contract tests，再把 live 項列 blocked，禁止假成功。',
    '',
    'Grok 機制：UUID=$(uuidgen)，把完整指示寫到 /tmp/aios_client_langflow_' + id + '.txt。Grok headless 會誤載入 ~/.cursor/mcp.json 的 taskmaster-ai 並中止，所以每次 Grok shell 必須先確認 ~/.cursor/mcp.json.aios-workflow-backup 不存在，再把 ~/.cursor/mcp.json 暫移到該 backup，設定 shell trap 保證 Grok 結束即原路復原；不可修改檔案內容，且執行後必須確認原檔已恢復。第一次執行 `' + GROK + ' --prompt-file <file> -s "$UUID" --output-format json --always-approve --reasoning-effort high --cwd <正確子專案>`。跨 server/web/MCP/infra 時用同一 UUID 以 `-r "$UUID"` 續接並切正確 cwd。所有 shell prompt 都先 `export PATH="' + NODE22 + ':$PATH"` 並驗證 Node 22。Grok 可以直接修改本地檔案，但不得 commit/push。',
    '',
    '完成後取 POST tree，細讀 `git diff PRE POST`。逐條核對 acceptance、must-not-modify、clean-room 與紅線；跑票內 verification，加上受影響子專案 tsc。若失敗，整理 findings，使用同一 Grok UUID `-r` 修正，最多三輪，每輪從頭重測。',
    '',
    'Prisma：既有多個 untracked migration 已屬使用者 WIP；只新增本票 migration，不改既有檔。DB 可達才 migrate dev；否則產生可審查 SQL 與 generate，live migrate 列 blocked。不要因測試清理刪除使用者資料。',
    '',
    '回傳 StructuredOutput。pass 只有在所有可執行 acceptance/測試通過、無 P0/P1 finding、未越界時才可為 true。ticket 01 的真 Cherry GUI 與最終 Browser journey 可交給 root Codex，列 browser handoff 不必讓整條 code chain 失敗；但 route/DB 安全測試必須完成。',
  ].concat(fgRule ? ['', fgRule] : []).concat(resume09 ? ['', resume09] : []).join('\n')
}

function integrationPrompt(results) {
  return [
    '你是最終 Fable 整合審查者。主要實作已由 Grok 完成並逐票審查。請親自讀完整 diff 與每票結果，跑全矩陣，不能只相信前票自述。',
    '',
    redLines(),
    '',
    '結果摘要：' + JSON.stringify(results),
    '',
    '必跑：server `npx prisma generate && npx tsc --noEmit`；web `npm run typecheck` 或 `npx tsc --noEmit`；MCP `npx tsc --noEmit`；所有本 feature tests；既有 agent-builder、skill-production-platform、agent-workbench 五紅線回歸；Prisma validate/migrate status；兩份 Langflow compose config/security checks。不可在 next dev 時跑 next build。',
    '',
    '做 clean-room audit：dependency 與 source 搜尋不得包含 @cherrystudio 或 Cherry source/assets；Client 只能是獨立 AIOS 實作。做 Runtime/Engine audit：LANGFLOW 不在 Engine enum；Production tool/model direct provider 路徑不存在。',
    '',
    '整理 Browser handoff：精確列出 root Codex 要在 /work、/admin、Langflow Sandbox/Production health、Remote MCP companion flow 點驗的 journeys 與測試帳號前置，不得宣稱已做 GUI。',
    '',
    '若發現缺陷，直接用 owning ticket 的 Grok session（結果中 session id）修復並重跑；若 session 不可用，建立新 Grok session但在摘要說明。最多三輪。最後 StructuredOutput。',
  ].join('\n')
}

phase('Baseline')
log('讀取 spec/tickets 並建立 dirty-worktree 基線；不 commit、不碰真 index')
const baseline = await agent([
  '以唯讀方式建立 AIOS Client/Langflow 平台基線。讀 AGENTS、CONTEXT、ADR0013、spec、ticket index、git status。',
  '先 `export PATH="' + NODE22 + ':$PATH"` 並確認 `node -v` 為 v22；$HOME/.local/node/bin 不存在，禁止回退 Node 23。',
  '用 alternate GIT_INDEX_FILE 產生 tree snapshot；跑 server/web/MCP typecheck、Prisma validate 與現有關鍵治理測試。',
  '本機已由 root Codex 修復下載資料夾造成的 fsevents 原生模組載入問題，Prisma validate 已在 Node 22 實跑通過。每項驗證最多一次；若仍有 live service 不可達，再列 blocked，不得換入口反覆重試。',
  '不要改檔。回傳 StructuredOutput，pass 可在 live external service 未啟動時成立，但要列 blocked。',
].join('\n'), {
  agentType: 'general-purpose', effort: 'high', phase: 'Baseline',
  schema: RESULT_SCHEMA, label: 'baseline',
})

const results = [...PRECOMPLETED_RESULTS]
if (!baseline || !baseline.pass) return { fatal: 'baseline failed', baseline }

for (const [id, slug, ph] of TICKETS) {
  phase(ph)
  log('Ticket ' + id + '：Fable 編排 Grok 實作與獨立驗收')
  const result = await agent(ticketPrompt(id, slug), {
    agentType: 'general-purpose', effort: 'high', phase: ph,
    schema: RESULT_SCHEMA, label: 'ticket-' + id,
  })
  results.push(result || { pass: false, ticket: id, blocked: ['no structured result'] })
  if (!result || !result.pass) {
    return { fatal: 'ticket ' + id + ' failed', baseline, results }
  }
}

phase('Integration')
log('全票完成；Fable 執行跨票整合、安全與回歸審查')
const integration = await agent(integrationPrompt(results), {
  agentType: 'general-purpose', effort: 'max', phase: 'Integration',
  schema: INTEGRATION_SCHEMA, label: 'fable-integration',
})

return { baseline, results, integration }
