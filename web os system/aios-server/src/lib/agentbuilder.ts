// Agent Builder domain: durable discovery interview → capability plan →
// authorize (create/reuse draft) → real runAgent test → FDE finalize.
//
// Hard rules:
// - Discovery is deterministic (no CLI wait); works offline.
// - MEMBER may create its own least-privilege working Agent container; Skill,
//   Workflow, MCP and elevated capability changes remain governed/inert.
// - New skills stay AWAITING_USER_CONFIRM until FDE finalize after PASSED test.
// - Every string leaf is deep-redacted before DB write.
// - Session ownership: foreign users get 404 (no existence leak); FDE may inspect.
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { Prisma, type AgentBuildIteration, type AgentBuildSession, type AgentBuildSessionStatus, type UserRole } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { slugify } from './slug.js';
import { safeJoin } from './safepath.js';
import { paths } from '../config.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import type { RunAgentOptions, RunOutcome } from '../engine/types.js';
import { runClaude } from '../engine/claude.js';
import { looseParseJson } from '../engine/draft.js';
import { guardBudget, recordCost } from '../engine/cost.js';
import {
  createBuilderEvolutionIteration,
  toIterationDto,
  type BuilderGeneratedBy,
  type HarnessSnapshot,
  type IterationDto,
} from './agentbuilderevolution.js';
import {
  abortBuilderSessionWork,
  beginBuilderInterviewCall,
  combineAbortSignals,
  finishBuilderInterviewCall,
  type BuilderClaudeFn,
} from './builderabort.js';
import {
  assemblePrompt,
  DEFAULT_ADVISOR_PERSONA_BODY,
  syncAdvisorPersonaFromRolePrompt,
} from './promptassembly.js';
import {
  createExternalBuilderWorkflows,
  materializeExternalBuilderFiles,
} from './builderartifactmaterialize.js';
import {
  assertFixtureExtension,
  getTestInputStatus,
  inferTestInputRequirements,
  parseBuilderTestData,
  type BuilderTestInputRequirement,
  type BuilderTestInputStatus,
} from './buildertestinputs.js';
import {
  deriveBuilderTestProgress,
  type BuilderTestProgressDto,
} from './buildertestprogress.js';
import { createBuilderWorkingAgent } from './builderworkingagent.js';
import { hub } from '../ws/hub.js';

// ── Types (business-language DTOs — no engines/manifests/MCP protocol) ───────

export type TranscriptEntry = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  /** Present when the turn was synchronized by an external MCP client. */
  source?: 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CHATGPT' | 'CURSOR' | 'OTHER';
  /** Client-supplied idempotency key; never treated as authorization. */
  externalEventId?: string;
};

export type BriefFieldKey =
  | 'objective'
  | 'inputs'
  | 'outputs'
  | 'process'
  | 'exceptions'
  | 'permissions'
  | 'testData';

const EXPLICIT_CORRECTION_RE = /(?:反悔|改成|更改|推翻|不要再|取消(?:之前|原本)|修正(?:之前|原本)|不是.{0,12}(?:而是|要))/;

export type Brief = {
  objective?: string;
  successCriteria?: string;
  inputs?: string;
  sources?: string;
  outputs?: string;
  recipients?: string;
  timing?: string;
  process?: string;
  exceptions?: string;
  permissions?: string;
  testDataHint?: string;
  expectedResult?: string;
  /** Explicit business-facing employee name requested by the operator. */
  requestedAgentName?: string;
  /** Explicit create/reuse intent. A stated create requirement overrides catalog reuse. */
  requestedStrategy?: 'reuse' | 'create';
  /** Domain tags inferred from the initial prompt (finance, email, drive, …). */
  tags?: string[];
  /** External Builder provenance used to resume the same desktop conversation. */
  externalSource?: 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CHATGPT' | 'CURSOR' | 'OTHER';
  externalConversationId?: string;
  externalConversationTitle?: string;
  /** Files explicitly uploaded from the end-user Builder UI. Content is redacted before persistence. */
  sourceFiles?: Array<{
    name: string;
    mimeType?: string;
    size: number;
    content: string;
    uploadedAt: string;
  }>;
};

export type Progress = {
  answeredKeys: BriefFieldKey[];
  currentKey: BriefFieldKey | null;
  total: number;
  /** 0–100 style fraction of answered discovery fields. */
  percent: number;
  /** Current contextual interview turn. The field gate remains deterministic;
   * only wording, examples and optional-source advice are model-assisted. */
  turn?: InterviewTurn | null;
  /** Dynamic Grill mode. answeredKeys is retained only as a compatibility
   * summary for downstream compilation; it no longer dictates question order. */
  mode?: 'grill';
};

export type InterviewTurn = {
  key: BriefFieldKey;
  /** Short acknowledgement tying the next question to the stated task. */
  context: string;
  /** Exactly one high-value, business-language question. */
  question: string;
  /** 2–4 contextual starting points; never treated as mandatory choices. */
  suggestions: string[];
  /** The advisor's own proposed answer, so the user reacts to a concrete idea. */
  recommendation?: string;
  /** Why this decision is the most valuable branch to resolve now. */
  whyThisMatters?: string;
  intent?: 'explore' | 'clarify' | 'resolve_conflict' | 'offer_test' | 'confirm_build';
  sourceAdvice: {
    mode: 'hidden' | 'optional' | 'recommended';
    reason: string;
  };
  /**
   * How this turn was produced. Stored on the existing `progress` JSON column.
   * `model` = Claude succeeded; `fallback` = Grill rules after model failure;
   * `questionnaire` = AIOS_BUILDER_ADAPTIVE_MODEL=off (Tier-1 fixed questions).
   */
  generatedBy?: BuilderGeneratedBy;
};

export type ConnectionGap = {
  /** Business label, e.g.「公司信箱（Gmail）」 */
  label: string;
  available: boolean;
  /** What the operator needs to do (never protocol jargon). */
  actionNeeded: string;
};

export type PlanDto = {
  summary: string;
  strategyRecommendation: 'reuse' | 'create';
  reuseCandidates: Array<{ agentId: string; name: string; reason: string }>;
  skillMatches: Array<{ skillId: string; name: string; reason: string }>;
  connections: ConnectionGap[];
  gaps: Array<{ label: string; actionNeeded: string }>;
  proposedAgentName: string;
  proposedSkillName: string;
  /** Plain-language least-privilege note (no engine names). */
  privilegeNote: string;
};

export type TestResultDto = {
  ok: boolean;
  status: 'PASSED' | 'FAILED';
  runId?: string;
  summary: string;
  /** Production connectors still missing even if manual fixture passed. */
  productionBlockers: string[];
  detail?: string;
};

export type BuilderDraftState = {
  reply: string;
  testData: string;
  testExpected: string;
};

export type SessionDto = {
  id: string;
  status: AgentBuildSessionStatus;
  progress: Progress | null;
  brief: Brief | null;
  plan: PlanDto | null;
  strategy: string | null;
  targetAgentId: string | null;
  builtAgentId: string | null;
  /** Phase-2 binding: once set, later training of this employee resumes this session. */
  agentId: string | null;
  draftSkillIds: string[];
  hasTestData: boolean;
  testInputStatus: BuilderTestInputStatus;
  testResult: TestResultDto | null;
  testProgress: BuilderTestProgressDto | null;
  lastRunId: string | null;
  lastAssistantMessage: string | null;
  draftState: BuilderDraftState;
  transcript: TranscriptEntry[];
  iterations: IterationDto[];
  latestIteration: IterationDto | null;
  /** Present on role-aware list responses; avoids leaking raw owner ids. */
  ownedByCurrentUser?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Set when the owner soft-deletes an unsubmitted draft. */
  abandonedAt: string | null;
};

export type BuilderMessageResult = {
  session: SessionDto;
  assistantMessage: string;
  status: AgentBuildSessionStatus;
  progress: Progress | null;
};

/** Injectable runAgent for tests (never call paid CLIs in unit failure paths). */
export type RunAgentFn = (opts: RunAgentOptions) => Promise<RunOutcome>;

// ── Discovery question catalog (one at a time) ───────────────────────────────

const DISCOVERY_ORDER: BriefFieldKey[] = [
  'objective',
  'inputs',
  'outputs',
  'process',
  'exceptions',
  'permissions',
  'testData',
];

const BUILDER_ADVISOR_SLUG = 'aios-agent-builder-advisor';
/** Pre-v2 create-time stub. Never read back (P1); migrate to Appendix A on sync. */
const LEGACY_ADVISOR_ROLE_PROMPT =
  '你只協助釐清企業 AI 員工需求，不執行工具、不建立或修改任何系統物件。';

export async function ensureBuilderAdvisor(): Promise<{
  id: string;
  costPolicy: unknown;
}> {
  // V2-3: PATCH /api/agents/:id forbids systemManaged agents, so there is no
  // routes-layer editor for this advisor's rolePrompt. Persona sync is
  // unidirectional DB → aios-data/prompts/builder/advisor-persona.section.md
  // here on create/update. Direct section-file edits also work (mtime cache)
  // until the next ensureBuilderAdvisor call overwrites them (DB wins).
  const existing = await prisma.agent.findUnique({ where: { slug: BUILDER_ADVISOR_SLUG } });
  const costPolicy = {
    dailyBudgetUsd: 1,
    monthlyBudgetUsd: 15,
    hardStop: true,
  };
  if (existing) {
    const nextRolePrompt =
      existing.rolePrompt === LEGACY_ADVISOR_ROLE_PROMPT
        ? DEFAULT_ADVISOR_PERSONA_BODY
        : existing.rolePrompt;
    const updated = await prisma.agent.update({
      where: { id: existing.id },
      data: {
        name: 'AIOS 員工建立顧問',
        description: '依客戶情境產生下一個高價值訪談問題；不能建立、修改或啟用任何 Agent／Skill。',
        department: 'AIOS 系統',
        systemManaged: true,
        deletedAt: null,
        status: 'ACTIVE',
        riskTier: 'low',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
          cloudEmbedding: false,
          notes: '只產生訪談文字；不得執行工具或改變建立狀態。',
        },
        costPolicy,
        ...(nextRolePrompt !== existing.rolePrompt ? { rolePrompt: nextRolePrompt } : {}),
      },
      select: { id: true, costPolicy: true, rolePrompt: true },
    });
    syncAdvisorPersonaFromRolePrompt(updated.rolePrompt);
    return { id: updated.id, costPolicy: updated.costPolicy };
  }
  const creator = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!creator) throw errors.notConfigured('找不到可建立訪談顧問的 FDE 帳號');
  const created = await prisma.agent.create({
    data: {
      id: ulid(),
      slug: BUILDER_ADVISOR_SLUG,
      name: 'AIOS 員工建立顧問',
      description: '依客戶情境產生下一個高價值訪談問題；不能建立、修改或啟用任何 Agent／Skill。',
      department: 'AIOS 系統',
      rolePrompt: DEFAULT_ADVISOR_PERSONA_BODY,
      engineExecute: 'CLAUDE_CODE',
      engineVerify: 'GROK',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
        cloudEmbedding: false,
        notes: '只產生訪談文字；不得執行工具或改變建立狀態。',
      },
      costPolicy,
      riskTier: 'low',
      maxRounds: 1,
      status: 'ACTIVE',
      systemManaged: true,
      createdBy: creator.id,
    },
    select: { id: true, costPolicy: true, rolePrompt: true },
  });
  syncAdvisorPersonaFromRolePrompt(created.rolePrompt);
  return { id: created.id, costPolicy: created.costPolicy };
}

const QUESTIONS: Record<
  BriefFieldKey,
  { ask: string; recommend: string; briefKeys: (keyof Brief)[] }
> = {
  objective: {
    ask: '這位 AI 員工最重要的目標與成功標準是什麼？（做完什麼算「完成」？）',
    recommend: '以可驗收的成果描述，例如「每天彙整帳款郵件成表，並存到指定資料夾」。',
    briefKeys: ['objective', 'successCriteria'],
  },
  inputs: {
    ask: '它需要讀取哪些資料或來源？（信箱、雲端資料夾、表單、檔案路徑等）',
    recommend: '列出來源名稱即可，例如「公司 Gmail 裡主旨含帳款的郵件」。',
    briefKeys: ['inputs', 'sources'],
  },
  outputs: {
    ask: '產出給誰、什麼形式、多久一次？（例如表、摘要、草稿信；每天／手動）',
    recommend: '寫清楚對象與節奏，例如「產出 Excel 摘要給財務主管，工作日早上」。',
    briefKeys: ['outputs', 'recipients', 'timing'],
  },
  process: {
    ask: '順利時的標準步驟是什麼？（用日常語言描述流程即可）',
    recommend: '用 3–6 步說明：讀取 → 整理 → 產出 → 存放／通知。',
    briefKeys: ['process'],
  },
  exceptions: {
    ask: '遇到例外（資料不全、來源失敗、結果不確定）時要怎麼處理？要通知誰？',
    recommend: '例如「無法判斷的項目標註待審，並在結果中列出，不擅自寄出」。',
    briefKeys: ['exceptions'],
  },
  permissions: {
    ask: '是否允許寄信、改寫雲端檔、或執行不可逆操作？預設一律不開，只做草稿／讀取。',
    recommend: '若只需整理與草稿，請回答「不允許寄信與寫入；只產出草稿供人工確認」。',
    briefKeys: ['permissions'],
  },
  testData: {
    ask: '請提供一組代表性測試資料，以及期望結果（之後會用這組資料做真實試跑）。',
    recommend: '可用去識別後的假資料，例如「三封假帳款郵件摘要」＋「期望表內有三列金額合計」。',
    briefKeys: ['testDataHint', 'expectedResult'],
  },
};

// ── Keyword inference (deterministic; optional future LLM extractor hook) ────

export type InferenceResult = {
  brief: Partial<Brief>;
  /** Fields considered sufficiently answered from the initial prompt. */
  answered: BriefFieldKey[];
};

function splitTestDataAnswer(text: string): { data: string; expected: string } {
  const split = text.match(/(?:^|[。；;]\s*)測試資料[:：]\s*([\s\S]*?)(?:期望(?:結果)?[:：]\s*)([\s\S]+)$/);
  return {
    data: (split?.[1] ?? text).trim(),
    expected: (split?.[2] ?? '依測試資料可產出符合描述之結果').trim(),
  };
}

/** Names must be business-facing. Verb remnants and bare classifiers are not names. */
export function isMeaningfulRequestedName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  if (/^[出好成]?(?:一個|一位)$/.test(trimmed)) return false;
  if (/^(?:這個|那個|新的|全新的?)$/.test(trimmed)) return false;
  return true;
}

/**
 * Infer facts already stated in free text. Never invents decisions —
 * only fills fields when keywords + surrounding context support it.
 * Pure function: injectable / unit-testable without DB or CLI.
 */
