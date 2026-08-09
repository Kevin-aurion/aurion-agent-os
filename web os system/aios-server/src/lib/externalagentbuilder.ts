// External Agent Builder ingress for Claude, ChatGPT, Codex and Cursor.
//
// MCP clients can synchronize exact transcript turns, parsed source files and a
// complete draft artifact. All writes are owner-scoped, deep-redacted and inert:
// external clients can submit for FDE review, but can never approve, confirm or
// activate an Agent/Skill/Workflow through these functions.
import path from 'node:path';
import { ulid } from 'ulid';
import { Prisma, type AgentBuildIteration, type AgentBuildSessionStatus, type UserRole } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { createProposal } from './changeproposal.js';
import { sha256 } from './crypto.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { hub } from '../ws/hub.js';
import {
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
  selectionRequired?: boolean;
  candidates?: Array<{ id: string; name: string; status: string }>;
};

export type BuilderAgentSummary = {
  id: string;
  name: string;
  description: string;
  department: string;
  status: string;
  skillCount: number;
  workflowCount: number;
  updatedAt: string;
  latestBuild: { id: string; status: AgentBuildSessionStatus; updatedAt: string } | null;
};

const MAX_TRANSCRIPT_ENTRIES = 1_000;
const MAX_MEMORY_DOCUMENTS = 24;
const MAX_WORKFLOWS = 12;

const AGENT_BUILD_ACTION_RE = /(?:建立|新增|打造|設計|規劃|訓練|教會|更新|調整|改造|優化|做(?:一位|一個)?|想要|需要|build|create|train|teach|update|design|want|need)/i;
const AGENT_BUILD_OBJECT_RE = /(?:AI\s*(?:員工|助理|代理)|agent|bot|機器人|技能|skill)/i;
const NEGATED_BUILD_RE = /(?:不要|不用|無需|別|停止|取消).{0,16}(?:建立|新增|打造|訓練|更新|調整|改造|優化|build|create|train|update)/i;
const EXPLICIT_NEW_RE = /(?:建立|新增|打造|create|build).{0,18}(?:全新|新的?|new)?.{0,18}(?:AI\s*(?:員工|助理|代理)|agent|bot|機器人)/i;
const CONTINUATION_RE = /(?:接續|繼續|續(?:著)?|訓練|教會|更新|調整|改造|優化|continue|resume|train|teach|update|improve)/i;
const INTERNAL_BUILDER_TEST_MARKERS = [
  '【Agent Builder 試跑】',
  '[This step\'s task]',
  '[Verifier feedback (cross-model review)',
  '"builderTest":true',
];

/** Defense in depth: a CLI run created by AIOS must never re-enter Builder hooks. */
export function isInternalBuilderTestPrompt(prompt: string): boolean {
  const normalized = String(prompt ?? '');
  return INTERNAL_BUILDER_TEST_MARKERS.some((marker) => normalized.includes(marker));
}

/** Conservative hook activation: unrelated Claude Code chats must remain no-op. */
export function isExplicitAgentBuildPrompt(prompt: string): boolean {
  const normalized = cleanString(prompt, 12_000);
  if (isInternalBuilderTestPrompt(normalized) || NEGATED_BUILD_RE.test(normalized)) return false;
  return AGENT_BUILD_ACTION_RE.test(normalized) && AGENT_BUILD_OBJECT_RE.test(normalized);
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
    testIdeas: (input.tests ?? []).slice(0, 20).map((test, index) => ({
      name: cleanString(test.name, 180) || `測試 ${index + 1}`,
      input: cleanString(test.input, 5_000),
      expected: cleanString(test.expected, 5_000),
    })).filter((test) => test.input && test.expected),
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

async function hydratedSession(sessionId: string, includeDraft = true): Promise<SessionDto> {
  const row = await prisma.agentBuildSession.findUnique({
    where: { id: sessionId },
    include: { iterations: { orderBy: { sequence: 'asc' }, take: 100 } },
  });
  if (!row) throw errors.notFound('Session not found');
  return toSessionDto(row, { includeDraft });
}

async function findExternalSession(userId: string, conversationId: string) {
  const recent = await prisma.agentBuildSession.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { iterations: { orderBy: { sequence: 'desc' }, take: 100 } },
  });
  return recent.find((candidate) => {
    const brief = asBrief(candidate.brief);
    return brief.externalConversationId === conversationId;
  }) ?? null;
}

