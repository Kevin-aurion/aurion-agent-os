// Skill evaluation suites: CRUD + deterministic checkers + cross-model non-deterministic eval.
// Iron rules: execute != verify (fail-closed); evidence always via redactSecrets; recordCost fail-safe.
import type {
  Engine,
  EvalCase,
  EvalCaseKind,
  EvalRun,
  EvalSuite,
  Prisma,
} from '@prisma/client';
import { Prisma as PrismaNs } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { errors } from './http.js';
import { isApproved } from '../engine/codex.js';
import { estimateTokens, priceUsd, recordCost } from '../engine/cost.js';
import { redactSecrets } from '../memory/redactor.js';

export interface EvalRunnerDeps {
  /** Produce candidate output for non-deterministic / high-risk cases. Default throws. */
  runCandidate?: (a: {
    engine: Engine;
    input: string;
    kind: EvalCaseKind;
  }) => Promise<{ output: string; latencyMs?: number; costText?: string }>;
  /** Cross-model judge; default uses isApproved() on output. */
  judge?: (a: {
    engine: Engine;
    output: string;
    rubric: string;
  }) => Promise<{ approved: boolean; rationale: string }>;
}

/** Fixed, predictable peer engine; always returns a different engine than input. */
export function crossVerifyEngine(execute: Engine): Engine {
  switch (execute) {
    case 'CLAUDE_CODE':
      return 'GROK';
    case 'CODEX':
      return 'GROK';
    case 'GROK':
      return 'CLAUDE_CODE';
    default: {
      const _exhaustive: never = execute;
      throw errors.badRequest(`未知執行引擎: ${String(_exhaustive)}`);
    }
  }
}

export async function createSuite(args: {
  skillId: string;
  name: string;
  description?: string;
  createdBy?: string;
}): Promise<EvalSuite> {
  const skill = await prisma.skill.findFirst({
    where: { id: args.skillId, deletedAt: null },
    select: { id: true },
  });
  if (!skill) throw errors.notFound('Skill not found');

  return prisma.evalSuite.create({
    data: {
      id: ulid(),
      skillId: args.skillId,
      name: args.name,
      description: args.description ?? null,
      createdBy: args.createdBy ?? null,
    },
  });
}

export async function addCase(args: {
  suiteId: string;
  kind: EvalCaseKind;
  name: string;
  input: unknown;
  expected?: unknown;
  requiredTools?: string[];
  forbiddenTools?: string[];
  weight?: number;
}): Promise<EvalCase> {
  const suite = await prisma.evalSuite.findUnique({ where: { id: args.suiteId } });
  if (!suite) throw errors.notFound('EvalSuite not found');

  return prisma.evalCase.create({
    data: {
      id: ulid(),
      suiteId: args.suiteId,
      kind: args.kind,
      name: args.name,
      input: args.input as Prisma.InputJsonValue,
      expected:
        args.expected === undefined
          ? undefined
          : (args.expected as Prisma.InputJsonValue),
      requiredTools: args.requiredTools ?? [],
      forbiddenTools: args.forbiddenTools ?? [],
      weight: args.weight ?? 1,
    },
  });
}

export async function getSuite(suiteId: string) {
  const suite = await prisma.evalSuite.findUnique({
    where: { id: suiteId },
    include: { cases: { orderBy: { createdAt: 'asc' } } },
  });
  if (!suite) throw errors.notFound('EvalSuite not found');
  return suite;
}

export async function listSuitesForSkill(skillId: string) {
  const suites = await prisma.evalSuite.findMany({
    where: { skillId },
    orderBy: { createdAt: 'desc' },
  });

  const withLastRun = await Promise.all(
    suites.map(async (s) => {
      const last = await prisma.evalRun.findFirst({
        where: { suiteId: s.id },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          status: true,
          passedCases: true,
          failedCases: true,
          finishedAt: true,
          totalCases: true,
        },
      });
      return {
        ...s,
        lastRun: last
          ? {
              id: last.id,
              status: last.status,
              passed: last.passedCases,
              failed: last.failedCases,
              finishedAt: last.finishedAt,
              totalCases: last.totalCases,
            }
          : null,
      };
    }),
  );
  return withLastRun;
}