export function inferFromPrompt(message: string): InferenceResult {
  const text = message.trim();
  const brief: Partial<Brief> = {};
  const answered: BriefFieldKey[] = [];
  const tags: string[] = [];
  const lower = text.toLowerCase();

  const has = (...keys: string[]) => keys.some((k) => text.includes(k) || lower.includes(k.toLowerCase()));
  const explicitlyUncertain = (subject: RegExp) =>
    (subject.test(text) && /(不確定|不知道|尚未決定|還沒想好|請.*問|一步一步問)/.test(text)) ||
    /(不確定|不知道|尚未決定|還沒想好)/.test(text) && subject.test(text);
  const processUncertain = explicitlyUncertain(/流程|步驟|怎麼做/);
  const exceptionsUncertain = explicitlyUncertain(/例外|失敗處理|異常處理/);

  // Preserve explicit naming and build intent. These are operator decisions,
  // not suggestions that the catalog/reuse heuristic may silently overwrite.
  // `做` compounds (`做出`/`做好`/`做成`) must not leak 出/好/成 into the name
  // capture: lazy `[^…]{2,80}?` used to turn「做出一個 agent」into「出一個」.
  const requestedName = [
    /(?:建立|新增|訓練|打造|做(?:[出好成])?)(?:一位|一個)?(?:全新(?:的)?|新的?)?(?:名為|叫做)?\s*[「『“"]([^」』”"]{2,80})[」』”"]/i,
    /(?:Agent|AI\s*員工|員工)(?:名稱)?(?:是|為|叫做|名為)\s*[「『“"]?([^」』”"\n，。；;]{2,80})/i,
    /(?:建立|新增|訓練|打造|做(?:[出好成])?)(?:一位|一個)?\s*([^，。；;\n]{2,80}?)(?:的)?\s*(?:AI\s*員工|Agent|機器人)/i,
  ]
    .map((pattern) => text.match(pattern)?.[1]?.trim())
    .find((name): name is string => typeof name === 'string' && isMeaningfulRequestedName(name));
  if (requestedName) brief.requestedAgentName = requestedName;

  const explicitlyRequiresCreate =
    /(?:建立|新增|訓練|打造).{0,12}(?:全新|新的).{0,12}(?:Agent|AI\s*員工|員工|專員)/i.test(text) ||
    /(?:不可|不要|禁止|不准).{0,30}(?:沿用|複用|使用|交給|改造)?.{0,12}既有/i.test(text) ||
    /(?:不用|不使用)既有/i.test(text);
  if (explicitlyRequiresCreate) brief.requestedStrategy = 'create';

  if (has('帳款', '財務', 'invoice', 'ar', 'ap', '對帳', '收款')) tags.push('finance');
  if (has('gmail', '郵件', 'email', '信箱', 'outlook')) tags.push('email');
  if (has('drive', '雲端', 'onedrive', '資料夾', '上傳')) tags.push('cloud');
  if (has('表', 'excel', '試算', 'csv', '整理')) tags.push('spreadsheet');
  if (has('line', '通知', '推播')) tags.push('notify');
  if (has('每天', '每日', '定期', 'cron', '早上', '每週')) tags.push('schedule');
  if (has('網路搜尋', '上網找', '網路上找', '搜尋資料', '找資料', '新聞', 'research', 'web search')) {
    tags.push('research');
  }

  if (tags.length) brief.tags = tags;

  // Objective: if the message is substantial, treat whole prompt as objective seed.
  if (text.length >= 12) {
    brief.objective = text.slice(0, 2000);
    if (has('成功', '完成', '驗收') || text.length >= 20) {
      brief.successCriteria = '依使用者描述之業務結果完成，並可人工覆核。';
      answered.push('objective');
    } else if (tags.length >= 2) {
      answered.push('objective');
    }
  }

  // Inputs / sources
  const inputBits: string[] = [];
  if (has('gmail', '郵件', 'email', '信箱')) inputBits.push('電子郵件');
  if (has('drive', 'onedrive', '雲端')) inputBits.push('雲端檔案');
  if (has('表單', 'excel', 'csv', '試算')) inputBits.push('表單／試算表');
  if (has('pdf')) inputBits.push('PDF 文件');
  if (has('手動上傳', '上傳檔案')) inputBits.push('手動上傳檔案');
  if (tags.includes('research')) inputBits.push('公開網路來源');
  if (inputBits.length) {
    brief.inputs = inputBits.join('、');
    brief.sources = inputBits.join('、');
    answered.push('inputs');
  }

  // Outputs / timing
  const outBits: string[] = [];
  let outputDecisionExplicit = false;
  if (has('報告', '摘要', '報表', '做成表', '整理成表', '產生表', '輸出表')) {
    outBits.push('整理後的報告／表格摘要');
    outputDecisionExplicit = true;
  }
  if (tags.includes('research') && has('新聞', '資料', '情報', '趨勢')) {
    outBits.push('經過來源篩選、去重與附連結的研究摘要');
  }
  if (has('上傳到', '存到', '寫入', '存放')) {
    outBits.push('存到指定位置（草稿／待確認）');
    outputDecisionExplicit = true;
  }
  if (has('草擬', '信件草稿', '草稿信', '催款信')) {
    outBits.push('郵件草稿（不直接寄出）');
    outputDecisionExplicit = true;
  } else if (has('寄出', '通知', '回覆')) {
    outBits.push('通知或郵件草稿（預設不直接寄出）');
    outputDecisionExplicit = true;
  }
  if (outBits.length) {
    brief.outputs = outBits.join('、');
    if (outputDecisionExplicit) answered.push('outputs');
  }
  if (has('每天', '每日')) brief.timing = '每日';
  else if (has('每週')) brief.timing = '每週';
  else if (has('早上')) brief.timing = '早上執行';
  if (has('主管', '財務', '老闆', '收件')) brief.recipients = '指定業務收件人（待確認）';

  // Process (only if multiple action verbs)
  const steps: string[] = [];
  if (has('掃', '讀', '抓', '搜')) steps.push('讀取來源');
  if (has('整理', '彙整', '解析', '分類')) steps.push('整理／彙整');
  if (has('產出', '產生', '做成', '生成')) steps.push('產出結果');
  if (has('上傳', '存', '放')) steps.push('存放（預設草稿）');
  if (has('通知', '寄', '回報')) steps.push('通知相關人員（預設草稿）');
  if (steps.length >= 2 && !processUncertain) {
    brief.process = steps.join(' → ');
    answered.push('process');
  } else if (tags.includes('research') && !processUncertain) {
    brief.process = '搜尋候選來源 → 篩選可信度與時效 → 去除重複 → 摘要並保留原始連結';
    answered.push('process');
  }

  // Exception handling is a decision, not any occurrence of words such as
  // “異常支出”. Infer only when the user describes a conditional/failure policy.
  const hasExceptionPolicy = /(遇到|如果|若|一旦).{0,50}(失敗|錯誤|無法|缺少|不完整|不確定)|(?:失敗|錯誤|無法|資料不全).{0,40}(就|則|時|要|通知|交給)/.test(text);
  if (hasExceptionPolicy && !exceptionsUncertain) {
    brief.exceptions = text.match(/.{0,50}(遇到|如果|若|一旦|失敗|錯誤|無法|資料不全).{0,100}/)?.[0] ?? '需人工處理例外';
    answered.push('exceptions');
  }

  // Permissions are a user decision. Least privilege is recommended elsewhere,
  // but is considered answered only when the operator explicitly states it.
  if (has('不要寄', '不寄出', '僅草稿', '人工確認', '不要寫入', '先問我', '問我同意', '需要核准')) {
    brief.permissions =
      '預設不允許寄信、雲端寫入、Shell、電腦操控；僅讀取與產出草稿供人工確認。';
    answered.push('permissions');
  }

  // Test data only if user already provided sample-like content
  if (has('測試資料', '範例', '例如以下', 'fixture')) {
    const fixture = splitTestDataAnswer(text);
    brief.testDataHint = fixture.data.slice(0, 1500);
    brief.expectedResult = fixture.expected.slice(0, 1500);
    answered.push('testData');
  }

  // Deduplicate answered while preserving order
  const seen = new Set<BriefFieldKey>();
  const uniq = answered.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { brief, answered: uniq };
}

export function nextUnanswered(answered: BriefFieldKey[]): BriefFieldKey | null {
  const set = new Set(answered);
  for (const k of DISCOVERY_ORDER) {
    if (!set.has(k)) return k;
  }
  return null;
}

export function buildProgress(answered: BriefFieldKey[], turn: InterviewTurn | null = null): Progress {
  // In Grill mode the advisor may revisit or replace a branch after the user
  // changes direction. The legacy fixed order is only a deterministic fallback.
  const currentKey = turn?.key ?? nextUnanswered(answered);
  const total = DISCOVERY_ORDER.length;
  const percent = Math.round((answered.length / total) * 100);
  return {
    answeredKeys: [...answered],
    currentKey,
    total,
    percent: Math.min(100, percent),
    turn: currentKey ? turn : null,
    mode: 'grill',
  };
}

function taskSubject(brief: Brief): string {
  if (brief.requestedAgentName) return `「${brief.requestedAgentName}」`;
  const objective = (brief.objective ?? '').replace(/\s+/g, ' ').trim();
  if (!objective) return '這位 AI 員工';
  return `「${objective.slice(0, 72)}${objective.length > 72 ? '…' : ''}」`;
}

/** Deterministic contextual fallback. It is also the safety boundary for the
 * model planner: the model may improve wording/options, never field order or
 * completion state. */