function hookContext(sessionId: string, status: AgentBuildSessionStatus): string {
  return [
    `AIOS 已自動追蹤這段 Agent 建置對話（建置 ID：${sessionId}，狀態：${status}）。`,
    '請像資深顧問一樣自然理解需求、一次追問一個最有價值的問題；不要使用固定問卷，也不要要求使用者提醒你保存。',
    '對話會由 Hook 自動同步並由 AIOS 在背景建立 Agent／Skill 草稿。草稿不代表已啟用；送審、測試與正式生效仍遵守 FDE 閘門。',
    '如果使用者提供檔案，請使用 build-aios-agent Skill 的檔案同步流程；如果使用者明確要求送審，再使用該 Skill 的送審工具。',
    '若尚未由使用者親自指定員工名稱，先自然詢問名稱；取得名稱後呼叫 set_agent_build_name，再繼續訪談。',
  ].join('\n');
}

function selectionContext(candidates: BuilderAgentSummary[]): string {
  return [
    '使用者的語意像是在接續訓練既有員工，但目前無法安全判定是哪一位；AIOS 尚未建立新草稿。',
    '請先詢問：「這一次想訓練哪一位員工？」並列出下列候選；同時提供「都不是，建立新員工」。',
    ...candidates.slice(0, 12).map((agent, index) => `${index + 1}. ${agent.name}（${agent.status}，ID：${agent.id}）`),
    '使用者選定後，呼叫 start_agent_build 並傳 targetAgentId 與既有名稱；若選「都不是」，先詢問新員工名稱，再建立。',
  ].join('\n');
}

export async function listOwnedBuilderAgents(userId: string): Promise<BuilderAgentSummary[]> {
  const agents = await prisma.agent.findMany({
    where: { createdBy: userId, deletedAt: null, systemManaged: false },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      _count: { select: { skills: true, workflows: { where: { deletedAt: null } } } },
    },
  });
  const ids = agents.map((agent) => agent.id);
  const builds = ids.length
    ? await prisma.agentBuildSession.findMany({
        where: { userId, OR: [{ builtAgentId: { in: ids } }, { targetAgentId: { in: ids } }] },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, status: true, builtAgentId: true, targetAgentId: true, updatedAt: true },
      })
    : [];
  const latestByAgent = new Map<string, typeof builds[number]>();
  for (const build of builds) {
    const agentId = build.builtAgentId ?? build.targetAgentId;
    if (agentId && !latestByAgent.has(agentId)) latestByAgent.set(agentId, build);
  }
  return agents.map((agent) => {
    const latest = latestByAgent.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      department: agent.department,
      status: agent.status,
      skillCount: agent._count.skills,
      workflowCount: agent._count.workflows,
      updatedAt: agent.updatedAt.toISOString(),
      latestBuild: latest
        ? { id: latest.id, status: latest.status, updatedAt: latest.updatedAt.toISOString() }
        : null,
    };
  });
}

