// Cost ledger + fail-closed budget guard (L7).
// Engines are local CLIs that do not return token usage — all figures here are
// estimates (char-length heuristics + placeholder $/MTok rates). Purpose is not
// precise billing, but stopping a runaway agent loop via hard daily/monthly caps.
import type { Engine } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { config } from '../config.js';

// ── Pure estimators / pricing ────────────────────────────────────────────────

/** Estimate tokens from character length (mixed CJK/EN). Prefer slightly high over low. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export interface EnginePrice {
  /** Estimated USD per 1M input tokens (placeholder; not live market rates). */
  inUsdPerMTok: number;
  /** Estimated USD per 1M output tokens (placeholder; not live market rates). */
  outUsdPerMTok: number;
}

/**
 * Placeholder per-engine list prices ($/MTok). Estimates only — may be
 * overridden later via config. Not for accurate invoicing.
 */
export const PRICING: Record<Engine, EnginePrice> = {
  CLAUDE_CODE: { inUsdPerMTok: 3, outUsdPerMTok: 15 },
  CODEX: { inUsdPerMTok: 2.5, outUsdPerMTok: 10 },
  GROK: { inUsdPerMTok: 2, outUsdPerMTok: 10 },
};

/** Compute estimated USD cost from token counts and PRICING table. */
export function priceUsd(engine: Engine, inputTokens: number, outputTokens: number): number {
  const p = PRICING[engine];
  return (inputTokens / 1_000_000) * p.inUsdPerMTok + (outputTokens / 1_000_000) * p.outUsdPerMTok;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
  todayUsd: number;
  monthUsd: number;
}

export type CostPolicy = {
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  hardStop?: boolean;
} | null | undefined;

/**
 * Pure fail-closed budget decision (no DB).
 * - null/undefined policy → allowed (no limit configured)
 * - hardStop === false → allowed (soft mode; never block)
 * - otherwise if daily or monthly budget is set and spend is at/over → denied
 */
export function decideBudget(
  policy: CostPolicy,
  todayUsd: number,
  monthUsd: number,
): BudgetDecision {
  const base = { todayUsd, monthUsd };
  if (policy == null) {
    return { allowed: true, ...base };
  }
  if (policy.hardStop === false) {
    return { allowed: true, ...base };
  }
  // hardStop !== false → fail-closed hard stop when over budget
  if (
    typeof policy.dailyBudgetUsd === 'number' &&
    Number.isFinite(policy.dailyBudgetUsd) &&
    todayUsd >= policy.dailyBudgetUsd
  ) {
    return {
      allowed: false,
      reason: `日預算超限：今日已用 $${todayUsd.toFixed(6)} ≥ 日上限 $${policy.dailyBudgetUsd}（fail-closed）`,
      ...base,
    };
  }
  if (
    typeof policy.monthlyBudgetUsd === 'number' &&
    Number.isFinite(policy.monthlyBudgetUsd) &&
    monthUsd >= policy.monthlyBudgetUsd
  ) {
    return {
      allowed: false,
      reason: `月預算超限：本月已用 $${monthUsd.toFixed(6)} ≥ 月上限 $${policy.monthlyBudgetUsd}（fail-closed）`,
      ...base,
    };
  }
  return { allowed: true, ...base };
}

// ── Error ────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(reason: string) {
    super(reason);
    this.name = 'BudgetExceededError';
  }
}

// ── Local-day / month bounds (config.tz) ─────────────────────────────────────

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Convert a wall-clock time in `timeZone` to a UTC Date (iterative offset fix). */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i++) {
    const local = zonedParts(new Date(utcMs), timeZone);
    const asIfUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    utcMs += desired - asIfUtc;
  }
  return new Date(utcMs);
}

function startOfLocalDay(now = new Date(), timeZone = config.tz): Date {
  const p = zonedParts(now, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, 0, timeZone);
}

function startOfLocalMonth(now = new Date(), timeZone = config.tz): Date {
  const p = zonedParts(now, timeZone);
  return zonedTimeToUtc(p.year, p.month, 1, 0, 0, 0, timeZone);
}

