// Agent Builder shadow evolution pipeline.
//
// Every meaningful conversation turn creates an append-only iteration. A
// worker compiles the latest redacted understanding into a non-effective
// Harness snapshot (identity / skills / memory / tools / policies / tests).
// These snapshots are review evidence only: they never mutate live Agent or
// Skill rows until the owner explicitly activates the latest training snapshot.
import { ulid } from 'ulid';
import type { AgentBuildIteration, AgentBuildIterationStatus } from '@prisma/client';
import { prisma } from './db.js';
import { audit } from './audit.js';
import { excludeUnreleasedBuilderAgentsWhere } from './builderrelease.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { runClaude } from '../engine/claude.js';
import { looseParseJson } from '../engine/draft.js';
import { guardBudget, recordCost } from '../engine/cost.js';
import { paths } from '../config.js';
import { hub } from '../ws/hub.js';
import {
  abortBuilderIteration,
  beginBuilderIterationCall,
  combineAbortSignals,
  finishBuilderIterationCall,
  type BuilderClaudeFn,
} from './builderabort.js';
import {
  inferTestInputRequirements,
  normalizeTestInputRequirements,
  type BuilderTestInputRequirement,
} from './buildertestinputs.js';
import { assemblePrompt } from './promptassembly.js';

export type BuilderGeneratedBy = 'model' | 'fallback' | 'questionnaire';

export type EvolutionChange = {
  area: 'identity' | 'skill' | 'memory' | 'tool' | 'policy' | 'test' | 'workflow';
  action: 'added' | 'updated' | 'removed';
  summary: string;
  reason: string;
};

export type DecisionGraph = {
  northStar: string;
  painPoints: string[];
  facts: Array<{ statement: string; source: string }>;
  hypotheses: Array<{ statement: string; confidence: 'low' | 'medium' | 'high' }>;
  decisions: Array<{
    topic: string;
    decision: string;
    status: 'provisional' | 'confirmed' | 'revised';
  }>;
  openBranches: Array<{
    topic: string;
    whyItMatters: string;
    recommendation: string;
  }>;
  contradictions: string[];
  confidence: number;
};

export type HarnessSnapshot = {
  identity: {
    name: string;
    purpose: string;
    department?: string;
    workingStyle: string[];
  };
  /** Optional full markdown authored by an external Builder such as Claude. */
  agentMarkdown?: string;
  /** Optional companion operating notes; remains draft evidence until owner activation. */
  claudeMarkdown?: string;
  skills: Array<{
    name: string;
    purpose: string;
    instructions: string[];
    inputs: string[];
    outputs: string[];
    edgeCases: string[];
    /** Exact SKILL.md draft when the external Builder already authored one. */
    contentMd?: string;
    status: 'DRAFT';
  }>;
  memory: {
    facts: string[];
    preferences: string[];
    glossary: string[];
    documents?: Array<{
      path: string;
      contentMd: string;
      purpose?: string;
    }>;
  };
  tools: Array<{
    name: string;
    purpose: string;
    status: 'AVAILABLE' | 'NEEDS_SETUP' | 'NOT_NEEDED';
  }>;
  policies: {
    allowed: string[];
    requiresApproval: string[];
    forbidden: string[];
  };
  testIdeas: Array<{
    name: string;
    input: string;
    expected: string;
  }>;
  /** Per-Agent fixture contract. The runtime refuses tests until every required item is supplied. */
  testInputRequirements: BuilderTestInputRequirement[];
  workflows?: Array<{
    name: string;
    description: string;
    trigger: Record<string, unknown>;
    durable?: boolean;
    steps: Array<{
      stepKey: string;
      type: 'DO' | 'TOOL' | 'AGENT' | 'CONDITION' | 'NOTIFY' | 'COMPUTER_CONTROL';
      config: Record<string, unknown>;
      verifyRubric?: string | null;
      onFail?: Record<string, unknown> | null;
    }>;
  }>;
  provenance?: {
    source: 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CODEX' | 'CHATGPT' | 'CURSOR' | 'OTHER';
    externalEventId: string;
    syncedAt: string;
  };
  /** How this snapshot was compiled. Stored on artifactSnapshot JSON. */
  generatedBy?: BuilderGeneratedBy;
};

