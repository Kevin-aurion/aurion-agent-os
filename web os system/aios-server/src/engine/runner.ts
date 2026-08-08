// The single run entrypoint: runAgent(). Compiles a manifest from the DB
// (Agent + optional Workflow.steps, or an ad-hoc chat step), then executes
// steps sequentially — DO/TOOL steps loop execute -> verify (cross-model,
// capped at maxRounds), AGENT steps delegate to a sub-agent run, CONDITION
// steps branch deterministically, NOTIFY/COMPUTER_CONTROL steps reach
// outside the model loop entirely. Every engine CLI call is wrapped so a
// missing/failed CLI marks the step as errored instead of crashing the
// process.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import type { Engine, RunStatus } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';
import { hub } from '../ws/hub.js';
import { audit } from '../lib/audit.js';
import { errors } from '../lib/http.js';
import { requiresApproval, createApproval, isRunApproved } from '../lib/approval.js';
import { materializeAgent } from './materialize.js';
import { runClaude, runClaudeStream } from './claude.js';
import { runCodex, isApproved } from './codex.js';
import { runGrok } from './grok.js';
import {
  parseRestrictions,
  restrictionsToRules,
  claudeDisallowedTools,
  buildSandboxProfile,
  type AgentRestrictions,
} from './restrictions.js';
import { runTool, evalCondition } from './tools.js';
import { guardBudget, recordCost, BudgetExceededError } from './cost.js';
import { recordViolation, createProposal } from '../lib/changeproposal.js';
// Server-local Computer Use (connectComputerUse) is intentionally NOT imported
// on the formal run path — multi-device DeviceTask is the only COMPUTER_CONTROL
// dispatch. Legacy helpers remain at file bottom under LEGACY_LOCAL_COMPUTER_USE
// and are never called from runComputerControlStep.
import { parseIdentityCard, type IdentityCard } from '../lib/identitycard.js';
import {
  buildAgentSkillCatalog,
  buildSkillCatalog,
  resolveConflictedSlugs,
} from '../lib/skillmanifest.js';
import {
  readCorePages,
  recall,
  ingestRunSummary,
  ingestChatSummary,
} from '../memory/memoryService.js';
import { summarizeRun, summarizeChat } from '../memory/summary.js';
import type {
  CompiledManifest,
  CompiledSkill,
  Step,
  DoStep,
  ToolStep,
  AgentStep,
  ConditionStep,
  NotifyStep,
  ComputerControlStep,
  ComputerControlStepConfig,
  StepResult,
  RoundRecord,
  RunOutcome,
  RunAgentOptions,
} from './types.js';
import { checkDeviceEligibility } from '../lib/deviceeligibility.js';
import {
  createAndDispatchTask,
  cancelDeviceTask,
  waitForDeviceTaskTerminal,
} from '../lib/devicetask.js';
import { publishToDevice } from '../ws/hub.js';
import {
  parseDeviceLineTool,
  isLineSendTool,
  LINE_DESKTOP_MANIFEST,
} from '../lib/devicemcp.js';

const MAX_DELEGATION_DEPTH = 1; // a delegate agent may not itself delegate
const MAX_CONDITION_JUMPS = 50; // guard against a CONDITION cycle looping forever
const EXEC_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const DECISION_TIMEOUT_MS = 2 * 60_000;
const COMPUTER_CONTROL_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_RUBRIC =
  'Approve the artifact if it plausibly and completely satisfies the step instruction and does not contradict ' +
  'the source of truth. Only report substantive problems (missing/incorrect content, contradictions with the ' +
  'source of truth); ignore pure style. When genuinely unsure, prefer ISSUES FOUND.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Run context ──────────────────────────────────────────────────────────

interface RunContext {
  runId: string;
  runDir: string;
  manifest: CompiledManifest;
  input: Record<string, unknown>;
  rawMessage: string; // source of truth for verification
  identity: Record<string, unknown>;
  approved: { stepKey: string; output: string }[];
  stepOutputs: Record<string, string>;
  reworkFeedback: Record<string, string>;
  attempts: Record<string, number>;
  depth: number;
  triggeredBy: string;
  /** Set when the agent's cloud file targets were synced into agentDir/data/. */
  hasCloudFiles?: boolean;
  /** Agent.costPolicy — null/undefined = no budget limit. */
  costPolicy: unknown;
  /**
   * Cached path to this run's SBPL profile (written once under runDir/sandbox.sb).
   * Only set when restrictions.sandbox.enabled is true.
   */
  sandboxProfilePath?: string;
  signal?: AbortSignal;
}

interface VerdictResult {
  approved: boolean;
  text: string;
  threadId: string | null;
}

// ── Templating: {{identity.x}} / {{input.x}} / {{steps.key.field}} ─────────

