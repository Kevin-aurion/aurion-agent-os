/** Shared types for Agent Workbench (chat + teach). Mirrors employee detail shapes. */

export interface AgentListItem {
  id: string;
  name: string;
  description: string;
  department?: string | null;
  avatar?: string | null;
  status: string;
  skillCount: number;
  workflowCount: number;
}

export interface AgentSkillRef {
  agentId: string;
  skillId: string;
  skill: {
    id: string;
    name: string;
    reviewStatus: string;
    kind: string;
    executionEnv?: string;
  };
}

export interface AgentDetail {
  id: string;
  name: string;
  description: string;
  department?: string | null;
  rolePrompt: string;
  avatar?: string | null;
  status: string;
  skills: AgentSkillRef[];
  restrictions?: {
    webSearch?: boolean;
    computerUse?: boolean;
    sendEmail?: boolean;
    cloudWrite?: boolean;
    shell?: boolean;
    notes?: string;
  } | null;
}

export interface Conversation {
  id: string;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  id: string;
  role?: string;
  sender?: string;
  content: string;
  createdAt?: string;
  runId?: string | null;
}

/** Live step from hub `run.step` — backend publishes `phase`, not `status`. */
export interface RunStep {
  stepKey: string;
  round?: number;
  /** Backend field: executing | verifying | approved | rejected | awaiting_review | … */
  phase: string;
  verdict?: string;
}

export interface RunListItem {
  id: string;
  agentId: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** Terminal run.step phases (stop spinner). */
export const TERMINAL_RUN_PHASES = new Set([
  'approved',
  'rejected',
  'failed',
  'error',
  'succeeded',
  'cancelled',
  'skipped',
  'timeout',
]);

/** Skill.understanding JSON (backend src/skills/understand.ts). */
export interface SkillUnderstanding {
  summary: string;
  capabilities: string[];
  data_read: string[];
  data_written: string[];
  external_calls: string[];
  irreversible_actions: string[];
  risks: string[];
}

export interface SkillDetail {
  id: string;
  name: string;
  reviewStatus: string;
  executionEnv?: string;
  understanding?: SkillUnderstanding | null;
}

export interface TrainMessageResult {
  skillId: string;
  contentMd: string;
  reviewStatus: string;
  understanding: SkillUnderstanding | null;
}

export interface AgentFlows {
  skills: Array<{ id: string; name: string; summary: string; reviewStatus: string }>;
  workflows: Array<{ id: string; name: string; trigger: string }>;
}

/** Safe client view of a durable RecordingSession (opaque ids only — no paths). */
export interface RecordingSessionView {
  id: string;
  agentId?: string | null;
  status: string; // RECORDING | STOPPED | COMPILING | RECORDED | INTERRUPTED | FAILED
  artifactId?: string | null;
  skillId?: string | null;
  createdAt?: string;
  stoppedAt?: string | null;
  compiledAt?: string | null;
}

export interface RecordingStatus {
  recording?: boolean;
  isRecording?: boolean;
  active?: boolean;
  status?: string;
  /** Durable server-owned session (opaque ids only). */
  session?: RecordingSessionView | null;
  /** Best-effort live probe from event-stream (only while RECORDING). */
  live?: unknown;
  [key: string]: unknown;
}

/** @deprecated S1-4b: teach merged into work conversation; builder is left-rail only. */
export type WorkbenchMode = 'work' | 'teach';

export type TeachChatMsg =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'system'; text: string }
  | { id: string; kind: 'drafting' }
  | {
      id: string;
      kind: 'draft';
      skillId: string;
      name: string;
      reviewStatus: string;
      understanding: SkillUnderstanding | null;
      statusNote?: string;
    }
  | {
      id: string;
      kind: 'flows';
      skills: AgentFlows['skills'];
      workflows: AgentFlows['workflows'];
    }
  | {
      id: string;
      kind: 'error';
      text: string;
      /** Present when train/message failed and the user may resend the same payload. */
      retry?: { message: string; display?: string };
    };

export function normalizeUnderstanding(raw: unknown): SkillUnderstanding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    capabilities: arr(o.capabilities),
    data_read: arr(o.data_read),
    data_written: arr(o.data_written),
    external_calls: arr(o.external_calls),
    irreversible_actions: arr(o.irreversible_actions),
    risks: arr(o.risks),
  };
}