export type EvolutionPayload = {
  understanding: DecisionGraph;
  changes: EvolutionChange[];
  harness: HarnessSnapshot;
  userSummary: string;
  fdeSummary: string;
  suggestTest: boolean;
  generatedBy: BuilderGeneratedBy;
};

export type IterationDto = {
  id: string;
  sequence: number;
  basedOnIterationId: string | null;
  triggerKind: string;
  triggerSummary: string;
  status: AgentBuildIterationStatus;
  understanding: DecisionGraph | null;
  changes: EvolutionChange[];
  harness: HarnessSnapshot | null;
  generatedBy: BuilderGeneratedBy | null;
  userSummary: string | null;
  fdeSummary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown, maxItems = 12, maxLength = 500): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
}

function decisionGraph(value: unknown, fallback: DecisionGraph): DecisionGraph {
  const obj = asObject(value);
  if (!obj) return fallback;
  const facts = Array.isArray(obj.facts)
    ? obj.facts.slice(0, 20).map((item) => {
        const row = asObject(item);
        return {
          statement: String(row?.statement ?? '').trim().slice(0, 600),
          source: String(row?.source ?? '對話').trim().slice(0, 160),
        };
      }).filter((item) => item.statement)
    : fallback.facts;
  const hypotheses = Array.isArray(obj.hypotheses)
    ? obj.hypotheses.slice(0, 16).map((item) => {
        const row = asObject(item);
        const confidence = ['low', 'medium', 'high'].includes(String(row?.confidence))
          ? String(row?.confidence) as 'low' | 'medium' | 'high'
          : 'medium';
        return { statement: String(row?.statement ?? '').trim().slice(0, 600), confidence };
      }).filter((item) => item.statement)
    : fallback.hypotheses;
  const decisions = Array.isArray(obj.decisions)
    ? obj.decisions.slice(0, 24).map((item) => {
        const row = asObject(item);
        const status = ['provisional', 'confirmed', 'revised'].includes(String(row?.status))
          ? String(row?.status) as 'provisional' | 'confirmed' | 'revised'
          : 'provisional';
        return {
          topic: String(row?.topic ?? '').trim().slice(0, 180),
          decision: String(row?.decision ?? '').trim().slice(0, 800),
          status,
        };
      }).filter((item) => item.topic && item.decision)
    : fallback.decisions;
  const openBranches = Array.isArray(obj.openBranches)
    ? obj.openBranches.slice(0, 12).map((item) => {
        const row = asObject(item);
        return {
          topic: String(row?.topic ?? '').trim().slice(0, 180),
          whyItMatters: String(row?.whyItMatters ?? '').trim().slice(0, 500),
          recommendation: String(row?.recommendation ?? '').trim().slice(0, 600),
        };
      }).filter((item) => item.topic && item.whyItMatters)
    : fallback.openBranches;
  return deepRedactSecrets({
    northStar: String(obj.northStar ?? fallback.northStar).trim().slice(0, 1200),
    painPoints: strings(obj.painPoints, 12, 600),
    facts,
    hypotheses,
    decisions,
    openBranches,
    contradictions: strings(obj.contradictions, 10, 600),
    confidence: Math.max(0, Math.min(100, Number(obj.confidence ?? fallback.confidence) || 0)),
  }) as DecisionGraph;
}

