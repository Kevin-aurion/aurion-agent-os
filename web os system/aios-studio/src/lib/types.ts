export type Agent = {
  id: string; name: string; description: string; department: string; status: string;
  engineExecute: string; engineVerify: string | null; rolePrompt: string; restrictions?: Record<string, boolean | string>;
  skillCount?: number; workflowCount?: number; createdAt: string;
  skills?: Array<{ skill: Skill }>;
  workflows?: Array<{ id: string; name: string; enabled: boolean }>;
  fileTargets?: Array<{ id: string; purpose?: string; cloudFileRef?: { name?: string; path?: string } }>;
};
export type Skill = { id: string; name: string; slug: string; kind: string; origin: string; reviewStatus: string; executionEnv: string; updatedAt: string };
export type McpServer = { id: string; serverId: string; name: string; transport: string; enabled: boolean; trustTier: string; healthStatus: string; readWriteClass: string; approvalRequired: boolean; toolAllowlist: string[]; allowedAgentIds: string[]; updatedAt: string };
export type Deployment = { id: string; artifactId: string; skillId: string; environment: string; channel: string; active: boolean; runtimeKind?: string; runtimeBinding?: unknown; activatedAt: string; digest?: string; artifactStatus?: string };
export type DashboardSummary = { agents: { active: number }; skills: Record<string, number>; workflows: { enabled: number }; runsToday: Record<string, number>; wsConnections: number };

export type KnowledgePilotCitation = {
  id: number; title: string; channel: string; label: string | null; excerpt: string;
  timestamp: string; url: string; wikiSource: string | null; matchedTools: string[]; score: number;
};
export type KnowledgePilotTraceStep = {
  key: string; label: string; status: 'SUCCEEDED' | 'FAILED' | 'NON_BLOCKING_FAILURE';
  durationMs: number; detail: string;
};
export type KnowledgePilotRun = {
  id: string; flowId: string; flowName: string; environment: 'SANDBOX'; runtimeKind: 'LANGFLOW';
  status: 'SUCCEEDED' | 'FAILED'; question: string; answer: string;
  citations: KnowledgePilotCitation[]; trace: KnowledgePilotTraceStep[];
  startedAt: string; finishedAt: string; durationMs: number; error: string | null;
};
export type KnowledgePilotStatus = {
  flowId: string; flowName: string; environment: 'SANDBOX'; productionActivated: false;
  knowledgeIndex: { ready: boolean; documentCount: number; generatedAt: string | null; detail: string };
  langflow: { healthy: boolean; latencyMs: number | null; detail: string | null };
  latestRun: KnowledgePilotRun | null;
};
