// Agent Builder shadow evolution pipeline.
//
// Every meaningful conversation turn creates an append-only iteration. A
// worker compiles the latest redacted understanding into a non-effective
// Harness snapshot (identity / skills / memory / tools / policies / tests).
// These snapshots are review evidence only: they never mutate live Agent or
// Skill rows and therefore never bypass the existing FDE gates.
import { ulid } from 'ulid';
import type { AgentBuildIteration, AgentBuildIterationStatus } from '@prisma/client';
import { prisma } from './db.js';
import { audit } from './audit.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { runClaude } from '../engine/claude.js';
import { looseParseJson } from '../engine/draft.js';
import { guardBudget, recordCost } from '../engine/cost.js';
import { paths } from '../config.js';
import { hub } from '../ws/hub.js';
import {
  inferTestInputRequirements,
  normalizeTestInputRequirements,
  type BuilderTestInputRequirement,
} from './buildertestinputs.js';

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
    workingStyle: string[];
  };
  /** Optional full markdown authored by an external Builder such as Claude. */
  agentMarkdown?: string;
  /** Optional companion operating notes; remains draft evidence until FDE promotion. */
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
    status: 'AVAILABLE' | 'NEEDS_FDE' | 'NOT_NEEDED';
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
    source: 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CHATGPT' | 'CURSOR' | 'OTHER';
    externalEventId: string;
    syncedAt: string;
  };
};

