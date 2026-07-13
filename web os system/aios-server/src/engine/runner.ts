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
import { materializeAgent } from './materialize.js';
import { runClaude, runClaudeStream } from './claude.js';
import { runCodex, isApproved } from './codex.js';
import { runGrok } from './grok.js';
import { parseRestrictions, restrictionsToRules } from './restrictions.js';
import { runTool, evalCondition } from './tools.js';
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
  StepResult,
  RoundRecord,
  RunOutcome,
  RunAgentOptions,
} from './types.js';

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
          instruction: String(cfg.instruction ?? ''),
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
      return { ...base, type: 'TOOL', config: { tool: String(cfg.tool ?? ''), args: (cfg.args as Record<string, string>) ?? {} } };
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
        config: { skillId: String(cfg.skillId ?? ''), instructions: cfg.instructions as string | undefined, timeoutMs: cfg.timeoutMs as number | undefined },
      };
    default:
      throw new Error(`Unknown step type: ${row.type}`);
  }
}

async function compileManifest(agentId: string, workflowId: string | undefined, agentDir: string, chatMessage?: string): Promise<CompiledManifest> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { skills: { include: { skill: true } } },
  });
  if (!agent || agent.deletedAt) throw errors.notFound(`Agent not found: ${agentId}`);

  const skills: CompiledSkill[] = agent.skills
    .map((as) => as.skill)
    .filter((s) => s.reviewStatus === 'CONFIRMED' && !s.deletedAt)
    .map((s) => ({ name: s.slug, contentMd: s.contentMd }));

  const engineExecute: Engine = agent.engineExecute;
  // Verifier: the agent's explicit choice (e.g. GROK for speed), else the
  // opposite CLI of the executor. Cross-model rule: never verify with the
  // same engine that executed.
  const autoVerify: Engine = engineExecute === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE';
  const engineVerify: Engine = agent.engineVerify && agent.engineVerify !== engineExecute ? agent.engineVerify : autoVerify;

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
    // Ad-hoc single DO step for direct chat with the agent. Chat skips the
    // cross-model verify gate (user decision: 對話不驗證) — verification stays
    // on for real workflow steps, where correctness gates matter.
    steps = [
      {
        stepKey: 'chat',
        type: 'DO',
        verifyRubric: null,
        onFail: null,
        config: { instruction: chatMessage ?? '', skipVerify: true },
      } as DoStep,
    ];
  }

  return {
    agentSlug: agent.slug,
    agentId: agent.id,
    agentDir,
    engineExecute,
    engineVerify,
    maxRounds: Math.max(1, agent.maxRounds ?? 5),
    rolePrompt: agent.rolePrompt ?? '',
    restrictions: parseRestrictions(agent.restrictions),
    skills,
    steps,
  };
}

// ── Engine dispatch (execute / verify / manager-decision prompts) ──────────

function buildSystemPrompt(manifest: CompiledManifest): string {
  const parts: string[] = [];
  if (manifest.rolePrompt) parts.push(manifest.rolePrompt);
  const rules = restrictionsToRules(manifest.restrictions);
  if (rules) parts.push(rules);
  for (const sk of manifest.skills) {
    parts.push(`# Skill: ${sk.name}\n(This is a skill manual you have — follow its rules and steps when relevant.)\n\n${sk.contentMd}`);
  }
  return parts.join('\n\n---\n\n');
}

function buildExecutePrompt(ctx: RunContext, instruction: string, feedback: string | null, includeRole: boolean): string {
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

async function runExecuteStep(ctx: RunContext, step: DoStep, feedback: string | null, round: number): Promise<string> {
  const instruction = resolveTemplate(step.config.instruction, ctx);
  const onLine = (line: string) => {
    if (line.trim()) hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round, line });
  };

  if (ctx.manifest.engineExecute === 'CODEX') {
    const prompt = buildExecutePrompt(ctx, instruction, feedback, true);
    const res = await runCodex({ prompt, cwd: ctx.manifest.agentDir, sandbox: 'workspace-write', timeoutMs: EXEC_TIMEOUT_MS, onLine });
    return res.text;
  }
  if (ctx.manifest.engineExecute === 'GROK') {
    const prompt = buildExecutePrompt(ctx, instruction, feedback, true);
    const res = await runGrok({
      prompt,
      cwd: ctx.manifest.agentDir,
      timeoutMs: EXEC_TIMEOUT_MS,
      disableWebSearch: !ctx.manifest.restrictions.webSearch,
      onLine,
    });
    return res.stdout;
  }
  const prompt = buildExecutePrompt(ctx, instruction, feedback, false);
  const res = await runClaudeStream({
    prompt,
    systemAppend: buildSystemPrompt(ctx.manifest) || undefined,
    cwd: ctx.manifest.agentDir,
    fullPermissions: step.config.permissions === 'full',
    disallowedTools: ctx.manifest.restrictions.webSearch ? undefined : ['WebSearch', 'WebFetch'],
    timeoutMs: EXEC_TIMEOUT_MS,
    onLine,
  });
  return res.stdout;
}