export function buildContextualInterviewTurn(
  key: BriefFieldKey,
  brief: Brief,
): InterviewTurn {
  const tags = brief.tags ?? [];
  const subject = taskSubject(brief);
  const research = tags.includes('research');
  const finance = tags.includes('finance');
  const email = tags.includes('email');
  const spreadsheet = tags.includes('spreadsheet');
  const timing = brief.timing ? `目前節奏是「${brief.timing}」` : '執行頻率還沒決定';
  const noFixedTrainingSource = research || /公開網路|即時取得|不使用固定/.test(brief.sources ?? '');

  const sourceAdvice: InterviewTurn['sourceAdvice'] = noFixedTrainingSource
    ? {
        mode: 'hidden',
        reason: '這類任務可從需求與即時來源開始，不需要先上傳固定訓練檔案。',
      }
    : (finance || spreadsheet) && (key === 'process' || key === 'testData')
      ? {
          mode: 'recommended',
          reason: '如果有去識別的範例表格或既有輸出，能幫助欄位與格式更貼近實務；沒有也能繼續。',
        }
      : {
          mode: 'optional',
          reason: '有範本可以補充，但不是建立這位員工的必要條件。',
        };

  switch (key) {
    case 'objective':
      return {
        key,
        context: `我先確認 ${subject} 最重要的價值，避免只是把一句需求改寫成流程。`,
        question: '第一次實際使用後，你看到什麼結果會認為這位員工真的有幫上忙？',
        suggestions: research
          ? ['每天找到不重複、附原文連結的重點消息', '只保留可信來源，並說明為什麼值得看', '先做一份可人工檢查的研究摘要']
          : ['產出一份可直接人工覆核的結果', '省下目前最花時間的整理步驟', '把不確定項目清楚標示給我決定'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
    case 'inputs':
      return {
        key,
        context: research
          ? `${subject} 需要的是即時網路來源，不是固定的訓練檔案。`
          : `要讓 ${subject} 真正工作，我需要知道它在執行當下可以取得什麼。`,
        question: research
          ? '你希望它優先搜尋哪些主題與來源範圍？我也可以先從官方機構和可信科技媒體開始。'
          : `這項工作開始時，資訊通常從哪裡出現？${email ? '例如特定信箱、寄件人或主旨條件。' : '可以是系統、對話、網址或使用者當次提供的內容。'}`,
        suggestions: research
          ? ['先找生成式 AI、Agent 與企業應用；官方來源優先', '只看 OpenAI、Anthropic、Google DeepMind 等官方網站', '官方來源加主流科技媒體，排除內容農場', '我有指定網站，稍後提供']
          : ['由使用者每次下指令時提供', '從已連線的公司系統讀取', '沒有固定來源，依任務即時取得'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
    case 'outputs':
      return {
        key,
        context: `${subject} 的資料取得方式已經清楚；接下來決定最後交付物，而不是套用固定報表。`,
        question: research
          ? `它在${brief.timing === '每日' ? '每天' : '每次'}找完資料後，你最想收到哪一種成品？`
          : `完成這項工作時，你希望直接看到什麼成品，交給誰使用？${timing !== '執行頻率還沒決定' ? `（${timing}）` : ''}`,
        suggestions: research
          ? ['5 則重點新聞：標題、摘要、來源連結與重要性', '依主題分類的每日簡報，重複新聞合併', '先給我候選清單，我勾選後再做深度摘要']
          : finance
            ? ['差異清單＋金額與來源，交給財務覆核', '主管摘要＋待確認項目，不自動入帳', '沿用公司現有表格欄位']
            : ['一頁摘要＋來源與待確認事項', '先產出草稿，由我確認後再交付', '依使用者當次指定格式輸出'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
    case 'process':
      return {
        key,
        context: `我會先提出適合 ${subject} 的工作方法，你只需要修正不符合實務的地方。`,
        question: research
          ? '我建議採用「搜尋候選來源 → 檢查日期與可信度 → 合併重複消息 → 摘要並保留連結」，你希望在哪一步加入人工選擇？'
          : '從收到任務到交付結果，我建議先讀取、檢查、整理，再把不確定項目交給人確認；哪一段需要依你的做法調整？',
        suggestions: research
          ? ['候選新聞先給我勾選，再做摘要', '系統可自行篩選，但低可信來源必須標示', '全程自動整理，最後由我一次覆核']
          : ['先提出草稿，最後一步由我確認', '不確定資料立即停下來問我', '照建議流程即可，之後用測試結果再調整'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
    case 'exceptions':
      return {
        key,
        context: `${subject} 的正常路徑已經可以成立，現在只處理真正會影響信任的例外。`,
        question: research
          ? '如果不同網站說法互相矛盾、來源打不開，或當天沒有值得報告的新消息，你希望它怎麼處理？'
          : '如果資料缺漏、結果不確定或來源暫時失敗，哪些情況可以繼續標註，哪些情況必須停下來問你？',
        suggestions: research
          ? ['保留不同說法並標註可信度，不自行下結論', '沒有重要新消息就明確回報「今日無重大更新」', '來源無法驗證就排除，並列在待確認區']
          : ['能標註的繼續，可能造成錯誤動作時停下來問我', '資料缺漏就產出待補清單', '任何不確定項目都不得自動對外送出'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
    case 'permissions':
      return {
        key,
        context: `最後確認 ${subject} 能做什麼；沒有明確同意的外部動作一律保持關閉。`,
        question: research
          ? '它是否只讀取公開網頁並產出內容，還需要登入網站、下載檔案或主動發送結果？'
          : '除了讀取與產出草稿外，是否需要寄送、寫入系統或操作電腦？哪些動作一定要先得到你確認？',
        suggestions: research
          ? ['只讀公開網站並產出摘要，不登入、不發送', '可以下載公開附件，但任何發送都先問我', '先維持最小權限，之後再由 FDE 開通']
          : ['先維持只讀與草稿，任何寫入都要確認', '允許寫入指定位置，但寄送仍需確認', '所有不可逆操作都交給人工執行'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
    case 'testData':
      return {
        key,
        context: `需求已接近完整。現在用一個小案例驗證 ${subject}，不要求你一定要準備正式資料。`,
        question: research
          ? '第一次試跑要用哪個主題？我可以先產生一組模擬搜尋結果，驗證去重、來源與摘要格式。'
          : '你想提供一組去識別案例，還是由我先產生模擬資料來驗證流程？',
        suggestions: research
          ? ['用「本週 AI Agent 產品更新」，請系統先產生模擬資料', '用三則內容重複的 AI 新聞測試去重', '我稍後提供真實但去識別的案例']
          : ['請系統先產生一組模擬測試資料', '我現在貼一個去識別案例', '我稍後上傳範本，但先完成需求規劃'],
        sourceAdvice,
        generatedBy: 'questionnaire',
      };
  }
}

/** Stamp Grill-fallback provenance and redact every string leaf, including the
 * uploaded-file excerpt that is copied into `context`. Matches the model path. */
function finishFallbackTurn(turn: InterviewTurn): InterviewTurn {
  return deepRedactSecrets({ ...turn, generatedBy: 'fallback' as const });
}

/** Offline Grill fallback. Unlike the legacy catalog it can revisit a branch,
 * react to corrections, and reason from uploaded evidence. It deliberately
 * prefers a concrete lived example over asking for configuration fields. */
export function buildGrillFallbackTurn(opts: {
  fallbackKey: BriefFieldKey;
  brief: Brief;
  recentTranscript?: TranscriptEntry[];
}): InterviewTurn {
  const { brief } = opts;
  const transcript = opts.recentTranscript ?? [];
  const userTurnCount = transcript.filter((entry) => entry.role === 'user').length;
  const latestUser = [...transcript]
    .reverse()
    .find((entry) => entry.role === 'user')?.content ?? brief.objective ?? '';
  const subject = taskSubject(brief);
  const files = brief.sourceFiles ?? [];

  // A first-turn boundary such as "不要寄信" is a requirement, not a
  // correction. Conflict handling only makes sense after an earlier user turn.
  if (userTurnCount > 1 && EXPLICIT_CORRECTION_RE.test(latestUser)) {
    return finishFallbackTurn({
      key: opts.fallbackKey,
      intent: 'resolve_conflict',
      context: `我注意到你正在修正 ${subject} 先前的做法。新的說法應該優先，但我不會默默把兩套互相衝突的規則都留下。`,
      whyThisMatters: '如果沒有確認哪一版取代哪一版，員工之後可能在相同情境採取不同做法。',
      recommendation: '以你最新說法為準，把舊做法保留在版本紀錄中，但不再放進目前草稿。',
      question: '我理解成「最新說法完整取代先前做法」對嗎？還是只有其中一部分要改？',
      suggestions: ['完整以最新說法取代', '只修改我剛提到的部分，其餘保留', '先列出新舊差異讓我確認'],
      sourceAdvice: { mode: 'hidden', reason: '這一輪要釐清的是決策變更，不需要另外提供檔案。' },
    });
  }

  if (/(?:完整以最新說法取代|只修改我剛提到的部分|其餘保留)/.test(latestUser)) {
    return finishFallbackTurn({
      key: 'testData',
      intent: 'offer_test',
      context: '了解，現在的員工草稿會以你剛確認的最新規則為準；舊規則只留在歷史紀錄，不再參與目前判斷。',
      whyThisMatters: '規則衝突已經解開，下一個最有價值的動作是用具體案例確認新版真的不會自動處理模糊配對。',
      recommendation: '沿用剛才的三筆測試，並把一對多與僅日期金額相符的結果都設定為「必須人工確認」。',
      question: '要現在用最新版規則建立這三筆測試嗎？',
      suggestions: ['好，建立三筆測試', '再加一筆金額相同但客戶不同的案例', '先列出測試資料讓我確認', '先繼續補充其他例外'],
      sourceAdvice: { mode: 'hidden', reason: '目前可先用模擬資料驗證新版規則。' },
    });
  }

  if (
    userTurnCount > 1
    && /(?:好|可以|確認|請).{0,8}(?:建立|採用|先建立).{0,8}(?:三筆|這三筆|測試)/.test(latestUser)
  ) {
    return finishFallbackTurn({
      key: 'testData',
      intent: 'clarify',
      context: '我已經把三筆測試寫進這位員工的學習草稿：唯一一對一、一對多候選，以及沒有交易序號但日期金額相近。',
      whyThisMatters: '測試資料已建立，現在只需要確認預期結果，避免用錯誤答案驗證員工。',
      recommendation: '案例 A 可以產生明確配對草稿；案例 B、C 一律進候選清單並要求人工確認，不得寫回外部系統。',
      question: '這三筆測試的預期結果符合你的規則嗎？',
      suggestions: ['正確，採用這組測試', '案例 C 也要顯示信心分數', '再加入金額相同但客戶不同的案例', '先把完整測試資料列給我看'],
      sourceAdvice: { mode: 'hidden', reason: '測試使用模擬資料，不需要提供真實檔案。' },
    });
  }

  if (
    userTurnCount > 1
    && /(?:測試|試跑|跑跑看)/.test(latestUser)
  ) {
    return finishFallbackTurn({
      key: 'testData',
      intent: 'offer_test',
      context: `可以。我已經有足夠資訊先驗證 ${subject} 最容易出錯的核心判斷，不必等所有細節都訪談完。`,
      whyThisMatters: '先用一個小型案例試跑，可以提早發現配對規則是否太積極或漏掉人工確認。',
      recommendation: '先建立三筆測試：一筆明確一對一、一筆一對多候選、一筆沒有交易序號只能依日期與金額判斷；任何模糊結果都不能自動完成。',
      question: '要先用這三種案例建立測試集嗎？',
      suggestions: ['好，先建立這三筆測試', '再加一筆金額相同但客戶不同的案例', '先把測試資料列給我確認', '這一輪先不測試，繼續補充流程'],
      sourceAdvice: { mode: 'hidden', reason: '可以先用去識別的模擬資料驗證規則，不需要真實檔案。' },
    });
  }

  if (
    userTurnCount > 1
    && /(?:銀行|收款|ERP|應收|交易序號|單號|日期|金額|比對|配對)/i.test(latestUser)
  ) {
    const hasAmbiguousMatch = /(?:一筆.{0,12}(?:兩|多)筆|一對多|多對一|候選|漏掉)/.test(latestUser);
    return finishFallbackTurn({
      key: 'exceptions',
      intent: 'clarify',
      context: hasAmbiguousMatch
        ? '我已整理出你真正的判斷順序：先用交易序號找明確配對，找不到才比較日期與金額；目前最大的風險不是讀不到資料，而是一筆銀行款可能對到多張發票。'
        : '我已經把你剛才描述的實際操作順序整理進員工草稿，現在要釐清的是「無法唯一配對」時該怎麼處理。',
      whyThisMatters: '如果員工在模糊配對時自行猜答案，速度雖然變快，卻會把最容易漏帳的地方藏起來。',
      recommendation: '明確配對可以自動完成；一對多、多對一或信心不足的項目先列成候選清單，交由你確認。',
      question: '遇到一筆銀行款可能對到多張發票時，你希望候選清單至少列出哪些資訊，才足夠讓你快速確認？',
      suggestions: ['交易序號、日期、金額、發票號碼', '再加上客戶名稱與未沖帳餘額', '先照你的建議建立一個測試案例給我看', '這種情況其實有另一套判斷規則'],
      sourceAdvice: { mode: 'hidden', reason: '這一輪可先從你描述的實務例外建立規則，不需要強迫上傳檔案。' },
    });
  }

  if (files.length > 0) {
    const fileNames = files.map((file) => `「${file.name}」`).join('、');
    const sample = files[0]?.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join('／');
    return finishFallbackTurn({
      key: 'process',
      intent: 'clarify',
      context: `我已經讀過 ${fileNames}，會直接用裡面的內容更新員工草稿，不會再要你重新描述檔案裡已經寫清楚的事。${sample ? `我先看到的線索包括：${sample.slice(0, 220)}。` : ''}`,
      whyThisMatters: '真正需要你決定的不是檔案有哪些欄位，而是遇到多種可能對應方式時，哪一種符合你們實務。',
      recommendation: '我先依明確欄位與相同識別碼自動比對；模糊或多對一的項目放入待確認清單。',
      question: '當同一筆資料可能對到兩筆以上時，你現在通常依哪個線索做最後判斷？',
      suggestions: ['以單號／交易序號優先', '先看日期與金額，再由人工確認', '沒有唯一規則，請先列出候選配對', '檔案裡有說明，請再從內容找找看'],
      sourceAdvice: { mode: 'hidden', reason: '現有檔案已足以繼續分析。' },
    });
  }

  if (/(?:花.{0,8}(?:時間|小時)|容易|常常|漏掉|困擾|痛點|麻煩|人工)/.test(brief.objective ?? latestUser)) {
    return finishFallbackTurn({
      key: 'objective',
      intent: 'explore',
      context: `我聽到的重點不是「想做一個工具」，而是目前這件事正在消耗時間或造成錯誤。先把真實痛點看清楚，這位員工才不會只把舊流程照搬一次。`,
      whyThisMatters: '最近一次實際案例通常比抽象的流程描述更能暴露真正該自動化的判斷。',
      recommendation: '先從最近一次最麻煩或最容易出錯的案例開始，我會從案例裡整理出流程與需要的資料。',
      question: '最近一次這個問題實際發生時，從你開始處理到發現問題，中間發生了什麼？',
      suggestions: ['我可以照實際順序描述最近一次案例', '我手邊有當時使用的檔案，可以提供範本', '最麻煩的是找不到差異原因', '最容易出錯的是人工判斷哪兩筆要配在一起'],
      sourceAdvice: {
        mode: 'optional',
        reason: '若最近案例有去識別範本會更容易看出問題，但也可以先用描述進行。',
      },
    });
  }

  const base = buildContextualInterviewTurn(opts.fallbackKey, brief);
  return finishFallbackTurn({
    ...base,
    intent: opts.fallbackKey === 'testData' ? 'offer_test' : 'explore',
    whyThisMatters: base.context,
    recommendation: base.suggestions[0],
  });
}

function validateModelTurn(
  raw: unknown,
  fallbackKey: BriefFieldKey,
  brief: Brief,
): InterviewTurn | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const key = DISCOVERY_ORDER.includes(String(value.focusKey) as BriefFieldKey)
    ? String(value.focusKey) as BriefFieldKey
    : fallbackKey;
  const fallback = buildContextualInterviewTurn(key, brief);
  if (typeof value.question !== 'string' || value.question.trim().length < 8) return null;
  const suggestions = Array.isArray(value.suggestions)
    ? value.suggestions
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 180))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  if (suggestions.length < 2) return null;
  const source = value.sourceAdvice && typeof value.sourceAdvice === 'object'
    ? value.sourceAdvice as Record<string, unknown>
    : {};
  const requestedMode = ['hidden', 'optional', 'recommended'].includes(String(source.mode))
    ? String(source.mode) as InterviewTurn['sourceAdvice']['mode']
    : fallback.sourceAdvice.mode;
  // The model may make a source prompt less aggressive, never upgrade an
  // optional source to required-looking recommendation on its own.
  const mode = requestedMode === 'recommended' && fallback.sourceAdvice.mode !== 'recommended'
    ? 'optional'
    : requestedMode;
  return deepRedactSecrets({
    key,
    context: typeof value.context === 'string'
      ? value.context.trim().slice(0, 260)
      : fallback.context,
    question: value.question.trim().slice(0, 500),
    suggestions,
    recommendation: typeof value.recommendation === 'string'
      ? value.recommendation.trim().slice(0, 600)
      : suggestions[0],
    whyThisMatters: typeof value.whyThisMatters === 'string'
      ? value.whyThisMatters.trim().slice(0, 500)
      : fallback.context,
    intent: ['explore', 'clarify', 'resolve_conflict', 'offer_test', 'confirm_build'].includes(String(value.intent))
      ? String(value.intent) as InterviewTurn['intent']
      : 'explore',
    sourceAdvice: {
      mode,
      reason: typeof source.reason === 'string'
        ? source.reason.trim().slice(0, 260)
        : fallback.sourceAdvice.reason,
    },
    generatedBy: 'model',
  });
}

export async function planAdaptiveInterviewTurn(opts: {
  key: BriefFieldKey;
  brief: Brief;
  recentTranscript?: TranscriptEntry[];
  sessionId?: string;
  signal?: AbortSignal;
  /** Test seam: inject a fake Claude so abort / generatedBy can be verified offline. */
  runClaudeFn?: BuilderClaudeFn;
}): Promise<InterviewTurn> {
  const fallback = buildGrillFallbackTurn({
    fallbackKey: opts.key,
    brief: opts.brief,
    recentTranscript: opts.recentTranscript,
  });
  if (process.env.AIOS_BUILDER_ADAPTIVE_MODEL === 'off') {
    return buildContextualInterviewTurn(opts.key, opts.brief);
  }

  const execute = opts.runClaudeFn ?? runClaude;
  const skipLiveSideEffects = Boolean(opts.runClaudeFn);

  const latestUnderstanding = opts.sessionId && !skipLiveSideEffects
    ? await prisma.agentBuildIteration.findFirst({
        where: { sessionId: opts.sessionId, status: 'READY' },
        orderBy: { sequence: 'desc' },
        select: { understanding: true, artifactSnapshot: true, proposedChanges: true },
      }).catch(() => null)
    : null;

  const safeContext = deepRedactSecrets({
    brief: opts.brief,
    recentConversation: (opts.recentTranscript ?? []).slice(-6).map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, 800),
    })),
    fallbackFocus: opts.key,
    latestDecisionGraph: latestUnderstanding?.understanding ?? null,
    latestAgentDraft: latestUnderstanding?.artifactSnapshot ?? null,
    latestChanges: latestUnderstanding?.proposedChanges ?? null,
    sourceModeCeiling: fallback.sourceAdvice.mode,
  });
  const contextJson = JSON.stringify(safeContext);
  let systemPrompt: string;
  let userTurn: string;
  try {
    const assembled = assemblePrompt({
      stage: 'interview',
      vars: {},
      contextMessage: contextJson,
    });
    systemPrompt = assembled.systemPrompt;
    userTurn = assembled.contextMessage ?? contextJson;
  } catch (err) {
    console.warn('[agentbuilder] interview prompt assembly failed; using fallback', err);
    return fallback;
  }
  const costInput = systemPrompt ? `${systemPrompt}\n\n${userTurn}` : userTurn;

  const registered = opts.sessionId ? beginBuilderInterviewCall(opts.sessionId) : null;
  const signal = combineAbortSignals([opts.signal, registered?.signal]);

  try {
    if (signal?.aborted) return fallback;
    let advisorId: string | undefined;
    if (!skipLiveSideEffects) {
      const advisor = await ensureBuilderAdvisor();
      await guardBudget(advisor.id, advisor.costPolicy);
      advisorId = advisor.id;
    }
    const result = await execute({
      prompt: userTurn,
      systemAppend: systemPrompt,
      cwd: paths.cache,
      timeoutMs: 8_000,
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Task'],
      signal,
    });
    if (advisorId) {
      await recordCost({
        agentId: advisorId,
        engine: 'CLAUDE_CODE',
        inputText: costInput,
        outputText: result.stdout,
        stepKey: 'builder.interview',
      }).catch(() => {});
    }
    return validateModelTurn(looseParseJson(result.stdout), opts.key, opts.brief) ?? fallback;
  } catch {
    return fallback;
  } finally {
    if (opts.sessionId && registered) finishBuilderInterviewCall(opts.sessionId, registered);
  }
}

export function formatInterviewTurn(turn: InterviewTurn): string {
  return [
    turn.context,
    turn.whyThisMatters ? `\n我現在先問這件事，是因為：${turn.whyThisMatters}` : '',
    turn.recommendation ? `\n我的建議：${turn.recommendation}` : '',
    '',
    turn.question,
    '',
    '你可以直接回答，或從下方建議開始：',
    ...turn.suggestions.map((suggestion) => `・${suggestion}`),
  ].join('\n');
}

/** Backwards-compatible pure formatter used by focused tests/tools. */
export function formatQuestion(key: BriefFieldKey, brief: Brief = {}): string {
  return formatInterviewTurn(buildContextualInterviewTurn(key, brief));
}

/** Apply a user answer to the current open field. Pure. */
export function applyAnswer(brief: Brief, key: BriefFieldKey, message: string): Brief {
  const text = message.trim();
  const next = { ...brief };
  const tags = next.tags ?? [];
  const asksSystemForFixture = /(?:請|讓|由).{0,8}(?:系統|你).{0,8}(?:產生|建立|模擬)|先產生.*模擬|模擬測試資料/.test(text);
  switch (key) {
    case 'objective':
      next.objective = text;
      next.successCriteria = next.successCriteria ?? '依上述目標可人工驗收。';
      break;
    case 'inputs':
      if (/(?:沒有|不用|不需要).{0,12}(?:上傳|訓練來源|範本|固定資料)/.test(text)) {
        next.inputs = tags.includes('research')
          ? '執行當下搜尋公開網路來源；不使用固定訓練檔案'
          : '依使用者當次指令或系統可用資料取得；不使用固定訓練檔案';
        next.sources = '不使用固定訓練檔案';
      } else {
        next.inputs = text;
        next.sources = text;
      }
      break;
    case 'outputs':
      next.outputs = text;
      if (/每天|每日/.test(text)) next.timing = '每日';
      else if (/每週|一週/.test(text)) next.timing = '每週';
      else if (/每次|手動|需要時/.test(text)) next.timing = '手動／需要時';
      if (/主管/.test(text)) next.recipients = '主管';
      else if (/老闆|CEO/.test(text)) next.recipients = '公司負責人';
      else if (/自己|給我|我看/.test(text)) next.recipients = '需求提出者本人';
      break;
    case 'process':
      next.process = /照建議|依建議|就這樣/.test(text)
        ? tags.includes('research')
          ? '搜尋候選來源 → 檢查日期與可信度 → 合併重複消息 → 摘要並保留原始連結 → 人工覆核'
          : '讀取資料 → 檢查完整性 → 整理結果 → 標示不確定項目 → 人工覆核'
        : text;
      break;
    case 'exceptions':
      next.exceptions = text;
      break;
    case 'permissions':
      next.permissions = text;
      break;
    case 'testData':
      {
        if (asksSystemForFixture) {
          if (tags.includes('research')) {
            next.testDataHint = '模擬三則同日 AI Agent 新聞：其中兩則描述同一產品更新、另一則來自無法驗證的來源。';
            next.expectedResult = '合併重複消息、保留可信來源連結、排除或標示無法驗證來源，產出不重複的重點摘要。';
          } else if (tags.includes('finance')) {
            next.testDataHint = '模擬三筆去識別交易：一筆完全相符、一筆金額差異、一筆缺少比對鍵。';
            next.expectedResult = '正確列出相符與差異，缺少資料者進入待確認，不執行入帳或寄送。';
          } else {
            next.testDataHint = '由系統依上述需求產生一組正常案例、一組資料缺漏案例。';
            next.expectedResult = '正常案例產出指定結果；缺漏案例清楚標示待確認，且不執行不可逆動作。';
          }
        } else {
          const fixture = splitTestDataAnswer(text);
          next.testDataHint = fixture.data;
          next.expectedResult = fixture.expected;
        }
      }
      break;
    default:
      break;
  }
  return next;
}

// ── Capability catalog (real DB) ─────────────────────────────────────────────

async function uniqueAgentSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await prisma.agent.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function uniqueSkillSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await prisma.skill.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/**
 * Build a plain-language capability plan from real catalogs.
 * Never enables MCP / A2A / accounts — only inventories and gaps.
 */
export async function buildCapabilityPlan(brief: Brief, userId: string): Promise<PlanDto> {
  const tags = brief.tags ?? [];
  const blob = [
    brief.objective,
    brief.inputs,
    brief.outputs,
    brief.process,
    ...(tags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const agents = await prisma.agent.findMany({
    where: { deletedAt: null, status: { not: 'ARCHIVED' } },
    select: {
      id: true,
      name: true,
      description: true,
      department: true,
      rolePrompt: true,
      status: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const skills = await prisma.skill.findMany({
    where: { deletedAt: null, reviewStatus: 'CONFIRMED' },
    select: { id: true, name: true, contentMd: true, understanding: true },
    orderBy: { updatedAt: 'desc' },
    take: 80,
  });

  const accounts = await prisma.connectedAccount.findMany({
    // Connection inventory is user-scoped. Never infer one customer's
    // capabilities from another user's connected account.
    where: { userId, status: 'CONNECTED' },
    select: { provider: true, scopes: true, status: true },
  });

  const mcpServers = await prisma.mcpServerRegistry.findMany({
    where: { enabled: true },
    select: { name: true, healthStatus: true, enabled: true, serverId: true },
    take: 40,
  });

  const a2aPeers = await prisma.a2APeer.findMany({
    where: { enabled: true, approvedBy: { not: null } },
    select: { name: true, enabled: true, peerId: true },
    take: 40,
  });

  const scoreText = (s: string) => {
    const t = s.toLowerCase();
    let score = 0;
    for (const tag of tags) {
      if (t.includes(tag)) score += 3;
    }
    for (const kw of ['帳款', '財務', 'mail', 'gmail', 'drive', '表', '整理', 'invoice', 'finance']) {
      if (blob.includes(kw) && t.includes(kw)) score += 2;
    }
    // token overlap (CJK bigrams + ascii words)
    const tokens = blob.split(/[\s,，、。；;]+/).filter((x) => x.length >= 2).slice(0, 40);
    for (const tok of tokens) {
      if (t.includes(tok)) score += 1;
    }
    return score;
  };

  const financeTerms = /帳款|財務|invoice|finance|對帳|收款|應收|應付/;
  const sourceTerms = /gmail|mail|郵件|信箱|drive|onedrive|雲端/;
  const domainRelevant = (candidateText: string, allowSourceOnly: boolean) => {
    const t = candidateText.toLowerCase();
    if (tags.includes('finance')) {
      return financeTerms.test(t) || (allowSourceOnly && sourceTerms.test(t));
    }
    return true;
  };

  const reuseCandidates = agents
    .map((a) => ({
      agentId: a.id,
      name: a.name,
      reason: a.description?.slice(0, 120) || a.department || '既有員工',
      candidateText: `${a.name} ${a.description} ${a.rolePrompt} ${a.department}`,
      score: scoreText(`${a.name} ${a.description} ${a.rolePrompt} ${a.department}`),
    }))
    .filter((a) => a.score >= 3 && domainRelevant(a.candidateText, false))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ agentId, name, reason }) => ({ agentId, name, reason }));

  const skillMatches = skills
    .map((s) => {
      const summary =
        s.understanding && typeof s.understanding === 'object' && !Array.isArray(s.understanding)
          ? String((s.understanding as Record<string, unknown>).summary ?? '')
          : '';
      return {
        skillId: s.id,
        name: s.name,
        reason: summary.slice(0, 120) || '已確認技能',
        candidateText: `${s.name} ${summary} ${s.contentMd.slice(0, 400)}`,
        score: scoreText(`${s.name} ${summary} ${s.contentMd.slice(0, 400)}`),
      };
    })
    .filter((s) => s.score >= 3 && domainRelevant(s.candidateText, true))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ skillId, name, reason }) => ({ skillId, name, reason }));

  const healthyMcpNames = mcpServers
    .filter((m) => ['healthy', 'ok'].includes((m.healthStatus ?? '').toLowerCase()))
    .map((m) => `${m.name} ${m.serverId}`.toLowerCase());
  const hasMailAccount = accounts.some((a) => {
    const scopes = a.scopes.join(' ').toLowerCase();
    return a.provider === 'GOOGLE'
      ? /gmail|mail\.google|googleapis\.com\/auth\/gmail/.test(scopes)
      : /mail\.|mail\.read|mail\.readwrite/.test(scopes);
  });
  const hasCloudAccount = accounts.some((a) => {
    const scopes = a.scopes.join(' ').toLowerCase();
    return a.provider === 'GOOGLE'
      ? /drive|googleapis\.com\/auth\/drive/.test(scopes)
      : /files\.|onedrive/.test(scopes);
  });
  const hasMailTool = healthyMcpNames.some((n) => /gmail|outlook|mail/.test(n));
  const hasCloudTool = healthyMcpNames.some((n) => /drive|onedrive|sharepoint/.test(n));
  const needsEmail = /mail|郵件|信箱|gmail|outlook|email/.test(blob) || tags.includes('email');
  const needsCloud =
    /drive|雲端|onedrive|上傳|資料夾/.test(blob) || tags.includes('cloud');
  const needsResearch =
    /網路搜尋|上網找|公開網路|新聞|research|web search/.test(blob) || tags.includes('research');

  const connections: ConnectionGap[] = [];
  if (needsEmail) {
    const available = hasMailAccount || hasMailTool;
    connections.push({
      label: '公司信箱（Gmail / Outlook）',
      available,
      actionNeeded:
        available
          ? '已連線，上線前仍請確認讀取範圍與權限。'
          : '請在設定中連線公司信箱後，才能在正式環境讀信。',
    });
  }
  if (needsCloud) {
    const available = hasCloudAccount || hasCloudTool;
    connections.push({
      label: '雲端硬碟（Drive / OneDrive）',
      available,
      actionNeeded:
        available
          ? '已連線；正式寫入仍需 FDE 另行授權（預設只做草稿）。'
          : '請在設定中連線雲端硬碟；目前測試可用手動資料代替。',
    });
  }
  if (needsResearch) {
    connections.push({
      label: '公開網路搜尋',
      available: false,
      actionNeeded: '這項任務需要網路搜尋；建立與試跑仍採隔離資料，正式開放搜尋需由 FDE 明確核准範圍。',
    });
  }

  // Healthy MCP / A2A as optional business integrations (labels only)
  for (const m of mcpServers) {
    const healthy = (m.healthStatus ?? '').toLowerCase() === 'healthy' || m.healthStatus === 'ok';
    connections.push({
      label: `外部工具：${m.name}`,
      available: healthy,
      actionNeeded: healthy
        ? '已啟用且健康；不會自動掛給這位員工，需 FDE 另行授權。'
        : '已註冊但健康狀態異常，正式環境使用前請 FDE 檢查。',
    });
  }
  for (const p of a2aPeers) {
    connections.push({
      label: `協作對象：${p.name}`,
      available: true,
      actionNeeded: '已核准的外部協作對象；不會自動委派，需 FDE 另行設定。',
    });
  }

  const gaps = connections
    .filter((c) => !c.available)
    .map((c) => ({ label: c.label, actionNeeded: c.actionNeeded }));

  const strategyRecommendation: 'reuse' | 'create' =
    brief.requestedStrategy ?? (reuseCandidates.length > 0 ? 'reuse' : 'create');

  const proposedAgentName = brief.requestedAgentName ?? (tags.includes('finance')
    ? '財務管理 Agent'
    : tags.includes('email')
      ? '郵件營運 Agent'
      : tags.includes('research')
        ? '研究情報 Agent'
        : '營運助理 Agent');
  const proposedSkillName = brief.requestedAgentName
    ? `${brief.requestedAgentName.replace(/(?:\s*Agent|AI\s*員工|員工|專員)$/i, '')}核心流程`
    : tags.includes('finance')
      ? '財務彙整、異常檢查與催款草稿'
      : tags.includes('research')
        ? '可信來源搜尋、去重與研究摘要'
      : `${proposedAgentName.replace(/ Agent$/, '')}核心流程`;

  const summaryParts: string[] = [];
  if (brief.requestedStrategy === 'create') {
    summaryParts.push(
      `已依使用者明確要求規劃全新員工「${proposedAgentName}」；既有員工只列為能力參考，不會被沿用或修改。`,
    );
  } else if (strategyRecommendation === 'reuse') {
    summaryParts.push(
      `建議優先複用既有員工「${reuseCandidates[0]!.name}」，只新增一個待確認的技能草稿，不改寫其身分與權限。`,
    );
  } else {
    summaryParts.push('目前沒有高度相符的既有員工，建議建立一位新的 AI 員工（先暫停、最小權限）。');
  }
  if (skillMatches.length) {
    summaryParts.push(`已確認技能中有 ${skillMatches.length} 項可參考。`);
  }
  if (gaps.length) {
    summaryParts.push(`正式上線前尚缺：${gaps.map((g) => g.label).join('、')}。手動測試資料仍可先驗流程。`);
  } else if (connections.length) {
    summaryParts.push('相關連線看起來可用，但仍採最小權限，不會自動寄信或寫入雲端。');
  }

  return {
    summary: summaryParts.join(' '),
    strategyRecommendation,
    reuseCandidates,
    skillMatches,
    connections,
    gaps,
    proposedAgentName,
    proposedSkillName,
    privilegeNote:
      '預設關閉：寄信、雲端寫入、Shell、電腦操控。正式開放需 FDE 另審。',
  };
}

// ── Session helpers ──────────────────────────────────────────────────────────

function isFde(role: UserRole | string): boolean {
  return role === 'OWNER' || role === 'TRAINER';
}

function asBrief(raw: unknown): Brief {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Brief;
}

function asProgress(raw: unknown): Progress | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Progress;
}

function asPlan(raw: unknown): PlanDto | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as PlanDto;
}

function asTranscript(raw: unknown): TranscriptEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is TranscriptEntry =>
      !!e &&
      typeof e === 'object' &&
      (e as TranscriptEntry).role != null &&
      typeof (e as TranscriptEntry).content === 'string',
  );
}