function harnessSnapshot(value: unknown, fallback: HarnessSnapshot): HarnessSnapshot {
  const obj = asObject(value);
  if (!obj) return fallback;
  const identity = asObject(obj.identity);
  const memory = asObject(obj.memory);
  const policies = asObject(obj.policies);
  const skills = Array.isArray(obj.skills)
    ? obj.skills.slice(0, 8).map((item) => {
        const row = asObject(item);
        return {
          name: String(row?.name ?? '待命名技能').trim().slice(0, 120),
          purpose: String(row?.purpose ?? '').trim().slice(0, 800),
          instructions: strings(row?.instructions, 16, 600),
          inputs: strings(row?.inputs, 12, 300),
          outputs: strings(row?.outputs, 12, 300),
          edgeCases: strings(row?.edgeCases, 12, 500),
          status: 'DRAFT' as const,
        };
      })
    : fallback.skills;
  const tools = Array.isArray(obj.tools)
    ? obj.tools.slice(0, 16).map((item) => {
        const row = asObject(item);
        const rawStatus = String(row?.status);
        const status = rawStatus === 'AVAILABLE' || rawStatus === 'NOT_NEEDED'
          ? rawStatus as 'AVAILABLE' | 'NOT_NEEDED'
          : 'NEEDS_SETUP' as const;
        return {
          name: String(row?.name ?? '').trim().slice(0, 160),
          purpose: String(row?.purpose ?? '').trim().slice(0, 500),
          status,
        };
      }).filter((item) => item.name)
    : fallback.tools;
  const testIdeas = Array.isArray(obj.testIdeas)
    ? obj.testIdeas.slice(0, 10).map((item) => {
        const row = asObject(item);
        return {
          name: String(row?.name ?? '測試案例').trim().slice(0, 160),
          input: String(row?.input ?? '').trim().slice(0, 1200),
          expected: String(row?.expected ?? '').trim().slice(0, 1200),
        };
      })
    : fallback.testIdeas;
  const explicitRequirements = normalizeTestInputRequirements(obj.testInputRequirements);
  const testInputRequirements = explicitRequirements.length > 0
    ? explicitRequirements
    : fallback.testInputRequirements?.length
      ? fallback.testInputRequirements
      : inferTestInputRequirements({
          identityName: String(identity?.name ?? fallback.identity.name),
          skills,
          testIdeas,
        });
  return deepRedactSecrets({
    identity: {
      name: String(identity?.name ?? fallback.identity.name).trim().slice(0, 120),
      purpose: String(identity?.purpose ?? fallback.identity.purpose).trim().slice(0, 1200),
      department: String(identity?.department ?? fallback.identity.department ?? '').trim().slice(0, 80) || undefined,
      workingStyle: strings(identity?.workingStyle, 12, 500),
    },
    skills,
    memory: {
      facts: strings(memory?.facts, 20, 600),
      preferences: strings(memory?.preferences, 20, 600),
      glossary: strings(memory?.glossary, 20, 300),
    },
    tools,
    policies: {
      allowed: strings(policies?.allowed, 16, 400),
      requiresApproval: strings(policies?.requiresApproval, 16, 500),
      forbidden: strings(policies?.forbidden, 16, 500),
    },
    testIdeas,
    testInputRequirements,
  }) as HarnessSnapshot;
}

function changes(value: unknown, fallback: EvolutionChange[]): EvolutionChange[] {
  if (!Array.isArray(value)) return fallback;
  return deepRedactSecrets(value.slice(0, 20).map((item) => {
    const row = asObject(item);
    const area = ['identity', 'skill', 'memory', 'tool', 'policy', 'test', 'workflow'].includes(String(row?.area))
      ? String(row?.area) as EvolutionChange['area']
      : 'memory';
    const action = ['added', 'updated', 'removed'].includes(String(row?.action))
      ? String(row?.action) as EvolutionChange['action']
      : 'updated';
    return {
      area,
      action,
      summary: String(row?.summary ?? '').trim().slice(0, 500),
      reason: String(row?.reason ?? '').trim().slice(0, 600),
    };
  }).filter((item) => item.summary)) as EvolutionChange[];
}

function asGeneratedBy(value: unknown): BuilderGeneratedBy | null {
  return value === 'model' || value === 'fallback' || value === 'questionnaire'
    ? value
    : null;
}

function readGeneratedBy(snapshot: unknown, changes: unknown): BuilderGeneratedBy | null {
  const fromHarness = asGeneratedBy(asObject(snapshot)?.generatedBy);
  if (fromHarness) return fromHarness;
  if (Array.isArray(changes) && changes.some((item) => (
    String(asObject(item)?.summary ?? '').includes("source:'fallback'")
  ))) {
    return 'fallback';
  }
  return null;
}

function withGeneratedBy(payload: EvolutionPayload, generatedBy: BuilderGeneratedBy): EvolutionPayload {
  return {
    ...payload,
    generatedBy,
    harness: { ...payload.harness, generatedBy },
  };
}

