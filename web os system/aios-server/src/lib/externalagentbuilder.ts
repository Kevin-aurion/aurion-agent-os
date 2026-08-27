// External Agent Builder ingress for Claude, ChatGPT, Codex and Cursor.
//
// MCP clients can synchronize exact transcript turns, parsed source files and a
// complete draft artifact. All writes are owner-scoped and deep-redacted. A new
// conversation gets an immediately usable least-privilege Agent container, but
// external clients can never approve Skills, enable tools, or activate elevated
// Workflow/MCP capabilities through these functions.
import path from 'node:path';
import { ulid } from 'ulid';
import { Prisma, PrismaClient, type AgentBuildIteration, type AgentBuildSession, type AgentBuildSessionStatus, type UserRole } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { sha256 } from './crypto.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { hub } from '../ws/hub.js';
import {
  assertBuilderAgentBindingAvailable,
  buildCapabilityPlan,
  buildProgress,
  getBuilderSession,
  inferFromPrompt,
  loadOwnedSession,
  toSessionDto,
  type Brief,
  type SessionDto,
  type TranscriptEntry,
} from './agentbuilder.js';
import {
  createBuilderEvolutionIteration,
  toIterationDto,
  type DecisionGraph,
  type EvolutionChange,
  type HarnessSnapshot,
  type IterationDto,
} from './agentbuilderevolution.js';
import {
  inferTestInputRequirements,
  normalizeTestInputRequirements,
  type BuilderTestInputRequirement,
} from './buildertestinputs.js';
import { createBuilderWorkingAgent } from './builderworkingagent.js';

export type ExternalBuilderSource = 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CHATGPT' | 'CURSOR' | 'OTHER';

export type ExternalTurn = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ExternalArtifactInput = {
  identity: {
    name: string;
    purpose: string;
    workingStyle?: string[];
  };
  agentMarkdown?: string;
  claudeMarkdown?: string;
  skills?: Array<{
    name: string;
    purpose?: string;
    instructions?: string[];
    inputs?: string[];
    outputs?: string[];
    edgeCases?: string[];
    contentMd?: string;
  }>;
  memory?: {
    facts?: string[];
    preferences?: string[];
    glossary?: string[];
    documents?: Array<{ path: string; contentMd: string; purpose?: string }>;
  };
  tools?: Array<{
    name: string;
    purpose?: string;
    status?: 'AVAILABLE' | 'NEEDS_FDE' | 'NOT_NEEDED';
  }>;
  policies?: {
    allowed?: string[];
    requiresApproval?: string[];
    forbidden?: string[];
  };
  tests?: Array<{ name: string; input: string; expected: string }>;
  testInputRequirements?: Array<Partial<BuilderTestInputRequirement> & Pick<BuilderTestInputRequirement, 'key' | 'label' | 'kind' | 'required'>>;
  workflows?: Array<{
    name: string;
    description?: string;
    trigger?: Record<string, unknown>;
    durable?: boolean;
    steps?: Array<{
      stepKey: string;
      type: 'DO' | 'TOOL' | 'AGENT' | 'CONDITION' | 'NOTIFY' | 'COMPUTER_CONTROL';
      config?: Record<string, unknown>;
      verifyRubric?: string | null;
      onFail?: Record<string, unknown> | null;
    }>;
  }>;
  understanding?: Partial<DecisionGraph>;
  changes?: EvolutionChange[];
  userSummary?: string;
  fdeSummary?: string;
};

export type ExternalStopGuardResult = {
  matched: boolean;
  sessionId?: string;
  status?: AgentBuildSessionStatus;
  userMessageSynced?: boolean;
  finalMessageSynced?: boolean;
  artifactFresh?: boolean;
  backgroundBuildQueued?: boolean;
  /** A completed user/assistant pair queued a non-effective Shadow Skill reflection. */
  reflectionQueued?: boolean;
  created?: boolean;
  systemMessage?: string;
};

export type ExternalPromptHookResult = {
  matched: boolean;
  sessionId?: string;
  status?: AgentBuildSessionStatus;
  created?: boolean;
  userMessageSynced?: boolean;
  backgroundBuildQueued?: boolean;
  additionalContext?: string;
};

const MAX_TRANSCRIPT_ENTRIES = 1_000;
const MAX_MEMORY_DOCUMENTS = 24;
const MAX_WORKFLOWS = 12;

/** Internal compiler/test prompts must never recursively open a Builder session. */
const AGENT_BUILD_INTERNAL_RE =
  /(?:^|\n)\s*(?:你是\s*AIOS\s*的「員工演進建築師」|你是企業\s*AI\s*員工的\s*Grill\s*訪談顧問)|【Agent Builder 試跑】|Harness\s*是\s*shadow draft|輸出純\s*JSON[^\n]{0,160}(?:understanding|harness|suggestTest)/iu;