function decimalToNumber(v: Prisma.Decimal | null | undefined): number {
  if (v == null) return 0;
  return Number(v);
}

// ── DB-backed spend / guard / record ─────────────────────────────────────────

export async function getSpend(agentId: string): Promise<{ todayUsd: number; monthUsd: number }> {
  const dayStart = startOfLocalDay();
  const monthStart = startOfLocalMonth();

  const [todayAgg, monthAgg] = await Promise.all([
    prisma.costLog.aggregate({
      where: { agentId, createdAt: { gte: dayStart } },
      _sum: { costUsd: true },
    }),
    prisma.costLog.aggregate({
      where: { agentId, createdAt: { gte: monthStart } },
      _sum: { costUsd: true },
    }),
  ]);

  return {
    todayUsd: decimalToNumber(todayAgg._sum.costUsd),
    monthUsd: decimalToNumber(monthAgg._sum.costUsd),
  };
}

function parsePolicy(policy: unknown): CostPolicy {
  if (policy == null) return null;
  if (typeof policy !== 'object' || Array.isArray(policy)) return null;
  const p = policy as Record<string, unknown>;
  const out: {
    dailyBudgetUsd?: number;
    monthlyBudgetUsd?: number;
    hardStop?: boolean;
  } = {};
  if (typeof p.dailyBudgetUsd === 'number') out.dailyBudgetUsd = p.dailyBudgetUsd;
  if (typeof p.monthlyBudgetUsd === 'number') out.monthlyBudgetUsd = p.monthlyBudgetUsd;
  if (typeof p.hardStop === 'boolean') out.hardStop = p.hardStop;
  return out;
}

/**
 * Fail-closed budget check. Throws BudgetExceededError when over limit.
 * Does not swallow — callers must let this abort the run.
 */
export async function guardBudget(agentId: string, policy: unknown): Promise<void> {
  const parsed = parsePolicy(policy);
  const spend = await getSpend(agentId);
  const decision = decideBudget(parsed, spend.todayUsd, spend.monthUsd);
  if (!decision.allowed) {
    throw new BudgetExceededError(
      decision.reason ?? '預算超限，已 fail-closed 阻斷',
    );
  }
}

/** Estimate tokens/price from text and append one CostLog row. */
export async function recordCost(args: {
  agentId: string;
  runId?: string | null;
  engine: Engine;
  inputText: string;
  outputText: string;
  /** Workflow step key; null/omit for non-step contexts (manager decision, etc.). */
  stepKey?: string;
}): Promise<void> {
  const inputTokens = estimateTokens(args.inputText);
  const outputTokens = estimateTokens(args.outputText);
  const cost = priceUsd(args.engine, inputTokens, outputTokens);
  await prisma.costLog.create({
    data: {
      id: ulid(),
      agentId: args.agentId,
      runId: args.runId ?? null,
      engine: args.engine,
      inputTokens,
      outputTokens,
      costUsd: new Prisma.Decimal(cost.toFixed(6)),
      stepKey: args.stepKey ?? null,
    },
  });
}

/**
 * Aggregate estimated spend by workflow stepKey over the last 30 days.
 * Rows with null stepKey (non-step contexts) are included as stepKey: null.
 */
export async function getSpendByStep(
  agentId: string,
): Promise<
  Array<{
    stepKey: string | null;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
  }>
> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.costLog.groupBy({
    by: ['stepKey'],
    where: { agentId, createdAt: { gte: since } },
    _sum: {
      costUsd: true,
      inputTokens: true,
      outputTokens: true,
    },
    _count: { _all: true },
  });
  return rows.map((r) => ({
    stepKey: r.stepKey,
    costUsd: decimalToNumber(r._sum.costUsd),
    inputTokens: r._sum.inputTokens ?? 0,
    outputTokens: r._sum.outputTokens ?? 0,
    calls: r._count._all,
  }));
}