export function toIterationDto(row: AgentBuildIteration): IterationDto {
  const changes = (row.proposedChanges as EvolutionChange[] | null) ?? [];
  return {
    id: row.id,
    sequence: row.sequence,
    basedOnIterationId: row.basedOnIterationId,
    triggerKind: row.triggerKind,
    triggerSummary: row.triggerSummary,
    status: row.status,
    understanding: row.understanding as DecisionGraph | null,
    changes,
    harness: row.artifactSnapshot as HarnessSnapshot | null,
    generatedBy: readGeneratedBy(row.artifactSnapshot, row.proposedChanges),
    userSummary: row.userSummary,
    fdeSummary: row.fdeSummary,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const FALLBACK_PROMPT_LIMIT = 200;
const FALLBACK_SOURCE_MARK = "source:'fallback'";
const FALLBACK_RERUN_MARK = '待模型重跑';

/** Truncate a raw prompt so fallback artifacts never dump the full user text. */
export function fallbackPromptExcerpt(text: string): string {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  const truncated = normalized.length > FALLBACK_PROMPT_LIMIT
    ? `${normalized.slice(0, FALLBACK_PROMPT_LIMIT)}…`
    : normalized;
  return truncated ? `${truncated}（${FALLBACK_RERUN_MARK}）` : `（${FALLBACK_RERUN_MARK}）`;
}

export function fallbackPayload(session: {
  brief: unknown;
  transcript: unknown;
}, previous: AgentBuildIteration | null, triggerSummary: string, triggerKind: string): EvolutionPayload {
  const brief = asObject(session.brief) ?? {};
  const excerpt = fallbackPromptExcerpt(triggerSummary);
  const objective = String(brief.objective ?? excerpt).trim().slice(0, 1200);
  const name = String(brief.requestedAgentName ?? '持續學習中的 AI 員工').trim().slice(0, 120);
  const priorHarness = previous?.artifactSnapshot as HarnessSnapshot | null;
  const priorGraph = previous?.understanding as DecisionGraph | null;
  const isCorrection = triggerKind === 'correction' && previous !== null;
  const isReflection = triggerKind === 'reflection' && previous !== null;
  const asksForTest = triggerKind === 'test' || /(?:測試|試跑|跑跑看)/.test(triggerSummary);
  const previousDecisions = priorGraph?.decisions ?? [];
  const processInstruction = String(brief.process ?? '依目前對話理解處理，遇到不確定處停下確認');
  const clippedProcessInstruction = processInstruction.length > FALLBACK_PROMPT_LIMIT
    ? fallbackPromptExcerpt(processInstruction)
    : processInstruction;
  const graph: DecisionGraph = {
    northStar: objective,
    painPoints: priorGraph?.painPoints ?? [objective],
    facts: [
      ...(priorGraph?.facts ?? []),
      {
        statement: excerpt,
        source: 'fallback',
      },
    ].slice(-20),
    hypotheses: priorGraph?.hypotheses ?? [],
    decisions: isCorrection
      ? [
          ...previousDecisions.map((decision) => decision.status !== 'revised'
            ? { ...decision, status: 'revised' as const }
            : decision),
          { topic: '使用者修正', decision: excerpt, status: 'confirmed' as const },
        ].slice(-24)
      : [
          ...previousDecisions,
          {
            topic: isReflection ? '對話後反思' : asksForTest ? '測試方向' : '本輪理解',
            decision: excerpt,
            status: asksForTest ? 'confirmed' as const : 'provisional' as const,
          },
        ].slice(-24),
    openBranches: priorGraph?.openBranches ?? [],
    contradictions: priorGraph?.contradictions ?? [],
    confidence: Math.min(90, (priorGraph?.confidence ?? 20) + 8),
  };
  const baseHarness: HarnessSnapshot = priorHarness ?? {
    identity: { name, purpose: objective, workingStyle: ['先理解情境，再提出建議', '不確定時向使用者確認'] },
    skills: [{
      name: `${name}核心能力`,
      purpose: String(brief.process ?? objective).slice(0, 800),
      instructions: [clippedProcessInstruction],
      inputs: [String(brief.inputs ?? brief.sources ?? '依使用者當次提供的資訊')],
      outputs: [String(brief.outputs ?? '提供可人工覆核的結果')],
      edgeCases: [String(brief.exceptions ?? '資料不足或結果不確定時標示待確認')],
      status: 'DRAFT',
    }],
    memory: {
      facts: [excerpt],
      preferences: [String(brief.outputs ?? '輸出形式仍可在後續對話調整')],
      glossary: [],
    },
    tools: [],
    policies: {
      allowed: ['讀取使用者明確提供的資訊', '產生草稿與分析'],
      requiresApproval: ['寄送、寫入外部系統與不可逆操作'],
      forbidden: ['未經使用者連線或授權即宣稱外部工具可用'],
    },
    testIdeas: [],
    testInputRequirements: inferTestInputRequirements({
      identityName: name,
      skills: [{ inputs: [String(brief.inputs ?? brief.sources ?? '依使用者當次提供的資訊')] }],
      testIdeas: [],
    }),
  };
  const learningInstruction = `${isCorrection ? '目前有效規則' : isReflection ? '對話反思後的 Shadow 規則' : '本輪補充'}：${excerpt}`;
  const harness: HarnessSnapshot = {
    ...baseHarness,
    identity: { ...baseHarness.identity },
    skills: baseHarness.skills.map((skill, index) => index === 0
      ? {
          ...skill,
          instructions: [...skill.instructions.filter((item) => item !== learningInstruction), learningInstruction].slice(-16),
          status: 'DRAFT' as const,
        }
      : { ...skill, status: 'DRAFT' as const }),
    memory: {
      ...baseHarness.memory,
      facts: [...baseHarness.memory.facts.filter((item) => item !== triggerSummary && item !== excerpt), excerpt].slice(-30),
      preferences: isCorrection
        ? [...baseHarness.memory.preferences, `以最新規則為準：${excerpt}`].slice(-20)
        : [...baseHarness.memory.preferences],
    },
    tools: baseHarness.tools.map((tool) => ({ ...tool })),
    policies: {
      allowed: [...baseHarness.policies.allowed],
      requiresApproval: [...baseHarness.policies.requiresApproval],
      forbidden: [...baseHarness.policies.forbidden],
    },
    testIdeas: asksForTest
      ? [
          {
            name: '核心規則安全測試',
            input: [
              '案例 A：交易序號唯一且一對一。',
              '案例 B：一筆銀行款對到兩張發票。',
              '案例 C：沒有交易序號，只有日期與金額相近。',
            ].join('\n'),
            expected: '案例 A 可形成明確配對草稿；案例 B、C 必須列入候選清單並要求人工確認，不得自動完成或寫回外部系統。',
          },
          ...baseHarness.testIdeas,
        ].slice(0, 8)
      : [...baseHarness.testIdeas],
    testInputRequirements: baseHarness.testInputRequirements?.length
      ? [...baseHarness.testInputRequirements]
      : inferTestInputRequirements({
          identityName: baseHarness.identity.name,
          skills: baseHarness.skills,
          testIdeas: baseHarness.testIdeas,
        }),
  };
  const changeArea = isReflection ? 'skill' : isCorrection ? 'workflow' : asksForTest ? 'test' : previous ? 'memory' : 'identity';
  const changeSummary = isCorrection
    ? '依使用者最新說法修正先前的工作方式'
    : isReflection ? '依完整對話反思並更新 Shadow Skill 規則'
    : asksForTest ? '建立核心規則測試案例'
    : previous ? '把本輪新資訊加入員工草稿' : '建立第一版員工草稿';
  const payload: EvolutionPayload = {
    understanding: graph,
    changes: [{
      area: changeArea,
      action: previous ? 'updated' : 'added',
      summary: `${FALLBACK_SOURCE_MARK}。${changeSummary}`,
      reason: excerpt,
    }],
    harness,
    userSummary: previous ? '我已把你剛補充的內容整理進這位員工的學習草稿。' : '我已先建立這位員工的第一版學習草稿，後續對話會持續更新。',
    fdeSummary: `依去敏後的本輪對話建立草稿：${triggerSummary.slice(0, 500)}`,
    suggestTest: graph.confidence >= 65,
    generatedBy: 'fallback',
  };
  return withGeneratedBy(payload, 'fallback');
}

async function catalogContext(userId: string) {
  const unreleasedWhere = await excludeUnreleasedBuilderAgentsWhere();
  const [agents, skills, accounts, mcp] = await Promise.all([
    prisma.agent.findMany({
      where: { deletedAt: null, systemManaged: false, ...unreleasedWhere },
      select: { name: true, description: true, status: true },
      take: 30,
    }),
    prisma.skill.findMany({
      where: { deletedAt: null, reviewStatus: 'CONFIRMED' },
      select: { name: true, understanding: true },
      take: 40,
    }),
    prisma.connectedAccount.findMany({
      where: { userId, status: 'CONNECTED' },
      select: { provider: true, scopes: true },
    }),
    prisma.mcpServerRegistry.findMany({
      where: { enabled: true },
      select: { name: true, healthStatus: true },
      take: 30,
    }),
  ]);
  return deepRedactSecrets({ agents, skills, accounts, mcp });
}

function isNotBuildTurn(raw: unknown): boolean {
  return asObject(raw)?.notBuildTurn === true;
}

function validatePayload(raw: unknown, fallback: EvolutionPayload): EvolutionPayload {
  const obj = asObject(raw);
  if (!obj) return fallback;
  const userSummary = typeof obj.userSummary === 'string' && obj.userSummary.trim()
    ? obj.userSummary.trim().slice(0, 1200)
    : fallback.userSummary;
  const maintenanceSummary = typeof obj.maintenanceSummary === 'string'
    ? obj.maintenanceSummary
    : obj.fdeSummary;
  const fdeSummary = typeof maintenanceSummary === 'string' && maintenanceSummary.trim()
    ? maintenanceSummary.trim().slice(0, 3000)
    : fallback.fdeSummary;
  return deepRedactSecrets({
    understanding: decisionGraph(obj.understanding, fallback.understanding),
    changes: changes(obj.changes, fallback.changes),
    harness: harnessSnapshot(obj.harness, fallback.harness),
    userSummary,
    fdeSummary,
    suggestTest: obj.suggestTest === true,
    generatedBy: fallback.generatedBy,
  }) as EvolutionPayload;
}

export async function processBuilderEvolution(
  iterationId: string,
  deps?: { runClaudeFn?: BuilderClaudeFn; signal?: AbortSignal },
): Promise<void> {
  const staleBefore = new Date(Date.now() - 30_000);
  const claimed = await prisma.agentBuildIteration.updateMany({
    where: {
      id: iterationId,
      OR: [
        { status: 'QUEUED' },
        {
          status: { in: ['ANALYZING', 'BUILDING'] },
          updatedAt: { lt: staleBefore },
        },
      ],
    },
    data: { status: 'ANALYZING', startedAt: new Date(), error: null },
  });
  if (claimed.count !== 1) return;

  const iteration = await prisma.agentBuildIteration.findUnique({
    where: { id: iterationId },
    include: { session: true },
  });
  if (!iteration) return;
  if (iteration.session.status === 'ABANDONED') return;

  const registered = beginBuilderIterationCall(iteration.sessionId, iteration.id);
  const signal = combineAbortSignals([deps?.signal, registered.signal]);
  const execute = deps?.runClaudeFn ?? runClaude;
  const skipLiveSideEffects = Boolean(deps?.runClaudeFn);

  try {
    if (signal?.aborted) return;
    const previous = await prisma.agentBuildIteration.findFirst({
      where: {
        sessionId: iteration.sessionId,
        sequence: { lt: iteration.sequence },
        status: 'READY',
      },
      orderBy: { sequence: 'desc' },
    });
    const fallback = fallbackPayload(iteration.session, previous, iteration.triggerSummary, iteration.triggerKind);
    let payload = fallback;

    if (process.env.AIOS_BUILDER_EVOLUTION_MODEL !== 'off') {
      const safeSession = deepRedactSecrets({
        brief: iteration.session.brief,
        conversation: Array.isArray(iteration.session.transcript)
          ? iteration.session.transcript.slice(-14)
          : [],
        sourceFiles: (() => {
          const brief = asObject(iteration.session.brief);
          const files = Array.isArray(brief?.sourceFiles) ? brief.sourceFiles : [];
          return files.slice(0, 6).map((file) => {
            const row = asObject(file);
            return {
              name: String(row?.name ?? 'source'),
              content: String(row?.content ?? '').slice(0, 12_000),
            };
          });
        })(),
        previousUnderstanding: previous?.understanding ?? null,
        previousHarness: previous?.artifactSnapshot ?? null,
        realCatalog: skipLiveSideEffects ? {} : await catalogContext(iteration.session.userId),
        trigger: iteration.triggerSummary,
      });
      const contextJson = JSON.stringify(safeSession);
      let systemPrompt = '';
      let userTurn = contextJson;
      let assembledOk = false;
      try {
        const assembled = assemblePrompt({
          stage: 'evolution',
          vars: {},
          contextMessage: contextJson,
        });
        systemPrompt = assembled.systemPrompt;
        userTurn = assembled.contextMessage ?? contextJson;
        assembledOk = true;
      } catch (err) {
        console.warn('[builder-evolution] prompt assembly failed; using fallback', err);
      }
      if (assembledOk) {
        const costInput = systemPrompt ? `${systemPrompt}\n\n${userTurn}` : userTurn;
        try {
          if (signal?.aborted) return;
          let advisorId: string | undefined;
          if (!skipLiveSideEffects) {
            const { ensureBuilderAdvisor } = await import('./agentbuilder.js');
            const advisor = await ensureBuilderAdvisor();
            await guardBudget(advisor.id, advisor.costPolicy);
            advisorId = advisor.id;
          }
          const result = await execute({
            prompt: userTurn,
            systemAppend: systemPrompt,
            cwd: paths.cache,
            // This runs behind the conversation, but it must still keep up with an
            // active interview. A deterministic compiler below preserves progress
            // when the local model is unavailable or stalls.
            timeoutMs: 20_000,
            disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Task'],
            signal,
          });
          if (signal?.aborted) return;
          if (advisorId) {
            await recordCost({
              agentId: advisorId,
              engine: 'CLAUDE_CODE',
              inputText: costInput,
              outputText: result.stdout,
              stepKey: 'builder.evolution',
            }).catch(() => {});
          }
          const raw = looseParseJson(result.stdout);
          if (isNotBuildTurn(raw)) {
            console.info('[builder-evolution] notBuildTurn: skipped draft', {
              iterationId: iteration.id,
              sessionId: iteration.sessionId,
              sequence: iteration.sequence,
            });
            const liveSession = await prisma.agentBuildSession.findUnique({
              where: { id: iteration.sessionId },
              select: { status: true },
            });
            if (!liveSession || liveSession.status === 'ABANDONED') return;
            await prisma.agentBuildIteration.updateMany({
              where: { id: iteration.id, status: 'ANALYZING' },
              data: { status: 'SUPERSEDED', completedAt: new Date() },
            });
            return;
          }
          payload = asObject(raw)
            ? withGeneratedBy(validatePayload(raw, fallback), 'model')
            : fallback;
        } catch {
          if (signal?.aborted) return;
          payload = fallback;
        }
      }
    }

    if (signal?.aborted) return;
    const liveSession = await prisma.agentBuildSession.findUnique({
      where: { id: iteration.sessionId },
      select: { status: true },
    });
    if (!liveSession || liveSession.status === 'ABANDONED') return;

    const building = await prisma.agentBuildIteration.updateMany({
      where: { id: iteration.id, status: 'ANALYZING' },
      data: {
        status: 'BUILDING',
        understanding: payload.understanding as object,
        proposedChanges: payload.changes as object[],
        artifactSnapshot: payload.harness as object,
      },
    });
    if (building.count !== 1) return;
    const ready = await prisma.agentBuildIteration.updateMany({
      where: { id: iteration.id, status: 'BUILDING' },
      data: {
        status: 'READY',
        userSummary: payload.userSummary,
        fdeSummary: payload.fdeSummary,
        completedAt: new Date(),
      },
    });
    if (ready.count !== 1) return;
    await audit(iteration.session.userId, 'agent_builder.iteration_ready', 'AgentBuildIteration', iteration.id, {
      sessionId: iteration.sessionId,
      sequence: iteration.sequence,
      changes: payload.changes.map((change) => ({ area: change.area, action: change.action })),
      suggestTest: payload.suggestTest,
      generatedBy: payload.generatedBy,
    });
    hub.publishToUser(iteration.session.userId, 'agent-builder.iteration.ready', {
      sessionId: iteration.sessionId,
      iterationId: iteration.id,
      sequence: iteration.sequence,
      at: new Date().toISOString(),
    });
  } catch (error) {
    if (signal?.aborted) return;
    const message = String(deepRedactSecrets(error instanceof Error ? error.message : String(error))).slice(0, 1000);
    await prisma.agentBuildIteration.updateMany({
      where: { id: iterationId, status: { in: ['ANALYZING', 'BUILDING'] } },
      data: { status: 'FAILED', error: message, completedAt: new Date() },
    }).catch(() => {});
    await audit(iteration.session.userId, 'agent_builder.iteration_failed', 'AgentBuildIteration', iterationId, {
      sessionId: iteration.sessionId,
      error: message,
    }).catch(() => {});
    hub.publishToUser(iteration.session.userId, 'agent-builder.iteration.failed', {
      sessionId: iteration.sessionId,
      iterationId,
      at: new Date().toISOString(),
    });
  } finally {
    finishBuilderIterationCall(iteration.sessionId, iteration.id, registered);
  }
}

async function nextSequence(sessionId: string): Promise<{ sequence: number; previousId: string | null }> {
  const previous = await prisma.agentBuildIteration.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true },
  });
  return { sequence: (previous?.sequence ?? 0) + 1, previousId: previous?.id ?? null };
}