function asTestResult(raw: unknown): TestResultDto | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as TestResultDto;
}

function asBuilderDraftState(raw: unknown): BuilderDraftState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reply: '', testData: '', testExpected: '' };
  }
  const value = raw as Record<string, unknown>;
  return {
    reply: typeof value.reply === 'string' ? value.reply : '',
    testData: typeof value.testData === 'string' ? value.testData : '',
    testExpected: typeof value.testExpected === 'string' ? value.testExpected : '',
  };
}

export function toSessionDto(
  row: AgentBuildSession & { iterations?: AgentBuildIteration[] },
  opts: { includeDraft?: boolean; testProgress?: BuilderTestProgressDto | null } = {},
): SessionDto {
  const iterations = [...(row.iterations ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map(toIterationDto);
  const latestHarness = [...iterations].reverse().find((iteration) => iteration.harness)?.harness ?? null;
  const requirements = latestHarness?.testInputRequirements?.length
    ? latestHarness.testInputRequirements
    : inferTestInputRequirements({
        identityName: latestHarness?.identity.name,
        skills: latestHarness?.skills ?? [],
        testIdeas: latestHarness?.testIdeas ?? [],
      });
  const testInputStatus = getTestInputStatus(requirements, parseBuilderTestData(row.testData));
  return {
    id: row.id,
    status: row.status,
    progress: asProgress(row.progress),
    brief: asBrief(row.brief),
    plan: asPlan(row.plan),
    strategy: row.strategy,
    targetAgentId: row.targetAgentId,
    builtAgentId: row.builtAgentId,
    agentId: row.agentId,
    draftSkillIds: row.draftSkillIds ?? [],
    hasTestData: row.testData != null,
    testInputStatus,
    testResult: asTestResult(row.testResult),
    testProgress: opts.testProgress ?? null,
    lastRunId: row.lastRunId,
    lastAssistantMessage: row.lastAssistantMessage,
    // Unsubmitted text belongs to the operator. FDE review receives only
    // submitted transcript/brief/test evidence, never another user's draft.
    draftState: opts.includeDraft === false
      ? { reply: '', testData: '', testExpected: '' }
      : asBuilderDraftState(row.draftState),
    transcript: asTranscript(row.transcript),
    iterations,
    latestIteration: iterations.at(-1) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    abandonedAt: row.abandonedAt ? row.abandonedAt.toISOString() : null,
  };
}

type BuilderSessionRow = AgentBuildSession & { iterations?: AgentBuildIteration[] };

/** Batch-hydrate safe progress snapshots without leaking raw run output. */
async function hydrateSessionDtos(
  rows: BuilderSessionRow[],
  includeDraft: (row: BuilderSessionRow) => boolean,
): Promise<SessionDto[]> {
  const directRunIds = rows.map((row) => row.lastRunId).filter((id): id is string => Boolean(id));
  const testingAgentIds = rows
    .filter((row) => row.status === 'TESTING')
    .map((row) => row.builtAgentId ?? row.targetAgentId)
    .filter((id): id is string => Boolean(id));
  const include = {
    steps: { orderBy: { round: 'asc' as const } },
    agent: { select: { maxRounds: true } },
  };
  const [directRuns, runningCandidates] = await Promise.all([
    directRunIds.length
      ? prisma.run.findMany({ where: { id: { in: directRunIds } }, include })
      : [],
    testingAgentIds.length
      ? prisma.run.findMany({
          where: { agentId: { in: testingAgentIds }, status: 'RUNNING' },
          orderBy: { startedAt: 'desc' },
          include,
        })
      : [],
  ]);
  const directById = new Map(directRuns.map((run) => [run.id, run]));
  const runningBySession = new Map<string, (typeof runningCandidates)[number]>();
  for (const run of runningCandidates) {
    const input = run.input && typeof run.input === 'object' && !Array.isArray(run.input)
      ? run.input as Record<string, unknown>
      : {};
    const evidence = input.builderTestEvidence && typeof input.builderTestEvidence === 'object'
      ? input.builderTestEvidence as Record<string, unknown>
      : {};
    const sessionId = typeof evidence.sessionId === 'string' ? evidence.sessionId : null;
    if (input.builderTest === true && sessionId && !runningBySession.has(sessionId)) {
      runningBySession.set(sessionId, run);
    }
  }

  return rows.map((row) => {
    const run = row.status === 'TESTING'
      ? runningBySession.get(row.id) ?? (row.lastRunId ? directById.get(row.lastRunId) : undefined)
      : row.lastRunId ? directById.get(row.lastRunId) : undefined;
    return toSessionDto(row, {
      includeDraft: includeDraft(row),
      testProgress: run
        ? deriveBuilderTestProgress({ run, steps: run.steps, maxRounds: run.agent.maxRounds })
        : null,
    });
  });
}

async function testInputContractForSession(sessionId: string): Promise<{
  requirements: BuilderTestInputRequirement[];
  expected: string;
}> {
  const iteration = await prisma.agentBuildIteration.findFirst({
    where: { sessionId, status: 'READY', artifactSnapshot: { not: Prisma.DbNull } },
    orderBy: { sequence: 'desc' },
  });
  const harness = iteration?.artifactSnapshot as HarnessSnapshot | null;
  const requirements = harness?.testInputRequirements?.length
    ? harness.testInputRequirements
    : inferTestInputRequirements({
        identityName: harness?.identity.name,
        skills: harness?.skills ?? [],
        testIdeas: harness?.testIdeas ?? [],
      });
  return {
    requirements,
    expected: harness?.testIdeas?.[0]?.expected?.trim() || '輸出符合這位 Agent 已定義的技能、政策與驗收條件，且通過跨模型驗證。',
  };
}

/**
 * Load session with ownership fail-closed: non-owner non-FDE → 404
 * (avoid existence leak). FDE may inspect any session.
 */
export async function loadOwnedSession(
  sessionId: string,
  userId: string,
  role: UserRole | string,
): Promise<AgentBuildSession> {
  const row = await prisma.agentBuildSession.findUnique({ where: { id: sessionId } });
  if (!row) throw errors.notFound('Session not found');
  if (row.userId !== userId && !isFde(role)) {
    throw errors.notFound('Session not found');
  }
  return row;
}

function pushTranscript(
  existing: TranscriptEntry[],
  role: TranscriptEntry['role'],
  content: string,
): TranscriptEntry[] {
  const entry: TranscriptEntry = {
    role,
    content: deepRedactSecrets(content),
    at: new Date().toISOString(),
  };
  return deepRedactSecrets([...existing, entry]);
}

function planAssistantMessage(plan: PlanDto): string {
  const lines = [
    '需求已齊，以下是計畫摘要（以業務語言說明）：',
    '',
    plan.summary,
    '',
    `建議策略：${plan.strategyRecommendation === 'reuse' ? '複用既有員工並新增技能草稿' : '建立新的 AI 員工（先暫停）'}`,
  ];
  if (plan.reuseCandidates.length) {
    lines.push('', '可複用的既有員工：');
    for (const c of plan.reuseCandidates) {
      lines.push(`・${c.name} — ${c.reason}`);
    }
  }
  if (plan.skillMatches.length) {
    lines.push('', '可參考的已確認技能：');
    for (const s of plan.skillMatches) {
      lines.push(`・${s.name} — ${s.reason}`);
    }
  }
  if (plan.gaps.length) {
    lines.push('', '正式上線前需補齊：');
    for (const g of plan.gaps) {
      lines.push(`・${g.label}：${g.actionNeeded}`);
    }
  }
  lines.push('', plan.privilegeNote);
  lines.push('', '若策略正確，請按「授權建立」；操作者會送交 FDE，訓練師可直接建立草稿。');
  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createBuilderSession(opts: {
  userId: string;
  message: string;
}): Promise<BuilderMessageResult> {
  const message = opts.message.trim();
  if (!message) throw errors.badRequest('message is required');

  const inference = inferFromPrompt(message);
  const answered = [...inference.answered];
  const brief: Brief = deepRedactSecrets({ ...inference.brief });
  const fallbackFocus = nextUnanswered(answered) ?? 'objective';
  const id = ulid();
  const turn = await planAdaptiveInterviewTurn({ key: fallbackFocus, brief, sessionId: id });
  const progress = buildProgress(answered, turn);
  const status: AgentBuildSessionStatus = 'ACTIVE';
  const assistantMessage = formatInterviewTurn(turn);

  const transcript = pushTranscript(
    pushTranscript([], 'user', message),
    'assistant',
    assistantMessage,
  );
  const { row, workingAgent } = await prisma.$transaction(async (tx) => {
    const workingAgent = await createBuilderWorkingAgent(tx, {
      userId: opts.userId,
      name: brief.requestedAgentName,
      objective: brief.objective,
      process: brief.process,
      tags: brief.tags,
    });
    const row = await tx.agentBuildSession.create({
      data: {
        id,
        userId: opts.userId,
        status,
        transcript,
        brief: brief as object,
        progress: progress as object,
        strategy: 'create',
        agentId: workingAgent.id,
        targetAgentId: workingAgent.id,
        builtAgentId: workingAgent.id,
        lastAssistantMessage: deepRedactSecrets(assistantMessage),
      },
    });
    return { row, workingAgent };
  });

  // Draft cleanup is auxiliary: never fail a successfully created session.
  await prisma.agentBuilderWorkspace.deleteMany({ where: { userId: opts.userId } }).catch(() => {});

  await audit(opts.userId, 'agent_builder.session_created', 'AgentBuildSession', id, {
    status,
    agentId: workingAgent.id,
  });
  await audit(opts.userId, 'agent_builder.working_agent_created', 'Agent', workingAgent.id, {
    sessionId: id,
    status: 'ACTIVE',
    leastPrivilege: true,
  });
  hub.publish('agent.status', { id: workingAgent.id, status: 'ACTIVE', event: 'created' });

  const iteration = await createBuilderEvolutionIteration({
    sessionId: id,
    triggerKind: 'message',
    triggerSummary: message,
  }).catch(() => null);
  const sessionDto = toSessionDto(row);
  if (iteration) {
    sessionDto.iterations = [iteration];
    sessionDto.latestIteration = iteration;
  }

  return {
    session: sessionDto,
    assistantMessage,
    status: row.status,
    progress: asProgress(row.progress),
  };
}

function explicitlyRequestsBuild(message: string): boolean {
  return /(?:確認|就照|可以照|同意).{0,16}(?:這版|目前|建立|送審|開始)|(?:正式建立|送交.{0,8}審核|送審|請.{0,8}建立草稿|先建一版給我測)/.test(message);
}

export async function postBuilderMessage(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  message: string;
}): Promise<BuilderMessageResult> {
  const message = opts.message.trim();
  if (!message) throw errors.badRequest('message is required');

  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (!['DISCOVERY', 'ACTIVE'].includes(row.status)) {
    throw errors.conflict(`Session does not accept training messages (status=${row.status})`);
  }

  // Only the owner may continue the interview (FDE may read, not ghost-write).
  if (row.userId !== opts.userId) {
    throw errors.forbidden('Only the session owner may continue the interview');
  }

  const progress = asProgress(row.progress) ?? buildProgress([]);
  const continuingActiveAgent = row.status === 'ACTIVE';
  const current = progress.currentKey ?? progress.turn?.key ?? (continuingActiveAgent ? 'process' : 'objective');

  let brief = continuingActiveAgent
    ? {
        ...asBrief(row.brief),
        process: [asBrief(row.brief).process, `後續訓練：${message}`].filter(Boolean).join('\n'),
      }
    : applyAnswer(asBrief(row.brief), current, message);
  brief = deepRedactSecrets(brief);
  const answered = [...new Set([...progress.answeredKeys, current])];
  let nextProgress: Progress;

  let status: AgentBuildSessionStatus = continuingActiveAgent ? 'ACTIVE' : 'DISCOVERY';
  let plan: PlanDto | null = null;
  let assistantMessage: string;

  const legacyDeterministicComplete =
    process.env.AIOS_BUILDER_ADAPTIVE_MODEL === 'off' && nextUnanswered(answered) == null;
  if (!continuingActiveAgent && ((explicitlyRequestsBuild(message) && Boolean(brief.objective)) || legacyDeterministicComplete)) {
    plan = deepRedactSecrets(await buildCapabilityPlan(brief, row.userId));
    status = 'PLAN_READY';
    nextProgress = { ...buildProgress(answered), currentKey: null, turn: null, mode: 'grill' };
    assistantMessage = planAssistantMessage(plan);
  } else {
    const fallbackFocus = nextUnanswered(answered) ?? current;
    const turn = await planAdaptiveInterviewTurn({
      key: fallbackFocus,
      brief,
      recentTranscript: pushTranscript(asTranscript(row.transcript), 'user', message),
      sessionId: row.id,
    });
    nextProgress = buildProgress(answered, turn);
    assistantMessage = formatInterviewTurn(turn);
  }

  const transcript = pushTranscript(
    pushTranscript(asTranscript(row.transcript), 'user', message),
    'assistant',
    assistantMessage,
  );

  const updated = await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status,
      brief: brief as object,
      plan: plan ? (plan as object) : undefined,
      progress: nextProgress as object,
      transcript,
      lastAssistantMessage: deepRedactSecrets(assistantMessage),
      draftState: { reply: '', testData: '', testExpected: '' },
    },
  });

  const triggerKind = EXPLICIT_CORRECTION_RE.test(message)
    ? 'correction'
    : 'message';
  const iteration = await createBuilderEvolutionIteration({
    sessionId: row.id,
    triggerKind,
    triggerSummary: message,
  }).catch(() => null);
  const sessionDto = toSessionDto(updated);
  if (iteration) {
    sessionDto.iterations = [iteration];
    sessionDto.latestIteration = iteration;
  }

  return {
    session: sessionDto,
    assistantMessage,
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}