function stripFences(s: string): string {
  return s
    .replace(/^```[a-zA-Z]*\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
}

// Tolerant JSON extraction: try the whole (fence-stripped) text; on failure,
// scan for the first balanced {...} or [...] (ignoring braces inside quoted
// strings) and try that. Returns undefined if nothing parses.
function looseParseJson(raw: string): unknown {
  const t = stripFences(raw);
  try {
    return JSON.parse(t);
  } catch {
    // fall through to balanced-bracket extraction
  }
  for (const open of ['{', '['] as const) {
    const start = t.indexOf(open);
    if (start === -1) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function getPath(obj: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

function resolveTokenValue(expr: string, ctx: RunContext): unknown {
  const parts = expr.trim().split('.');
  if (parts[0] === 'identity') return getPath(ctx.identity, parts.slice(1));
  if (parts[0] === 'input') return getPath(ctx.input, parts.slice(1));
  if (parts[0] === 'steps') {
    const raw = ctx.stepOutputs[parts[1] as string];
    if (raw == null) return null;
    const obj = looseParseJson(raw);
    if (obj === undefined) return raw; // not JSON -> the raw string itself
    return getPath(obj, parts.slice(2));
  }
  return undefined;
}

/** Resolve a single `"{{...}}"` expression to a typed value; literal strings pass through unchanged. */
function resolveArg(expr: string, ctx: RunContext): unknown {
  const m = String(expr).match(/^\{\{(.+)\}\}$/);
  if (!m) return expr;
  return resolveTokenValue(m[1] as string, ctx);
}

function resolveArgs(map: Record<string, string> | undefined, ctx: RunContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map ?? {})) out[k] = resolveArg(v, ctx);
  return out;
}

/** Resolve every `{{...}}` token inside a larger string template (e.g. a NOTIFY message). */
function resolveTemplate(str: string, ctx: RunContext): string {
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, inner: string) => {
    const v = resolveTokenValue(inner, ctx);
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

// ── Context helpers ─────────────────────────────────────────────────────────

function approvedOutputs(ctx: RunContext): string {
  return ctx.approved.map((a) => `[step:${a.stepKey} — approved output]\n${a.output}`).join('\n\n');
}

// Verification's source of truth: original input + everything approved so far.
function sourceForStep(ctx: RunContext): string {
  const parts = [`[Original input]\n${ctx.rawMessage}`];
  // The agent's synced cloud files are part of the ground truth — the verifier
  // must treat them as a legitimate source, not flag data drawn from them as
  // fabricated. It runs read-only in the same agentDir, so it can inspect them.
  if (ctx.hasCloudFiles) {
    parts.push(
      '[Synced cloud files — additional source of truth]\n工作目錄的 data/cloud-files.md 是此員工已指派雲端檔案的同步內容，屬於有效事實來源；請實際讀取該檔案來核對 artifact 中的數據，出自該檔案的資料不得視為虛構。',
    );
  }
  const prior = approvedOutputs(ctx);
  if (prior) parts.push(prior);
  return parts.join('\n\n');
}

async function save(ctx: RunContext, name: string, content: string): Promise<void> {
  try {
    await writeFile(path.join(ctx.runDir, name), content, 'utf8');
  } catch {
    // best-effort artifact logging; must never fail the run
  }
}

function upsertApproved(ctx: RunContext, stepKey: string, output: string): void {
  const hit = ctx.approved.find((a) => a.stepKey === stepKey);
  if (hit) hit.output = output;
  else ctx.approved.push({ stepKey, output });
}

async function persistRunStep(
  ctx: RunContext,
  stepKey: string,
  round: number,
  status: string,
  fields: { output?: string; verdict?: string; approved?: boolean | null; error?: string } = {},
): Promise<void> {
  try {
    await prisma.runStep.create({
      data: {
        id: ulid(),
        runId: ctx.runId,
        stepKey,
        round,
        status,
        output: fields.output ?? null,
        verdict: fields.verdict ?? null,
        approved: fields.approved ?? null,
        error: fields.error ?? null,
        endedAt: status === 'executing' ? null : new Date(),
      },
    });
  } catch {
    // persistence must never crash the run
  }
}

// ── Manifest compilation (Agent + Workflow.steps | ad-hoc chat step) ────────

function compileStep(row: { stepKey: string; type: string; config: unknown; verifyRubric: string | null; onFail: unknown }): Step {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const onFailRaw = row.onFail as { routeTo?: string[]; maxCycles?: number } | null;
  const base = {
    stepKey: row.stepKey,
    verifyRubric: row.verifyRubric ?? null,
    onFail: onFailRaw ? { routeTo: onFailRaw.routeTo ?? [], maxCycles: onFailRaw.maxCycles ?? 2 } : null,
  };
  switch (row.type) {
    case 'DO':
      return {
        ...base,
        type: 'DO',
        config: {
          instruction: String(cfg.instruction ?? cfg.prompt ?? ''),
          // Workflow DO steps run inside the agent's own workspace and often
          // need to WRITE artifacts (報價單/報告等) — headless CLIs would
          // otherwise silently refuse file writes at the permission prompt.
          // Default to 'full' here; the agent's 限制設定 (restrictions) and
          // system-prompt rules remain the real capability boundary. Ad-hoc
          // chat steps are built elsewhere and stay restricted.
          permissions: (cfg.permissions as 'full' | 'restricted' | undefined) ?? 'full',
          // Workflow authors may opt a lightweight step out of the cross-model
          // verify gate (e.g. keyword-triggered quick replies).
          skipVerify: cfg.skipVerify === true,
        },
      };
    case 'TOOL':
      return {
        ...base,
        type: 'TOOL',
        config: {
          tool: String(cfg.tool ?? ''),
          args: (cfg.args as Record<string, string>) ?? {},
          deviceId: typeof cfg.deviceId === 'string' && cfg.deviceId.trim() ? cfg.deviceId.trim() : undefined,
        },
      };
    case 'AGENT':
      return { ...base, type: 'AGENT', config: { agentSlug: String(cfg.agentSlug ?? ''), brief: cfg.brief as string | undefined } };
    case 'CONDITION':
      return { ...base, type: 'CONDITION', config: { expr: String(cfg.expr ?? 'false'), onTrue: cfg.onTrue as string | undefined, onFalse: cfg.onFalse as string | undefined } };
    case 'NOTIFY':
      return {
        ...base,
        type: 'NOTIFY',
        config: {
          message: String(cfg.message ?? ''),
          channel: cfg.channel as 'LINE' | undefined,
          bindingId: cfg.bindingId as string | undefined,
          to: cfg.to as string | undefined,
        },
      };
    case 'COMPUTER_CONTROL':
      return {
        ...base,
        type: 'COMPUTER_CONTROL',
        config: {
          deviceId: String(cfg.deviceId ?? '').trim(),
          skillId: String(cfg.skillId ?? ''),
          instructions: cfg.instructions as string | undefined,
          timeoutMs: cfg.timeoutMs as number | undefined,
          app: typeof cfg.app === 'string' ? cfg.app : undefined,
          checkpoint:
            cfg.checkpoint && typeof cfg.checkpoint === 'object'
              ? (cfg.checkpoint as ComputerControlStepConfig['checkpoint'])
              : undefined,
        },
      };
    default:
      throw new Error(`Unknown step type: ${row.type}`);
  }
}

export async function compileManifest(
  agentId: string,
  workflowId: string | undefined,
  agentDir: string,
  chatMessage?: string,
  forceVerify = false,
  builderTest?: { sessionId: string; triggeredBy: string },
): Promise<CompiledManifest> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { skills: { include: { skill: true } } },
  });
  if (!agent || agent.deletedAt) throw errors.notFound(`Agent not found: ${agentId}`);

  // Normal runs are confirmed-only. Agent Builder may inject its exact pending
  // drafts into one isolated test manifest after deterministic DB validation;
  // this never changes reviewStatus or makes the draft visible to other runs.
  const confirmed = agent.skills
    .map((as) => as.skill)
    .filter((s) => s.reviewStatus === 'CONFIRMED' && !s.deletedAt);
  let builderDrafts: typeof confirmed = [];
  let builderExpected: unknown = null;
  if (builderTest) {
    const [session, actor] = await Promise.all([
      prisma.agentBuildSession.findUnique({ where: { id: builderTest.sessionId } }),
      prisma.user.findUnique({ where: { id: builderTest.triggeredBy }, select: { role: true, deletedAt: true } }),
    ]);
    const expectedAgentId = session?.builtAgentId ?? session?.targetAgentId;
    const actorMayTest =
      session?.userId === builderTest.triggeredBy || actor?.role === 'OWNER' || actor?.role === 'TRAINER';
    if (
      !session ||
      session.status !== 'TESTING' ||
      expectedAgentId !== agentId ||
      !actor ||
      actor.deletedAt ||
      !actorMayTest ||
      session.draftSkillIds.length === 0
    ) {
      throw errors.forbidden('Invalid or stale Agent Builder test capability');
    }

    builderDrafts = agent.skills
      .map((as) => as.skill)
      .filter(
        (skill) =>
          session.draftSkillIds.includes(skill.id) &&
          skill.generator === 'agent-builder' &&
          skill.reviewStatus === 'AWAITING_USER_CONFIRM' &&
          !skill.deletedAt,
      );
    if (
      builderDrafts.length !== session.draftSkillIds.length ||
      !session.draftSkillIds.every((id) => builderDrafts.some((skill) => skill.id === id))
    ) {
      throw errors.conflict('Agent Builder draft set no longer matches the reviewed session');
    }
    builderExpected = session.testExpected;
  }

  const manifestSkills = [...confirmed, ...builderDrafts];
  const catalog = buildAgentSkillCatalog(manifestSkills);
  const contentBySlug = new Map(manifestSkills.map((s) => [s.slug, s.contentMd]));
  const skills: CompiledSkill[] = catalog.map((c) => ({
    name: c.slug,
    contentMd: contentBySlug.get(c.slug) ?? '',
    metadata: c.metadata,
    relPath: c.relPath,
  }));

  // Draft testing uses the one executor whose tool surface can be hard-denied
  // deterministically. This validates the skill artifact, not an Agent's
  // production engine permissions.
  const engineExecute: Engine = builderTest ? 'CLAUDE_CODE' : agent.engineExecute;
  // Verifier: the agent's explicit choice (e.g. GROK for speed), else the
  // opposite CLI of the executor. Cross-model rule: never verify with the
  // same engine that executed.
  const autoVerify: Engine = engineExecute === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE';
  const engineVerify: Engine = builderTest
    ? 'CODEX'
    : agent.engineVerify && agent.engineVerify !== engineExecute
      ? agent.engineVerify
      : autoVerify;

  let steps: Step[];
  if (workflowId) {
    const workflow = await prisma.workflow.findUnique({
      where: { id: workflowId },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!workflow || workflow.deletedAt || workflow.agentId !== agentId) {
      throw errors.notFound(`Workflow not found: ${workflowId}`);
    }
    steps = workflow.steps.map(compileStep);
    if (steps.length === 0) throw errors.badRequest(`Workflow ${workflowId} has no steps`);
  } else {
    // Ad-hoc chat normally skips verification. Eval/Agent Builder callers may
    // only strengthen this path with forceVerify; compileManifest still chooses
    // a verifier different from the executor above.
    steps = [
      {
        stepKey: 'chat',
        type: 'DO',
        verifyRubric: builderTest
          ? [
              'This is an Agent Builder acceptance test. Fail closed unless the artifact satisfies every expected result below.',
              'Check calculations, required fields, exception handling, and permission boundaries item by item.',
              'If any expected item is missing, ambiguous, incorrect, or an external action was performed instead of drafted, return ISSUES FOUND.',
              '',
              '## Expected result (source of truth)',
              typeof builderExpected === 'string'
                ? builderExpected
                : JSON.stringify(builderExpected, null, 2),
            ].join('\n')
          : null,
        onFail: null,
        config: { instruction: chatMessage ?? '', skipVerify: !forceVerify },
      } as DoStep,
    ];
  }

  // L1 core memory pages — best-effort; empty string when memory disabled / missing.
  let memoryCore = '';
  if (!builderTest) {
    try {
      memoryCore = await readCorePages(agentDir);
    } catch {
      memoryCore = '';
    }
  }

  // Identity card for verify-gate semantic overstep (ticket 06). Null when unset.
  const identityCard: IdentityCard | null =
    agent.identityCard != null ? parseIdentityCard(agent.identityCard).card : null;

  const normalRestrictions = parseRestrictions(agent.restrictions);
  const restrictions = builderTest
    ? {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
        cloudEmbedding: false,
        testIsolation: true,
        notes: 'Agent Builder 隔離試跑：所有外部讀寫、網路、Shell 與電腦操控均停用。',
      }
    : normalRestrictions;

  return {
    agentSlug: agent.slug,
    agentId: agent.id,
    agentDir,
    engineExecute,
    engineVerify,
    maxRounds: Math.max(1, agent.maxRounds ?? 5),
    rolePrompt: agent.rolePrompt ?? '',
    restrictions,
    skills,
    steps,
    memoryCore,
    identityCard,
    builderTestDraftSkillIds: builderDrafts.length ? builderDrafts.map((skill) => skill.id) : undefined,
    builderTestDraftContent: builderDrafts.length
      ? builderDrafts.map((skill) => skill.contentMd).join('\n\n---\n\n')
      : undefined,
    // Carried for L7 budget guard; not part of CompiledManifest type surface.
    costPolicy: agent.costPolicy ?? null,
  } as CompiledManifest & { costPolicy: unknown };
}

// ── Engine dispatch (execute / verify / manager-decision prompts) ──────────

export function buildSystemPrompt(manifest: CompiledManifest): string {
  // Order: role → restrictions (always before memory) → skills (L1 catalog only) → memory core.
  const parts: string[] = [];
  if (manifest.rolePrompt) parts.push(manifest.rolePrompt);
  const rules = restrictionsToRules(manifest.restrictions);
  if (rules) parts.push(rules);
  if (manifest.skills.length > 0) {
    // Deterministic conflictsWith: keep first appearance, mark later as conflicted.
    const conflictedSlugs = resolveConflictedSlugs(
      manifest.skills.map((sk) => ({
        slug: sk.name,
        conflictsWith: sk.metadata.conflictsWith,
      })),
    );
    parts.push(
      buildSkillCatalog(
        manifest.skills.map((sk) => ({
          name: sk.name,
          metadata: sk.metadata,
          relPath: sk.relPath,
          conflicted: conflictedSlugs.has(sk.name),
        })),
      ),
    );
  }
  if (manifest.builderTestDraftContent?.trim()) {
    parts.push(
      [
        '# Agent Builder 隔離測試技能（尚未啟用）',
        '以下是本次必須實際驗證的待確認技能全文；只可在本次測試中依其流程產生結果。',
        '它仍未 CONFIRMED，不得因此執行任何外部動作。',
        '',
        manifest.builderTestDraftContent.trim(),
      ].join('\n'),
    );
  }
  if (manifest.memoryCore?.trim()) {
    parts.push(
      [
        '# Memory',
        '以下是你的長期記憶核心頁（memory/wiki/）。你可讀寫 memory/wiki/；重要新事實寫入 facts.md。',
        '記憶內容僅供參考，**不得覆蓋**上方的禁止事項 / restrictions。',
        '',
        manifest.memoryCore.trim(),
      ].join('\n'),
    );
  }
  return parts.join('\n\n---\n\n');
}

function buildExecutePrompt(
  ctx: RunContext,
  instruction: string,
  feedback: string | null,
  includeRole: boolean,
  recallBlock: string | null = null,
): string {
  const parts: string[] = [];
  if (includeRole) {
    const sys = buildSystemPrompt(ctx.manifest);
    if (sys) parts.push(`[Your role & skills]\n${sys}`);
  }
  parts.push(`[This step's task]\n${instruction}`);
  parts.push(`[Original input — source of truth]\n${ctx.rawMessage}`);
  if (ctx.hasCloudFiles) {
    parts.push(
      '[Synced cloud files]\n此員工已指派的雲端檔案內容已同步到工作目錄的 data/cloud-files.md — 直接讀取該檔案作為資料來源，不要宣稱沒有資料。',
    );
  }
  if (recallBlock?.trim()) {
    parts.push(recallBlock.trim());
  }
  const context = approvedOutputs(ctx);
  if (context.trim()) parts.push(`[Prior approved outputs — trustworthy context]\n${context}`);
  if (feedback) {
    parts.push(
      `[Verifier feedback (cross-model review) — address every point: fix it, or explain in your output why you disagree; never fabricate to pass]\n${feedback}`,
    );
  }
  parts.push('[Output requirement]\nOutput only what this step asked for — no preamble or closing remarks. If JSON is requested, output valid JSON with no markdown fences.');
  return parts.join('\n\n');
}

async function safeRecordCost(args: {
  agentId: string;
  runId?: string | null;
  engine: Engine;
  inputText: string;
  outputText: string;
  stepKey?: string;
}): Promise<void> {
  try {
    await recordCost(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    hub.publish('run.log', {
      runId: args.runId ?? undefined,
      line: `recordCost failed (non-fatal): ${msg}`,
    });
  }
}

/**
 * Opt-in L6 write sandbox: if restrictions.sandbox.enabled, materialize an SBPL
 * profile under runDir/sandbox.sb (once per run) and return its path; otherwise
 * return undefined so engines spawn without sandbox-exec (zero behaviour change).
 *
 * UNOBSERVABLE for violation signals: sandbox denials surface as OS EPERM inside
 * the CLI child process — we never see the attempt here, so we do not invent
 * VIOLATION proposals for sandbox blocks (ticket 03 / ADR 0004).
 */
async function ensureSandboxProfile(ctx: RunContext): Promise<string | undefined> {
  if (!ctx.manifest.restrictions.sandbox?.enabled) return undefined;
  if (ctx.sandboxProfilePath) return ctx.sandboxProfilePath;
  const profile = buildSandboxProfile(
    ctx.manifest.agentDir,
    ctx.manifest.restrictions.sandbox.extraWritePaths,
  );
  const profilePath = path.join(ctx.runDir, 'sandbox.sb');
  await writeFile(profilePath, profile, 'utf8');
  ctx.sandboxProfilePath = profilePath;
  return profilePath;
}

// ── Single engine dispatch table (execute / verify / decide) ─────────────
// One adapter per Engine; all three call paths share this table so adding
// an engine or changing CLI args is a single-place edit. Behaviour must stay
// equivalent to the former if-cascades (restrictions, sandbox, cost engine).

type EngineAdapter = {
  /** Claude folds role into systemAppend; Codex/Grok embed role in the prompt. */
  roleInSystem: boolean;
  /** Claude has no cross-round thread; Codex/Grok resume via threadId. */
  supportsResume: boolean;
  execute(args: {
    prompt: string;
    systemAppend?: string;
    cwd: string;
    timeoutMs: number;
    restrictions: AgentRestrictions;
    sandboxProfilePath?: string;
    onLine?: (l: string) => void;
    fullPermissions?: boolean;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
  verify(args: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    threadId: string | null;
    restrictions: AgentRestrictions;
    sandboxProfilePath?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; threadId: string | null; costInput: string }>;
  decide(args: {
    prompt: string;
    systemAppend?: string;
    cwd: string;
    timeoutMs: number;
    sandboxProfilePath?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
};

const ENGINE_ADAPTERS: Record<Engine, EngineAdapter> = {
  CLAUDE_CODE: {
    roleInSystem: true,
    supportsResume: false,
    async execute({ prompt, systemAppend, cwd, timeoutMs, restrictions, sandboxProfilePath, onLine, fullPermissions, signal }) {
      const res = await runClaudeStream({
        prompt,
        systemAppend,
        cwd,
        fullPermissions,
        disallowedTools: claudeDisallowedTools(restrictions),
        timeoutMs,
        onLine: onLine ?? (() => {}),
        sandboxProfilePath,
        signal,
      });
      return { text: res.stdout };
    },
    async verify({ prompt, cwd, timeoutMs, restrictions, sandboxProfilePath, signal }) {
      // Stateless re-review every round (claude -p has no thread resume).
      const sys =
        'You are an independent, cross-model verifier (Claude Code). Treat the artifact as a claim to be falsified, not assumed true.';
      const res = await runClaude({
        prompt,
        systemAppend: sys,
        cwd,
        // Read-only web so the verifier can check cited external sources.
        // Honors the agent's webSearch restriction.
        allowedTools: restrictions.webSearch ? ['WebFetch', 'WebSearch'] : undefined,
        timeoutMs,
        sandboxProfilePath,
        signal,
      });
      return { text: res.stdout, threadId: null, costInput: `${sys}\n\n${prompt}` };
    },
    async decide({ prompt, systemAppend, cwd, timeoutMs, sandboxProfilePath, signal }) {
      const res = await runClaude({
        prompt,
        systemAppend,
        cwd,
        timeoutMs,
        sandboxProfilePath,
        signal,
      });
      return { text: res.stdout };
    },
  },
  CODEX: {
    roleInSystem: false,
    supportsResume: true,
    async execute({ prompt, cwd, timeoutMs, restrictions, sandboxProfilePath, onLine, signal }) {
      const res = await runCodex({
        prompt,
        cwd,
        sandbox: restrictions.testIsolation ? 'read-only' : 'workspace-write',
        timeoutMs,
        onLine,
        sandboxProfilePath,
        signal,
      });
      return { text: res.text };
    },
    async verify({ prompt, cwd, timeoutMs, threadId, sandboxProfilePath, signal }) {
      const res = await runCodex({
        prompt,
        cwd,
        resumeThreadId: threadId,
        sandbox: 'read-only',
        timeoutMs,
        sandboxProfilePath,
        signal,
      });
      return { text: res.text, threadId: res.threadId, costInput: prompt };
    },
    async decide({ prompt, cwd, timeoutMs, sandboxProfilePath, signal }) {
      const res = await runCodex({
        prompt,
        cwd,
        sandbox: 'workspace-write',
        timeoutMs,
        sandboxProfilePath,
        signal,
      });
      return { text: res.text };
    },
  },
  GROK: {
    roleInSystem: false,
    supportsResume: true,
    async execute({ prompt, cwd, timeoutMs, restrictions, sandboxProfilePath, onLine, signal }) {
      const res = await runGrok({
        prompt,
        cwd,
        timeoutMs,
        disableWebSearch: !restrictions.webSearch,
        onLine,
        sandboxProfilePath,
        signal,
      });
      return { text: res.stdout };
    },
    async verify({ prompt, cwd, timeoutMs, threadId, sandboxProfilePath, signal }) {
      // Session resume keeps prior objections across rounds (CONCEDE/MAINTAIN).
      const sys =
        'You are an independent, cross-model verifier (Grok). Treat the artifact as a claim to be falsified, not assumed true. Do not modify any files — review only.';
      const res = await runGrok({
        prompt,
        systemAppend: sys,
        cwd,
        resumeSessionId: threadId,
        timeoutMs,
        sandboxProfilePath,
        signal,
      });
      return { text: res.stdout, threadId: res.sessionId, costInput: `${sys}\n\n${prompt}` };
    },
    async decide({ prompt, systemAppend, cwd, timeoutMs, sandboxProfilePath, signal }) {
      const res = await runGrok({
        prompt,
        systemAppend,
        cwd,
        timeoutMs,
        sandboxProfilePath,
        signal,
      });
      return { text: res.stdout };
    },
  },
};

export function canUseSemanticRecall(restrictions: AgentRestrictions): boolean {
  return restrictions.cloudEmbedding && restrictions.testIsolation !== true;
}

async function runExecuteStep(ctx: RunContext, step: DoStep, feedback: string | null, round: number): Promise<string> {
  await guardBudget(ctx.manifest.agentId, ctx.costPolicy);

  const instruction = resolveTemplate(step.config.instruction, ctx);
  const onLine = (line: string) => {
    if (line.trim()) hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round, line });
  };
  const sandboxProfilePath = await ensureSandboxProfile(ctx);

  // Top-k semantic recall for execute only (verify path never injects recall).
  let recallBlock = '';
  if (canUseSemanticRecall(ctx.manifest.restrictions)) {
    try {
      recallBlock = await recall(ctx.manifest.agentId, ctx.manifest.agentDir, instruction, 4);
    } catch {
      recallBlock = '';
    }
  }

  const engine = ctx.manifest.engineExecute;
  const adapter = ENGINE_ADAPTERS[engine];
  // Claude: role/skills via systemAppend; Codex/Grok: role folded into the user prompt.
  const includeRole = !adapter.roleInSystem;
  const prompt = buildExecutePrompt(ctx, instruction, feedback, includeRole, recallBlock);
  const systemAppend = adapter.roleInSystem ? buildSystemPrompt(ctx.manifest) || undefined : undefined;
  const res = await adapter.execute({
    prompt,
    systemAppend,
    cwd: ctx.manifest.agentDir,
    timeoutMs: EXEC_TIMEOUT_MS,
    restrictions: ctx.manifest.restrictions,
    sandboxProfilePath,
    onLine,
    fullPermissions: step.config.permissions === 'full',
    signal: ctx.signal,
  });
  await safeRecordCost({
    agentId: ctx.manifest.agentId,
    runId: ctx.runId,
    engine, // must match the engine actually invoked
    inputText: systemAppend ? `${systemAppend}\n\n${prompt}` : prompt,
    outputText: res.text,
    stepKey: step.stepKey,
  });
  return res.text;
}

function formatIdentityCardForVerify(card: IdentityCard): string {
  return [
    `oneLiner: ${card.oneLiner}`,
    `purpose: ${card.purpose}`,
    `canDo: ${JSON.stringify(card.canDo)}`,
    `cannotDo: ${JSON.stringify(card.cannotDo)}`,
    `servedAudience: ${card.servedAudience}`,
  ].join('\n');
}

/**
 * Build the verifier user prompt. When the agent has an identity card, append
 * an Overstep block AFTER the Verdict format. Overstep must not affect
 * APPROVED / ISSUES FOUND (isApproved stays fail-closed and unchanged).
 */
function buildVerifyPrompt(
  rubric: string,
  artifact: string,
  sourceOfTruth: string,
  isResume: boolean,
  identityCard?: IdentityCard | null,
): string {
  const overstepAppendix =
    identityCard != null
      ? [
          '',
          '[Identity card — authorization scope for Overstep only]',
          formatIdentityCardForVerify(identityCard),
          '',
          'After the Verdict block, output exactly these two additional lines as the absolute end of your reply.',
          'IMPORTANT: The Overstep judgment does NOT affect APPROVED / ISSUES FOUND. Decide the Verdict first, independently.',
          '## Overstep',
          'NONE | LOW | HIGH — <one-sentence reason>',
        ].join('\n')
      : '';

  if (isResume) {
    return [
      "[Re-review] The other party has attempted to fix the issues from your previous round. Below is the revised artifact.",
      'Review it again against the same rubric and source of truth, and mark each of your previous pushback points CONCEDE or MAINTAIN.',
      '',
      '[Revised artifact]',
      artifact,
      '',
      'Discipline: do not rubber-stamp, do not concede just to end the loop, do not treat MAINTAIN as APPROVED. If real problems remain, say ISSUES FOUND.',
      '[Reply format — mandatory] Your Verdict block must be:',
      '## Verdict',
      'APPROVED  (or)  ISSUES FOUND',
      overstepAppendix,
    ].join('\n');
  }
  return [
    'You are an independent, cross-model verifier. Treat the artifact under review as a claim to be falsified — verify it point by point, do not assume it is correct.',
    '',
    '[Verification rubric]',
    rubric,
    '',
    '[Source of truth — the only facts that count]',
    sourceOfTruth,
    '',
    '[Artifact under review]',
    artifact,
    '',
    'Discipline: verify every completeness claim against the source; independently recompute anything arithmetic rather than trusting the artifact; only report substantive problems, ignore pure style; when in doubt say ISSUES FOUND.',
    '[Reply format — mandatory] Your Verdict block must be:',
    '## Verdict',
    'APPROVED  (or)  ISSUES FOUND',
    overstepAppendix,
  ].join('\n');
}

export type OverstepLevel = 'NONE' | 'LOW' | 'HIGH' | 'UNKNOWN';

/**
 * Parse the optional "## Overstep" trailer from a verifier reply.
 * Does not affect isApproved — pure extraction for the semantic track (ADR 0004).
 */
export function parseOverstep(text: string): { level: OverstepLevel; reason?: string } {
  if (!text) return { level: 'UNKNOWN' };
  const m = text.match(
    /##\s*Overstep\s*\r?\n\s*(NONE|LOW|HIGH)\s*(?:[—–\-]\s*(.+?))?\s*(?:\r?\n|$)/i,
  );
  if (!m) return { level: 'UNKNOWN' };
  const level = m[1]!.toUpperCase() as 'NONE' | 'LOW' | 'HIGH';
  const reason = m[2]?.trim();
  return reason ? { level, reason } : { level };
}

/**
 * Semantic overstep review (ticket 06): only HIGH with an identity card creates
 * a SEMANTIC proposal. LOW / NONE / UNKNOWN → log only (noise control, ADR 0004).
 * Fail-safe: never throws into the verify path.
 */
export async function applySemanticOverstepReview(args: {
  agentId: string;
  runId?: string;
  verdictText: string;
  identityCard: IdentityCard | null | undefined;
}): Promise<void> {
  try {
    if (args.identityCard == null) return;

    const { level, reason } = parseOverstep(args.verdictText);
    if (level === 'HIGH') {
      await createProposal({
        agentId: args.agentId,
        runId: args.runId,
        source: 'SEMANTIC',
        proposedBy: 'system',
        targetType: 'IDENTITY_CARD',
        severity: 'high',
        confidence: 0.8,
        proposedChange: { overstep: reason ?? 'semantic overstep (HIGH)' },
      });
      return;
    }
    // Noise control: LOW / NONE / UNKNOWN — log only, do not queue.
    console.log(
      `[semantic-overstep] agent=${args.agentId} run=${args.runId ?? '-'} level=${level}` +
        (reason ? ` reason=${reason}` : ''),
    );
  } catch (e) {
    console.error(
      '[semantic-overstep] applySemanticOverstepReview failed (ignored):',
      e instanceof Error ? e.message : e,
    );
  }
}

async function runVerifyStep(ctx: RunContext, rubric: string, artifact: string, sourceOfTruth: string, threadId: string | null): Promise<VerdictResult> {
  await guardBudget(ctx.manifest.agentId, ctx.costPolicy);
  const sandboxProfilePath = await ensureSandboxProfile(ctx);

  const engine = ctx.manifest.engineVerify;
  const adapter = ENGINE_ADAPTERS[engine];
  const isResume = adapter.supportsResume && threadId != null;
  const prompt = buildVerifyPrompt(
    rubric,
    artifact,
    sourceOfTruth,
    isResume,
    ctx.manifest.identityCard,
  );
  const res = await adapter.verify({
    prompt,
    cwd: ctx.manifest.agentDir,
    timeoutMs: VERIFY_TIMEOUT_MS,
    threadId,
    restrictions: ctx.manifest.restrictions,
    sandboxProfilePath,
    signal: ctx.signal,
  });
  await safeRecordCost({
    agentId: ctx.manifest.agentId,
    runId: ctx.runId,
    engine, // must match the verifier engine actually invoked
    inputText: res.costInput,
    outputText: res.text,
  });
  // Semantic overstep track (ADR 0004): after verdict text is known, maybe queue.
  // Does not change approved/isApproved — fail-closed gate is unchanged.
  await applySemanticOverstepReview({
    agentId: ctx.manifest.agentId,
    runId: ctx.runId,
    verdictText: res.text,
    identityCard: ctx.manifest.identityCard,
  });
  return { approved: isApproved(res.text), text: res.text, threadId: res.threadId };
}

async function callManagerDecision(ctx: RunContext, instruction: string, source: string): Promise<string> {
  await guardBudget(ctx.manifest.agentId, ctx.costPolicy);
  const sandboxProfilePath = await ensureSandboxProfile(ctx);

  const engine = ctx.manifest.engineExecute;
  const adapter = ENGINE_ADAPTERS[engine];
  // Codex embeds role in the user prompt; Claude/Grok pass role via systemAppend.
  let prompt: string;
  let systemAppend: string | undefined;
  if (adapter.roleInSystem) {
    // CLAUDE_CODE (and any future roleInSystem engines)
    prompt = [`[Task]\n${instruction}`, `[Context]\n${source}`].join('\n\n');
    systemAppend = ctx.manifest.rolePrompt || undefined;
  } else if (engine === 'CODEX') {
    // Historical: Codex decision puts [Role] in the user prompt.
    const parts = [
      ctx.manifest.rolePrompt ? `[Role]\n${ctx.manifest.rolePrompt}` : '',
      `[Task]\n${instruction}`,
      `[Context]\n${source}`,
    ].filter(Boolean);
    prompt = parts.join('\n\n');
    systemAppend = undefined;
  } else {
    // GROK (and other non-system role engines): role via systemAppend (rolePrompt).
    prompt = [`[Task]\n${instruction}`, `[Context]\n${source}`].join('\n\n');
    systemAppend = ctx.manifest.rolePrompt || undefined;
  }
  const res = await adapter.decide({
    prompt,
    systemAppend,
    cwd: ctx.manifest.agentDir,
    timeoutMs: DECISION_TIMEOUT_MS,
    sandboxProfilePath,
    signal: ctx.signal,
  });
  await safeRecordCost({
    agentId: ctx.manifest.agentId,
    runId: ctx.runId,
    engine, // GROK decide must record GROK, not CLAUDE_CODE
    inputText: systemAppend ? `${systemAppend}\n\n${prompt}` : prompt,
    outputText: res.text,
  });
  return res.text;
}

// ── Step executors ───────────────────────────────────────────────────────

async function runDoStep(step: DoStep, ctx: RunContext): Promise<StepResult> {
  let threadId: string | null = null;
  let lastVerdict = '';
  let lastOutput = '';
  const records: RoundRecord[] = [];
  const rubric = step.verifyRubric ?? DEFAULT_RUBRIC;

  for (let round = 1; round <= ctx.manifest.maxRounds; round++) {
    hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round, phase: 'executing' });
    const feedback = round > 1 ? lastVerdict : ctx.reworkFeedback[step.stepKey] ?? null;

    let output: string;
    try {
      output = await runExecuteStep(ctx, step, feedback, round);
    } catch (e) {
      const isBudget = e instanceof BudgetExceededError;
      const reason = isBudget
        ? `預算超限，已 fail-closed 阻斷: ${e.message}`
        : `EXECUTE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
      if (isBudget) {
        await recordViolation({
          agentId: ctx.manifest.agentId,
          runId: ctx.runId,
          kind: 'budget_exceeded',
          detail: { phase: 'execute', stepKey: step.stepKey, message: e.message },
        });
      }
      await persistRunStep(ctx, step.stepKey, round, 'error', { error: reason, output: lastOutput || undefined });
      hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round, line: reason });
      return { ok: false, stepKey: step.stepKey, type: step.type, output: lastOutput, rounds: round, approved: false, reason, records };
    }
    lastOutput = output;
    await save(ctx, `${step.stepKey}.r${round}.output.txt`, output);

    // Chat (ad-hoc) steps skip the cross-model verify gate entirely — execute
    // once and accept. Workflow steps always verify.
    if (step.config?.skipVerify === true) {
      await persistRunStep(ctx, step.stepKey, round, 'approved', { output, approved: true });
      hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round, phase: 'approved' });
      records.push({ round, approved: true, verdict: '(skipVerify: 對話模式不進行跨模型驗證)' });
      return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: round, approved: true, records };
    }

    hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round, phase: 'verifying' });
    let verdict: VerdictResult;
    try {
      verdict = await runVerifyStep(ctx, rubric, output, sourceForStep(ctx), threadId);
    } catch (e) {
      const isBudget = e instanceof BudgetExceededError;
      const reason = isBudget
        ? `預算超限，已 fail-closed 阻斷: ${e.message}`
        : `VERIFY_ERROR: ${e instanceof Error ? e.message : String(e)}`;
      if (isBudget) {
        await recordViolation({
          agentId: ctx.manifest.agentId,
          runId: ctx.runId,
          kind: 'budget_exceeded',
          detail: { phase: 'verify', stepKey: step.stepKey, message: e instanceof Error ? e.message : String(e) },
        });
      }
      await persistRunStep(ctx, step.stepKey, round, 'error', { error: reason, output });
      hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round, line: reason });
      return { ok: false, stepKey: step.stepKey, type: step.type, output, rounds: round, approved: false, reason, records };
    }
    if (round === 1) threadId = verdict.threadId;
    lastVerdict = verdict.text;
    await save(ctx, `${step.stepKey}.r${round}.verdict.md`, verdict.text);
    records.push({ round, approved: verdict.approved, verdict: verdict.text });
    await persistRunStep(ctx, step.stepKey, round, verdict.approved ? 'approved' : 'rejected', { output, verdict: verdict.text, approved: verdict.approved });
    hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round, phase: verdict.approved ? 'approved' : 'rejected' });

    if (verdict.approved) {
      return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: round, approved: true, records };
    }
  }

  return {
    ok: false,
    stepKey: step.stepKey,
    type: step.type,
    output: lastOutput,
    rounds: ctx.manifest.maxRounds,
    approved: false,
    reason: 'MAX_ROUNDS_NO_APPROVAL',
    lastVerdict,
    records,
  };
}

// Tools are deterministic (same args => same result), so there's no rework
// loop here — a single execute + a single verify pass (governing access
// boundaries), pass or fail outright.
async function runToolStep(step: ToolStep, ctx: RunContext): Promise<StepResult> {
  const args = resolveArgs(step.config.args, ctx);
  hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round: 1, phase: 'executing' });

  // Device-local LINE Desktop MCP — never server-local broker.
  const lineTool = parseDeviceLineTool(step.config.tool);
  if (lineTool) {
    return runLineDesktopDeviceTool(step, ctx, lineTool.tool, args);
  }

  let result: unknown;
  try {
    result = await runTool(ctx.manifest.agentDir, step.config.tool, args, {
      agentId: ctx.manifest.agentId,
      agentDir: ctx.manifest.agentDir,
      cloudWrite: ctx.manifest.restrictions.cloudWrite,
      sendEmail: ctx.manifest.restrictions.sendEmail,
      runId: ctx.runId,
      userId: ctx.triggeredBy,
    });
  } catch (e) {
    const reason = `TOOL_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    await save(ctx, `${step.stepKey}.r1.output.txt`, reason);
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }
  const output = JSON.stringify(result);
  await save(ctx, `${step.stepKey}.r1.output.txt`, output);

  if (!step.verifyRubric) {
    await persistRunStep(ctx, step.stepKey, 1, 'approved', { output, approved: true });
    return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records: [] };
  }

  hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round: 1, phase: 'verifying' });
  let verdict: VerdictResult;
  try {
    verdict = await runVerifyStep(
      ctx,
      step.verifyRubric,
      `Tool "${step.config.tool}" was called with args ${JSON.stringify(args)} and returned:\n${output}`,
      sourceForStep(ctx),
      null,
    );
  } catch (e) {
    const isBudget = e instanceof BudgetExceededError;
    const reason = isBudget
      ? `預算超限，已 fail-closed 阻斷: ${e.message}`
      : `VERIFY_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    if (isBudget) {
      await recordViolation({
        agentId: ctx.manifest.agentId,
        runId: ctx.runId,
        kind: 'budget_exceeded',
        detail: { phase: 'tool_verify', stepKey: step.stepKey, message: e instanceof Error ? e.message : String(e) },
      });
    }
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output });
    hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round: 1, line: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: false, reason, records: [] };
  }
  await save(ctx, `${step.stepKey}.r1.verdict.md`, verdict.text);
  const records: RoundRecord[] = [{ round: 1, approved: verdict.approved, verdict: verdict.text }];
  await persistRunStep(ctx, step.stepKey, 1, verdict.approved ? 'approved' : 'rejected', { output, verdict: verdict.text, approved: verdict.approved });

  if (verdict.approved) return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records };
  return { ok: false, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: false, reason: 'VERIFY_REJECTED', lastVerdict: verdict.text, records };
}

async function runAgentStep(step: AgentStep, ctx: RunContext): Promise<StepResult> {
  try {
    if (ctx.depth >= MAX_DELEGATION_DEPTH) {
      return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 0, approved: false, reason: 'DELEGATION_DEPTH_EXCEEDED', records: [] };
    }

    const brief = step.config.brief ? String(resolveArg(step.config.brief, ctx) ?? '') : '';
    if (step.config.brief && (!brief.trim() || brief.trim() === 'null' || brief.trim() === 'undefined')) {
      const note = '(manager plan determined this role is not needed for this run — step skipped)';
      await save(ctx, `${step.stepKey}.skipped.txt`, note);
      await persistRunStep(ctx, step.stepKey, 0, 'approved', { output: note, approved: true });
      return { ok: true, stepKey: step.stepKey, type: step.type, output: note, rounds: 0, approved: true, skipped: true, delegatedTo: step.config.agentSlug, records: [] };
    }

    const subAgent = await prisma.agent.findUnique({ where: { slug: step.config.agentSlug } });
    if (!subAgent || subAgent.deletedAt) {
      const reason = `SUB_AGENT_NOT_FOUND: ${step.config.agentSlug}`;
      return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 0, approved: false, reason, records: [] };
    }

    const prior = approvedOutputs(ctx);
    const message = [brief || 'Handle the request below per your responsibilities.', `[Original request]\n${ctx.rawMessage}`, prior ? `[Prior approved outputs]\n${prior}` : '']
      .filter(Boolean)
      .join('\n\n');

    const outcome = await runAgent({
      agentId: subAgent.id,
      input: { message },
      triggeredBy: ctx.triggeredBy,
      depth: ctx.depth + 1,
      signal: ctx.signal,
    });

    if (!outcome.ok) {
      const failed = outcome.results.find((r) => !r.ok);
      const reason = `DELEGATE_FAILED: sub-agent ${step.config.agentSlug} stopped at "${outcome.stoppedAt}" (${failed?.reason ?? '?'})`;
      return {
        ok: false,
        stepKey: step.stepKey,
        type: step.type,
        output: failed?.output ?? '',
        rounds: 0,
        approved: false,
        reason,
        lastVerdict: failed?.lastVerdict,
        delegatedTo: step.config.agentSlug,
        records: [],
      };
    }

    const deliverable = outcome.results[outcome.results.length - 1]?.output ?? '';
    await save(ctx, `${step.stepKey}.deliverable.txt`, deliverable);

    if (!step.verifyRubric) {
      await persistRunStep(ctx, step.stepKey, 1, 'approved', { output: deliverable, approved: true });
      return { ok: true, stepKey: step.stepKey, type: step.type, output: deliverable, rounds: 1, approved: true, delegatedTo: step.config.agentSlug, records: [] };
    }

    const verdict = await runVerifyStep(ctx, step.verifyRubric, deliverable, sourceForStep(ctx), null);
    await save(ctx, `${step.stepKey}.acceptance.md`, verdict.text);
    await persistRunStep(ctx, step.stepKey, 1, verdict.approved ? 'approved' : 'rejected', { output: deliverable, verdict: verdict.text, approved: verdict.approved });

    if (verdict.approved) {
      return {
        ok: true,
        stepKey: step.stepKey,
        type: step.type,
        output: deliverable,
        rounds: 1,
        approved: true,
        delegatedTo: step.config.agentSlug,
        records: [{ round: 1, approved: true, verdict: verdict.text }],
      };
    }
    return {
      ok: false,
      stepKey: step.stepKey,
      type: step.type,
      output: deliverable,
      rounds: 1,
      approved: false,
      reason: 'ACCEPTANCE_REJECTED',
      lastVerdict: verdict.text,
      delegatedTo: step.config.agentSlug,
      records: [{ round: 1, approved: false, verdict: verdict.text }],
    };
  } catch (e) {
    const reason = `DELEGATE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 0, approved: false, reason, records: [] };
  }
}