export function parseSkillNameFromMd(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?^name:\s*["']?(.+?)["']?\s*$/m);
  return m?.[1]?.trim() || '技能草稿';
}

const NON_ACTIVE_SESSION_STATUSES = new Set([
  'STOPPED',
  'COMPILING',
  'RECORDED',
  'INTERRUPTED',
  'FAILED',
]);

export function isRecordingActive(s: RecordingStatus | undefined): boolean {
  if (!s) return false;
  // Durable session status is authoritative when present.
  if (s.session?.status === 'RECORDING') return true;
  if (s.session?.status && NON_ACTIVE_SESSION_STATUSES.has(s.session.status)) return false;
  // Legacy fields (pre–RecordingSession).
  if (s.recording === true || s.isRecording === true || s.active === true) return true;
  if (typeof s.status === 'string' && /record|active|running/i.test(s.status)) return true;
  return false;
}

export function recordingSessionStatus(s: RecordingStatus | undefined): string | null {
  return s?.session?.status ?? null;
}

// ── Agent Builder (CEO-friendly factory; mirrors backend SessionDto, no engines) ─

export type BuilderBriefFieldKey =
  | 'objective'
  | 'inputs'
  | 'outputs'
  | 'process'
  | 'exceptions'
  | 'permissions'
  | 'testData';

export type BuilderGeneratedBy = 'model' | 'fallback' | 'questionnaire';

export function generatedByLabel(value?: string | null): string | null {
  if (value === 'fallback') return '規則兜底';
  if (value === 'questionnaire') return '固定問卷';
  if (value === 'model') return '模型產生';
  return null;
}

export function generatedByBadgeClass(value?: string | null): string {
  if (value === 'fallback') return 'bg-amber-500/15 text-amber-600 dark:text-amber-300';
  if (value === 'questionnaire') return 'bg-zinc-500/15 text-zinc-500';
  if (value === 'model') return 'bg-sky-500/15 text-sky-600 dark:text-sky-300';
  return 'bg-black/5 text-muted';
}

export function draftGeneratedBy(session: { iterations: BuilderIteration[] }): BuilderGeneratedBy | undefined {
  const ranked = [...session.iterations].sort((a, b) => b.sequence - a.sequence);
  const latest = ranked.find((iteration) => iteration.status === 'READY')
    ?? ranked.find((iteration) => iteration.harness || iteration.generatedBy);
  const value = latest?.generatedBy ?? latest?.harness?.generatedBy;
  if (value === 'model' || value === 'fallback' || value === 'questionnaire') return value;
  if (latest?.changes.some((change) => change.summary.includes("source:'fallback'"))) return 'fallback';
  return undefined;
}

export type BuilderProgress = {
  answeredKeys: BuilderBriefFieldKey[] | string[];
  currentKey: BuilderBriefFieldKey | string | null;
  total: number;
  percent: number;
  turn?: {
    key: BuilderBriefFieldKey | string;
    context: string;
    question: string;
    suggestions: string[];
    recommendation?: string;
    whyThisMatters?: string;
    intent?: 'explore' | 'clarify' | 'resolve_conflict' | 'offer_test' | 'confirm_build';
    sourceAdvice: {
      mode: 'hidden' | 'optional' | 'recommended';
      reason: string;
    };
    generatedBy?: BuilderGeneratedBy;
  } | null;
  mode?: 'grill';
};

export type BuilderEvolutionChange = {
  area: 'identity' | 'skill' | 'memory' | 'tool' | 'policy' | 'test' | 'workflow';
  action: 'added' | 'updated' | 'removed';
  summary: string;
  reason: string;
};

export type BuilderDecisionGraph = {
  northStar: string;
  painPoints: string[];
  facts: Array<{ statement: string; source: string }>;
  hypotheses: Array<{ statement: string; confidence: 'low' | 'medium' | 'high' }>;
  decisions: Array<{ topic: string; decision: string; status: 'provisional' | 'confirmed' | 'revised' }>;
  openBranches: Array<{ topic: string; whyItMatters: string; recommendation: string }>;
  contradictions: string[];
  confidence: number;
};

export type BuilderHarnessSnapshot = {
  identity: { name: string; purpose: string; workingStyle: string[] };
  agentMarkdown?: string;
  claudeMarkdown?: string;
  skills: Array<{
    name: string;
    purpose: string;
    instructions: string[];
    inputs: string[];
    outputs: string[];
    edgeCases: string[];
    contentMd?: string;
    status: 'DRAFT';
  }>;
  memory: {
    facts: string[];
    preferences: string[];
    glossary: string[];
    documents?: Array<{ path: string; contentMd: string; purpose?: string }>;
  };
  tools: Array<{ name: string; purpose: string; status: 'AVAILABLE' | 'NEEDS_FDE' | 'NOT_NEEDED' }>;
  policies: { allowed: string[]; requiresApproval: string[]; forbidden: string[] };
  testIdeas: Array<{ name: string; input: string; expected: string }>;
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
  generatedBy?: BuilderGeneratedBy;
};

export type BuilderTestInputRequirement = {
  key: string;
  label: string;
  description: string;
  kind: 'FILE' | 'TEXT';
  required: boolean;
  acceptedExtensions: string[];
  minFiles: number;
  maxFiles: number;
};

export type BuilderTestInputStatus = {
  requirements: Array<BuilderTestInputRequirement & {
    suppliedCount: number;
    supplied: boolean;
    files: Array<{ id: string; name: string; mimeType: string; size: number; uploadedAt: string }>;
  }>;
  complete: boolean;
  missingRequiredKeys: string[];
};

export type BuilderIteration = {
  id: string;
  sequence: number;
  basedOnIterationId: string | null;
  triggerKind: string;
  triggerSummary: string;
  status: 'QUEUED' | 'ANALYZING' | 'BUILDING' | 'READY' | 'FAILED' | 'SUPERSEDED';
  understanding: BuilderDecisionGraph | null;
  changes: BuilderEvolutionChange[];
  harness: BuilderHarnessSnapshot | null;
  generatedBy?: BuilderGeneratedBy | null;
  userSummary: string | null;
  fdeSummary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BuilderBrief = {
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
  requestedAgentName?: string;
  externalSource?: 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CHATGPT' | 'CURSOR' | 'OTHER';
  externalConversationId?: string;
  externalConversationTitle?: string;
  tags?: string[];
  sourceFiles?: Array<{
    name: string;
    mimeType?: string;
    size: number;
    content: string;
    uploadedAt: string;
  }>;
};

export type BuilderPlan = {
  summary: string;
  strategyRecommendation: 'reuse' | 'create';
  reuseCandidates: Array<{ agentId: string; name: string; reason: string }>;
  skillMatches: Array<{ skillId: string; name: string; reason: string }>;
  connections: Array<{ label: string; available: boolean; actionNeeded: string }>;
  gaps: Array<{ label: string; actionNeeded: string }>;
  proposedAgentName: string;
  proposedSkillName: string;
  privilegeNote: string;
};

export type BuilderTestResult = {
  ok: boolean;
  status: 'PASSED' | 'FAILED';
  runId?: string;
  summary: string;
  productionBlockers: string[];
  detail?: string;
};

export type BuilderTestProgress = {
  runId: string;
  status: string;
  stage: 'QUEUED' | 'EXECUTING' | 'VERIFYING' | 'REWORKING' | 'COMPLETED';
  currentRound: number;
  maxRounds: number;
  startedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  elapsedSeconds: number;
  latestUpdateAt: string;
  latestMessage: string;
  rounds: Array<{
    round: number;
    status: string;
    approved: boolean | null;
    summary: string;
    startedAt: string;
    endedAt: string | null;
  }>;
};

export type BuilderTranscriptEntry = {
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  at: string;
};

/** Safe session DTO from `/api/agent-builder/*` (no engines / manifests / protocol). */
export type BuilderSession = {
  id: string;
  status: string;
  progress: BuilderProgress | null;
  brief?: BuilderBrief | null;
  plan: BuilderPlan | null;
  strategy: string | null;
  agentId: string | null;
  targetAgentId: string | null;
  builtAgentId: string | null;
  draftSkillIds: string[];
  hasTestData: boolean;
  testInputStatus: BuilderTestInputStatus;
  testResult: BuilderTestResult | null;
  testProgress: BuilderTestProgress | null;
  lastRunId: string | null;
  lastAssistantMessage: string | null;
  draftState: {
    reply: string;
    testData: string;
    testExpected: string;
  };
  transcript: BuilderTranscriptEntry[];
  iterations: BuilderIteration[];
  latestIteration: BuilderIteration | null;
  ownedByCurrentUser?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type BuilderMessageResult = {
  session: BuilderSession;
  assistantMessage: string;
  status: string;
  progress: BuilderProgress | null;
};

export type ApproveAndActivateStage = 'approve' | 'test' | 'evidence' | 'finalize';

export type ApproveAndActivateResult = {
  ok: boolean;
  stage?: ApproveAndActivateStage;
  reason?: string;
  session: BuilderSession;
  assistantMessage: string;
  status: string;
  progress: BuilderProgress | null;
};

/** Business-language labels for discovery checklist (right rail / progress). */
export const BUILDER_FIELD_LABELS: Record<string, string> = {
  objective: '痛點與希望改變的結果',
  inputs: '現況與可用線索',
  outputs: '理想成果',
  process: '可能的工作方式',
  exceptions: '仍有分歧或不確定的地方',
  permissions: '需要人工確認的動作',
  testData: '值得先試驗的想法',
};

export const BUILDER_STATUS_LABEL: Record<string, string> = {
  DISCOVERY: '持續學習中',
  PLAN_READY: '計畫已就緒',
  AWAITING_FDE: '等待訓練師核准',
  BUILDING: '建立草稿中',
  AWAITING_TEST_DATA: '等待測試資料',
  TESTING: '試跑中',
  PASSED: '試跑通過',
  FAILED: '試跑未通過',
  ACTIVE: '已啟用',
};

export const BUILDER_DISCOVERY_ORDER: BuilderBriefFieldKey[] = [
  'objective',
  'inputs',
  'outputs',
  'process',
  'exceptions',
  'permissions',
  'testData',
];

export function builderStatusLabel(status: string): string {
  return BUILDER_STATUS_LABEL[status] ?? status;
}

/** Example starters for the empty builder state (business language only). */
export const BUILDER_STARTER_EXAMPLES = [
  '每天早上整理帳款郵件做成表，供財務覆核',
  '把客戶詢價轉成報價草稿，先不寄出',
  '每週彙整雲端資料夾的週報摘要',
] as const;