export async function getBuilderSession(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
}): Promise<SessionDto> {
  let row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  // Crash recovery for an in-process test job. A normal test has a 20-minute
  // timeout; anything still TESTING after 25 minutes is failed closed instead
  // of leaving the session permanently stuck.
  if (row.status === 'TESTING' && Date.now() - row.updatedAt.getTime() > 25 * 60_000) {
    const testResult: TestResultDto = {
      ok: false,
      status: 'FAILED',
      summary: '試跑中斷或逾時，請重新提交測試。',
      productionBlockers: productionBlockersFromPlan(asPlan(row.plan)),
    };
    const recovered = await prisma.agentBuildSession.updateMany({
      where: { id: row.id, status: 'TESTING', updatedAt: row.updatedAt },
      data: {
        status: 'FAILED',
        testResult: deepRedactSecrets(testResult) as object,
        lastAssistantMessage: testResult.summary,
      },
    });
    if (recovered.count === 1) {
      await audit(opts.userId, 'agent_builder.test_recovered_timeout', 'AgentBuildSession', row.id, {
        previousUpdatedAt: row.updatedAt.toISOString(),
      });
    }
    row = (await prisma.agentBuildSession.findUnique({ where: { id: row.id } }))!;
  }
  const hydrated = await prisma.agentBuildSession.findUnique({
    where: { id: row.id },
    include: { iterations: { orderBy: { sequence: 'asc' }, take: 50 } },
  });
  if (!hydrated) throw errors.notFound('Session not found');
  return (await hydrateSessionDtos([hydrated], (item) => item.userId === opts.userId))[0]!;
}

/**
 * Resume the current user's latest unfinished Builder flow. This is deliberately
 * owner-scoped and excludes ACTIVE sessions so opening "建立 AI 員工" after a
 * completed build still starts cleanly. FAILED remains resumable for correction
 * and retesting instead of stranding the evidence trail.
 */
export async function getLatestBuilderSession(opts: {
  userId: string;
}): Promise<SessionDto | null> {
  const row = await prisma.agentBuildSession.findFirst({
    where: {
      userId: opts.userId,
      status: { notIn: ['ACTIVE', 'ABANDONED'] },
    },
    orderBy: { updatedAt: 'desc' },
    include: { iterations: { orderBy: { sequence: 'desc' }, take: 10 } },
  });
  return row ? toSessionDto(row) : null;
}

/**
 * Fail-closed: one non-ABANDONED builder session per (userId, agentId).
 * Callers that would bind a second active session must resume the existing id.
 */
export async function assertBuilderAgentBindingAvailable(
  opts: { userId: string; agentId: string; exceptSessionId?: string },
  db: { agentBuildSession: { findFirst: typeof prisma.agentBuildSession.findFirst } } = prisma,
): Promise<void> {
  const existing = await db.agentBuildSession.findFirst({
    where: {
      userId: opts.userId,
      agentId: opts.agentId,
      status: { not: 'ABANDONED' },
      ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}),
    },
    select: { id: true },
  });
  if (existing) {
    throw errors.badRequest(
      `此員工已有進行中的建置對話（${existing.id}），請續接該筆而非新建`,
    );
  }
}

/** List the owner's recent Builder flows, including ACTIVE employees that may
 * be taught new information tomorrow without mutating their live version. */
export async function listBuilderSessions(opts: { userId: string }): Promise<SessionDto[]> {
  const rows = await prisma.agentBuildSession.findMany({
    where: { userId: opts.userId, status: { not: 'ABANDONED' } },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { iterations: { orderBy: { sequence: 'desc' }, take: 10 } },
  });
  return hydrateSessionDtos(rows, () => true);
}

const ABANDONABLE_STATUSES: AgentBuildSessionStatus[] = ['DISCOVERY', 'PLAN_READY'];

/** Fail-safe: session success must not depend on the lesson reflection. */
async function enqueueBuilderSelfReflectionSafe(sessionId: string): Promise<void> {
  try {
    const { enqueueBuilderSelfReflection } = await import('./builderlessons.js');
    await enqueueBuilderSelfReflection(sessionId);
  } catch (err) {
    console.warn(
      '[agentbuilder] builder self-reflection enqueue failed (ignored):',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Soft-delete an unsubmitted owner draft. Governed sessions (AWAITING_FDE+)
 * cannot be abandoned here — they stay on the FDE path. Never hard-deletes.
 */
export async function abandonBuilderSession(opts: {
  sessionId: string;
  userId: string;
  confirmSessionId?: string;
}): Promise<SessionDto> {
  const row = await prisma.agentBuildSession.findUnique({
    where: { id: opts.sessionId },
    include: { iterations: { orderBy: { sequence: 'asc' } } },
  });
  if (!row || row.userId !== opts.userId) {
    throw errors.notFound('Session not found');
  }
  if (opts.confirmSessionId !== undefined && opts.confirmSessionId !== opts.sessionId) {
    throw errors.badRequest('confirmSessionId 必須與 sessionId 相同');
  }
  if (row.status === 'ABANDONED') {
    return toSessionDto(row);
  }
  if (!ABANDONABLE_STATUSES.includes(row.status)) {
    throw errors.forbidden('已進入審核流程的建置不可自行捨棄；請走 FDE 流程');
  }
  if (row.builtAgentId || row.draftSkillIds.length > 0) {
    throw errors.forbidden('此建置已產生員工或技能草稿，不可直接捨棄');
  }

  abortBuilderSessionWork(row.id);
  await prisma.agentBuildIteration.updateMany({
    where: {
      sessionId: row.id,
      status: { in: ['QUEUED', 'ANALYZING', 'BUILDING'] },
    },
    data: { status: 'SUPERSEDED', completedAt: new Date() },
  }).catch(() => {});

  const updated = await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status: 'ABANDONED',
      abandonedAt: new Date(),
    },
    include: { iterations: { orderBy: { sequence: 'asc' } } },
  });
  await audit(opts.userId, 'agentbuild.abandoned', 'AgentBuildSession', row.id, {
    previousStatus: row.status,
  });
  await enqueueBuilderSelfReflectionSafe(row.id);
  return toSessionDto(updated);
}