/** Claude Code UserPromptSubmit hook: start/resume and persist the user turn. */
export async function prepareExternalBuilderPrompt(opts: {
  userId: string;
  source: ExternalBuilderSource;
  externalConversationId: string;
  prompt: string;
}): Promise<ExternalPromptHookResult> {
  const conversationId = cleanString(opts.externalConversationId, 160);
  const prompt = cleanString(opts.prompt, 12_000);
  if (!conversationId || !prompt || isInternalBuilderTestPrompt(prompt)) return { matched: false };

  let row = await findExternalSession(opts.userId, conversationId);
  if (!row) {
    if (!isExplicitAgentBuildPrompt(prompt)) return { matched: false };
    const inferred = inferFromPrompt(prompt).brief;
    const ownedAgents = await listOwnedBuilderAgents(opts.userId);
    const explicitNew = inferred.requestedStrategy === 'create' || EXPLICIT_NEW_RE.test(prompt);
    if (!explicitNew && CONTINUATION_RE.test(prompt) && ownedAgents.length) {
      const matches = ownedAgents.filter((agent) => prompt.includes(agent.name));
      if (matches.length !== 1) {
        const candidates = matches.length > 1 ? matches : ownedAgents;
        return {
          matched: true,
          created: false,
          selectionRequired: true,
          candidates: candidates.slice(0, 12).map(({ id, name, status }) => ({ id, name, status })),
          backgroundBuildQueued: false,
          additionalContext: selectionContext(candidates),
        };
      }
      const selected = matches[0]!;
      const created = await createExternalBuilderSession({
        userId: opts.userId,
        source: opts.source,
        initialRequest: prompt,
        externalConversationId: conversationId,
        requestedAgentName: selected.name,
        targetAgentId: selected.id,
      });
      return {
        matched: true,
        sessionId: created.session.id,
        status: created.session.status,
        created: true,
        userMessageSynced: true,
        backgroundBuildQueued: Boolean(created.session.latestIteration),
        additionalContext: hookContext(created.session.id, created.session.status),
      };
    }
    const created = await createExternalBuilderSession({
      userId: opts.userId,
      source: opts.source,
      initialRequest: prompt,
      externalConversationId: conversationId,
      requestedAgentName: inferred.requestedAgentName,
    });
    return {
      matched: true,
      sessionId: created.session.id,
      status: created.session.status,
      created: true,
      userMessageSynced: true,
      backgroundBuildQueued: Boolean(created.session.latestIteration),
      additionalContext: hookContext(created.session.id, created.session.status),
    };
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
  row = await findExternalSession(opts.userId, conversationId);
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
  const userMessage = cleanString(opts.lastUserMessage, 24_000);
  if (!conversationId || isInternalBuilderTestPrompt(userMessage)) return { matched: false };

  let row = await findExternalSession(opts.userId, conversationId);
  let created = false;
  if (!row && userMessage && isExplicitAgentBuildPrompt(userMessage)) {
    const result = await createExternalBuilderSession({
      userId: opts.userId,
      source: opts.source,
      initialRequest: userMessage,
      externalConversationId: conversationId,
    });
    row = await findExternalSession(opts.userId, conversationId);
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
    const duplicate = transcript.at(-1)?.role === 'user' && transcript.at(-1)?.content === userMessage;
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
    const duplicate = transcript.at(-1)?.role === 'assistant' && transcript.at(-1)?.content === message;
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

  const iteration = newlySyncedUser && !created
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
}): Promise<{ session: SessionDto; deduplicated: boolean }> {
  const initialRequest = cleanString(opts.initialRequest, 12_000);
  if (!initialRequest) throw errors.badRequest('initialRequest is required');
  const conversationId = cleanString(opts.externalConversationId ?? ulid(), 160);

  let target: { id: string; name: string } | null = null;
  if (opts.targetAgentId) {
    target = await prisma.agent.findFirst({
      where: {
        id: opts.targetAgentId,
        createdBy: opts.userId,
        deletedAt: null,
        systemManaged: false,
      },
      select: { id: true, name: true },
    });
    if (!target) throw errors.notFound('Target agent not found');
  }
  const inference = inferFromPrompt(initialRequest);
  const brief = deepRedactSecrets({
    ...inference.brief,
    requestedAgentName: cleanString(opts.requestedAgentName, 120) || target?.name || inference.brief.requestedAgentName,
    requestedStrategy: target ? 'reuse' : 'create',
    externalSource: opts.source,
    externalConversationId: conversationId,
    externalConversationTitle: cleanString(opts.externalConversationTitle, 240) || undefined,
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
  const persisted = await prisma.$transaction(async (tx) => {
    // Claude hooks can deliver prompt/stop events concurrently. Serialize the
    // same owner + external conversation and re-check while holding the lock,
    // otherwise both requests can pass a read-then-create dedupe check.
    await tx.$queryRaw<Array<{ locked: number }>>`
      WITH conversation_lock AS (
        SELECT pg_advisory_xact_lock(
          hashtext(${opts.userId}),
          hashtext(${`${opts.source}:${conversationId}`})
        )
      )
      SELECT 1::int AS "locked" FROM conversation_lock
    `;
    const existingIds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "AgentBuildSession"
      WHERE "userId" = ${opts.userId}
        AND "brief"->>'externalSource' = ${opts.source}
        AND "brief"->>'externalConversationId' = ${conversationId}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    if (existingIds[0]) {
      const existing = await tx.agentBuildSession.findUniqueOrThrow({
        where: { id: existingIds[0].id },
        include: { iterations: { orderBy: { sequence: 'asc' }, take: 100 } },
      });
      return { row: existing, created: false as const };
    }
    const row = await tx.agentBuildSession.create({
      data: {
        id,
        userId: opts.userId,
        status: 'DISCOVERY',
        transcript: transcript as Prisma.InputJsonValue,
        brief: brief as Prisma.InputJsonValue,
        progress: buildProgress(inference.answered, null) as Prisma.InputJsonValue,
        targetAgentId: target?.id ?? null,
        strategy: target ? 'reuse' : 'create',
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
  });
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

export async function setExternalBuilderName(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  name: string;
}): Promise<SessionDto> {
  const row = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (row.userId !== opts.userId) throw errors.notFound('Session not found');
  if (!['DISCOVERY', 'PLAN_READY'].includes(row.status)) {
    throw errors.conflict(`Cannot rename a build from status=${row.status}`);
  }
  const name = cleanString(opts.name, 120);
  if (name.length < 2) throw errors.badRequest('Agent name must contain at least 2 characters');
  const brief = { ...asBrief(row.brief), requestedAgentName: name } as Brief;
  const plan = asObject(row.plan);
  const latest = await prisma.agentBuildIteration.findFirst({
    where: { sessionId: row.id, status: 'READY' },
    orderBy: { sequence: 'desc' },
  });
  await prisma.$transaction(async (tx) => {
    await tx.agentBuildSession.update({
      where: { id: row.id },
      data: {
        brief: deepRedactSecrets(brief) as Prisma.InputJsonValue,
        ...(plan
          ? {
              plan: deepRedactSecrets({
                ...plan,
                proposedAgentName: name,
                summary: typeof plan.summary === 'string'
                  ? plan.summary.replace(/建立「[^」]+」/, `建立「${name}」`)
                  : plan.summary,
              }) as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    if (latest?.artifactSnapshot) {
      const harness = asObject(latest.artifactSnapshot) ?? {};
      await tx.agentBuildIteration.update({
        where: { id: latest.id },
        data: {
          artifactSnapshot: deepRedactSecrets({
            ...harness,
            identity: { ...(asObject(harness.identity) ?? {}), name },
          }) as Prisma.InputJsonValue,
        },
      });
    }
  });
  await audit(opts.userId, 'agent_builder.name_set', 'AgentBuildSession', row.id, { name });
  return hydratedSession(row.id);
}

export async function requestOwnedAgentRename(opts: {
  agentId: string;
  userId: string;
  name: string;
}) {
  const name = cleanString(opts.name, 120);
  if (name.length < 2) throw errors.badRequest('Agent name must contain at least 2 characters');
  const agent = await prisma.agent.findFirst({
    where: { id: opts.agentId, createdBy: opts.userId, deletedAt: null, systemManaged: false },
    select: { id: true, name: true },
  });
  if (!agent) throw errors.notFound('Agent not found');
  if (agent.name === name) throw errors.conflict('Agent already has this name');
  const pending = await prisma.changeProposal.findMany({
    where: { agentId: agent.id, targetId: agent.id, targetType: 'AGENT', status: 'PENDING' },
  });
  const existing = pending.find((proposal) => {
    const change = asObject(proposal.proposedChange);
    return change?.action === 'rename' && change?.name === name;
  });
  if (existing) return { proposal: existing, deduplicated: true };
  const proposal = await createProposal({
    agentId: agent.id,
    source: 'OPERATOR',
    proposedBy: opts.userId,
    targetType: 'AGENT',
    targetId: agent.id,
    proposedChange: { action: 'rename', name },
    severity: 'low',
    confidence: 1,
  });
  await audit(opts.userId, 'agent.rename_requested', 'ChangeProposal', proposal.id, {
    agentId: agent.id,
    oldName: agent.name,
    newName: name,
  });
  return { proposal, deduplicated: false };
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

  const triggerSummary = cleanString(
    opts.summary ?? (userText || nextTurns.at(-1)?.content),
    2_000,
  );
  const iteration = await createBuilderEvolutionIteration({
    sessionId: row.id,
    triggerKind: /(?:反悔|改成|更改|推翻|取消|修正|不是.{0,12}(?:而是|要))/.test(userText)
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
    targetAgentId = opts.targetAgentId ?? row.builtAgentId ?? row.targetAgentId;
    if (!targetAgentId) throw errors.badRequest('targetAgentId is required for reuse strategy');
    const target = await prisma.agent.findFirst({
      where: { id: targetAgentId, createdBy: row.userId, deletedAt: null, systemManaged: false },
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