export type EvolutionPayload = {
  understanding: DecisionGraph;
  changes: EvolutionChange[];
  harness: HarnessSnapshot;
  userSummary: string;
  fdeSummary: string;
  suggestTest: boolean;
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
        const status = ['AVAILABLE', 'NEEDS_FDE', 'NOT_NEEDED'].includes(String(row?.status))
          ? String(row?.status) as 'AVAILABLE' | 'NEEDS_FDE' | 'NOT_NEEDED'
          : 'NEEDS_FDE';
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

export function toIterationDto(row: AgentBuildIteration): IterationDto {
  return {
    id: row.id,
    sequence: row.sequence,
    basedOnIterationId: row.basedOnIterationId,
    triggerKind: row.triggerKind,
    triggerSummary: row.triggerSummary,
    status: row.status,
    understanding: row.understanding as DecisionGraph | null,
    changes: (row.proposedChanges as EvolutionChange[] | null) ?? [],
    harness: row.artifactSnapshot as HarnessSnapshot | null,
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
      forbidden: ['未經 FDE 核准即啟用新能力'],
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
  return {
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
  };
}

async function catalogContext(userId: string) {
  const [agents, skills, accounts, mcp] = await Promise.all([
    prisma.agent.findMany({
      where: { deletedAt: null, systemManaged: false },
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

function validatePayload(raw: unknown, fallback: EvolutionPayload): EvolutionPayload {
  const obj = asObject(raw);
  if (!obj) return fallback;
  const userSummary = typeof obj.userSummary === 'string' && obj.userSummary.trim()
    ? obj.userSummary.trim().slice(0, 1200)
    : fallback.userSummary;
  const fdeSummary = typeof obj.fdeSummary === 'string' && obj.fdeSummary.trim()
    ? obj.fdeSummary.trim().slice(0, 3000)
    : fallback.fdeSummary;
  return deepRedactSecrets({
    understanding: decisionGraph(obj.understanding, fallback.understanding),
    changes: changes(obj.changes, fallback.changes),
    harness: harnessSnapshot(obj.harness, fallback.harness),
    userSummary,
    fdeSummary,
    suggestTest: obj.suggestTest === true,
  }) as EvolutionPayload;
}

export async function processBuilderEvolution(iterationId: string): Promise<void> {
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

  try {
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
      const { ensureBuilderAdvisor } = await import('./agentbuilder.js');
      const advisor = await ensureBuilderAdvisor();
      await guardBudget(advisor.id, advisor.costPolicy);
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
        realCatalog: await catalogContext(iteration.session.userId),
        trigger: iteration.triggerSummary,
      });
      const prompt = [
        '你是 AIOS 的「員工演進建築師」。使用者仍在聊天，請把本輪新理解編譯成下一版非生效 Agent 草稿。',
        '這不是固定欄位表單。請建立決策圖，辨認痛點、事實、假設、已決定事項、反悔／矛盾與仍需探索的分支。',
        '能從已解析檔案或 realCatalog 得知的事實直接使用，不要把它列成要反問使用者的問題。',
        '若新資訊推翻舊決定，將舊決定標成 revised，並在 changes 清楚說明。不得偷偷保留互相衝突的做法。',
        'triggerKind=reflection 時，必須檢查完整的使用者輸入、Agent 行為與使用者回饋：把可重複的必要欄位、輸出格式、判斷規則、例外處理與防止重犯的測試更新到 Shadow Skill。Agent 自己聲稱「已了解」不是事實；沒有使用者證據時只能列 hypothesis，不能提升為 confirmed rule。',
        'Harness 是 shadow draft：可更新 identity、skills、memory、tools、policies、testIdeas、testInputRequirements，但絕不可聲稱已啟用或已取得權限。',
        'testInputRequirements 必須依這位員工的真實工作資料定義；每項包含 key、label、description、kind(FILE|TEXT)、required、acceptedExtensions、minFiles、maxFiles。不要把選填資料誤標必填。',
        '工具只有 realCatalog 明確存在且健康時才能標 AVAILABLE；否則一律 NEEDS_FDE。',
        '對 End User 的 userSummary 不得出現 Harness、manifest、MCP、engine、JSON 等技術詞，只說這位員工這次學會或調整了什麼。',
        'FDE 摘要必須記錄新增、修改、移除與矛盾，便於日後審查。',
        '所有技能 status 必須是 DRAFT。寄信、雲端寫入、電腦操作、不可逆動作必須列入 requiresApproval。',
        '輸出純 JSON，鍵為 understanding、changes、harness、userSummary、fdeSummary、suggestTest。',
        '',
        JSON.stringify(safeSession),
      ].join('\n');
      try {
        const result = await runClaude({
          prompt,
          cwd: paths.cache,
          // This runs behind the conversation, but it must still keep up with an
          // active interview. A deterministic compiler below preserves progress
          // when the local model is unavailable or stalls.
          timeoutMs: 20_000,
          disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Task'],
        });
        await recordCost({
          agentId: advisor.id,
          engine: 'CLAUDE_CODE',
          inputText: prompt,
          outputText: result.stdout,
          stepKey: 'builder.evolution',
        }).catch(() => {});
        payload = validatePayload(looseParseJson(result.stdout), fallback);
      } catch {
        payload = fallback;
      }
    }

    await prisma.agentBuildIteration.update({
      where: { id: iteration.id },
      data: {
        status: 'BUILDING',
        understanding: payload.understanding as object,
        proposedChanges: payload.changes as object[],
        artifactSnapshot: payload.harness as object,
      },
    });
    const ready = await prisma.agentBuildIteration.update({
      where: { id: iteration.id },
      data: {
        status: 'READY',
        userSummary: payload.userSummary,
        fdeSummary: payload.fdeSummary,
        completedAt: new Date(),
      },
    });
    await audit(iteration.session.userId, 'agent_builder.iteration_ready', 'AgentBuildIteration', iteration.id, {
      sessionId: iteration.sessionId,
      sequence: iteration.sequence,
      changes: payload.changes.map((change) => ({ area: change.area, action: change.action })),
      suggestTest: payload.suggestTest,
    });
    hub.publishToUser(iteration.session.userId, 'agent-builder.iteration.ready', {
      sessionId: iteration.sessionId,
      iterationId: ready.id,
      sequence: ready.sequence,
      at: new Date().toISOString(),
    });
  } catch (error) {
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

  // Supersede only older work that has not produced a reviewable snapshot yet.
  await prisma.agentBuildIteration.updateMany({
    where: {
      sessionId: opts.sessionId,
      sequence: { lt: row.sequence },
      status: 'QUEUED',
    },
    data: { status: 'SUPERSEDED', completedAt: new Date() },
  }).catch(() => {});

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
