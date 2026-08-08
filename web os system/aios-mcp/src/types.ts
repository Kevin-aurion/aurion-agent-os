// Hand-written minimal TS types mirroring the aios-server DTO shapes actually consumed.
// Not code-generated — kept in sync manually; this package only reads JSON over HTTP.

export type Engine = 'CLAUDE_CODE' | 'CODEX' | 'GROK';
export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'AWAITING_REVIEW' | 'CANCELLED';
export type MessageRole = 'USER' | 'AGENT' | 'SYSTEM';
export type SkillReview = 'PENDING_UNDERSTANDING' | 'AWAITING_USER_CONFIRM' | 'CONFIRMED' | 'REJECTED';

export interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string;
  department: string;
  avatar: string | null;
  rolePrompt: string;
  engineExecute: Engine;
  engineVerify: Engine | null;
  restrictions: Record<string, unknown> | null;
  maxRounds: number;
  status: AgentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Appended by GET /api/agents */
  skillCount?: number;
  workflowCount?: number;
  /** Included by GET /api/agents/:id */
  skills?: Array<{ agentId: string; skillId: string; skill: Skill }>;
  fileTargets?: Array<{ agentId: string; cloudFileRefId: string; purpose: string | null; cloudFileRef: unknown }>;
  workflows?: Array<{ id: string; name: string; enabled: boolean }>;
}

export interface Skill {
  id: string;
  slug: string;
  name: string;
  origin: 'UPLOADED' | 'BUILTIN' | 'CLI_GENERATED';
  kind: 'PROMPT_MANUAL' | 'TOOL_MODULE' | 'COMPUTER_CONTROL';
  version: number;
  contentMd: string;
  assets: unknown;
  generator: string | null;
  executionEnv: 'CLI' | 'DESKTOP_APP' | 'DIRECT';
  understanding: unknown;
  reviewStatus: SkillReview;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInfo {
  id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
}

/** Shape of GET /api/agents/:agentId/workflows items (serializeWorkflowSummary). */
export interface WorkflowSummary {
  id: string;
  agentId: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  stepCount: number;
  schedule: ScheduleInfo | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStep {
  id: string;
  workflowId: string;
  position: number;
  stepKey: string;
  type: 'DO' | 'TOOL' | 'AGENT' | 'CONDITION' | 'NOTIFY' | 'COMPUTER_CONTROL';
  config: Record<string, unknown>;
  verifyRubric: string | null;
  onFail: Record<string, unknown> | null;
}

/** Shape of GET /api/workflows/:id (full workflow incl. ordered steps + schedules). */
export interface Workflow {
  id: string;
  agentId: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  inputSchema: unknown;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStep[];
  schedules: ScheduleInfo[];
}

/** Shape of GET /api/runs items (select subset). */
export interface RunSummary {
  id: string;
  agentId: string;
  workflowId: string | null;
  status: RunStatus;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunStep {
  id: string;
  runId: string;
  stepKey: string;
  round: number;
  status: string;
  output: string | null;
  verdict: string | null;
  approved: boolean | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** Shape of GET /api/runs/:id (full run incl. ordered steps). */
export interface Run extends RunSummary {
  input: unknown;
  output: unknown;
  stoppedAt: string | null;
  runDir: string;
  steps: RunStep[];
}

export interface Conversation {
  id: string;
  agentId: string;
  userId: string;
  title: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  runId: string | null;
  createdAt: string;
}

export interface MemoryHit {
  path?: string;
  text?: string;
  score?: number;
  [key: string]: unknown;
}

export interface DashboardSummary {
  agents: { active: number };
  skills: Record<string, number>;
  workflows: { enabled: number };
  runsToday: Record<string, number>;
  connectedAccounts: Array<{ provider: string; status: string; count: number }>;
  wsConnections: number;
}

export interface RecentRun {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string;
  workflowId: string | null;
  agent: { id: string; name: string; slug: string } | null;
}

export interface Health {
  status: string;
  db: boolean;
  wsConnections: number;
  tz: string;
}

export interface Preflight {
  engines: {
    claude: { installed: boolean; version?: string };
    codex: { installed: boolean; version?: string };
    grok: { installed: boolean; version?: string };
  };
  integrations: { microsoft: boolean; google: boolean; line: boolean };
}

export type ExternalBuilderSource = 'CLAUDE_DESKTOP' | 'CLAUDE_CODE' | 'CHATGPT' | 'CURSOR' | 'OTHER';

export interface BuilderAgentSummary {
  id: string;
  name: string;
  description: string;
  department: string;
  status: string;
  skillCount: number;
  workflowCount: number;
  updatedAt: string;
  latestBuild: { id: string; status: string; updatedAt: string } | null;
}

export interface AgentBuildIteration {
  id: string;
  sequence: number;
  triggerKind: string;
  triggerSummary: string;
  status: 'QUEUED' | 'ANALYZING' | 'BUILDING' | 'READY' | 'FAILED' | 'SUPERSEDED';
  understanding: Record<string, unknown> | null;
  changes: Array<Record<string, unknown>>;
  harness: Record<string, unknown> | null;
  userSummary: string | null;
  fdeSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBuildSession {
  id: string;
  status:
    | 'DISCOVERY'
    | 'PLAN_READY'
    | 'AWAITING_FDE'
    | 'BUILDING'
    | 'AWAITING_TEST_DATA'
    | 'TESTING'
    | 'PASSED'
    | 'FAILED'
    | 'ACTIVE';
  brief: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  strategy: string | null;
  targetAgentId: string | null;
  builtAgentId: string | null;
  draftSkillIds: string[];
  hasTestData: boolean;
  testResult: Record<string, unknown> | null;
  lastRunId: string | null;
  transcript: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    at: string;
    source?: ExternalBuilderSource;
    externalEventId?: string;
  }>;
  iterations: AgentBuildIteration[];
  latestIteration: AgentBuildIteration | null;
  createdAt: string;
  updatedAt: string;
}