/** Execution / schedule instructions must never open a new Agent Builder session. */
const AGENT_BUILD_EXECUTION_RE =
  /(?:^|\n)\s*(?:執行|跑一次|立即執行|現在是|凌晨\s*\d)|(?:每日|每週|每月)\s*(?:自我)?(?:執行|進化|排程)|cron|【步驟\s*\d】|```bash/iu;
/** Explicit refusal/discussion of creation is not permission to create anything. */
const AGENT_BUILD_NEGATED_RE =
  /(?:不要|不需要|無需|毋須|禁止|別)\s*.{0,18}(?:建立|新增|打造|訓練|教會|建置|create|build|train|teach|design)\s*.{0,24}(?:AI(?:OS)?\s*(?:員工|助理|代理)|agent|bot|機器人|技能|skill)/iu;
/** Architecture/research requests often quote build examples but ask only for analysis. */
const AGENT_BUILD_META_ONLY_RE =
  /(?:幫我|請你|麻煩你).{0,24}(?:分析|研究|評估|瞭解|了解|閱讀|檢查).{0,120}(?:系統|程式碼|架構|現況|問題).{0,240}(?:報告|規劃|建議|看法)/iu;
// English tokens must be complete words. Matching `build` inside the product
// noun `Builder` / `agentbuilder` causes unrelated coding chats (edit a .ts
// file, `npm run build` in an agent package) to look like Agent-build intent.
// Chinese verbs/nouns are unaffected by `\b`.
export const AGENT_BUILD_ACTION_RE =
  /建立|新增|打造|訓練|教會|建置|\b(?:create|build|train|teach|design)\b/i;
export const AGENT_BUILD_OBJECT_RE =
  /AI(?:OS)?\s*(?:員工|助理|代理)|\bagent\b|\bbot\b|機器人|技能|\bskill\b/i;
/** Locative English prepositions: `build in the agent package` is a compile, not a hire. */
const ENGLISH_LOCATIVE_RE = /\b(?:in|on|at|into|onto|within|inside|from|via|through|of)\b/i;

export const AGENT_BUILD_CONFIRM_START_HINT =
  '偵測到可能的建置意圖，請與使用者確認後呼叫 start_agent_build';

function isPureEnglishToken(value: string): boolean {
  return /^[a-z]+$/i.test(value);
}

function englishActionObjectIsLocative(text: string, action: RegExpMatchArray, object: RegExpMatchArray): boolean {
  if (!isPureEnglishToken(action[0] ?? '') || !isPureEnglishToken(object[0] ?? '')) return false;
  const actionEnd = (action.index ?? 0) + action[0].length;
  const objectStart = object.index ?? 0;
  if (actionEnd > objectStart) return false;
  return ENGLISH_LOCATIVE_RE.test(text.slice(actionEnd, objectStart));
}

function pairsIndicateBuildIntent(text: string, maxGap?: number): boolean {
  const actions = [...text.matchAll(new RegExp(AGENT_BUILD_ACTION_RE.source, 'gi'))];
  const objects = [...text.matchAll(new RegExp(AGENT_BUILD_OBJECT_RE.source, 'gi'))];
  for (const action of actions) {
    const actionStart = action.index ?? 0;
    const actionEnd = actionStart + action[0].length;
    for (const object of objects) {
      const objectStart = object.index ?? 0;
      const objectEnd = objectStart + object[0].length;
      const gap = actionEnd <= objectStart
        ? objectStart - actionEnd
        : objectEnd <= actionStart
          ? actionStart - objectEnd
          : 0;
      if (maxGap !== undefined && gap > maxGap) continue;
      if (englishActionObjectIsLocative(text, action, object)) continue;
      return true;
    }
  }
  return false;
}

function sentenceHasBuildIntent(sentence: string): boolean {
  return pairsIndicateBuildIntent(sentence);
}

function nearbyBuildIntent(text: string, maxGap = 24): boolean {
  return pairsIndicateBuildIntent(text, maxGap);
}

/** Conservative hook activation: unrelated Claude Code chats must remain no-op. */
export function isExplicitAgentBuildPrompt(prompt: string): boolean {
  const normalized = cleanString(prompt, 12_000);
  if (!normalized) return false;
  if (AGENT_BUILD_INTERNAL_RE.test(normalized)) return false;
  if (AGENT_BUILD_EXECUTION_RE.test(normalized)) return false;
  if (AGENT_BUILD_NEGATED_RE.test(normalized)) return false;
  if (AGENT_BUILD_META_ONLY_RE.test(normalized)) return false;
  const sentences = normalized.split(/[。！？!?\n]+/).filter((sentence) => sentence.trim());
  if (sentences.some(sentenceHasBuildIntent)) return true;
  return nearbyBuildIntent(normalized);
}

function isFde(role: UserRole | string): boolean {
  return role === 'OWNER' || role === 'TRAINER';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTranscript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is TranscriptEntry => {
    const row = asObject(entry);
    return (
      row != null &&
      ['user', 'assistant', 'system'].includes(String(row.role)) &&
      typeof row.content === 'string'
    );
  });
}

function asBrief(value: unknown): Brief {
  return (asObject(value) ?? {}) as Brief;
}

function cleanString(value: unknown, maxLength: number): string {
  return String(deepRedactSecrets(String(value ?? ''))).trim().slice(0, maxLength);
}

function cleanStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeMemoryPath(raw: string): string {
  let candidate = raw.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  candidate = path.posix.normalize(candidate);
  if (!candidate || candidate === '.' || candidate.includes('\0')) {
    throw errors.badRequest('Memory document path is invalid');
  }
  if (candidate === '..' || candidate.startsWith('../') || candidate.includes('/../')) {
    throw errors.badRequest('Memory document path escapes the agent memory folder');
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw errors.badRequest('Memory document path contains an unsafe segment');
  }
  if (!candidate.toLowerCase().endsWith('.md')) candidate += '.md';
  if (candidate.length > 240) throw errors.badRequest('Memory document path is too long');
  return candidate;
}

function normalizeTrigger(value: unknown): Record<string, unknown> {
  const raw = asObject(value) ?? {};
  const type = ['schedule', 'manual', 'keyword', 'webhook', 'event'].includes(String(raw.type))
    ? String(raw.type)
    : 'manual';
  const trigger: Record<string, unknown> = { ...raw, type };
  // External clients may describe a webhook, but can never import a plaintext secret.
  delete trigger.secret;
  if (typeof trigger.cron === 'string') trigger.cron = trigger.cron.slice(0, 160);
  if (Array.isArray(trigger.keywords)) {
    trigger.keywords = cleanStrings(trigger.keywords, 30, 120);
  }
  return deepRedactSecrets(trigger) as Record<string, unknown>;
}

function normalizeHarness(
  input: ExternalArtifactInput,
  source: ExternalBuilderSource,
  externalEventId: string,
): HarnessSnapshot {
  const name = cleanString(input.identity?.name, 120) || '待命名 AI 員工';
  const purpose = cleanString(input.identity?.purpose, 1_500) || '依使用者對話持續建立中的 AI 員工';
  const skills = (input.skills ?? []).slice(0, 12).map((skill, index) => ({
    name: cleanString(skill.name, 120) || `技能 ${index + 1}`,
    purpose: cleanString(skill.purpose, 1_200) || purpose,
    instructions: cleanStrings(skill.instructions, 30, 1_200),
    inputs: cleanStrings(skill.inputs, 20, 600),
    outputs: cleanStrings(skill.outputs, 20, 600),
    edgeCases: cleanStrings(skill.edgeCases, 20, 800),
    contentMd: skill.contentMd ? cleanString(skill.contentMd, 60_000) : undefined,
    status: 'DRAFT' as const,
  }));
  if (!skills.length) {
    skills.push({
      name: `${name}核心能力`,
      purpose,
      instructions: ['依目前已確認需求處理；不確定時先向使用者確認。'],
      inputs: ['使用者明確提供的資料'],
      outputs: ['可人工覆核的結果草稿'],
      edgeCases: ['資料不足、規則衝突或需外部寫入時停止並要求確認。'],
      contentMd: undefined,
      status: 'DRAFT',
    });
  }

  const documents = (input.memory?.documents ?? []).slice(0, MAX_MEMORY_DOCUMENTS).map((document) => ({
    path: safeMemoryPath(document.path),
    contentMd: cleanString(document.contentMd, 40_000),
    purpose: document.purpose ? cleanString(document.purpose, 500) : undefined,
  })).filter((document) => document.contentMd);

  const workflows = (input.workflows ?? []).slice(0, MAX_WORKFLOWS).map((workflow, workflowIndex) => {
    const seenKeys = new Set<string>();
    const steps = (workflow.steps ?? []).slice(0, 40).map((step, stepIndex) => {
      let stepKey = cleanString(step.stepKey, 100)
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `step-${stepIndex + 1}`;
      while (seenKeys.has(stepKey)) stepKey = `${stepKey}-${stepIndex + 1}`;
      seenKeys.add(stepKey);
      return {
        stepKey,
        type: step.type,
        config: deepRedactSecrets(asObject(step.config) ?? {}) as Record<string, unknown>,
        verifyRubric: step.verifyRubric == null ? null : cleanString(step.verifyRubric, 2_000),
        onFail: step.onFail == null
          ? null
          : deepRedactSecrets(asObject(step.onFail) ?? {}) as Record<string, unknown>,
      };
    });
    return {
      name: cleanString(workflow.name, 160) || `工作流程 ${workflowIndex + 1}`,
      description: cleanString(workflow.description, 1_200),
      trigger: normalizeTrigger(workflow.trigger),
      durable: workflow.durable === true,
      steps,
    };
  });

  const requestedTools = (input.tools ?? []).slice(0, 30).map((tool) => ({
    name: cleanString(tool.name, 180),
    purpose: cleanString(tool.purpose, 800),
    // Never trust a desktop model's assertion that a connection or permission exists.
    status: tool.status === 'NOT_NEEDED' ? 'NOT_NEEDED' as const : 'NEEDS_FDE' as const,
  })).filter((tool) => tool.name);

  const requiredApprovals = new Set([
    ...cleanStrings(input.policies?.requiresApproval, 30, 800),
    '寄信、雲端寫入、電腦操作、Shell、付款、刪除與其他不可逆動作',
    '新增或修改 Agent、Skill、Workflow、工具連線與權限後的正式生效',
  ]);
  const testIdeas = (input.tests ?? []).slice(0, 20).map((test, index) => ({
    name: cleanString(test.name, 180) || `測試 ${index + 1}`,
    input: cleanString(test.input, 5_000),
    expected: cleanString(test.expected, 5_000),
  })).filter((test) => test.input && test.expected);
  const explicitTestInputs = normalizeTestInputRequirements(input.testInputRequirements);

  return deepRedactSecrets({
    identity: {
      name,
      purpose,
      workingStyle: cleanStrings(input.identity?.workingStyle, 20, 800),
    },
    agentMarkdown: input.agentMarkdown ? cleanString(input.agentMarkdown, 60_000) : undefined,
    claudeMarkdown: input.claudeMarkdown ? cleanString(input.claudeMarkdown, 60_000) : undefined,
    skills,
    memory: {
      facts: cleanStrings(input.memory?.facts, 60, 1_200),
      preferences: cleanStrings(input.memory?.preferences, 40, 1_200),
      glossary: cleanStrings(input.memory?.glossary, 60, 600),
      documents,
    },
    tools: requestedTools,
    policies: {
      allowed: cleanStrings(input.policies?.allowed, 30, 800),
      requiresApproval: [...requiredApprovals],
      forbidden: cleanStrings(input.policies?.forbidden, 30, 800),
    },
    testIdeas,
    testInputRequirements: explicitTestInputs.length > 0
      ? explicitTestInputs
      : inferTestInputRequirements({ identityName: name, skills, testIdeas }),
    workflows,
    provenance: {
      source,
      externalEventId: cleanString(externalEventId, 160),
      syncedAt: new Date().toISOString(),
    },
  }) as HarnessSnapshot;
}

function normalizeDecisionGraph(input: ExternalArtifactInput, harness: HarnessSnapshot): DecisionGraph {
  const raw = input.understanding ?? {};
  const facts = Array.isArray(raw.facts)
    ? raw.facts.slice(0, 40).map((fact) => ({
        statement: cleanString(fact.statement, 1_200),
        source: cleanString(fact.source, 240) || '外部 Builder 同步',
      })).filter((fact) => fact.statement)
    : harness.memory.facts.map((statement) => ({ statement, source: '同步記憶草稿' }));
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.slice(0, 40).map((decision) => ({
        topic: cleanString(decision.topic, 240),
        decision: cleanString(decision.decision, 1_500),
        status: ['provisional', 'confirmed', 'revised'].includes(String(decision.status))
          ? decision.status as 'provisional' | 'confirmed' | 'revised'
          : 'provisional' as const,
      })).filter((decision) => decision.topic && decision.decision)
    : harness.skills.map((skill) => ({
        topic: `技能：${skill.name}`,
        decision: skill.purpose,
        status: 'provisional' as const,
      }));
  return deepRedactSecrets({
    northStar: cleanString(raw.northStar, 1_500) || harness.identity.purpose,
    painPoints: cleanStrings(raw.painPoints, 20, 1_000),
    facts,
    hypotheses: Array.isArray(raw.hypotheses)
      ? raw.hypotheses.slice(0, 20).map((hypothesis) => ({
          statement: cleanString(hypothesis.statement, 1_000),
          confidence: ['low', 'medium', 'high'].includes(String(hypothesis.confidence))
            ? hypothesis.confidence as 'low' | 'medium' | 'high'
            : 'medium' as const,
        })).filter((hypothesis) => hypothesis.statement)
      : [],
    decisions,
    openBranches: Array.isArray(raw.openBranches)
      ? raw.openBranches.slice(0, 20).map((branch) => ({
          topic: cleanString(branch.topic, 240),
          whyItMatters: cleanString(branch.whyItMatters, 1_000),
          recommendation: cleanString(branch.recommendation, 1_000),
        })).filter((branch) => branch.topic && branch.whyItMatters)
      : [],
    contradictions: cleanStrings(raw.contradictions, 20, 1_000),
    confidence: Math.max(0, Math.min(100, Number(raw.confidence ?? 70) || 70)),
  }) as DecisionGraph;
}

function defaultChanges(input: ExternalArtifactInput, previous: AgentBuildIteration | null): EvolutionChange[] {
  const changes: EvolutionChange[] = [
    {
      area: 'identity',
      action: previous ? 'updated' : 'added',
      summary: `${input.identity.name} 的身份與工作方式已同步`,
      reason: '外部 Agent Builder 提交完整草稿。',
    },
  ];
  if (input.skills?.length) changes.push({
    area: 'skill',
    action: previous ? 'updated' : 'added',
    summary: `同步 ${input.skills.length} 個技能草稿`,
    reason: '保留 Claude／Cursor 已整理的 SKILL.md 與能力說明。',
  });
  if (input.memory?.facts?.length || input.memory?.documents?.length) changes.push({
    area: 'memory',
    action: previous ? 'updated' : 'added',
    summary: '同步工作記憶與記憶文件草稿',
    reason: '讓後續版本可追溯已確認的事實與偏好。',
  });
  if (input.workflows?.length) changes.push({
    area: 'workflow',
    action: previous ? 'updated' : 'added',
    summary: `同步 ${input.workflows.length} 個工作流程草稿`,
    reason: '流程只進入審核草稿，尚未啟用。',
  });
  if (input.tests?.length) changes.push({
    area: 'test',
    action: previous ? 'updated' : 'added',
    summary: `同步 ${input.tests.length} 個測試案例`,
    reason: '作為 FDE 建立後的試跑候選資料。',
  });
  return changes;
}

function mergeInferredBrief(current: Brief, userText: string): Brief {
  if (!userText.trim()) return current;
  const inferred = inferFromPrompt(userText).brief;
  return deepRedactSecrets({
    ...current,
    ...Object.fromEntries(Object.entries(inferred).filter(([, value]) => value != null && value !== '')),
    sourceFiles: current.sourceFiles ?? [],
    externalSource: current.externalSource,
    externalConversationId: current.externalConversationId,
    externalConversationTitle: current.externalConversationTitle,
  }) as Brief;
}

type BuilderDb = PrismaClient | Prisma.TransactionClient;
type ResolvedBuilderSession = AgentBuildSession & { iterations: AgentBuildIteration[] };

const BUILDER_SESSION_INCLUDE = {
  iterations: { orderBy: { sequence: 'desc' as const }, take: 100 },
};

/**
 * Two-phase builder session key:
 * 1. Once bound to an employee, (userId, agentId) always wins.
 * 2. Before that, (userId, externalSource, externalConversationId) is the identity.
 */
export async function resolveBuilderSession(
  opts: {
    userId: string;
    agentId?: string;
    externalSource?: string;
    externalConversationId?: string;
  },
  db: BuilderDb = prisma,
): Promise<ResolvedBuilderSession | null> {
  if (opts.agentId) {
    const byAgent = await db.agentBuildSession.findFirst({
      where: {
        userId: opts.userId,
        agentId: opts.agentId,
        status: { not: 'ABANDONED' },
      },
      orderBy: { updatedAt: 'desc' },
      include: BUILDER_SESSION_INCLUDE,
    });
    if (byAgent) return byAgent;
  }
  const conversationId = opts.externalConversationId?.trim();
  if (conversationId) {
    const source = opts.externalSource?.trim();
    const byExternal = await db.agentBuildSession.findFirst({
      where: {
        userId: opts.userId,
        externalConversationId: conversationId,
        status: { not: 'ABANDONED' },
        ...(source ? { externalSource: source } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      include: BUILDER_SESSION_INCLUDE,
    });
    if (byExternal) return byExternal;
  }
  return null;
}

async function hydratedSession(sessionId: string, includeDraft = true): Promise<SessionDto> {
  const row = await prisma.agentBuildSession.findUnique({
    where: { id: sessionId },
    include: { iterations: { orderBy: { sequence: 'asc' }, take: 100 } },
  });
  if (!row) throw errors.notFound('Session not found');
  return toSessionDto(row, { includeDraft });
}

async function findExternalSession(
  userId: string,
  conversationId: string,
  source?: ExternalBuilderSource,
) {
  return resolveBuilderSession({
    userId,
    externalSource: source,
    externalConversationId: conversationId,
  });
}

function hookContext(sessionId: string, status: AgentBuildSessionStatus): string {
  return [
    `AIOS 已自動追蹤這段 Agent 建置對話（建置 ID：${sessionId}，狀態：${status}）。`,
    '請像資深顧問一樣自然理解需求、一次追問一個最有價值的問題；不要使用固定問卷，也不要要求使用者提醒你保存。',
    '對話會由 Hook 自動同步並由 AIOS 在背景建立 Agent／Skill 草稿。草稿不代表已啟用；送審、測試與正式生效仍遵守 FDE 閘門。',
    '如果使用者提供檔案，請使用 build-aios-agent Skill 的檔案同步流程；如果使用者明確要求送審，再使用該 Skill 的送審工具。',
  ].join('\n');
}

/**
 * UserPromptSubmit without an existing session: never create a build file here.
 * Only an explicit `start_agent_build` call may persist a new AgentBuildSession.
 * Existing sessions keep synchronizing (see prepareExternalBuilderPrompt below).
 */
export function hookResultForUnstartedBuild(prompt: string): ExternalPromptHookResult {
  if (!isExplicitAgentBuildPrompt(prompt)) return { matched: false };
  return {
    matched: true,
    created: false,
    userMessageSynced: false,
    backgroundBuildQueued: false,
    additionalContext: AGENT_BUILD_CONFIRM_START_HINT,
  };
}

/** Claude Code UserPromptSubmit hook: resume and persist the user turn. */
export async function prepareExternalBuilderPrompt(opts: {
  userId: string;
  source: ExternalBuilderSource;
  externalConversationId: string;
  prompt: string;
}): Promise<ExternalPromptHookResult> {
  const conversationId = cleanString(opts.externalConversationId, 160);
  const prompt = cleanString(opts.prompt, 12_000);
  if (!conversationId || !prompt) return { matched: false };

  let row = await findExternalSession(opts.userId, conversationId, opts.source);
  if (!row) {
    // Possible build intent is a hint only. Creating a session here made every
    // classifier false-positive durable. start_agent_build is the sole create path.
    return hookResultForUnstartedBuild(prompt);
  }

  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(row.status)) {
    return {
      matched: true,
      sessionId: row.id,
      status: row.status,
      userMessageSynced: false,
      backgroundBuildQueued: false,
      additionalContext: hookContext(row.id, row.status),
    };
  }

  const transcript = asTranscript(row.transcript);
  const lastEntry = transcript.at(-1);
  if (lastEntry?.role === 'user' && lastEntry.content === prompt) {
    return {
      matched: true,
      sessionId: row.id,
      status: row.status,
      userMessageSynced: true,
      backgroundBuildQueued: false,
      additionalContext: hookContext(row.id, row.status),
    };
  }
  if (transcript.length >= MAX_TRANSCRIPT_ENTRIES) {
    throw errors.badRequest(`Builder transcript exceeds ${MAX_TRANSCRIPT_ENTRIES} entries; start a continuation session`);
  }

  const userEventId = `prompt:${sha256(prompt).slice(0, 40)}:${transcript.length}`;
  transcript.push({
    role: 'user',
    content: prompt,
    at: new Date().toISOString(),
    source: opts.source,
    externalEventId: userEventId,
  });
  const brief = mergeInferredBrief(asBrief(row.brief), prompt);
  await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status: row.status === 'PLAN_READY' ? 'DISCOVERY' : row.status,
      transcript: deepRedactSecrets(transcript) as Prisma.InputJsonValue,
      brief: brief as Prisma.InputJsonValue,
      plan: row.status === 'PLAN_READY' ? Prisma.DbNull : undefined,
    },
  });
  const iteration = await createBuilderEvolutionIteration({
    sessionId: row.id,
    triggerKind: /(?:反悔|改成|更改|推翻|取消|修正|不是.{0,12}(?:而是|要))/.test(prompt)
      ? 'correction'
      : 'message',
    triggerSummary: prompt,
  }).catch(() => null);
  await audit(opts.userId, 'agent_builder.external_prompt_synced', 'AgentBuildSession', row.id, {
    source: opts.source,
    externalConversationId: conversationId,
    externalEventId: userEventId,
    iterationId: iteration?.id ?? null,
  });
  row = await findExternalSession(opts.userId, conversationId, opts.source);
  const status = row?.status ?? 'DISCOVERY';
  return {
    matched: true,
    sessionId: row?.id ?? '',
    status,
    userMessageSynced: true,
    backgroundBuildQueued: Boolean(iteration),
    additionalContext: hookContext(row?.id ?? '', status),
  };
}

/**
 * Claude Code Stop-hook safety net.
 *
 * UserPromptSubmit normally creates/synchronizes the build. Stop mirrors the
 * final assistant text and catches a missed user turn. It never waits for the
 * model to author an artifact: the server's evolution worker builds the next
 * shadow Agent/Skill version asynchronously from the durable transcript.
 */
export async function guardExternalBuilderStop(opts: {
  userId: string;
  source: ExternalBuilderSource;
  externalConversationId: string;
  lastUserMessage?: string;
  lastUserMessageAt?: string;
  lastAssistantMessage?: string;
  stopHookActive: boolean;
}): Promise<ExternalStopGuardResult> {
  const conversationId = cleanString(opts.externalConversationId, 160);
  if (!conversationId) return { matched: false };

  let row = await findExternalSession(opts.userId, conversationId, opts.source);
  let created = false;
  const userMessage = cleanString(opts.lastUserMessage, 24_000);
  if (!row && userMessage && isExplicitAgentBuildPrompt(userMessage)) {
    const result = await createExternalBuilderSession({
      userId: opts.userId,
      source: opts.source,
      initialRequest: userMessage,
      externalConversationId: conversationId,
    });
    row = await findExternalSession(opts.userId, conversationId, opts.source);
    created = !result.deduplicated;
  }
  if (!row) return { matched: false };

  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(row.status)) {
    return {
      matched: true,
      sessionId: row.id,
      status: row.status,
      created,
      userMessageSynced: false,
      finalMessageSynced: false,
      backgroundBuildQueued: false,
      systemMessage: `AIOS 建置 ${row.id} 目前為 ${row.status}；本輪未修改待審或測試中的版本。`,
    };
  }

  const transcript = asTranscript(row.transcript);
  const parsedUserAt = Date.parse(String(opts.lastUserMessageAt ?? ''));
  const userAt = Number.isFinite(parsedUserAt)
    ? new Date(Math.min(parsedUserAt, Date.now())).toISOString()
    : new Date().toISOString();
  const userEventId = userMessage ? `stop-user:${sha256(userMessage).slice(0, 40)}` : '';
  const message = cleanString(opts.lastAssistantMessage, 24_000);
  const eventId = message ? `stop:${sha256(message).slice(0, 40)}` : '';
  let userMessageSynced = !userMessage;
  let finalMessageSynced = !message;
  let newlySyncedUser = false;
  let transcriptChanged = false;
  if (userMessage) {
    const duplicate = transcript.some((entry) =>
      entry.role === 'user' &&
      entry.source === opts.source &&
      (entry.externalEventId === userEventId || entry.content === userMessage),
    );
    if (duplicate) {
      userMessageSynced = true;
    } else if (transcript.length < MAX_TRANSCRIPT_ENTRIES) {
      transcript.push({
        role: 'user',
        content: userMessage,
        at: userAt,
        source: opts.source,
        externalEventId: userEventId,
      });
      transcriptChanged = true;
      newlySyncedUser = true;
      userMessageSynced = true;
    }
  }
  if (message) {
    const duplicate = transcript.some((entry) =>
      entry.role === 'assistant' &&
      entry.source === opts.source &&
      (entry.externalEventId === eventId || entry.content === message),
    );
    if (duplicate) {
      finalMessageSynced = true;
    } else if (transcript.length < MAX_TRANSCRIPT_ENTRIES) {
      transcript.push({
        role: 'assistant',
        content: message,
        at: new Date().toISOString(),
        source: opts.source,
        externalEventId: eventId,
      });
      transcriptChanged = true;
      finalMessageSynced = true;
    }
  }

  if (transcriptChanged) {
    await prisma.agentBuildSession.update({
      where: { id: row.id },
      data: {
        transcript: deepRedactSecrets(transcript) as Prisma.InputJsonValue,
        ...(newlySyncedUser ? { brief: mergeInferredBrief(asBrief(row.brief), userMessage) as Prisma.InputJsonValue } : {}),
        ...(message ? { lastAssistantMessage: message } : {}),
      },
    });
    await audit(opts.userId, 'agent_builder.external_stop_messages_synced', 'AgentBuildSession', row.id, {
      source: opts.source,
      externalConversationId: conversationId,
      userExternalEventId: userEventId || undefined,
      assistantExternalEventId: eventId || undefined,
    });
  }

  // Prompt Hook normally queued an iteration before Claude answered. Queue one
  // more iteration after a complete pair so the compiler can reflect on the
  // actual behaviour, the user's correction and Claude's response together.
  // Duplicate Stop calls do not change the transcript, so this is idempotent
  // without trusting a client-provided completion flag.
  const completedPair = transcriptChanged && Boolean(message);
  const reflectionSummary = completedPair
    ? [
        '對話結束反思（只更新 Shadow Draft，不得直接生效）',
        userMessage ? `使用者回饋／要求：${userMessage}` : '',
        `本輪回覆：${message}`,
        '請找出可重複使用的 Skill 指令、必要輸出欄位、規則、例外與測試；未被使用者確認的 Agent 自述只能列為假設。',
      ].filter(Boolean).join('\n')
    : userMessage;
  const iteration = completedPair
    ? await createBuilderEvolutionIteration({
        sessionId: row.id,
        triggerKind: 'reflection',
        triggerSummary: reflectionSummary,
      }).catch(() => null)
    : newlySyncedUser && !created
      ? await createBuilderEvolutionIteration({
          sessionId: row.id,
          triggerKind: /(?:反悔|改成|更改|推翻|取消|修正|不是.{0,12}(?:而是|要))/.test(userMessage)
            ? 'correction'
            : 'message',
          triggerSummary: userMessage,
        }).catch(() => null)
      : null;

  const latestUserAt = transcript
    .filter((entry) => entry.role === 'user')
    .map((entry) => Date.parse(entry.at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] ?? 0;
  const latestExternalArtifact = row.iterations.find((iteration) => {
    if (iteration.status !== 'READY' || !iteration.artifactSnapshot) return false;
    const snapshot = asObject(iteration.artifactSnapshot);
    const provenance = asObject(snapshot?.provenance);
    return typeof provenance?.externalEventId === 'string';
  });
  const artifactFresh = Boolean(
    latestExternalArtifact && latestExternalArtifact.createdAt.getTime() >= latestUserAt,
  );
  return {
    matched: true,
    sessionId: row.id,
    status: row.status,
    created,
    userMessageSynced,
    finalMessageSynced,
    artifactFresh,
    backgroundBuildQueued: created || Boolean(iteration),
    reflectionQueued: completedPair && Boolean(iteration),
    systemMessage: transcriptChanged
      ? 'AIOS 已自動保存本輪對話；Agent／Skill 草稿會在背景更新，不需要額外提醒或等待。'
      : undefined,
  };
}

export async function createExternalBuilderSession(opts: {
  userId: string;
  source: ExternalBuilderSource;
  initialRequest: string;
  externalConversationId?: string;
  externalConversationTitle?: string;
  requestedAgentName?: string;
  targetAgentId?: string;
  agentId?: string;
}): Promise<{ session: SessionDto; deduplicated: boolean }> {
  const initialRequest = cleanString(opts.initialRequest, 12_000);
  if (!initialRequest) throw errors.badRequest('initialRequest is required');
  if (opts.agentId && opts.targetAgentId && opts.agentId !== opts.targetAgentId) {
    throw errors.badRequest('agentId and targetAgentId must refer to the same employee');
  }
  const providedConversationId = cleanString(opts.externalConversationId ?? '', 160);
  const conversationId = providedConversationId || ulid();
  const requestedAgentId = cleanString(opts.agentId ?? opts.targetAgentId ?? '', 160) || undefined;

  let target: { id: string; name: string } | null = null;
  if (requestedAgentId) {
    target = await prisma.agent.findFirst({
      where: {
        id: requestedAgentId,
        createdBy: opts.userId,
        deletedAt: null,
        systemManaged: false,
      },
      select: { id: true, name: true },
    });
    if (!target) throw errors.notFound('Target agent not found');
  }
  const inference = inferFromPrompt(initialRequest);
  const conversationTitle = cleanString(opts.externalConversationTitle, 240) || undefined;
  const brief = deepRedactSecrets({
    ...inference.brief,
    requestedAgentName: cleanString(opts.requestedAgentName, 120) || target?.name || inference.brief.requestedAgentName,
    requestedStrategy: target ? 'reuse' : 'create',
    externalSource: opts.source,
    externalConversationId: conversationId,
    externalConversationTitle: conversationTitle,
  }) as Brief;
  const eventId = `start:${conversationId}`;
  const transcript: TranscriptEntry[] = [{
    role: 'user',
    content: initialRequest,
    at: new Date().toISOString(),
    source: opts.source,
    externalEventId: eventId,
  }];
  const id = ulid();
  // Concurrent Claude lifecycle hooks can race; hold an advisory lock and
  // re-check so the same owner+conversation never creates two sessions.
  const persisted = await prisma.$transaction(async (tx) => {
    if (target) {
      await tx.$queryRaw<Array<{ locked: number }>>`
        WITH agent_lock AS (
          SELECT pg_advisory_xact_lock(
            hashtext(${opts.userId}),
            hashtext(${`agent:${target.id}`})
          )
        )
        SELECT 1::int AS "locked" FROM agent_lock
      `;
    }
    await tx.$queryRaw<Array<{ locked: number }>>`
      WITH conversation_lock AS (
        SELECT pg_advisory_xact_lock(
          hashtext(${opts.userId}),
          hashtext(${`${opts.source}:${conversationId}`})
        )
      )
      SELECT 1::int AS "locked" FROM conversation_lock
    `;
    const existing = await resolveBuilderSession({
      userId: opts.userId,
      agentId: target?.id,
      externalSource: opts.source,
      externalConversationId: providedConversationId || conversationId,
    }, tx);
    if (existing) {
      return { row: existing, created: false as const };
    }
    if (target) {
      await assertBuilderAgentBindingAvailable({
        userId: opts.userId,
        agentId: target.id,
      }, tx);
    }
    const workingAgent = target ?? await createBuilderWorkingAgent(tx, {
      userId: opts.userId,
      name: brief.requestedAgentName || conversationTitle,
      objective: brief.objective,
      process: brief.process,
      tags: brief.tags,
    });
    const row = await tx.agentBuildSession.create({
      data: {
        id,
        userId: opts.userId,
        status: 'ACTIVE',
        transcript: transcript as Prisma.InputJsonValue,
        brief: brief as Prisma.InputJsonValue,
        progress: buildProgress(inference.answered, null) as Prisma.InputJsonValue,
        targetAgentId: workingAgent.id,
        agentId: workingAgent.id,
        builtAgentId: target ? null : workingAgent.id,
        strategy: target ? 'reuse' : 'create',
        externalSource: opts.source,
        externalConversationId: conversationId,
        externalConversationTitle: conversationTitle ?? null,
      },
      include: { iterations: { orderBy: { sequence: 'asc' }, take: 100 } },
    });
    return { row, created: true as const };
  });
  if (!persisted.created) {
    return { session: toSessionDto(persisted.row), deduplicated: true };
  }
  const row = persisted.row;
  await audit(opts.userId, 'agent_builder.external_session_created', 'AgentBuildSession', id, {
    source: opts.source,
    externalConversationId: conversationId,
    agentId: row.agentId,
  });
  if (row.builtAgentId) {
    await audit(opts.userId, 'agent_builder.working_agent_created', 'Agent', row.builtAgentId, {
      sessionId: id,
      source: opts.source,
      status: 'ACTIVE',
      leastPrivilege: true,
    });
    hub.publish('agent.status', { id: row.builtAgentId, status: 'ACTIVE', event: 'created' });
  }
  // Local evolution ledger: first message seeds a background iteration so
  // reflection/training history stays continuous after remote idempotency merge.
  const iteration = await createBuilderEvolutionIteration({
    sessionId: id,
    triggerKind: 'message',
    triggerSummary: initialRequest,
  }).catch(() => null);
  const session = toSessionDto(row);
  if (iteration) {
    session.iterations = [iteration];
    session.latestIteration = iteration;
  }
  return { session, deduplicated: false };
}

export async function syncExternalBuilderTurn(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  source: ExternalBuilderSource;
  externalEventId: string;
  turns: ExternalTurn[];
  summary?: string;
}): Promise<{ session: SessionDto; deduplicated: boolean; iteration: IterationDto | null }> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (row.userId !== opts.userId) throw errors.notFound('Session not found');
  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(row.status)) {
    throw errors.conflict(`Session does not accept external turns (status=${row.status})`);
  }
  const eventId = cleanString(opts.externalEventId, 160);
  if (!eventId) throw errors.badRequest('externalEventId is required');
  const transcript = asTranscript(row.transcript);
  if (transcript.some((entry) => entry.source === opts.source && entry.externalEventId === eventId)) {
    return { session: await hydratedSession(row.id), deduplicated: true, iteration: null };
  }
  if (transcript.length + opts.turns.length > MAX_TRANSCRIPT_ENTRIES) {
    throw errors.badRequest(`Builder transcript exceeds ${MAX_TRANSCRIPT_ENTRIES} entries; start a continuation session`);
  }
  const now = new Date().toISOString();
  const nextTurns = opts.turns.map((turn) => ({
    role: turn.role,
    content: cleanString(turn.content, turn.role === 'assistant' ? 24_000 : 12_000),
    at: now,
    source: opts.source,
    externalEventId: eventId,
  })).filter((turn) => turn.content) as TranscriptEntry[];
  if (!nextTurns.length) throw errors.badRequest('At least one non-empty turn is required');

  const userText = nextTurns.filter((turn) => turn.role === 'user').map((turn) => turn.content).join('\n');
  const brief = mergeInferredBrief(asBrief(row.brief), userText);
  const lastAssistant = [...nextTurns].reverse().find((turn) => turn.role === 'assistant')?.content;
  await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status: row.status === 'PLAN_READY' ? 'DISCOVERY' : row.status,
      transcript: deepRedactSecrets([...transcript, ...nextTurns]) as Prisma.InputJsonValue,
      brief: brief as Prisma.InputJsonValue,
      lastAssistantMessage: lastAssistant ?? row.lastAssistantMessage,
      plan: row.status === 'PLAN_READY' ? Prisma.DbNull : undefined,
    },
  });

  const hasUserTurn = nextTurns.some((turn) => turn.role === 'user');
  const hasAssistantTurn = nextTurns.some((turn) => turn.role === 'assistant');
  const completedPair = hasUserTurn && hasAssistantTurn;
  const triggerSummary = cleanString(
    opts.summary ?? (completedPair
      ? [
          '對話結束反思（只更新 Shadow Draft，不得直接生效）',
          `使用者回饋／要求：${userText}`,
          `本輪回覆：${lastAssistant ?? ''}`,
          '請找出可重複使用的 Skill 指令、必要輸出欄位、規則、例外與測試；未被使用者確認的 Agent 自述只能列為假設。',
        ].join('\n')
      : (userText || nextTurns.at(-1)?.content)),
    2_000,
  );
  const iteration = await createBuilderEvolutionIteration({
    sessionId: row.id,
    triggerKind: completedPair
      ? 'reflection'
      : /(?:反悔|改成|更改|推翻|取消|修正|不是.{0,12}(?:而是|要))/.test(userText)
        ? 'correction'
        : 'message',
    triggerSummary,
  }).catch(() => null);
  await audit(opts.userId, 'agent_builder.external_turn_synced', 'AgentBuildSession', row.id, {
    source: opts.source,
    externalEventId: eventId,
    roles: nextTurns.map((turn) => turn.role),
    iterationId: iteration?.id ?? null,
  });
  return { session: await hydratedSession(row.id), deduplicated: false, iteration };
}

/**
 * Convergent snapshot write for clients without lifecycle hooks (for example
 * ChatGPT web). The paired turn is stored first and the authoritative artifact
 * second. Component event ids are deterministic, so a retry after any network
 * interruption safely completes the missing half without duplicating content.
 */
export async function upsertExternalBuilderSnapshot(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  source: ExternalBuilderSource;
  externalEventId: string;
  turns: ExternalTurn[];
  summary?: string;
  artifact: ExternalArtifactInput;
}): Promise<{
  session: SessionDto;
  turn: { deduplicated: boolean; iteration: IterationDto | null };
  artifact: { deduplicated: boolean; iteration: IterationDto };
}> {
  const rootEventId = cleanString(opts.externalEventId, 120);
  if (!rootEventId) throw errors.badRequest('externalEventId is required');
  const turn = await syncExternalBuilderTurn({
    ...opts,
    externalEventId: `${rootEventId}:turn`,
  });
  const artifact = await importExternalBuilderArtifact({
    ...opts,
    externalEventId: `${rootEventId}:artifact`,
  });
  return {
    session: artifact.session,
    turn: { deduplicated: turn.deduplicated, iteration: turn.iteration },
    artifact: { deduplicated: artifact.deduplicated, iteration: artifact.iteration },
  };
}

async function nextIterationSequence(sessionId: string): Promise<{ sequence: number; previousId: string | null }> {
  const previous = await prisma.agentBuildIteration.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true },
  });
  return { sequence: (previous?.sequence ?? 0) + 1, previousId: previous?.id ?? null };
}

export async function importExternalBuilderArtifact(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  source: ExternalBuilderSource;
  externalEventId: string;
  artifact: ExternalArtifactInput;
}): Promise<{ session: SessionDto; iteration: IterationDto; deduplicated: boolean }> {
  const session = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (session.userId !== opts.userId) throw errors.notFound('Session not found');
  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(session.status)) {
    throw errors.conflict(`Session does not accept external artifacts (status=${session.status})`);
  }
  const eventId = cleanString(opts.externalEventId, 160);
  if (!eventId) throw errors.badRequest('externalEventId is required');
  const recent = await prisma.agentBuildIteration.findMany({
    where: { sessionId: session.id },
    orderBy: { sequence: 'desc' },
    take: 100,
  });
  const duplicate = recent.find((iteration) => {
    const snapshot = asObject(iteration.artifactSnapshot);
    const provenance = asObject(snapshot?.provenance);
    return provenance?.source === opts.source && provenance?.externalEventId === eventId;
  });
  if (duplicate) {
    return {
      session: await hydratedSession(session.id),
      iteration: toIterationDto(duplicate),
      deduplicated: true,
    };
  }

  const harness = normalizeHarness(opts.artifact, opts.source, eventId);
  const previous = recent.find((iteration) => iteration.status === 'READY') ?? null;
  const understanding = normalizeDecisionGraph(opts.artifact, harness);
  const changes = opts.artifact.changes?.length
    ? deepRedactSecrets(opts.artifact.changes.slice(0, 40)) as EvolutionChange[]
    : defaultChanges(opts.artifact, previous);
  const userSummary = cleanString(
    opts.artifact.userSummary,
    1_500,
  ) || `我已把「${harness.identity.name}」的最新能力、技能、記憶與流程整理進學習草稿。`;
  const fdeSummary = cleanString(opts.artifact.fdeSummary, 4_000) || [
    `外部來源：${opts.source}`,
    `Agent：${harness.identity.name}`,
    `技能：${harness.skills.length}；記憶文件：${harness.memory.documents?.length ?? 0}；流程：${harness.workflows?.length ?? 0}；測試：${harness.testIdeas.length}`,
    '所有內容仍為 shadow draft，尚未建立、掛載、確認或啟用。',
  ].join('\n');

  let created: AgentBuildIteration | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    const next = await nextIterationSequence(session.id);
    try {
      created = await prisma.agentBuildIteration.create({
        data: {
          id: ulid(),
          sessionId: session.id,
          sequence: next.sequence,
          basedOnIterationId: next.previousId,
          triggerKind: 'external_artifact',
          triggerSummary: cleanString(
            `${opts.source} 同步完整草稿 ${sha256(`${opts.source}:${eventId}`).slice(0, 12)}`,
            2_000,
          ),
          status: 'READY',
          understanding: understanding as Prisma.InputJsonValue,
          proposedChanges: changes as Prisma.InputJsonValue,
          artifactSnapshot: harness as Prisma.InputJsonValue,
          userSummary,
          fdeSummary,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  if (!created) throw new Error('Failed to create external Agent Builder iteration');

  const currentBrief = asBrief(session.brief);
  const firstSkill = harness.skills[0];
  const nextBrief: Brief = deepRedactSecrets({
    ...currentBrief,
    objective: harness.identity.purpose,
    requestedAgentName: harness.identity.name,
    requestedStrategy: currentBrief.requestedStrategy ?? 'create',
    inputs: firstSkill?.inputs.join('；') || currentBrief.inputs,
    outputs: firstSkill?.outputs.join('；') || currentBrief.outputs,
    process: firstSkill?.instructions.join('\n') || currentBrief.process,
    exceptions: firstSkill?.edgeCases.join('；') || currentBrief.exceptions,
    permissions: harness.policies.requiresApproval.join('；'),
    testDataHint: harness.testIdeas[0]?.input || currentBrief.testDataHint,
    expectedResult: harness.testIdeas[0]?.expected || currentBrief.expectedResult,
  }) as Brief;
  await prisma.agentBuildSession.update({
    where: { id: session.id },
    data: {
      status: session.status === 'PLAN_READY' ? 'DISCOVERY' : session.status,
      brief: nextBrief as Prisma.InputJsonValue,
      plan: session.status === 'PLAN_READY' ? Prisma.DbNull : undefined,
      lastAssistantMessage: userSummary,
    },
  });
  await prisma.agentBuildIteration.updateMany({
    where: { sessionId: session.id, sequence: { lt: created.sequence }, status: 'QUEUED' },
    data: { status: 'SUPERSEDED', completedAt: new Date() },
  }).catch(() => {});
  await audit(opts.userId, 'agent_builder.external_artifact_synced', 'AgentBuildIteration', created.id, {
    sessionId: session.id,
    source: opts.source,
    externalEventId: eventId,
    skills: harness.skills.length,
    workflows: harness.workflows?.length ?? 0,
    memoryDocuments: harness.memory.documents?.length ?? 0,
    tests: harness.testIdeas.length,
  });
  hub.publishToUser(opts.userId, 'agent-builder.iteration.ready', {
    sessionId: session.id,
    iterationId: created.id,
    sequence: created.sequence,
    source: opts.source,
    at: new Date().toISOString(),
  });
  return {
    session: await hydratedSession(session.id),
    iteration: toIterationDto(created),
    deduplicated: false,
  };
}

export async function submitExternalBuilderForReview(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  strategy: 'create' | 'reuse';
  targetAgentId?: string;
}): Promise<SessionDto> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (row.userId !== opts.userId) throw errors.notFound('Session not found');
  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(row.status)) {
    throw errors.conflict(`Cannot submit external build from status=${row.status}`);
  }
  const latest = await prisma.agentBuildIteration.findFirst({
    where: { sessionId: row.id, status: 'READY' },
    orderBy: { sequence: 'desc' },
  });
  if (!latest?.artifactSnapshot) {
    throw errors.badRequest('A READY synchronized artifact is required before FDE review');
  }
  const harness = latest.artifactSnapshot as HarnessSnapshot;
  const brief = deepRedactSecrets({
    ...asBrief(row.brief),
    objective: harness.identity.purpose,
    requestedAgentName: harness.identity.name,
    requestedStrategy: opts.strategy,
  }) as Brief;
  const plan = await buildCapabilityPlan(brief, row.userId);
  plan.summary = `建立「${harness.identity.name}」：${harness.identity.purpose}`;
  plan.proposedAgentName = harness.identity.name;
  plan.proposedSkillName = harness.skills[0]?.name ?? `${harness.identity.name}核心能力`;
  plan.strategyRecommendation = opts.strategy;

  let targetAgentId: string | null = null;
  if (opts.strategy === 'reuse') {
    targetAgentId = opts.targetAgentId ?? row.builtAgentId ?? row.targetAgentId ?? row.agentId;
    if (!targetAgentId) throw errors.badRequest('targetAgentId is required for reuse strategy');
    const target = await prisma.agent.findFirst({
      where: { id: targetAgentId, deletedAt: null, systemManaged: false },
      select: { id: true },
    });
    if (!target) throw errors.notFound('Target agent not found');
    if (!plan.reuseCandidates.some((candidate) => candidate.agentId === targetAgentId)) {
      plan.reuseCandidates.unshift({
        agentId: targetAgentId,
        name: harness.identity.name,
        reason: '外部 Builder 明確要求在此員工建立新版本草稿。',
      });
    }
    await assertBuilderAgentBindingAvailable({
      userId: row.userId,
      agentId: targetAgentId,
      exceptSessionId: row.id,
    });
  }

  const assistantMessage = '最新訓練草稿已送交 FDE；核准前不會建立、修改或啟用任何正式 Agent、Skill 或 Workflow。';
  const transcript = asTranscript(row.transcript);
  if (transcript.length >= MAX_TRANSCRIPT_ENTRIES) {
    throw errors.badRequest(`Builder transcript exceeds ${MAX_TRANSCRIPT_ENTRIES} entries`);
  }
  transcript.push({
    role: 'system',
    content: assistantMessage,
    at: new Date().toISOString(),
    source: asBrief(row.brief).externalSource ?? 'OTHER',
    externalEventId: `review:${latest.id}`,
  });
  await prisma.agentBuildSession.update({
    where: { id: row.id },
    data: {
      status: 'AWAITING_FDE',
      brief: brief as Prisma.InputJsonValue,
      plan: deepRedactSecrets(plan) as Prisma.InputJsonValue,
      strategy: opts.strategy,
      targetAgentId,
      agentId: targetAgentId ?? row.agentId,
      transcript: deepRedactSecrets(transcript) as Prisma.InputJsonValue,
      lastAssistantMessage: assistantMessage,
    },
  });
  await audit(opts.userId, 'agent_builder.external_awaiting_fde', 'AgentBuildSession', row.id, {
    strategy: opts.strategy,
    targetAgentId,
    iterationId: latest.id,
    callerRole: opts.role,
    // Explicitly demonstrate that an OWNER credential did not bypass review.
    forcedReviewGate: isFde(opts.role),
  });
  return getBuilderSession({ sessionId: row.id, userId: opts.userId, role: opts.role });
}