/** Load the redacted unsent fields for a new flow or an owned existing flow. */
export async function getBuilderDraft(opts: {
  userId: string;
  sessionId?: string;
}): Promise<BuilderDraftState> {
  if (!opts.sessionId) {
    const workspace = await prisma.agentBuilderWorkspace.findUnique({ where: { userId: opts.userId } });
    return { reply: workspace?.newDraft ?? '', testData: '', testExpected: '' };
  }
  const row = await prisma.agentBuildSession.findUnique({ where: { id: opts.sessionId } });
  if (!row || row.userId !== opts.userId) throw errors.notFound('Session not found');
  return asBuilderDraftState(row.draftState);
}

/** Persist unsent fields server-side so another device can continue safely. */
export async function saveBuilderDraft(opts: {
  userId: string;
  sessionId?: string;
  draft: BuilderDraftState;
}): Promise<BuilderDraftState> {
  const draft: BuilderDraftState = deepRedactSecrets({
    reply: opts.draft.reply.slice(0, 8_000),
    testData: opts.draft.testData.slice(0, 30_000),
    testExpected: opts.draft.testExpected.slice(0, 12_000),
  });
  if (!opts.sessionId) {
    await prisma.agentBuilderWorkspace.upsert({
      where: { userId: opts.userId },
      update: { newDraft: draft.reply || null },
      create: { userId: opts.userId, newDraft: draft.reply || null },
    });
    return { reply: draft.reply, testData: '', testExpected: '' };
  }
  const claimed = await prisma.agentBuildSession.updateMany({
    where: { id: opts.sessionId, userId: opts.userId },
    data: { draftState: draft as Prisma.InputJsonValue },
  });
  if (claimed.count !== 1) throw errors.notFound('Unfinished session not found');
  return draft;
}

/** Least-privilege defaults for builder-created agents (spec hard rule). */
export const BUILDER_LEAST_PRIVILEGE = {
  webSearch: false,
  computerUse: false,
  sendEmail: false,
  cloudWrite: false,
  shell: false,
  cloudEmbedding: false,
  notes: 'Agent Builder 預設最小權限：禁止網路搜尋／寄信／雲端寫入／Shell／電腦操控／雲端 embedding。',
} as const;

function skillMarkdownFromBrief(
  brief: Brief,
  skillName: string,
  harness?: HarnessSnapshot | null,
  harnessSkill?: HarnessSnapshot['skills'][number] | null,
): string {
  if (harnessSkill?.contentMd?.trim()) {
    const authored = String(deepRedactSecrets(harnessSkill.contentMd)).trim().slice(0, 60_000);
    return [
      authored,
      '',
      '## AIOS 治理狀態',
      '- 此檔案由外部 Agent Builder 同步為技能草稿。',
      '- 需通過測試與 FDE 最終確認後才會生效。',
      '',
    ].join('\n');
  }
  const sourceBlocks = (brief.sourceFiles ?? []).flatMap((file) => [
    `### ${file.name}`,
    `前臺上傳時間：${file.uploadedAt}`,
    '',
    file.content,
    '',
  ]);
  const lines = [
    '---',
    `name: ${skillName.replace(/[:\n]/g, ' ').slice(0, 80)}`,
    `description: ${(brief.objective ?? skillName).replace(/\n/g, ' ').slice(0, 200)}`,
    '---',
    '',
    `# ${skillName}`,
    '',
    '## 目標',
    brief.objective ?? '（未填）',
    '',
    '## 成功標準',
    brief.successCriteria ?? '人工可驗收之業務結果',
    '',
    '## 輸入來源',
    brief.inputs ?? brief.sources ?? '（未填）',
    '',
    ...(sourceBlocks.length
      ? ['## 前臺上傳的訓練來源', '', ...sourceBlocks]
      : []),
    '## 產出',
    brief.outputs ?? '（未填）',
    brief.recipients ? `收件／對象：${brief.recipients}` : '',
    brief.timing ? `節奏：${brief.timing}` : '',
    '',
    '## 標準流程',
    ...(harnessSkill?.instructions?.length
      ? harnessSkill.instructions.map((step, index) => `${index + 1}. ${step}`)
      : [brief.process ?? '（未填）']),
    '',
    '## 例外處理',
    brief.exceptions ?? '不確定時標註待審，不擅自執行不可逆操作。',
    '',
    '## 權限邊界',
    brief.permissions ??
      '禁止寄信、雲端寫入、Shell、電腦操控；僅讀取與產出草稿供人工確認。',
    '',
    ...(harness?.memory
      ? [
          '## 從對話累積的工作記憶',
          ...harness.memory.facts.map((fact) => `- 事實：${fact}`),
          ...harness.memory.preferences.map((preference) => `- 偏好：${preference}`),
          '',
        ]
      : []),
    ...(harness?.tools?.length
      ? [
          '## 工具與連線候選',
          ...harness.tools.map((tool) => `- ${tool.name}：${tool.purpose}（${tool.status === 'AVAILABLE' ? '可用' : '需 FDE 檢查'}）`),
          '',
        ]
      : []),
    '## 注意',
    '- 本技能由 Agent Builder 產生，需 FDE 確認後才會生效。',
    '- 正式連線（信箱／雲端）未就緒前，僅可用手動測試資料驗流程。',
    '',
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

const MAX_BUILDER_SOURCE_FILES = 6;
const MAX_BUILDER_SOURCE_CHARS = 24_000;

/** Attach a redacted, parsed source file to a Builder session before authorization. */
export async function attachBuilderSourceFile(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  name: string;
  mimeType?: string;
  size: number;
  content: string;
}): Promise<BuilderMessageResult> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (row.userId !== opts.userId) throw errors.notFound('Session not found');
  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(row.status)) {
    throw errors.conflict(`Cannot attach training sources from status=${row.status}`);
  }

  const brief = asBrief(row.brief);
  const existing = [...(brief.sourceFiles ?? [])];
  const safeName = path.basename(opts.name).replace(/[\r\n]/g, ' ').slice(0, 160) || 'training-source';
  const redactedContent = String(deepRedactSecrets(opts.content)).slice(
    0,
    MAX_BUILDER_SOURCE_CHARS,
  );
  if (!redactedContent.trim()) throw errors.badRequest('Uploaded file contains no readable text');

  const nextFile = {
    name: safeName,
    mimeType: opts.mimeType?.slice(0, 120),
    size: opts.size,
    content: redactedContent,
    uploadedAt: new Date().toISOString(),
  };
  const duplicateIndex = existing.findIndex((file) => file.name === safeName);
  if (duplicateIndex >= 0) existing[duplicateIndex] = nextFile;
  else existing.push(nextFile);
  if (existing.length > MAX_BUILDER_SOURCE_FILES) {
    throw errors.badRequest(`A builder session supports at most ${MAX_BUILDER_SOURCE_FILES} files`);
  }

  const nextBrief: Brief = deepRedactSecrets({
    ...brief,
    inputs: brief.inputs
      ? `${brief.inputs}\n前臺上傳檔案：${safeName}`
      : `前臺上傳檔案：${safeName}`,
    sourceFiles: existing,
  }) as Brief;
  const assistantMessage = `我已讀取「${safeName}」。現在會先從內容找出流程、欄位與例外，更新這位員工的學習草稿；你不需要逐欄重新說明。`;
  const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);
  const updated = await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      brief: nextBrief as object,
      transcript,
      lastAssistantMessage: deepRedactSecrets(assistantMessage),
    },
  });
  await audit(opts.userId, 'agent_builder.source_uploaded', 'AgentBuildSession', row.id, {
    name: safeName,
    size: opts.size,
    chars: redactedContent.length,
  });
  const iteration = await createBuilderEvolutionIteration({
    sessionId: row.id,
    triggerKind: 'file',
    triggerSummary: `使用者提供參考資料：${safeName}；已解析 ${redactedContent.length} 字。`,
  }).catch(() => null);
  const sessionDto = toSessionDto(updated);
  if (iteration) {
    sessionDto.iterations = [iteration];
    sessionDto.latestIteration = iteration;
  }
  return {
    session: sessionDto,
    assistantMessage,
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}

/** FDE review inbox: pre-build authorization and final activation only. */
export async function listBuilderReviewQueue(): Promise<SessionDto[]> {
  const rows = await prisma.agentBuildSession.findMany({
    where: { status: { in: ['AWAITING_FDE', 'PASSED'] } },
    orderBy: { updatedAt: 'asc' },
    include: { iterations: { orderBy: { sequence: 'desc' }, take: 50 } },
  });
  return hydrateSessionDtos(rows, () => false);
}

/** Account-scoped evolution ledger for /agent-builds.
 * Every role, including OWNER/TRAINER, sees only builds owned by that login. */