function buildVerifyPrompt(rubric: string, artifact: string, sourceOfTruth: string, isResume: boolean): string {
  if (isResume) {
    return [
      "[Re-review] The other party has attempted to fix the issues from your previous round. Below is the revised artifact.",
      'Review it again against the same rubric and source of truth, and mark each of your previous pushback points CONCEDE or MAINTAIN.',
      '',
      '[Revised artifact]',
      artifact,
      '',
      'Discipline: do not rubber-stamp, do not concede just to end the loop, do not treat MAINTAIN as APPROVED. If real problems remain, say ISSUES FOUND.',
      '[Reply format — mandatory] The last two lines of your reply must be exactly:',
      '## Verdict',
      'APPROVED  (or)  ISSUES FOUND',
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
    '[Reply format — mandatory] The last two lines of your reply must be exactly:',
    '## Verdict',
    'APPROVED  (or)  ISSUES FOUND',
  ].join('\n');
}

async function runVerifyStep(ctx: RunContext, rubric: string, artifact: string, sourceOfTruth: string, threadId: string | null): Promise<VerdictResult> {
  if (ctx.manifest.engineVerify === 'CODEX') {
    const isResume = threadId != null;
    const prompt = buildVerifyPrompt(rubric, artifact, sourceOfTruth, isResume);
    const res = await runCodex({ prompt, cwd: ctx.manifest.agentDir, resumeThreadId: threadId, sandbox: 'read-only', timeoutMs: VERIFY_TIMEOUT_MS });
    return { approved: isApproved(res.text), text: res.text, threadId: res.threadId };
  }
  if (ctx.manifest.engineVerify === 'GROK') {
    // Grok verifier: fast cross-model review; session resume keeps its own
    // prior objections across rounds (CONCEDE/MAINTAIN discipline).
    const isResume = threadId != null;
    const prompt = buildVerifyPrompt(rubric, artifact, sourceOfTruth, isResume);
    const sys =
      'You are an independent, cross-model verifier (Grok). Treat the artifact as a claim to be falsified, not assumed true. Do not modify any files — review only.';
    const res = await runGrok({
      prompt,
      systemAppend: sys,
      cwd: ctx.manifest.agentDir,
      resumeSessionId: threadId,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    return { approved: isApproved(res.stdout), text: res.stdout, threadId: res.sessionId };
  }
  // Claude verifier: `claude -p` has no cross-round thread, so every round is a stateless re-review.
  const prompt = buildVerifyPrompt(rubric, artifact, sourceOfTruth, false);
  const sys =
    'You are an independent, cross-model verifier (Claude Code). Treat the artifact as a claim to be falsified, not assumed true.';
  const res = await runClaude({
    prompt,
    systemAppend: sys,
    cwd: ctx.manifest.agentDir,
    // Read-only web access so the verifier can actually check cited external
    // sources (e.g. news URLs) instead of fail-closing on "cannot verify".
    // Honors the agent's webSearch restriction.
    allowedTools: ctx.manifest.restrictions.webSearch ? ['WebFetch', 'WebSearch'] : undefined,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  return { approved: isApproved(res.stdout), text: res.stdout, threadId: null };
}

async function callManagerDecision(ctx: RunContext, instruction: string, source: string): Promise<string> {
  if (ctx.manifest.engineExecute === 'CODEX') {
    const parts = [ctx.manifest.rolePrompt ? `[Role]\n${ctx.manifest.rolePrompt}` : '', `[Task]\n${instruction}`, `[Context]\n${source}`].filter(Boolean);
    const res = await runCodex({ prompt: parts.join('\n\n'), cwd: ctx.manifest.agentDir, sandbox: 'workspace-write', timeoutMs: DECISION_TIMEOUT_MS });
    return res.text;
  }
  const prompt = [`[Task]\n${instruction}`, `[Context]\n${source}`].join('\n\n');
  const res = await runClaude({ prompt, systemAppend: ctx.manifest.rolePrompt || undefined, cwd: ctx.manifest.agentDir, timeoutMs: DECISION_TIMEOUT_MS });
  return res.stdout;
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
      const reason = `EXECUTE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
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
      const reason = `VERIFY_ERROR: ${e instanceof Error ? e.message : String(e)}`;
      await persistRunStep(ctx, step.stepKey, round, 'error', { error: reason, output });
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

  let result: unknown;
  try {
    result = await runTool(ctx.manifest.agentDir, step.config.tool, args, {
      agentId: ctx.manifest.agentId,
      agentDir: ctx.manifest.agentDir,
      cloudWrite: ctx.manifest.restrictions.cloudWrite,
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
    const reason = `VERIFY_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason, output });
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
    await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
    hub.publish('run.log', { runId: ctx.runId, stepKey: step.stepKey, round: 1, line: reason });
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }
  const taskId = ulid();
  try {
    await prisma.computerControlTask.create({
      data: { id: taskId, runId: ctx.runId, stepKey: step.stepKey, skillId: step.config.skillId, status: 'PENDING' },
    });
  } catch (e) {
    const reason = `COMPUTER_CONTROL_TASK_CREATE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
  }

  hub.publish('computer.control_requested', {
    runId: ctx.runId,
    taskId,
    stepKey: step.stepKey,
    skillId: step.config.skillId,
    instructions: resolveTemplate(step.config.instructions ?? '', ctx) || null,
  });

  const timeoutMs = step.config.timeoutMs ?? COMPUTER_CONTROL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let dispatched = false;

  while (Date.now() < deadline) {
    const task = await prisma.computerControlTask.findUnique({ where: { id: taskId } }).catch(() => null);
    if (!task) break;
    if (task.dispatchedTo) dispatched = true;
    if (task.status === 'DONE' || task.status === 'SUCCEEDED') {
      const output = JSON.stringify(task.result ?? {});
      await save(ctx, `${step.stepKey}.r1.output.txt`, output);
      await persistRunStep(ctx, step.stepKey, 1, 'approved', { output, approved: true });
      return { ok: true, stepKey: step.stepKey, type: step.type, output, rounds: 1, approved: true, records: [] };
    }
    if (task.status === 'FAILED' || task.status === 'ERROR') {
      const reason = `COMPUTER_CONTROL_FAILED: ${JSON.stringify(task.result ?? {})}`;
      await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
      return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
    }
    await sleep(1000);
  }

  const reason = dispatched ? 'COMPUTER_CONTROL_TIMEOUT' : 'NO_EXECUTOR';
  await prisma.computerControlTask.update({ where: { id: taskId }, data: { status: 'TIMEOUT' } }).catch(() => {});
  await persistRunStep(ctx, step.stepKey, 1, 'error', { error: reason });
  return { ok: false, stepKey: step.stepKey, type: step.type, output: '', rounds: 1, approved: false, reason, records: [] };
}

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
  } catch {
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
export async function runAgent(opts: RunAgentOptions): Promise<RunOutcome> {
  const agentRow = await prisma.agent.findUnique({ where: { id: opts.agentId } });
  if (!agentRow || agentRow.deletedAt) throw errors.notFound(`Agent not found: ${opts.agentId}`);

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
  const manifest = await compileManifest(agentRow.id, opts.workflowId, agentDir, chatPrompt);

  // Sync the agent's cloud file targets into the workspace so EVERY run path
  // (chat, keyword workflow, schedule, test) can read live data from
  // data/cloud-files.md — not just the chat path. Best-effort.
  let hasCloudFiles = false;
  if ((opts.depth ?? 0) === 0) {
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

  await prisma.run.create({
    data: {
      id: runId,
      workflowId: opts.workflowId ?? null,
      agentId: agentRow.id,
      triggeredBy: opts.triggeredBy,
      status: 'RUNNING',
      input: (opts.input ?? {}) as object,
      runDir,
    },
  });
  await audit(opts.triggeredBy, 'run.start', 'Run', runId, { agentId: agentRow.id, workflowId: opts.workflowId ?? null });
  hub.publish('run.started', { runId, agentId: agentRow.id, workflowId: opts.workflowId ?? null, triggeredBy: opts.triggeredBy, startedAt: new Date().toISOString() });

  const rawMessage = chatMessage ?? JSON.stringify(opts.input ?? {});
  const identity = (opts.input?.identity as Record<string, unknown>) ?? {};

  const ctx: RunContext = {
    runId,
    runDir,
    manifest,
    input: opts.input ?? {},
    rawMessage,
    identity,
    approved: [],
    stepOutputs: {},
    reworkFeedback: {},
    attempts: {},
    depth: opts.depth ?? 0,
    triggeredBy: opts.triggeredBy,
    hasCloudFiles,
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
    results.push({
      ok: false,
      stepKey: 'runner',
      type: 'DO',
      output: e instanceof Error ? e.message : String(e),
      rounds: 0,
      approved: false,
      reason: 'RUNNER_ERROR',
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

  return { ok: finalStatus === 'SUCCEEDED', runId, runDir, status: finalStatus, results, reworkHistory, stoppedAt, output };
}