async function runConditionStep(step: ConditionStep, ctx: RunContext): Promise<StepResult> {
  try {
    const resolveToken = (token: string) => resolveTokenValue(token, ctx);
    const result = evalCondition(step.config.expr, resolveToken);
    const branch = result ? step.config.onTrue ?? null : step.config.onFalse ?? null;
    const output = JSON.stringify({ result, branch });
    await save(ctx, `${step.stepKey}.r1.output.txt`, output);
    await persistRunStep(ctx, step.stepKey, 1, 'approved', { output, approved: true });
    return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records: [] };
  } catch (e) {
    const reason = `CONDITION_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }
}

async function runNotifyStep(step: NotifyStep, ctx: RunContext): Promise<StepResult> {
  const message = resolveTemplate(step.config.message, ctx);
  const target = step.config.bindingId ?? step.config.to ?? null;
  hub.publish('agent.status', { runId: ctx.runId, stepKey: step.stepKey, kind: 'notify', message, target });

  let delivered = false;
  let deliveryError: string | undefined;
  try {
    if (target) {
      // Dynamic import: NOTIFY must degrade gracefully if no channel adapter is wired up.
      const line = await import('../channels/line.js').catch(() => null);
      if (line) {
        if (step.config.bindingId) await line.pushToBinding(step.config.bindingId, message);
        else if (step.config.to) await line.pushMessage(step.config.to, message);
        delivered = true;
      }
    }
  } catch (e) {
    deliveryError = e instanceof Error ? e.message : String(e);
  }

  const output = JSON.stringify({ message, target, delivered, error: deliveryError ?? null });
  await save(ctx, `${step.stepKey}.r1.output.txt`, output);
  await persistRunStep(ctx, step.stepKey, 1, 'approved', { output, approved: true, error: deliveryError });
  return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records: [] };
}

async function runComputerControlStep(step: ComputerControlStep, ctx: RunContext): Promise<StepResult> {
  // Hard gate: agents without the computerUse capability cannot dispatch
  // desktop automation at all, regardless of the workflow definition.
  if (!ctx.manifest.restrictions.computerUse) {
    const reason = 'RESTRICTED: 此員工未開啟「電腦操控」權限（概況 → 限制設定），無法執行 COMPUTER_CONTROL 步驟。';
    await recordViolation({
      agentId: ctx.manifest.agentId,
      runId: ctx.runId,
      kind: 'computer_use',
      detail: { stepKey: step.stepKey, skillId: step.config.skillId, message: reason },
    });
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round: 1, line: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }

  // Formal path: targeted DeviceTask only. Server-local connectComputerUse and
  // public computer.control_requested broadcast are no longer primary.
  return runComputerControlViaDevice(step, ctx);
}

/**
 * Targeted multi-device Computer Use. Fail-closed on eligibility / offline wake.
 * Waits for DB terminal SUCCEEDED only — never treats DISPATCHED as success.
 */
async function runComputerControlViaDevice(
  step: ComputerControlStep,
  ctx: RunContext,
): Promise<StepResult> {
  const deviceId = step.config.deviceId?.trim();
  if (!deviceId) {
    const reason = 'COMPUTER_CONTROL requires config.deviceId (no public broadcast fallback)';
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }

  const requireScreenshot = step.config.checkpoint?.requireScreenshot !== false;
  // Default checkpoint needs screen capture; eligibility enforces screenshot/screenRecording.
  const elig = await checkDeviceEligibility({
    deviceId,
    agentId: ctx.manifest.agentId,
    requirement: 'computer_use',
    requireScreenCapture: requireScreenshot,
  });
  if (!elig.eligible) {
    const reason = `DEVICE_NOT_ELIGIBLE: ${elig.reasonCode} — ${elig.reason}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round: 1, line: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }

  const instructions = resolveTemplate(step.config.instructions ?? '', ctx) || undefined;

  let task;
  try {
    task = await createAndDispatchTask({
      deviceId,
      kind: 'COMPUTER_CONTROL',
      agentId: ctx.manifest.agentId,
      runId: ctx.runId,
      stepKey: step.stepKey,
      idempotencyKey: `${ctx.runId}:${step.stepKey}:computer-control`,
      actorUserId: ctx.triggeredBy,
      requestedByUserId: ctx.triggeredBy,
      confirmationRequired: requireScreenshot,
      payload: {
        skillId: step.config.skillId,
        instructions,
        app: step.config.app,
        checkpoint: {
          requireScreenshot,
          label: step.config.checkpoint?.label,
        },
      },
      deadlineAt: new Date(Date.now() + (step.config.timeoutMs ?? COMPUTER_CONTROL_TIMEOUT_MS)),
    });
  } catch (e) {
    const reason = `COMPUTER_CONTROL_TASK_CREATE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }

  const woke = publishToDevice(deviceId, 'device.task', { taskId: task.id });
  if (!woke) {
    await cancelDeviceTask({
      taskId: task.id,
      actorUserId: ctx.triggeredBy,
      reason: 'DEVICE_OFFLINE at wake',
    });
    const reason = 'DEVICE_OFFLINE';
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }

  hub.publish('run.step', {
    runId: ctx.runId,
    stepKey: step.stepKey,
    type: step.type,
    round: 1,
    phase: 'executing',
    deviceId,
    taskId: task.id,
  });

  const timeoutMs = step.config.timeoutMs ?? COMPUTER_CONTROL_TIMEOUT_MS;
  const terminal = await waitForDeviceTaskTerminal(task.id, timeoutMs);

  if (terminal.status !== 'SUCCEEDED') {
    const reason = `COMPUTER_CONTROL_${terminal.status}: ${JSON.stringify(terminal.error ?? terminal.result ?? {})}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    return {
      ok: false,
      stepKey: step.stepKey,
      type: step.type,
      output: JSON.stringify(terminal.result ?? {}),
      rounds: 1,
      approved: false,
      reason,
      records: [],
    };
  }

  // SUCCEEDED DeviceTask is not enough — cross-model verify gate (execute≠verify).
  const artifacts = await prisma.deviceArtifact.findMany({
    where: { taskId: terminal.id, deviceId },
    orderBy: { seq: 'asc' },
    take: 20,
    select: {
      id: true,
      kind: true,
      sha256: true,
      mimeType: true,
      sizeBytes: true,
      redacted: true,
      expiresAt: true,
      seq: true,
    },
  });
  const screenshots = artifacts.filter((a) => a.kind === 'SCREENSHOT');
  const evidence = {
    deviceId,
    taskId: terminal.id,
    status: terminal.status,
    result: terminal.result ?? null,
    confirmationArtifactId: terminal.confirmationArtifactId,
    confirmedAt: terminal.confirmedAt,
    screenshots,
    artifacts,
  };
  const output = JSON.stringify(evidence);
  await save(ctx, `${step.stepKey}.r1.output.txt`, output);

  const rubric =
    step.verifyRubric?.trim() ||
    'Approve only if the device Computer Use task fully completed the instructed UI work on the target device, ' +
      'result is coherent, and required screenshot evidence is present and consistent. Reject if only dispatched, ' +
      'partial, missing screenshots when required, or contradictory.';

  hub.publish('run.step', {
    runId: ctx.runId,
    stepKey: step.stepKey,
    type: step.type,
    round: 1,
    phase: 'verifying',
    deviceId,
    taskId: terminal.id,
  });

  let verdict: VerdictResult;
  try {
    verdict = await runVerifyStep(
      ctx,
      rubric,
      [
        `[Device Computer Use evidence]`,
        `deviceId=${deviceId}`,
        `taskId=${terminal.id}`,
        `skillId=${step.config.skillId}`,
        `confirmationRequired=${requireScreenshot}`,
        `result=${JSON.stringify(terminal.result ?? null)}`,
        `screenshotArtifacts=${JSON.stringify(screenshots)}`,
        `fullEvidence=${output}`,
      ].join('\n'),
      sourceForStep(ctx),
      null,
    );
  } catch (e) {
    const reason = `VERIFY_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output });
    return { ok: false, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: false, reason, records: [] };
  }
  await save(ctx, `${step.stepKey}.r1.verdict.md`, verdict.text);
  const records: RoundRecord[] = [{ round: 1, approved: verdict.approved, verdict: verdict.text }];
  await persistRunStep(ctx, step.stepKey, 1, verdict.approved ? 'approved' : 'rejected', {
    output,
    verdict: verdict.text,
    approved: verdict.approved,
  });
  if (verdict.approved) {
    return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records };
  }
  return {
    ok: false,
    stepKey: step.stepKey,
    type: step.type,
    output,
    rounds: 1,
    approved: false,
    reason: 'VERIFY_REJECTED',
    lastVerdict: verdict.text,
    records,
  };
}

/** LINE Desktop via DeviceTask LINE_DESKTOP — not central MCP broker. */
async function runLineDesktopDeviceTool(
  step: ToolStep,
  ctx: RunContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<StepResult> {
  if (!ctx.manifest.restrictions.computerUse) {
    const reason = 'RESTRICTED: LINE Desktop MCP requires computerUse restriction';
    await recordViolation({
      agentId: ctx.manifest.agentId,
      runId: ctx.runId,
      kind: 'computer_use',
      detail: { stepKey: step.stepKey, tool, message: reason },
    });
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }

  const deviceId = step.config.deviceId?.trim();
  if (!deviceId) {
    const reason = 'device-mcp:line-desktop requires config.deviceId';
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }

  if (isLineSendTool(tool)) {
    const approved = await isRunApproved(ctx.runId);
    if (!approved) {
      const reason =
        'LINE_SEND_REQUIRES_APPROVAL: send_message_* requires a real ApprovalRequest for this run (status=APPROVED)';
      await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
      return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
    }
  }

  const elig = await checkDeviceEligibility({
    deviceId,
    agentId: ctx.manifest.agentId,
    requirement: { kind: 'line_tool', tool },
  });
  if (!elig.eligible) {
    const reason = `DEVICE_NOT_ELIGIBLE: ${elig.reasonCode} — ${elig.reason}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }

  const operation = isLineSendTool(tool) ? 'send' : 'read';
  let task;
  try {
    task = await createAndDispatchTask({
      deviceId,
      kind: 'LINE_DESKTOP',
      agentId: ctx.manifest.agentId,
      runId: ctx.runId,
      stepKey: step.stepKey,
      idempotencyKey: `${ctx.runId}:${step.stepKey}:line:${tool}`,
      actorUserId: ctx.triggeredBy,
      requestedByUserId: ctx.triggeredBy,
      payload: {
        operation,
        tool,
        args,
      },
    });
  } catch (e) {
    const reason = `LINE_TASK_CREATE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }

  const woke = publishToDevice(deviceId, 'device.task', { taskId: task.id });
  if (!woke) {
    await cancelDeviceTask({
      taskId: task.id,
      actorUserId: ctx.triggeredBy,
      reason: 'DEVICE_OFFLINE at wake',
    });
    const reason = 'DEVICE_OFFLINE';
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }

  const terminal = await waitForDeviceTaskTerminal(task.id, COMPUTER_CONTROL_TIMEOUT_MS);
  if (terminal.status !== 'SUCCEEDED') {
    const reason = `LINE_DESKTOP_${terminal.status}: ${JSON.stringify(terminal.error ?? {})}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: reason, rounds: 1, approved: false, reason, records: [] };
  }

  const evidence = {
    deviceId,
    taskId: terminal.id,
    tool,
    operation,
    status: terminal.status,
    result: terminal.result ?? null,
  };
  const output = JSON.stringify(evidence);
  await save(ctx, `${step.stepKey}.r1.output.txt`, output);

  // Always cross-model verify (execute≠verify). Default rubric if author omitted.
  const rubric =
    step.verifyRubric?.trim() ||
    (isLineSendTool(tool)
      ? 'Approve only if the LINE Desktop send completed as requested on the target device, ' +
        'result is coherent, and no unauthorized extra sends are indicated. Reject partial/failed/ambiguous sends.'
      : 'Approve only if the LINE Desktop read returned coherent chatroom/history data for the request on the ' +
        'target device. Reject empty unexplained failures or device/task mismatch.');

  hub.publish('run.step', { runId: ctx.runId, stepKey: step.stepKey, type: step.type, round: 1, phase: 'verifying' });
  let verdict: VerdictResult;
  try {
    verdict = await runVerifyStep(
      ctx,
      rubric,
      [
        `[Device LINE Desktop evidence]`,
        `deviceId=${deviceId}`,
        `taskId=${terminal.id}`,
        `tool=${tool}`,
        `operation=${operation}`,
        `result=${JSON.stringify(terminal.result ?? null)}`,
      ].join('\n'),
      sourceForStep(ctx),
      null,
    );
  } catch (e) {
    const reason = `VERIFY_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output });
    return { ok: false, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: false, reason, records: [] };
  }
  await save(ctx, `${step.stepKey}.r1.verdict.md`, verdict.text);
  const records: RoundRecord[] = [{ round: 1, approved: verdict.approved, verdict: verdict.text }];
  await persistRunStep(ctx, step.stepKey, 1, verdict.approved ? 'approved' : 'rejected', {
    output,
    verdict: verdict.text,
    approved: verdict.approved,
  });
  if (verdict.approved) {
    return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records };
  }
  return {
    ok: false,
    stepKey: step.stepKey,
    type: step.type,
    output,
    rounds: 1,
    approved: false,
    reason: 'VERIFY_REJECTED',
    lastVerdict: verdict.text,
    records,
  };
}

// ── LEGACY_LOCAL_COMPUTER_USE (isolated; never called) ─────────────────────
// Historical server-Mac Computer Use + public computer.control_requested path.
// Formal COMPUTER_CONTROL always uses runComputerControlViaDevice above.
// Kept only as documentation anchors so a future regression cannot silently
// re-wire runComputerControlStep without deleting this notice.
void function LEGACY_LOCAL_COMPUTER_USE_DO_NOT_CALL() {
  // Intentionally empty — tryCodexComputerUse / runComputerControlViaDesktopApp removed
  // from the callable surface. Do not reintroduce connectComputerUse here.
};

async function runStep(step: Step, ctx: RunContext): Promise<StepResult> {
  switch (step.type) {
    case 'DO':
      return runDoStep(step, ctx);
    case 'TOOL':
      return runToolStep(step, ctx);
    case 'AGENT':
      return runAgentStep(step, ctx);
    case 'CONDITION':
      return runConditionStep(step, ctx);
    case 'NOTIFY':
      return runNotifyStep(step, ctx);
    case 'COMPUTER_CONTROL':
      return runComputerControlStep(step, ctx);
  }
}

// ── Defect routing (on_fail) ────────────────────────────────────────────────

async function routeDefects(failed: StepResult, candidates: string[], ctx: RunContext): Promise<string[]> {
  if (candidates.length <= 1) return candidates; // single candidate => no manager decision needed

  const defectReport = [`[Verifier's final note]\n${failed.lastVerdict ?? '(none)'}`, failed.output ? `[Last output — has defect details]\n${failed.output}` : '']
    .filter(Boolean)
    .join('\n\n');
  const instruction =
    `You are the manager. Step "${failed.stepKey}" failed; below is the defect information. ` +
    `Candidate steps to route the fix back to: ${JSON.stringify(candidates)}. ` +
    `Decide whose responsibility each defect is and which candidates must rework, in fix order. ` +
    `Reply with ONLY a valid JSON array — a subset of the candidates — e.g. ["backend"]. No other text.`;

  try {
    const out = await callManagerDecision(ctx, instruction, defectReport);
    const m = out.match(/\[[\s\S]*?\]/);
    const arr = JSON.parse(m ? m[0] : out) as string[];
    const valid = arr.filter((id) => candidates.includes(id));
    if (valid.length) return valid;
  } catch (e) {
    // Budget hard-stop must not be swallowed into the conservative default.
    if (e instanceof BudgetExceededError) {
      await recordViolation({
        agentId: ctx.manifest.agentId,
        runId: ctx.runId,
        kind: 'budget_exceeded',
        detail: { phase: 'manager_decision', message: e.message },
      });
      hub.publish('run.log', {
        runId: ctx.runId,
        line: `預算超限，已 fail-closed 阻斷: ${e.message}`,
      });
      throw e;
    }
    // fall through to the conservative default below
  }
  return candidates; // parse failure => conservative: route back to every candidate
}

// ── Run entrypoint ──────────────────────────────────────────────────────────

/**
 * Execute a single run of an agent (optionally against one of its
 * workflows). Creates the Run row, materializes the agent directory,
 * compiles the manifest, executes steps sequentially, and persists a
 * RunStep row per round. Publishes run.started / run.step / run.log /
 * run.finished on the WS hub throughout.
 */
/** True if workflow steps include device-mcp LINE send tools (high-risk). */
async function workflowHasLineSendTools(workflowId: string | undefined): Promise<boolean> {
  if (!workflowId) return false;
  try {
    const steps = await prisma.workflowStep.findMany({
      where: { workflowId },
      select: { type: true, config: true },
    });
    for (const s of steps) {
      if (s.type !== 'TOOL') continue;
      const cfg = (s.config ?? {}) as { tool?: string };
      const tool = typeof cfg.tool === 'string' ? cfg.tool : '';
      const parsed = parseDeviceLineTool(tool);
      if (parsed && isLineSendTool(parsed.tool)) return true;
    }
    return false;
  } catch {
    // Fail-closed: treat as needing approval if we cannot scan.
    return true;
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<RunOutcome> {
  if (opts.signal?.aborted) throw new Error('Agent run aborted before start');
  const agentRow = await prisma.agent.findUnique({ where: { id: opts.agentId } });
  if (!agentRow || agentRow.deletedAt) throw errors.notFound(`Agent not found: ${opts.agentId}`);

  // Pre-execution HITL gate: high-risk agents OR LINE send tools halt before any engine call.
  // Only a real DB ApprovalRequest with status APPROVED counts (fail-closed).
  const alreadyApproved = await isRunApproved(opts.runId ?? '', opts.approvedApprovalId);
  const lineSendNeedsApproval = await workflowHasLineSendTools(opts.workflowId);
  const needsHitl =
    requiresApproval(agentRow.riskTier, alreadyApproved) ||
    (lineSendNeedsApproval && !alreadyApproved);

  if (needsHitl) {
    const runId = opts.runId ?? ulid();
    const runDir = path.join(paths.runs, runId);
    await mkdir(runDir, { recursive: true });
    await prisma.run.create({
      data: {
        id: runId,
        workflowId: opts.workflowId ?? null,
        agentId: agentRow.id,
        triggeredBy: opts.triggeredBy,
        status: 'AWAITING_REVIEW',
        input: (opts.input ?? {}) as object,
        runDir,
      },
    });
    const reasonParts: string[] = [];
    if (requiresApproval(agentRow.riskTier, false)) {
      reasonParts.push('高風險員工（riskTier=high）執行前需人工核准');
    }
    if (lineSendNeedsApproval) {
      reasonParts.push(
        '工作流含 LINE Desktop 傳送工具（send_message_manual/auto），需真 ApprovalRequest 核准後才可派送',
      );
    }
    const { resumeToken } = await createApproval({
      runId,
      agentId: agentRow.id,
      reason: reasonParts.join('；') || '執行前需人工核准',
      payload: {
        agentId: opts.agentId,
        workflowId: opts.workflowId,
        input: opts.input,
        triggeredBy: opts.triggeredBy,
        lineSendTools: lineSendNeedsApproval,
      },
    });
    await audit(opts.triggeredBy, 'run.awaiting_review', 'Run', runId, {
      agentId: agentRow.id,
      lineSendTools: lineSendNeedsApproval,
    });
    hub.publish('run.step', { runId, agentId: agentRow.id, phase: 'awaiting_review' });
    hub.publish('approval.requested', { runId, agentId: agentRow.id, resumeToken });
    return {
      ok: false,
      runId,
      runDir,
      status: 'AWAITING_REVIEW',
      results: [],
      reworkHistory: [],
      stoppedAt: 'awaiting_review',
    };
  }

  const agentDir = await materializeAgent(agentRow.id);

  const runId = opts.runId ?? ulid();
  const runDir = path.join(paths.runs, runId);
  await mkdir(runDir, { recursive: true });

  const chatMessage = typeof opts.input?.message === 'string' ? opts.input.message : undefined;
  // Prepend recent dialogue so the agent has conversation memory. The history
  // array (from the chat route) excludes the current turn; render it as a
  // transcript above the new user message.
  const historyArr = Array.isArray(opts.input?.history)
    ? (opts.input!.history as Array<{ role?: string; content?: string }>)
    : [];
  let chatPrompt = chatMessage;
  if (chatMessage !== undefined && historyArr.length > 0) {
    const transcript = historyArr
      .filter((m) => typeof m.content === 'string' && m.content.trim())
      .map((m) => {
        const who = m.role === 'USER' ? '使用者' : m.role === 'AGENT' ? '你（助理）' : '系統';
        return `${who}：${m.content}`;
      })
      .join('\n\n');
    chatPrompt = `以下是先前的對話紀錄，供你理解上下文：\n\n${transcript}\n\n───\n\n使用者最新訊息：\n${chatMessage}`;
  }
  const manifest = await compileManifest(
    agentRow.id,
    opts.workflowId,
    agentDir,
    chatPrompt,
    opts.forceVerify === true,
    opts.builderTestSessionId
      ? { sessionId: opts.builderTestSessionId, triggeredBy: opts.triggeredBy }
      : undefined,
  );
  const runInput = manifest.builderTestDraftSkillIds?.length
    ? {
        ...(opts.input ?? {}),
        builderTestEvidence: {
          sessionId: opts.builderTestSessionId,
          draftSkillIds: manifest.builderTestDraftSkillIds,
        },
      }
    : (opts.input ?? {});

  // Sync the agent's cloud file targets into the workspace so EVERY run path
  // (chat, keyword workflow, schedule, test) can read live data from
  // data/cloud-files.md — not just the chat path. Best-effort.
  let hasCloudFiles = false;
  if ((opts.depth ?? 0) === 0 && !opts.builderTestSessionId) {
    try {
      const { gatherAgentFileContext } = await import('../lib/filecontext.js');
      const fileCtx = await gatherAgentFileContext(agentRow.id);
      if (fileCtx) {
        const dataDir = path.join(agentDir, 'data');
        await mkdir(dataDir, { recursive: true });
        await writeFile(path.join(dataDir, 'cloud-files.md'), fileCtx, 'utf8');
        hasCloudFiles = true;
      }
    } catch {
      /* cloud sync is best-effort; the run proceeds without it */
    }
  }

  // Create-or-resume: approval flow already created the run as AWAITING_REVIEW.
  if (opts.approvedApprovalId) {
    const existing = await prisma.run.findUnique({ where: { id: runId } });
    if (existing) {
      await prisma.run.update({
        where: { id: runId },
        data: { status: 'RUNNING' },
      });
    } else {
      await prisma.run.create({
        data: {
          id: runId,
          workflowId: opts.workflowId ?? null,
          agentId: agentRow.id,
          triggeredBy: opts.triggeredBy,
          status: 'RUNNING',
          input: runInput as object,
          runDir,
        },
      });
    }
  } else {
    await prisma.run.create({
      data: {
        id: runId,
        workflowId: opts.workflowId ?? null,
        agentId: agentRow.id,
        triggeredBy: opts.triggeredBy,
        status: 'RUNNING',
        input: runInput as object,
        runDir,
      },
    });
  }
  await audit(opts.triggeredBy, 'run.start', 'Run', runId, { agentId: agentRow.id, workflowId: opts.workflowId ?? null });
  hub.publish('run.started', { runId, agentId: agentRow.id, workflowId: opts.workflowId ?? null, triggeredBy: opts.triggeredBy, startedAt: new Date().toISOString() });

  const rawMessage = chatMessage ?? JSON.stringify(runInput);
  const identity = (runInput.identity as Record<string, unknown>) ?? {};

  const ctx: RunContext = {
    runId,
    runDir,
    manifest,
    input: runInput,
    rawMessage,
    identity,
    approved: [],
    stepOutputs: {},
    reworkFeedback: {},
    attempts: {},
    depth: opts.depth ?? 0,
    triggeredBy: opts.triggeredBy,
    hasCloudFiles,
    costPolicy: (manifest as CompiledManifest & { costPolicy?: unknown }).costPolicy ?? agentRow.costPolicy ?? null,
    signal: opts.signal,
  };

  const stepIndex = new Map(manifest.steps.map((s, idx) => [s.stepKey, idx]));
  const reworkCycles: Record<string, number> = {};
  const results: StepResult[] = [];
  const reworkHistory: StepResult[] = [];
  let conditionJumps = 0;
  let finalStatus: RunStatus = 'SUCCEEDED';
  let stoppedAt: string | undefined;

  try {
    let i = 0;
    while (i < manifest.steps.length) {
      if (opts.signal?.aborted) throw new Error('Agent run aborted');
      const step = manifest.steps[i] as Step;
      ctx.attempts[step.stepKey] = (ctx.attempts[step.stepKey] ?? 0) + 1;

      const r = await runStep(step, ctx);
      results.push(r);
      ctx.stepOutputs[step.stepKey] = r.output;

      if (r.ok) {
        upsertApproved(ctx, step.stepKey, r.output);
        delete ctx.reworkFeedback[step.stepKey];

        if (step.type === 'CONDITION') {
          const parsed = looseParseJson(r.output) as { branch?: string | null } | undefined;
          const branch = parsed?.branch ?? null;
          if (branch && stepIndex.has(branch)) {
            if (++conditionJumps > MAX_CONDITION_JUMPS) {
              finalStatus = 'FAILED';
              stoppedAt = step.stepKey;
              break;
            }
            i = stepIndex.get(branch) as number;
            continue;
          }
        }
        i++;
        continue;
      }

      // Defect rework loop (on_fail): route back to prior steps, re-run them, then re-run this step.
      const cycles = reworkCycles[step.stepKey] ?? 0;
      if (step.onFail && cycles < step.onFail.maxCycles) {
        reworkCycles[step.stepKey] = cycles + 1;
        const targets = await routeDefects(r, step.onFail.routeTo, ctx);
        const defectReport = [`[Issue found downstream at "${step.stepKey}"]\n${r.lastVerdict ?? ''}`, r.output ? `[Full report]\n${r.output}` : ''].filter(Boolean).join('\n\n');

        let reworkFailed = false;
        for (const tid of targets) {
          const targetIdx = stepIndex.get(tid);
          if (targetIdx == null) continue;
          const target = manifest.steps[targetIdx] as Step;
          const prevDeliverable = ctx.stepOutputs[tid] ?? '';
          ctx.reworkFeedback[tid] = `${defectReport}\n\n[Your previous delivery — fix it in place]\n${prevDeliverable}`;
          ctx.attempts[tid] = (ctx.attempts[tid] ?? 0) + 1;

          const rr = await runStep(target, ctx);
          reworkHistory.push(rr);
          ctx.stepOutputs[tid] = rr.output;
          delete ctx.reworkFeedback[tid];

          if (!rr.ok) {
            reworkFailed = true;
            stoppedAt = tid;
            break;
          }
          upsertApproved(ctx, tid, rr.output);
        }
        if (reworkFailed) {
          finalStatus = 'FAILED';
          break;
        }

        ctx.reworkFeedback[step.stepKey] =
          `This is re-check #${cycles + 1}. The issues below were found previously; the relevant steps have been fixed and re-delivered — re-verify specifically against these points:\n${defectReport}`;
        continue; // re-run this step (i unchanged)
      }

      finalStatus = 'FAILED';
      stoppedAt = step.stepKey;
      break;
    }
  } catch (e) {
    finalStatus = 'FAILED';
    stoppedAt = stoppedAt ?? 'runner';
    const isBudget = e instanceof BudgetExceededError;
    const msg = e instanceof Error ? e.message : String(e);
    if (isBudget) {
      await recordViolation({
        agentId: agentRow.id,
        runId,
        kind: 'budget_exceeded',
        detail: { phase: 'runner', message: msg },
      });
      hub.publish('run.log', { runId, line: `預算超限，已 fail-closed 阻斷: ${msg}` });
    }
    results.push({
      ok: false,
      stepKey: 'runner',
      type: 'DO',
      output: msg,
      rounds: 0,
      approved: false,
      reason: isBudget ? `預算超限，已 fail-closed 阻斷: ${msg}` : 'RUNNER_ERROR',
      records: [],
    });
  }

  const output = { results, reworkHistory, stoppedAt: stoppedAt ?? null };
  await prisma.run
    .update({
      where: { id: runId },
      data: { status: finalStatus, output: output as object, stoppedAt: stoppedAt ?? null, finishedAt: new Date() },
    })
    .catch(() => {});
  await audit(opts.triggeredBy, 'run.finish', 'Run', runId, { status: finalStatus, stoppedAt: stoppedAt ?? null });
  hub.publish('run.finished', { runId, agentId: agentRow.id, status: finalStatus, stoppedAt: stoppedAt ?? null });

  const outcome: RunOutcome = {
    ok: finalStatus === 'SUCCEEDED',
    runId,
    runDir,
    status: finalStatus,
    results,
    reworkHistory,
    stoppedAt,
    output,
  };

  // Deterministic memory precipitation (best-effort). Never fails the run.
  // Writes log.md always when memory enabled; embedding/Qdrant is best-effort.
  if (!opts.builderTestSessionId) {
    try {
      const summary = summarizeRun(outcome);
      await ingestRunSummary(agentRow.id, agentDir, runId, summary);
      const conversationId =
        typeof opts.input?.conversationId === 'string' ? opts.input.conversationId : undefined;
      if (conversationId) {
        const lastOk = [...results].reverse().find((r) => r.ok && r.output?.trim());
        const replyText = lastOk?.output ?? '';
        const chatSum = summarizeChat(rawMessage, replyText);
        await ingestChatSummary(agentRow.id, agentDir, conversationId, chatSum, runId);
      }
    } catch (e) {
      console.warn('[memory] post-run ingest failed (non-fatal)', e instanceof Error ? e.message : e);
    }
  }

  // Builder fixtures are evaluation data, not production behavior: do not
  // sediment them into the Agent's memory or self-improvement trace corpus.
  if (!opts.builderTestSessionId) {
    try {
      const { ingestRunTrace } = await import('../lib/trace.js');
      await ingestRunTrace({ agent: agentRow, manifest, outcome });
    } catch (e) {
      console.warn('[trace] post-run trace ingest failed (non-fatal)', e instanceof Error ? e.message : e);
    }
  }

  return outcome;
}