export async function listBuilderEvolutionSessions(opts: {
  userId: string;
}): Promise<SessionDto[]> {
  const rows = await prisma.agentBuildSession.findMany({
    where: {
      // Legacy front-end Builder sessions predate append-only evolution rows.
      // Keep completed ACTIVE Agents visible so they can still be exported.
      OR: [{ iterations: { some: {} } }, { status: 'ACTIVE' }],
      userId: opts.userId,
      status: { not: 'ABANDONED' },
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { iterations: { orderBy: { sequence: 'desc' }, take: 50 } },
  });
  // Account portal: rows are already filtered by userId.
  const sessions = await hydrateSessionDtos(rows, () => false);
  return sessions.map((session) => ({
    ...session,
    ownedByCurrentUser: true,
  }));
}

/** FDE-only global ledger. This must only be exposed from a trainer-guarded
 * admin endpoint and must never back the account-scoped /agent-builds page. */
export async function listAllBuilderEvolutionSessions(opts: {
  viewerUserId: string;
}): Promise<SessionDto[]> {
  const rows = await prisma.agentBuildSession.findMany({
    where: {
      OR: [{ iterations: { some: {} } }, { status: 'ACTIVE' }],
      status: { not: 'ABANDONED' },
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { iterations: { orderBy: { sequence: 'desc' }, take: 50 } },
  });
  const sessions = await hydrateSessionDtos(rows, () => false);
  return sessions.map((session, index) => ({
    ...session,
    ownedByCurrentUser: rows[index]!.userId === opts.viewerUserId,
  }));
}

async function createInertSkillDraft(opts: {
  name: string;
  brief: Brief;
  createdBy: string;
  harness?: HarnessSnapshot | null;
  harnessSkill?: HarnessSnapshot['skills'][number] | null;
}): Promise<{ id: string; filePath: string }> {
  const id = ulid();
  const name = opts.name.slice(0, 80) || 'Builder 技能草稿';
  const contentMd = deepRedactSecrets(
    skillMarkdownFromBrief(opts.brief, name, opts.harness, opts.harnessSkill),
  );
  const slug = await uniqueSkillSlug(slugify(name));

  const dest = safeJoin(paths.skills, slug, 'SKILL.md');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, contentMd, 'utf8');

  await prisma.skill.create({
    data: {
      id,
      slug,
      name,
      origin: 'CLI_GENERATED',
      kind: 'PROMPT_MANUAL',
      contentMd,
      generator: 'agent-builder',
      // Builder discovery is deterministic and must never block on a model CLI.
      // The structured brief itself is the human-readable understanding; the
      // draft still requires an explicit FDE confirmation before it is effective.
      reviewStatus: 'AWAITING_USER_CONFIRM',
      understanding: deepRedactSecrets({
        summary: opts.brief.objective ?? name,
        capabilities: opts.harnessSkill?.instructions?.length
          ? opts.harnessSkill.instructions
          : [opts.brief.process ?? '依已確認流程處理測試資料'],
        data_read: opts.harnessSkill?.inputs?.length
          ? opts.harnessSkill.inputs
          : [opts.brief.inputs ?? opts.brief.sources ?? '由使用者提供的測試資料'],
        data_written: opts.harnessSkill?.outputs?.length
          ? opts.harnessSkill.outputs
          : ['只產生草稿；不執行外部寫入'],
        external_calls: opts.harness?.tools?.map((tool) => `${tool.name}:${tool.status}`) ?? [],
        irreversible_actions: [],
        risks: [opts.brief.permissions ?? '不可逆操作一律需人工核准'],
      }) as object,
      executionEnv: 'CLI',
    },
  });

  void opts.createdBy;
  return { id, filePath: dest };
}

export async function authorizeBuilderSession(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  strategy: 'reuse' | 'create';
  targetAgentId?: string;
}): Promise<BuilderMessageResult> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);

  if (row.status !== 'PLAN_READY' && row.status !== 'AWAITING_FDE') {
    // Allow re-authorize only from plan/awaiting states; not after build.
    throw errors.conflict(`Cannot authorize from status=${row.status}`);
  }
  if (!row.plan) throw errors.badRequest('Plan is not ready');

  const plan = asPlan(row.plan);
  if (!plan) throw errors.badRequest('Plan is invalid');

  // MEMBER: request only — no Agent/Skill mutation.
  if (!isFde(opts.role)) {
    if (row.userId !== opts.userId) {
      throw errors.notFound('Session not found');
    }
    const requestedTarget =
      opts.strategy === 'reuse'
        ? opts.targetAgentId ?? plan.reuseCandidates[0]?.agentId ?? null
        : null;
    if (
      opts.strategy === 'reuse' &&
      (!requestedTarget || !plan.reuseCandidates.some((candidate) => candidate.agentId === requestedTarget))
    ) {
      throw errors.badRequest('targetAgentId must be one of the reviewed reuse candidates');
    }
    const assistantMessage =
      '已送交訓練師（FDE）審核授權。在核准前不會建立或修改任何員工／技能。';
    const transcript = pushTranscript(
      asTranscript(row.transcript),
      'assistant',
      assistantMessage,
    );
    if (requestedTarget) {
      await assertBuilderAgentBindingAvailable({
        userId: row.userId,
        agentId: requestedTarget,
        exceptSessionId: row.id,
      });
    }
    const updated = await prisma.agentBuildSession.update({
      where: { id: row.id },
      data: {
        status: 'AWAITING_FDE',
        strategy: opts.strategy,
        targetAgentId: requestedTarget,
        agentId: requestedTarget ?? row.agentId,
        transcript,
        lastAssistantMessage: deepRedactSecrets(assistantMessage),
      },
    });
    await audit(opts.userId, 'agent_builder.awaiting_fde', 'AgentBuildSession', row.id, {
      strategy: opts.strategy,
    });
    return {
      session: toSessionDto(updated),
      assistantMessage,
      status: updated.status,
      progress: asProgress(updated.progress),
    };
  }

  // FDE path: atomically claim the build. Two concurrent approvals must not
  // both pass the stale status check and create duplicate orphan artifacts.
  const claimed = await prisma.agentBuildSession.updateMany({
    where: {
      id: row.id,
      status: { in: ['PLAN_READY', 'AWAITING_FDE'] },
    },
    data: { status: 'BUILDING', strategy: opts.strategy },
  });
  if (claimed.count !== 1) {
    throw errors.conflict('Build is already in progress or no longer awaiting authorization');
  }

  const brief = asBrief(row.brief);
  const latestEvolution = await prisma.agentBuildIteration.findFirst({
    where: { sessionId: row.id, status: 'READY' },
    orderBy: { sequence: 'desc' },
    select: { id: true, artifactSnapshot: true },
  });
  const harness = latestEvolution?.artifactSnapshot as HarnessSnapshot | null;
  const skillBlueprints = harness?.skills?.length
    ? harness.skills.slice(0, 6)
    : [{
        name: plan.proposedSkillName,
        purpose: brief.objective ?? plan.proposedSkillName,
        instructions: [brief.process ?? '依已確認流程處理測試資料'],
        inputs: [brief.inputs ?? brief.sources ?? '由使用者提供'],
        outputs: [brief.outputs ?? '可人工覆核的結果'],
        edgeCases: [brief.exceptions ?? '不確定時停止並詢問'],
        status: 'DRAFT' as const,
      }];
  let builtAgentId: string | null = row.builtAgentId;
  let targetAgentId: string | null = null;
  const draftSkillIds: string[] = [];
  const draftSkillFiles: string[] = [];
  let createdAgentId: string | null = null;

  const makeSkillDrafts = async () => {
    const created: Array<{ id: string; filePath: string }> = [];
    for (const blueprint of skillBlueprints) {
      created.push(await createInertSkillDraft({
        name: blueprint.name || plan.proposedSkillName,
        brief,
        createdBy: opts.userId,
        harness,
        harnessSkill: blueprint,
      }));
    }
    return created;
  };

  try {
    if (opts.strategy === 'reuse') {
      const tid =
        opts.targetAgentId ??
        plan.reuseCandidates[0]?.agentId ??
        row.targetAgentId;
      if (!tid) throw errors.badRequest('targetAgentId is required for reuse strategy');
      if (!plan.reuseCandidates.some((candidate) => candidate.agentId === tid)) {
        throw errors.badRequest('targetAgentId must be one of the reviewed reuse candidates');
      }
      const agent = await prisma.agent.findFirst({ where: { id: tid, deletedAt: null } });
      if (!agent) throw errors.notFound('Target agent not found');
      targetAgentId = agent.id;
      // Do NOT rewrite identity/role/restrictions.

      const skillDrafts = await makeSkillDrafts();
      for (const skillDraft of skillDrafts) {
        const skillId = skillDraft.id;
        draftSkillIds.push(skillId);
        draftSkillFiles.push(skillDraft.filePath);
        await prisma.agentSkill.upsert({
          where: { agentId_skillId: { agentId: agent.id, skillId } },
          create: { agentId: agent.id, skillId },
          update: {},
        });
        await audit(opts.userId, 'agent_builder.reuse_draft_skill', 'Skill', skillId, {
          agentId: agent.id,
          sessionId: row.id,
          iterationId: latestEvolution?.id ?? null,
          reviewStatus: 'AWAITING_USER_CONFIRM',
        });
      }
    } else {
      // create: PAUSED agent + linked inert draft
      const agentId = ulid();
      const name = plan.proposedAgentName.slice(0, 80) || '新 AI 員工';
      const slug = await uniqueAgentSlug(slugify(name));
      const rolePrompt = deepRedactSecrets(
        harness?.agentMarkdown?.trim()
          ? [
              harness.agentMarkdown.trim().slice(0, 60_000),
              harness.claudeMarkdown?.trim()
                ? `\n\n## 外部 Builder 操作備註\n\n${harness.claudeMarkdown.trim().slice(0, 40_000)}`
                : '',
            ].filter(Boolean).join('')
          : [
              `你是「${name}」。`,
              harness?.identity?.purpose
                ? `目標：${harness.identity.purpose}`
                : brief.objective ? `目標：${brief.objective}` : '',
              ...(harness?.identity?.workingStyle?.map((style) => `工作原則：${style}`) ?? []),
              brief.process ? `標準流程：${brief.process}` : '',
              brief.permissions
                ? `權限：${brief.permissions}`
                : '禁止寄信、雲端寫入、Shell、電腦操控；僅草稿。',
              brief.exceptions ? `例外：${brief.exceptions}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
      );

      await prisma.agent.create({
        data: {
          id: agentId,
          slug,
          name,
          description: deepRedactSecrets((brief.objective ?? name).slice(0, 500)),
          department: brief.tags?.includes('finance') ? '財務' : '未分類',
          rolePrompt,
          // Execute ≠ verify enforced at compileManifest; leave verify null = auto opposite.
          engineExecute: 'CLAUDE_CODE',
          engineVerify: null,
          restrictions: { ...BUILDER_LEAST_PRIVILEGE },
          riskTier: 'medium',
          status: 'PAUSED',
          // The FDE approves the build, but the resulting employee belongs to
          // the session owner rather than the approving operator.
          createdBy: row.userId,
        },
      });
      createdAgentId = agentId;
      builtAgentId = agentId;
      targetAgentId = agentId;

      const skillDrafts = await makeSkillDrafts();
      for (const skillDraft of skillDrafts) {
        draftSkillIds.push(skillDraft.id);
        draftSkillFiles.push(skillDraft.filePath);
        await prisma.agentSkill.create({ data: { agentId, skillId: skillDraft.id } });
      }

      await audit(opts.userId, 'agent_builder.created_paused_agent', 'Agent', agentId, {
        sessionId: row.id,
        status: 'PAUSED',
        iterationId: latestEvolution?.id ?? null,
        skillIds: skillDrafts.map((skill) => skill.id),
      });
      for (const skillDraft of skillDrafts) {
        await audit(opts.userId, 'agent_builder.draft_skill', 'Skill', skillDraft.id, {
          agentId,
          sessionId: row.id,
          iterationId: latestEvolution?.id ?? null,
          reviewStatus: 'AWAITING_USER_CONFIRM',
        });
      }
    }
  } catch (e) {
    // Best-effort compensation: a partial build must not leave effective or
    // visible orphan rows. The original error still fails the authorization.
    if (draftSkillIds.length) {
      await prisma.agentSkill.deleteMany({ where: { skillId: { in: draftSkillIds } } }).catch(() => {});
      await prisma.skill.deleteMany({ where: { id: { in: draftSkillIds } } }).catch(() => {});
    }
    if (createdAgentId) {
      await prisma.agent.deleteMany({ where: { id: createdAgentId } }).catch(() => {});
    }
    await Promise.all(draftSkillFiles.map((file) => unlink(file).catch(() => {})));
    // Roll status back so FDE can retry.
    await prisma.agentBuildSession.update({
      where: { id: row.id },
      data: { status: row.status === 'AWAITING_FDE' ? 'AWAITING_FDE' : 'PLAN_READY' },
    });
    throw e;
  }

  // If brief already has test data hint, still require explicit test-data POST
  // (spec: test data mandatory via dedicated endpoint).
  const assistantMessage = [
    opts.strategy === 'create'
      ? `已建立暫停中的 AI 員工草稿「${plan.proposedAgentName}」，並連結待確認技能。`
      : `已在既有員工上新增待確認技能草稿（未改寫員工設定）。`,
    '',
    opts.strategy === 'create'
      ? '技能尚未確認、員工尚未啟用。請提交測試資料後執行試跑。'
      : '新技能尚未確認；既有員工維持原狀。請提交測試資料後執行隔離試跑。',
    plan.gaps.length
      ? `提醒：正式環境仍缺 ${plan.gaps.map((g) => g.label).join('、')}；手動測試可先進行。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);

  const bindId = builtAgentId ?? targetAgentId;
  if (bindId) {
    await assertBuilderAgentBindingAvailable({
      userId: row.userId,
      agentId: bindId,
      exceptSessionId: row.id,
    });
  }

  const updated = await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status: 'AWAITING_TEST_DATA',
      strategy: opts.strategy,
      targetAgentId,
      builtAgentId,
      agentId: bindId,
      draftSkillIds,
      transcript,
      lastAssistantMessage: deepRedactSecrets(assistantMessage),
    },
  });

  return {
    session: toSessionDto(updated),
    assistantMessage,
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}

export async function submitBuilderTestData(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  data: unknown;
  expected: unknown;
}): Promise<BuilderMessageResult> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (row.userId !== opts.userId && !isFde(opts.role)) {
    throw errors.notFound('Session not found');
  }
  if (row.status !== 'AWAITING_TEST_DATA' && row.status !== 'FAILED' && row.status !== 'PASSED') {
    // Allow re-submit after failed/passed to retest; not before build.
    throw errors.conflict(`Cannot submit test data from status=${row.status}`);
  }
  if (!row.draftSkillIds?.length && !row.builtAgentId && !row.targetAgentId) {
    throw errors.badRequest('Session has no built agent/skill yet');
  }

  const contract = await testInputContractForSession(row.id);
  const currentData = parseBuilderTestData(row.testData);
  const data = deepRedactSecrets(
    contract.requirements.length === 1 && contract.requirements[0]?.kind === 'TEXT'
      ? {
          ...currentData,
          manualText: { ...currentData.manualText, [contract.requirements[0].key]: String(opts.data) },
        }
      : opts.data,
  );
  const expected = deepRedactSecrets(opts.expected);
  if (data === undefined || data === null || data === '') {
    throw errors.badRequest('test data is required');
  }
  if (expected === undefined || expected === null || expected === '') {
    throw errors.badRequest('expected result is required');
  }

  const assistantMessage = '已收到測試資料（已遮罩敏感內容）。可以開始試跑。';
  const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);

  const updated = await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      // Stay AWAITING_TEST_DATA until test starts; test endpoint moves to TESTING.
      // If was FAILED/PASSED, return to AWAITING_TEST_DATA for a clean retest.
      status: 'AWAITING_TEST_DATA',
      testData: data as object,
      testExpected: expected as object,
      testResult: Prisma.DbNull,
      draftState: { reply: '', testData: '', testExpected: '' },
      transcript,
      lastAssistantMessage: deepRedactSecrets(assistantMessage),
    },
  });

  await audit(opts.userId, 'agent_builder.test_data', 'AgentBuildSession', row.id, {
    hasData: true,
  });

  return {
    session: toSessionDto(updated),
    assistantMessage,
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}

/** Attach one locally parsed, redacted fixture to the Agent-specific test contract. */
export async function attachBuilderTestFixture(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  requirementKey: string;
  name: string;
  mimeType: string;
  size: number;
  content: string;
}): Promise<BuilderMessageResult> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (!['AWAITING_TEST_DATA', 'FAILED', 'PASSED'].includes(row.status)) {
    throw errors.conflict(`Cannot attach test fixture from status=${row.status}`);
  }
  if (!row.draftSkillIds?.length && !row.builtAgentId && !row.targetAgentId) {
    throw errors.badRequest('Session has no built agent/skill yet');
  }
  const contract = await testInputContractForSession(row.id);
  const requirement = contract.requirements.find((item) => item.key === opts.requirementKey);
  if (!requirement) throw errors.badRequest('Unknown test input requirement');
  if (requirement.kind !== 'FILE') throw errors.badRequest('This test input expects text, not a file');
  try {
    assertFixtureExtension(requirement, opts.name);
  } catch (error) {
    throw errors.badRequest(error instanceof Error ? error.message : 'Unsupported test fixture type');
  }
  if (opts.size <= 0 || opts.size > 10 * 1024 * 1024) {
    throw errors.badRequest('Test fixture must be between 1 byte and 10 MB');
  }
  const redactedContent = deepRedactSecrets(opts.content).slice(0, 60_000);
  if (!redactedContent.trim()) throw errors.badRequest('Test fixture contains no readable text');

  const current = parseBuilderTestData(row.testData);
  const existing = current.fixtures.filter((fixture) => fixture.requirementKey === requirement.key);
  const keep = requirement.maxFiles === 1
    ? current.fixtures.filter((fixture) => fixture.requirementKey !== requirement.key)
    : current.fixtures;
  if (requirement.maxFiles > 1 && existing.length >= requirement.maxFiles) {
    throw errors.badRequest(`${requirement.label}最多只能上傳 ${requirement.maxFiles} 份`);
  }
  const fixture = deepRedactSecrets({
    id: ulid(),
    requirementKey: requirement.key,
    name: path.basename(opts.name).replace(/[\r\n]/g, '').slice(0, 240),
    mimeType: opts.mimeType.slice(0, 160),
    size: opts.size,
    content: redactedContent,
    uploadedAt: new Date().toISOString(),
  });
  const testData = deepRedactSecrets({ ...current, fixtures: [...keep, fixture] });
  const status = getTestInputStatus(contract.requirements, parseBuilderTestData(testData));
  const assistantMessage = status.complete
    ? `已收到「${requirement.label}」，必填測試資料已完整，可以開始隔離試跑。`
    : `已收到「${requirement.label}」，仍需補齊：${status.missingRequiredKeys.join('、')}。`;
  const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);
  const updated = await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status: 'AWAITING_TEST_DATA',
      testData: testData as object,
      testExpected: deepRedactSecrets(contract.expected),
      testResult: Prisma.DbNull,
      transcript,
      lastAssistantMessage: deepRedactSecrets(assistantMessage),
    },
  });
  await audit(opts.userId, 'agent_builder.test_fixture_uploaded', 'AgentBuildSession', row.id, {
    requirementKey: requirement.key,
    name: fixture.name,
    size: fixture.size,
    complete: status.complete,
  });
  return {
    session: toSessionDto(updated),
    assistantMessage,
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}

function compactRunSummary(outcome: RunOutcome, expected: unknown): TestResultDto {
  const productionBlockers: string[] = [];
  // Callers may append blockers from plan gaps after.

  if (!outcome.ok || outcome.status === 'FAILED' || outcome.status === 'CANCELLED') {
    return {
      ok: false,
      status: 'FAILED',
      runId: outcome.runId,
      summary: `試跑未通過（狀態：${outcome.status}${outcome.stoppedAt ? `，停在 ${outcome.stoppedAt}` : ''}）`,
      productionBlockers,
      detail: deepRedactSecrets(
        outcome.results
          .map((r) => `${r.stepKey}:${r.reason ?? (r.ok ? 'ok' : 'fail')}`)
          .join('; ')
          .slice(0, 1500),
      ),
    };
  }
  if (outcome.status === 'AWAITING_REVIEW') {
    return {
      ok: false,
      status: 'FAILED',
      runId: outcome.runId,
      summary: '試跑因需人工核准而中止（視為未通過）。',
      productionBlockers,
    };
  }

  // Any step not approved / with error → FAILED
  const bad = outcome.results.filter(
    (r) => r.ok === false || r.approved === false || r.reason,
  );
  if (bad.length) {
    return {
      ok: false,
      status: 'FAILED',
      runId: outcome.runId,
      summary: '試跑步驟未全部通過驗證。',
      productionBlockers,
      detail: deepRedactSecrets(
        bad.map((b) => `${b.stepKey}:${b.reason ?? b.lastVerdict ?? 'fail'}`).join('; ').slice(0, 1500),
      ),
    };
  }

  // Builder tests must have evidence from the cross-model verifier. A normal
  // chat skipVerify record can never be promoted into a PASSED builder result.
  const unverified = outcome.results.filter(
    (r) =>
      !Array.isArray(r.records) ||
      r.records.length === 0 ||
      r.records.some((record) => /skipVerify|不進行跨模型驗證/i.test(record.verdict ?? '')) ||
      !r.records.some((record) => record.approved === true),
  );
  if (unverified.length) {
    return {
      ok: false,
      status: 'FAILED',
      runId: outcome.runId,
      summary: '試跑沒有取得有效的跨模型驗證證據，已拒絕通過。',
      productionBlockers,
    };
  }

  const expectedText =
    typeof expected === 'string' ? expected.trim() : JSON.stringify(expected ?? '').trim();
  if (!expectedText) {
    return {
      ok: false,
      status: 'FAILED',
      runId: outcome.runId,
      summary: '試跑缺少可驗收的期望結果，已拒絕通過。',
      productionBlockers,
    };
  }
  return {
    ok: true,
    status: 'PASSED',
    runId: outcome.runId,
    summary: '手動測試資料試跑通過（跨模型已逐項核對期望結果）。',
    productionBlockers,
  };
}