export async function getRun(runId: string) {
  const run = await prisma.evalRun.findUnique({
    where: { id: runId },
    include: {
      results: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!run) throw errors.notFound('EvalRun not found');
  // evidence is stored already redacted
  return run;
}

// ── Case evaluation helpers ──────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function phraseFromInput(input: unknown): string {
  if (typeof input === 'string') return input;
  const rec = asRecord(input);
  if (typeof rec.phrase === 'string') return rec.phrase;
  if (typeof rec.payload === 'string') return rec.payload;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function detectTrigger(phrase: string, keywords: string[]): boolean {
  const lower = phrase.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Deterministic tool coverage: required must all be present; forbidden must none hit. */
function checkTools(
  observed: string[],
  required: string[],
  forbidden: string[],
): { ok: boolean; reason: string } {
  const obs = new Set(observed.map((t) => t.toLowerCase()));
  const missing = required.filter((t) => !obs.has(t.toLowerCase()));
  const hit = forbidden.filter((t) => obs.has(t.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, reason: `缺少必要工具: ${missing.join(', ')}` };
  }
  if (hit.length > 0) {
    return { ok: false, reason: `命中禁止工具: ${hit.join(', ')}` };
  }
  return { ok: true, reason: 'tools ok' };
}

const TRIGGER_KINDS: EvalCaseKind[] = [
  'POSITIVE_TRIGGER',
  'NEGATIVE_TRIGGER',
  'CONFUSION_PAIR',
];

const HIGH_RISK_KINDS: EvalCaseKind[] = ['PROMPT_INJECTION', 'RED_TEAM'];

const NON_DET_KINDS: EvalCaseKind[] = ['OUTPUT_RUBRIC', 'TRAJECTORY'];

async function defaultRunCandidate(): Promise<never> {
  throw new Error('no runCandidate configured');
}

async function defaultJudge(a: {
  engine: Engine;
  output: string;
  rubric: string;
}): Promise<{ approved: boolean; rationale: string }> {
  // Fail-closed oracle: REJECTED before APPROVED (isApproved).
  void a.engine;
  void a.rubric;
  const approved = isApproved(a.output);
  return {
    approved,
    rationale: approved ? 'isApproved=true' : 'isApproved=false (fail-closed)',
  };
}

/**
 * Sanitized evidence for high-risk execution failures.
 * One-line message only — no stack, no prompt, no raw provider dump.
 * Always passed through redactSecrets before return.
 */
function safeExecErrorEvidence(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const oneLine = raw
    .split(/\r?\n/)[0]
    ?.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) ?? 'unknown error';
  return redactSecrets(`high-risk candidate execution failed (fail-closed): ${oneLine}`);
}

type CaseEvalOut = {
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  score: number | null;
  engine: Engine | null;
  deterministic: boolean;
  latencyMs: number | null;
  costUsd: number;
  evidence: string;
  highRisk: boolean;
};

async function evaluateCase(opts: {
  c: EvalCase;
  executeEngine: Engine;
  verifyEngine: Engine;
  deps: Required<EvalRunnerDeps>;
  agentId?: string;
  evalRunId: string;
}): Promise<CaseEvalOut> {
  const { c, executeEngine, verifyEngine, deps, agentId, evalRunId } = opts;
  const expected = asRecord(c.expected);
  const inputPhrase = phraseFromInput(c.input);

  // Shared tool check data from expected.toolsInvoked
  const toolsInvoked = stringArray(expected.toolsInvoked);

  if (TRIGGER_KINDS.includes(c.kind)) {
    const shouldTrigger = expected.shouldTrigger === true;
    const keywords = stringArray(expected.triggerKeywords);
    const triggered = detectTrigger(inputPhrase, keywords);
    let pass = triggered === shouldTrigger;
    let evidence = `trigger=${triggered} expected=${shouldTrigger} keywords=[${keywords.join(',')}]`;

    const toolCheck = checkTools(toolsInvoked, c.requiredTools, c.forbiddenTools);
    if (!toolCheck.ok) {
      pass = false;
      evidence += `; ${toolCheck.reason}`;
    }

    return {
      status: pass ? 'PASS' : 'FAIL',
      score: pass ? 1 : 0,
      engine: null,
      deterministic: true,
      latencyMs: null,
      costUsd: 0,
      evidence: redactSecrets(evidence),
      highRisk: false,
    };
  }

  if (HIGH_RISK_KINDS.includes(c.kind)) {
    // Fail-closed: any throw during candidate execution / checks / evidence prep
    // must FAIL the case. Never substitute inputPhrase as if execution succeeded.
    try {
      let output: string;
      let latencyMs: number | null = null;
      let caseCost = 0;

      if (deps.runCandidate !== defaultRunCandidate) {
        // Real candidate path (CLI / injected). Errors → catch below (no input fallback).
        const cand = await deps.runCandidate({
          engine: executeEngine,
          input: inputPhrase,
          kind: c.kind,
        });
        output = cand.output;
        latencyMs = cand.latencyMs ?? null;
        if (cand.costText) {
          caseCost = priceUsd(
            executeEngine,
            estimateTokens(inputPhrase),
            estimateTokens(cand.costText || cand.output),
          );
        }
      } else {
        // No executor configured: offline deterministic check of the payload text only
        // (not a post-throw fallback — execution was never attempted).
        output = inputPhrase;
      }

      const forbidden = [
        ...stringArray(expected.forbiddenOutput),
        ...stringArray(expected.canaries),
      ];
      const breached = forbidden.filter((f) => f.length > 0 && output.includes(f));
      const securityPass = breached.length === 0;
      let pass = securityPass;
      // Snippet of candidate output only; always redact before persist.
      let evidence = securityPass
        ? `security PASS; output_len=${output.length}; snippet=${output.slice(0, 400)}`
        : `security FAIL; breached=${breached.length} markers; snippet=${output.slice(0, 400)}`;

      const toolCheck = checkTools(toolsInvoked, c.requiredTools, c.forbiddenTools);
      if (!toolCheck.ok) {
        pass = false;
        evidence += `; ${toolCheck.reason}`;
      }

      // Ancillary: cost ledger fail-safe (never fails the eval decision)
      if (agentId) {
        try {
          await recordCost({
            agentId,
            runId: evalRunId,
            engine: executeEngine,
            inputText: inputPhrase,
            outputText: output,
            stepKey: `eval:${c.id}`,
          });
        } catch (e) {
          console.warn('recordCost failed (non-fatal)', e);
        }
      }

      return {
        status: pass ? 'PASS' : 'FAIL',
        score: pass ? 1 : 0,
        engine: null,
        deterministic: true,
        latencyMs,
        costUsd: caseCost,
        evidence: redactSecrets(evidence),
        // highRisk when injection/red-team markers appear in output (breach)
        highRisk: !securityPass,
      };
    } catch (e) {
      // Execution / budget / dispatch / evidence prep threw → deterministic fail-closed.
      // highRisk=true so promote gate rejects even if another suite has a PASSED run.
      return {
        status: 'ERROR',
        score: null,
        engine: null,
        deterministic: true,
        latencyMs: null,
        costUsd: 0,
        evidence: safeExecErrorEvidence(e),
        highRisk: true,
      };
    }
  }

  if (NON_DET_KINDS.includes(c.kind)) {
    const cand = await deps.runCandidate({
      engine: executeEngine,
      input: inputPhrase,
      kind: c.kind,
    });
    const rubric =
      typeof expected.rubric === 'string' ? expected.rubric : '';
    const verdict = await deps.judge({
      engine: verifyEngine,
      output: cand.output,
      rubric,
    });
    let pass = verdict.approved;
    let evidence = `judge=${verdict.approved ? 'APPROVED' : 'REJECTED'}; ${verdict.rationale}; out=${cand.output.slice(0, 300)}`;

    const toolCheck = checkTools(toolsInvoked, c.requiredTools, c.forbiddenTools);
    if (!toolCheck.ok) {
      pass = false;
      evidence += `; ${toolCheck.reason}`;
    }

    const caseCost = priceUsd(
      executeEngine,
      estimateTokens(inputPhrase),
      estimateTokens(cand.costText ?? cand.output),
    );

    if (agentId) {
      try {
        await recordCost({
          agentId,
          runId: evalRunId,
          engine: executeEngine,
          inputText: inputPhrase,
          outputText: cand.output,
          stepKey: `eval:${c.id}`,
        });
      } catch (e) {
        console.warn('recordCost failed (non-fatal)', e);
      }
    }

    return {
      status: pass ? 'PASS' : 'FAIL',
      score: pass ? 1 : 0,
      engine: verifyEngine,
      deterministic: false,
      latencyMs: cand.latencyMs ?? null,
      costUsd: caseCost,
      evidence: redactSecrets(evidence),
      highRisk: false,
    };
  }

  // Unknown kind — fail closed as ERROR
  return {
    status: 'ERROR',
    score: null,
    engine: null,
    deterministic: true,
    latencyMs: null,
    costUsd: 0,
    evidence: redactSecrets(`unsupported kind: ${c.kind}`),
    highRisk: false,
  };
}

export async function runSuite(args: {
  suiteId: string;
  candidateVersionId?: string;
  executeEngine: Engine;
  verifyEngine?: Engine;
  triggeredBy?: string;
  agentId?: string;
  deps?: EvalRunnerDeps;
}): Promise<EvalRun> {
  const suite = await prisma.evalSuite.findUnique({
    where: { id: args.suiteId },
    include: { cases: { orderBy: { createdAt: 'asc' } } },
  });
  if (!suite) throw errors.notFound('EvalSuite not found');

  const executeEngine = args.executeEngine;
  const verifyEngine = args.verifyEngine ?? crossVerifyEngine(executeEngine);

  // Fail-closed cross-model invariant — before creating EvalRun
  if (verifyEngine === executeEngine) {
    throw errors.badRequest(
      '非決定性評測的驗證引擎必須不同於候選執行引擎（跨模型驗證閘）',
    );
  }

  const deps: Required<EvalRunnerDeps> = {
    runCandidate: args.deps?.runCandidate ?? defaultRunCandidate,
    judge: args.deps?.judge ?? defaultJudge,
  };

  const runId = ulid();
  let run = await prisma.evalRun.create({
    data: {
      id: runId,
      suiteId: suite.id,
      skillId: suite.skillId,
      candidateVersionId: args.candidateVersionId ?? null,
      executeEngine,
      verifyEngine,
      status: 'RUNNING',
      totalCases: suite.cases.length,
      passedCases: 0,
      failedCases: 0,
      costUsd: new PrismaNs.Decimal(0),
      triggeredBy: args.triggeredBy ?? null,
    },
  });

  let passed = 0;
  let failed = 0;
  let totalCost = 0;

  for (const c of suite.cases) {
    let out: CaseEvalOut;
    try {
      out = await evaluateCase({
        c,
        executeEngine,
        verifyEngine,
        deps,
        agentId: args.agentId,
        evalRunId: runId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out = {
        status: 'ERROR',
        score: null,
        engine: NON_DET_KINDS.includes(c.kind) ? verifyEngine : null,
        deterministic: !NON_DET_KINDS.includes(c.kind),
        latencyMs: null,
        costUsd: 0,
        evidence: redactSecrets(`case error: ${msg}`),
        highRisk: false,
      };
    }

    if (out.status === 'PASS') passed += 1;
    else if (out.status === 'FAIL' || out.status === 'ERROR') failed += 1;

    totalCost += out.costUsd;

    await prisma.evalResult.create({
      data: {
        id: ulid(),
        runId,
        caseId: c.id,
        status: out.status,
        score: out.score,
        engine: out.engine,
        deterministic: out.deterministic,
        latencyMs: out.latencyMs,
        costUsd: new PrismaNs.Decimal(out.costUsd.toFixed(6)),
        evidence: out.evidence, // already redacted
        highRisk: out.highRisk,
        resolved: false,
      },
    });
  }

  const finalStatus = failed > 0 ? 'FAILED' : 'PASSED';
  run = await prisma.evalRun.update({
    where: { id: runId },
    data: {
      status: finalStatus,
      passedCases: passed,
      failedCases: failed,
      costUsd: new PrismaNs.Decimal(totalCost.toFixed(6)),
      finishedAt: new Date(),
    },
  });

  return run;
}
