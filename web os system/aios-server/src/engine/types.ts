// Core types for the agent execution engine: compiled manifest, the
// do|tool|agent|condition|notify|computer_control step model, round-loop
// results, and the run outcome returned to callers (workflows/runs/conversations).
import type { Engine, RunStatus, StepType } from '@prisma/client';

/** Defect-routing on a failed step: which prior steps to send it back to. */
export interface OnFailConfig {
  routeTo: string[]; // candidate prior step keys
  maxCycles: number; // rework cycles allowed before giving up (fail-closed)
}

export interface CompiledSkill {
  name: string; // skill slug
  contentMd: string; // SKILL.md content, injected into the execute engine's system prompt
}

interface BaseStep {
  stepKey: string;
  verifyRubric: string | null; // rubric text; null = engine default rubric (DO/TOOL) or "no extra acceptance gate" (AGENT)
  onFail: OnFailConfig | null;
}

export interface DoStepConfig {
  instruction: string; // supports {{identity.x}} / {{steps.key.field}} templating
  permissions?: 'full' | 'restricted'; // 'full' => skip Claude Code permission prompts
  /** Ad-hoc chat runs set this — execute once, skip the cross-model verify gate. */
  skipVerify?: boolean;
}
export interface DoStep extends BaseStep {
  type: 'DO';
  config: DoStepConfig;
}

export interface ToolStepConfig {
  tool: string; // tools/<tool>.js|.ts under the agent dir
  args?: Record<string, string>; // values may be literal or "{{...}}" templates
}
export interface ToolStep extends BaseStep {
  type: 'TOOL';
  config: ToolStepConfig;
}

export interface AgentStepConfig {
  agentSlug: string; // sub-agent to delegate to
  brief?: string; // task brief template; resolves empty => manager decided to skip this role
}
export interface AgentStep extends BaseStep {
  type: 'AGENT';
  config: AgentStepConfig;
}

export interface ConditionStepConfig {
  expr: string; // deterministic boolean expression; {{...}} tokens are substituted before eval
  onTrue?: string; // step key to jump to when true
  onFalse?: string; // step key to jump to when false
}
export interface ConditionStep extends BaseStep {
  type: 'CONDITION';
  config: ConditionStepConfig;
}

export interface NotifyStepConfig {
  message: string; // supports {{...}} templating
  channel?: 'LINE';
  bindingId?: string; // ChannelBinding id
  to?: string; // raw external id (userId/groupId/roomId)
}
export interface NotifyStep extends BaseStep {
  type: 'NOTIFY';
  config: NotifyStepConfig;
}

export interface ComputerControlStepConfig {
  skillId: string;
  instructions?: string;
  timeoutMs?: number;
}
export interface ComputerControlStep extends BaseStep {
  type: 'COMPUTER_CONTROL';
  config: ComputerControlStepConfig;
}

export type Step = DoStep | ToolStep | AgentStep | ConditionStep | NotifyStep | ComputerControlStep;

/** Compiled from Agent + (Workflow.steps | ad-hoc chat step) — the engine's source of truth for a run. */
export interface CompiledManifest {
  agentSlug: string;
  agentId: string;
  agentDir: string;
  engineExecute: Engine; // Agent.engineExecute
  engineVerify: Engine; // agent's explicit choice, else opposite of engineExecute
  maxRounds: number;
  rolePrompt: string;
  restrictions: import('./restrictions.js').AgentRestrictions;
  skills: CompiledSkill[];
  steps: Step[];
  /** L1 core wiki pages (index.md + facts.md) injected into the system prompt. */
  memoryCore: string;
}

export interface RoundRecord {
  round: number;
  approved: boolean;
  verdict: string;
}

export interface StepResult {
  ok: boolean;
  stepKey: string;
  type: StepType;
  output: string; // final (approved or last-round) output
  rounds: number;
  approved: boolean | null;
  reason?: string; // e.g. MAX_ROUNDS_NO_APPROVAL, VERIFY_REJECTED, TOOL_ERROR, NO_EXECUTOR
  lastVerdict?: string;
  records: RoundRecord[];
  skipped?: boolean; // AGENT step: manager plan decided this role wasn't needed
  delegatedTo?: string; // AGENT step: sub-agent slug
}

export interface RunOutcome {
  ok: boolean;
  runId: string;
  runDir: string;
  status: RunStatus;
  results: StepResult[];
  reworkHistory: StepResult[]; // rework-cycle step re-runs, kept separate from `results`
  stoppedAt?: string;
  output?: unknown;
}

export interface RunAgentInput {
  message?: string;
  identity?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunAgentOptions {
  agentId: string;
  workflowId?: string;
  input: RunAgentInput;
  triggeredBy: string;
  /** optional: caller pre-generates the run id so it can return/subscribe to it
   * immediately while the run executes asynchronously. */
  runId?: string;
  /** internal: delegation depth (0 = top-level run); callers should not set this. */
  depth?: number;
  /** internal: set by the approval flow to bypass the high-risk pre-exec gate and resume the existing run. */
  approvedApprovalId?: string;
}