export async function runBuilderTest(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  /** Injectable for tests — defaults to real runAgent. */
  runAgentFn?: RunAgentFn;
  /** Fail closed if run exceeds this (ms). */
  timeoutMs?: number;
  /** HTTP path: return TESTING immediately and finish in the background. */
  background?: boolean;
  /** Internal recursion after the background path atomically claimed TESTING. */
  alreadyTesting?: boolean;
  /** Allocated before background dispatch so clients can follow this exact run. */
  runId?: string;
}): Promise<BuilderMessageResult> {
  let row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (row.userId !== opts.userId && !isFde(opts.role)) {
    throw errors.notFound('Session not found');
  }

  const allowedStatus = opts.alreadyTesting
    ? row.status === 'TESTING'
    : row.status === 'AWAITING_TEST_DATA' || row.status === 'FAILED' || row.status === 'PASSED';
  if (!allowedStatus) {
    throw errors.conflict(`Cannot test from status=${row.status}`);
  }
  if (row.testData == null) {
    throw errors.badRequest('Test data is required before running a test');
  }
  const contract = await testInputContractForSession(row.id);
  const inputStatus = getTestInputStatus(contract.requirements, parseBuilderTestData(row.testData));
  if (!inputStatus.complete) {
    const missingLabels = inputStatus.requirements
      .filter((item) => inputStatus.missingRequiredKeys.includes(item.key))
      .map((item) => item.label);
    throw errors.badRequest(`Required test data is incomplete: ${missingLabels.join('、')}`);
  }

  const agentId = row.builtAgentId ?? row.targetAgentId;
  if (!agentId) throw errors.badRequest('No agent available for test');

  const agent = await prisma.agent.findFirst({ where: { id: agentId, deletedAt: null } });
  if (!agent) throw errors.notFound('Agent not found for test');
  const plannedRunId = opts.runId ?? ulid();

  if (!opts.alreadyTesting) {
    const claimed = await prisma.agentBuildSession.updateMany({
      where: {
        id: row.id,
        status: { in: ['AWAITING_TEST_DATA', 'FAILED', 'PASSED'] },
      },
      data: { status: 'TESTING', lastRunId: plannedRunId },
    });
    if (claimed.count !== 1) throw errors.conflict('Test is already running');
    row = (await prisma.agentBuildSession.findUnique({ where: { id: row.id } }))!;
  }

  if (opts.background) {
    const assistantMessage = '試跑已開始；完成後會自動更新結果。';
    const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);
    const started = await prisma.agentBuildSession.update({
      where: { id: row.id },
      data: { transcript, lastAssistantMessage: assistantMessage },
    });
    void runBuilderTest({
      ...opts,
      background: false,
      alreadyTesting: true,
      runId: plannedRunId,
    }).catch(async (e) => {
      const detail = deepRedactSecrets(e instanceof Error ? e.message : String(e));
      const testResult: TestResultDto = {
        ok: false,
        status: 'FAILED',
        summary: '試跑工作中斷，請重新嘗試。',
        productionBlockers: productionBlockersFromPlan(asPlan(row.plan)),
        detail,
      };
      await prisma.agentBuildSession.updateMany({
        where: { id: row.id, status: 'TESTING', updatedAt: started.updatedAt },
        data: {
          status: 'FAILED',
          testResult: deepRedactSecrets(testResult) as object,
          lastAssistantMessage: testResult.summary,
        },
      }).catch(() => {});
    });
    return {
      session: toSessionDto(started),
      assistantMessage,
      status: started.status,
      progress: asProgress(started.progress),
    };
  }

  // A five-round cross-model run can legitimately exceed eight minutes on a
  // local subscription-backed CLI. Keep a hard fail-closed ceiling, but leave
  // enough room for execute + verify + rework to finish and persist its real
  // verdict instead of replacing it with a misleading timeout.
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const runAgentFn =
    opts.runAgentFn ??
    (async (o: RunAgentOptions) => {
      const { runAgent } = await import('../engine/runner.js');
      return runAgent(o);
    });

  const fixtureMessage = deepRedactSecrets(
    [
      '【Agent Builder 試跑】請依技能流程處理以下測試資料，並對照期望結果。',
      '',
      '## 測試資料',
      typeof row.testData === 'string' ? row.testData : JSON.stringify(row.testData, null, 2),
      '',
      '## 期望結果',
      typeof row.testExpected === 'string'
        ? row.testExpected
        : JSON.stringify(row.testExpected, null, 2),
    ].join('\n'),
  );

  let outcome: RunOutcome;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  try {
    const runPromise = runAgentFn({
      runId: plannedRunId,
      agentId,
      forceVerify: true,
      builderTestSessionId: row.id,
      input: {
        message: fixtureMessage,
        builderTest: true,
        testData: row.testData as object,
        expected: row.testExpected as object,
      },
      triggeredBy: opts.userId,
      signal: abortController.signal,
    });

    outcome = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort(new Error('builder test timeout'));
          reject(new Error('builder test timeout'));
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    const detail = deepRedactSecrets(e instanceof Error ? e.message : String(e));
    const testResult: TestResultDto = {
      ok: false,
      status: 'FAILED',
      summary: `試跑失敗：${detail}`,
      productionBlockers: productionBlockersFromPlan(asPlan(row.plan)),
      detail,
    };
    const assistantMessage = testResult.summary;
    const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);
    const failed = await prisma.agentBuildSession.updateMany({
      where: { id: row.id, status: 'TESTING' },
      data: {
        status: 'FAILED',
        testResult: deepRedactSecrets(testResult) as object,
        transcript,
        lastAssistantMessage: deepRedactSecrets(assistantMessage),
      },
    });
    const updated = (await prisma.agentBuildSession.findUnique({ where: { id: row.id } }))!;
    if (failed.count === 1) {
      await audit(opts.userId, 'agent_builder.test_failed', 'AgentBuildSession', row.id, {
        reason: detail.slice(0, 200),
      });
    }
    return {
      session: toSessionDto(updated),
      assistantMessage:
        failed.count === 1
          ? assistantMessage
          : updated.lastAssistantMessage ?? '逾時測試結果已捨棄。',
      status: updated.status,
      progress: asProgress(updated.progress),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  let testResult = compactRunSummary(outcome, row.testExpected);
  testResult.productionBlockers = productionBlockersFromPlan(asPlan(row.plan));
  if (testResult.ok && testResult.productionBlockers.length) {
    testResult = {
      ...testResult,
      summary:
        testResult.summary +
        ` 正式上線仍被阻擋：${testResult.productionBlockers.join('、')}。`,
    };
  }
  testResult = deepRedactSecrets(testResult);

  const status: AgentBuildSessionStatus = testResult.ok ? 'PASSED' : 'FAILED';
  const assistantMessage = testResult.ok
    ? `試跑通過。${testResult.productionBlockers.length ? `注意：${testResult.productionBlockers.join('；')}` : '可由 FDE 最終啟用。'}`
    : `試跑未通過：${testResult.summary}`;

  const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);

  const committed = await prisma.agentBuildSession.updateMany({
    where: { id: row.id, status: 'TESTING' },
    data: {
      status,
      testResult: testResult as object,
      lastRunId: outcome.runId,
      transcript,
      lastAssistantMessage: deepRedactSecrets(assistantMessage),
    },
  });
  const updated = (await prisma.agentBuildSession.findUnique({ where: { id: row.id } }))!;

  if (committed.count === 1) {
    await audit(
      opts.userId,
      testResult.ok ? 'agent_builder.test_passed' : 'agent_builder.test_failed',
      'AgentBuildSession',
      row.id,
      { runId: outcome.runId, status },
    );
  }

  return {
    session: toSessionDto(updated),
    assistantMessage:
      committed.count === 1
        ? assistantMessage
        : updated.lastAssistantMessage ?? '逾時測試結果已捨棄。',
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}

function productionBlockersFromPlan(plan: PlanDto | null): string[] {
  if (!plan) return [];
  return (plan.gaps ?? []).map((g) => g.label);
}

export async function finalizeBuilderSession(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
}): Promise<BuilderMessageResult> {
  if (!isFde(opts.role)) {
    throw errors.forbidden('Only FDE (OWNER/TRAINER) may finalize');
  }

  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);

  // Fail-closed: must be PASSED with a real test result.
  if (row.status !== 'PASSED') {
    throw errors.conflict(`Finalize requires PASSED (status=${row.status})`);
  }
  const tr = asTestResult(row.testResult);
  if (!tr || tr.status !== 'PASSED' || !tr.ok) {
    throw errors.conflict('Finalize requires a PASSED test result');
  }
  if (!row.lastRunId || tr.runId !== row.lastRunId) {
    throw errors.conflict('Finalize requires the latest persisted test run');
  }
  const persistedRun = await prisma.run.findUnique({
    where: { id: row.lastRunId },
    include: { steps: true },
  });
  const expectedAgentId = row.builtAgentId ?? row.targetAgentId;
  // A step may have rejected early rounds before a later approved repair.
  // Finalization checks the latest persisted row for every stepKey, not every
  // historical attempt and not merely "some approved row".
  const latestStepByKey = new Map<string, NonNullable<typeof persistedRun>['steps'][number]>();
  for (const step of persistedRun?.steps ?? []) {
    const previous = latestStepByKey.get(step.stepKey);
    if (
      !previous ||
      step.startedAt.getTime() > previous.startedAt.getTime() ||
      (step.startedAt.getTime() === previous.startedAt.getTime() && step.round > previous.round)
    ) {
      latestStepByKey.set(step.stepKey, step);
    }
  }
  const verifiedEvidence =
    latestStepByKey.size > 0 &&
    [...latestStepByKey.values()].every(
      (step) =>
      step.approved === true &&
      typeof step.verdict === 'string' &&
      step.verdict.trim().length > 0 &&
      !/skipVerify|不進行跨模型驗證/i.test(step.verdict),
    );
  const persistedInput =
    persistedRun?.input && typeof persistedRun.input === 'object' && !Array.isArray(persistedRun.input)
      ? (persistedRun.input as Record<string, unknown>)
      : {};
  const rawEvidence = persistedInput.builderTestEvidence;
  const builderEvidence =
    rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
      ? (rawEvidence as Record<string, unknown>)
      : null;
  const evidenceDraftIds = Array.isArray(builderEvidence?.draftSkillIds)
    ? builderEvidence.draftSkillIds.filter((id): id is string => typeof id === 'string')
    : [];
  const expectedDraftIds = [...(row.draftSkillIds ?? [])].sort();
  const evidenceMatches =
    builderEvidence?.sessionId === row.id &&
    JSON.stringify([...evidenceDraftIds].sort()) === JSON.stringify(expectedDraftIds);
  if (
    persistedRun?.status !== 'SUCCEEDED' ||
    persistedRun.agentId !== expectedAgentId ||
    !verifiedEvidence ||
    !evidenceMatches
  ) {
    throw errors.conflict('Finalize requires persisted cross-model verification evidence');
  }

  const draftIds = row.draftSkillIds ?? [];
  if (!draftIds.length) {
    throw errors.badRequest('No builder-owned draft skills to confirm');
  }

  const { confirmAwaitingSkill } = await import('./skillgate.js');
  const latestReadyIteration = await prisma.agentBuildIteration.findFirst({
    where: { sessionId: row.id, status: 'READY' },
    orderBy: { sequence: 'desc' },
    select: { artifactSnapshot: true },
  });
  const finalHarness = latestReadyIteration?.artifactSnapshot as HarnessSnapshot | null;
  const assistantMessage = '已完成最終確認：技能已確認，員工已啟用（若為新建）。';
  const transcript = pushTranscript(asTranscript(row.transcript), 'assistant', assistantMessage);

  // Atomic claim prevents two FDE requests from confirming/activating the same
  // session concurrently. State mutations then commit in one DB transaction.
  const claimed = await prisma.agentBuildSession.updateMany({
    where: { id: row.id, status: 'PASSED', lastRunId: row.lastRunId },
    data: { status: 'BUILDING' },
  });
  if (claimed.count !== 1) throw errors.conflict('Finalize is already in progress');

  let updated: typeof row;
  let activatedAgentId: string | null = null;
  let materializedAgentId: string | null = expectedAgentId ?? null;
  let importedWorkflowIds: string[] = [];
  try {
    updated = await prisma.$transaction(async (tx) => {
      for (const skillId of draftIds) {
        const skill = await tx.skill.findFirst({ where: { id: skillId, deletedAt: null } });
        if (!skill) throw errors.notFound(`Draft skill not found: ${skillId}`);
        if (skill.generator !== 'agent-builder') {
          throw errors.conflict(`Skill ${skillId} is not owned by Agent Builder`);
        }
        if (skill.reviewStatus !== 'CONFIRMED') {
          if (skill.reviewStatus !== 'AWAITING_USER_CONFIRM') {
            throw errors.conflict(
              `Skill ${skillId} is not awaiting confirmation (status=${skill.reviewStatus})`,
            );
          }
          await confirmAwaitingSkill(skillId, opts.userId, { client: tx });
        }
      }

      if (row.strategy === 'create' && row.builtAgentId) {
        const agent = await tx.agent.findFirst({
          where: { id: row.builtAgentId, deletedAt: null },
        });
        if (!agent) throw errors.notFound('Built agent not found');
        if (agent.status !== 'ACTIVE') {
          await tx.agent.update({ where: { id: agent.id }, data: { status: 'ACTIVE' } });
          activatedAgentId = agent.id;
        }
      }

      if (materializedAgentId) {
        importedWorkflowIds = await createExternalBuilderWorkflows(tx, {
          agentId: materializedAgentId,
          harness: finalHarness,
        });
      }

      return tx.agentBuildSession.update({
        where: { id: row.id },
        data: {
          status: 'ACTIVE',
          transcript,
          lastAssistantMessage: deepRedactSecrets(assistantMessage),
          draftState: { reply: '', testData: '', testExpected: '' },
        },
      });
    });
  } catch (e) {
    await prisma.agentBuildSession.updateMany({
      where: { id: row.id, status: 'BUILDING' },
      data: { status: 'PASSED' },
    });
    throw e;
  }

  for (const skillId of draftIds) {
    await audit(opts.userId, 'agent_builder.skill_confirmed', 'Skill', skillId, {
      sessionId: row.id,
    });
  }
  if (activatedAgentId) {
    await audit(opts.userId, 'agent_builder.agent_activated', 'Agent', activatedAgentId, {
      sessionId: row.id,
    });
  }

  if (materializedAgentId) {
    await materializeExternalBuilderFiles({
      agentId: materializedAgentId,
      userId: opts.userId,
      sessionId: row.id,
      harness: finalHarness,
      workflowIds: importedWorkflowIds,
    }).catch(async (error) => {
      await audit(opts.userId, 'agent_builder.external_materialize_failed', 'Agent', materializedAgentId!, {
        sessionId: row.id,
        error: String(deepRedactSecrets(error instanceof Error ? error.message : String(error))).slice(0, 800),
      }).catch(() => {});
    });
  }

  await audit(opts.userId, 'agent_builder.finalized', 'AgentBuildSession', row.id, {
    strategy: row.strategy,
    builtAgentId: row.builtAgentId,
    draftSkillIds: draftIds,
    importedWorkflowIds,
  });
  await enqueueBuilderSelfReflectionSafe(row.id);

  return {
    session: toSessionDto(updated),
    assistantMessage,
    status: updated.status,
    progress: asProgress(updated.progress),
  };
}