export async function createBuilderEvolutionIteration(opts: {
  sessionId: string;
  triggerKind: 'message' | 'file' | 'correction' | 'test' | 'reflection';
  triggerSummary: string;
}): Promise<IterationDto> {
  const safeSummary = String(deepRedactSecrets(opts.triggerSummary)).trim().slice(0, 2000);
  let row: AgentBuildIteration | null = null;
  for (let attempt = 0; attempt < 2 && !row; attempt += 1) {
    const next = await nextSequence(opts.sessionId);
    try {
      row = await prisma.agentBuildIteration.create({
        data: {
          id: ulid(),
          sessionId: opts.sessionId,
          sequence: next.sequence,
          basedOnIterationId: next.previousId,
          triggerKind: opts.triggerKind,
          triggerSummary: safeSummary || opts.triggerKind,
          status: 'QUEUED',
        },
      });
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  if (!row) throw new Error('Failed to create Agent Builder iteration');

  // Supersede older work that has not produced a reviewable snapshot yet,
  // including in-flight ANALYZING/BUILDING compilers, and abort their CLI.
  const stale = await prisma.agentBuildIteration.findMany({
    where: {
      sessionId: opts.sessionId,
      sequence: { lt: row.sequence },
      status: { in: ['QUEUED', 'ANALYZING', 'BUILDING'] },
    },
    select: { id: true },
  }).catch(() => [] as Array<{ id: string }>);
  if (stale.length > 0) {
    await prisma.agentBuildIteration.updateMany({
      where: { id: { in: stale.map((item) => item.id) } },
      data: { status: 'SUPERSEDED', completedAt: new Date() },
    }).catch(() => {});
    for (const item of stale) abortBuilderIteration(item.id);
  }

  if (process.env.AIOS_BUILDER_EVOLUTION_QUEUE === 'off') {
    return toIterationDto(row);
  }

  try {
    const { enqueueBuilderEvolution } = await import('../scheduler/index.js');
    const queued = await enqueueBuilderEvolution(row.id);
    if (!queued) {
      setImmediate(() => void processBuilderEvolution(row!.id));
    }
  } catch {
    setImmediate(() => void processBuilderEvolution(row!.id));
  }
  return toIterationDto(row);
}
