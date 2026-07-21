// Dashboard summary, recent runs, audit log, org/user-management, and health lights (L9).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { audit, verifyAuditChain } from '../lib/audit.js';
import { getSpend } from '../engine/cost.js';
import { hub } from '../ws/hub.js';

// ── L9 health traffic lights (pure aggregation, shared by route + tests) ─────

export type Light = 'green' | 'yellow' | 'red' | 'unknown';

export interface HealthMetric {
  key: string;
  label: string;
  value: string | number | null;
  light: Light;
  reason?: string;
  suggestion?: string;
}

const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;

function rateLight(rate: number): Light {
  if (rate >= 0.9) return 'green';
  if (rate >= 0.7) return 'yellow';
  return 'red';
}

function reworkLight(avg: number): Light {
  if (avg <= 1.3) return 'green';
  if (avg <= 2) return 'yellow';
  return 'red';
}

function hitlLight(n: number): Light {
  if (n === 0) return 'green';
  if (n <= 5) return 'yellow';
  return 'red';
}

function costOverrunLight(n: number): Light {
  if (n === 0) return 'green';
  if (n <= 2) return 'yellow';
  return 'red';
}

function failRateLight(rate: number): Light {
  if (rate < 0.1) return 'green';
  if (rate <= 0.3) return 'yellow';
  return 'red';
}

/** Days since most recent MemoryDoc.indexedAt: ≤7 綠、≤30 黃、>30 紅. */
function memoryFreshnessLight(days: number): Light {
  if (days <= 7) return 'green';
  if (days <= 30) return 'yellow';
  return 'red';
}

function isAtOrOverBudget(
  policy: unknown,
  todayUsd: number,
  monthUsd: number,
): boolean {
  if (policy == null || typeof policy !== 'object' || Array.isArray(policy)) return false;
  const p = policy as Record<string, unknown>;
  if (
    typeof p.dailyBudgetUsd === 'number' &&
    Number.isFinite(p.dailyBudgetUsd) &&
    todayUsd >= p.dailyBudgetUsd
  ) {
    return true;
  }
  if (
    typeof p.monthlyBudgetUsd === 'number' &&
    Number.isFinite(p.monthlyBudgetUsd) &&
    monthUsd >= p.monthlyBudgetUsd
  ) {
    return true;
  }
  return false;
}

/**
 * Compute the ten operational health lights from live DB / audit / cost data.
 * Metrics without a data source are light=unknown (never fake green).
 */
export async function computeHealthMetrics(): Promise<HealthMetric[]> {
  const now = Date.now();
  const since7d = new Date(now - 7 * MS_DAY);
  const since24h = new Date(now - 24 * MS_HOUR);

  const [
    steps7d,
    stepsRound1,
    stepsForRework,
    hitlPending,
    chain,
    agentsForCost,
    latestMemory,
    runs24hByStatus,
  ] = await Promise.all([
    prisma.runStep.findMany({
      where: { startedAt: { gte: since7d }, approved: { not: null } },
      select: { approved: true },
    }),
    prisma.runStep.findMany({
      where: { round: 1, approved: { not: null } },
      select: { approved: true },
    }),
    prisma.runStep.findMany({
      where: { startedAt: { gte: since7d } },
      select: { runId: true, stepKey: true, round: true },
    }),
    prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
    verifyAuditChain(),
    // Json? filter: load agents then keep those with a non-null costPolicy
    prisma.agent.findMany({
      where: { deletedAt: null },
      select: { id: true, costPolicy: true },
    }),
    prisma.memoryDoc.findFirst({
      orderBy: { indexedAt: 'desc' },
      select: { indexedAt: true },
    }),
    prisma.run.groupBy({
      by: ['status'],
      where: { startedAt: { gte: since24h } },
      _count: { _all: true },
    }),
  ]);

  const agentsWithPolicy = agentsForCost.filter((a) => a.costPolicy != null);

  // 1) verify_pass_rate
  let verifyMetric: HealthMetric;
  {
    const total = steps7d.length;
    if (total === 0) {
      verifyMetric = {
        key: 'verify_pass_rate',
        label: '驗證通過率',
        value: null,
        light: 'unknown',
        reason: '近 7 天無驗證資料',
      };
    } else {
      const passed = steps7d.filter((s) => s.approved === true).length;
      const rate = passed / total;
      const light = rateLight(rate);
      verifyMetric = {
        key: 'verify_pass_rate',
        label: '驗證通過率',
        value: Math.round(rate * 1000) / 1000,
        light,
        ...(light === 'red'
          ? {
              reason: '近 7 天驗證通過率偏低',
              suggestion: '檢視常被退回的步驟與 rubric',
            }
          : light === 'yellow'
            ? {
                reason: '近 7 天驗證通過率中等',
                suggestion: '關注被退回步驟的共同模式',
              }
            : {}),
      };
    }
  }

  // 2) first_round_pass
  let firstRoundMetric: HealthMetric;
  {
    const total = stepsRound1.length;
    if (total === 0) {
      firstRoundMetric = {
        key: 'first_round_pass',
        label: '首輪通過率',
        value: null,
        light: 'unknown',
        reason: '尚無首輪驗證資料',
      };
    } else {
      const passed = stepsRound1.filter((s) => s.approved === true).length;
      const rate = passed / total;
      const light = rateLight(rate);
      firstRoundMetric = {
        key: 'first_round_pass',
        label: '首輪通過率',
        value: Math.round(rate * 1000) / 1000,
        light,
        ...(light === 'red'
          ? {
              reason: '首輪驗證通過率偏低',
              suggestion: '強化步驟提示與輸入品質，減少首輪退回',
            }
          : light === 'yellow'
            ? {
                reason: '首輪驗證通過率中等',
                suggestion: '優化常見失敗步驟的 prompt 與範例',
              }
            : {}),
      };
    }
  }

  // 3) avg_rework_rounds — mean of max(round) per (runId, stepKey) in last 7d
  let reworkMetric: HealthMetric;
  {
    if (stepsForRework.length === 0) {
      reworkMetric = {
        key: 'avg_rework_rounds',
        label: '平均重跑輪數',
        value: null,
        light: 'unknown',
        reason: '近 7 天無執行步驟',
      };
    } else {
      const maxByKey = new Map<string, number>();
      for (const s of stepsForRework) {
        const k = `${s.runId}\0${s.stepKey}`;
        const prev = maxByKey.get(k) ?? 0;
        if (s.round > prev) maxByKey.set(k, s.round);
      }
      const maxes = Array.from(maxByKey.values());
      const avg = maxes.reduce((a, b) => a + b, 0) / maxes.length;
      const light = reworkLight(avg);
      reworkMetric = {
        key: 'avg_rework_rounds',
        label: '平均重跑輪數',
        value: Math.round(avg * 1000) / 1000,
        light,
        ...(light === 'red'
          ? {
              reason: '近 7 天平均重跑輪數偏高',
              suggestion: '檢視反覆被退回的 stepKey 與驗證標準',
            }
          : light === 'yellow'
            ? {
                reason: '近 7 天平均重跑輪數中等',
                suggestion: '針對多輪重跑步驟調整提示或限制',
              }
            : {}),
      };
    }
  }

  // 4) hitl_backlog
  const hitlLightVal = hitlLight(hitlPending);
  const hitlMetric: HealthMetric = {
    key: 'hitl_backlog',
    label: 'HITL 待審積壓',
    value: hitlPending,
    light: hitlLightVal,
    ...(hitlLightVal === 'red'
      ? {
          reason: '待審核核准請求過多',
          suggestion: '盡快處理 PENDING 核准或調整高風險員工門檻',
        }
      : hitlLightVal === 'yellow'
        ? {
            reason: '有待審核的核准請求',
            suggestion: '至核准佇列處理 PENDING 項目',
          }
        : {}),
  };

  // 5) audit_chain_integrity
  const auditMetric: HealthMetric = chain.valid
    ? {
        key: 'audit_chain_integrity',
        label: '稽核鏈完整性',
        value: chain.count,
        light: 'green',
      }
    : {
        key: 'audit_chain_integrity',
        label: '稽核鏈完整性',
        value: chain.count,
        light: 'red',
        reason: `稽核鏈中斷${chain.brokenAt ? `（brokenAt=${chain.brokenAt}）` : ''}${chain.reason ? `：${chain.reason}` : ''}`,
        suggestion: '檢查 AuditLog 寫入是否被跳過或手動竄改，必要時還原備份',
      };

  // 6) cost_overrun — agents with costPolicy at/over daily or monthly budget
  let overrunCount = 0;
  for (const a of agentsWithPolicy) {
    const spend = await getSpend(a.id);
    if (isAtOrOverBudget(a.costPolicy, spend.todayUsd, spend.monthUsd)) {
      overrunCount += 1;
    }
  }
  const costLight = costOverrunLight(overrunCount);
  const costMetric: HealthMetric = {
    key: 'cost_overrun',
    label: '成本超標員工數',
    value: overrunCount,
    light: costLight,
    ...(costLight === 'red'
      ? {
          reason: '多位員工已達或超過日/月成本上限',
          suggestion: '檢視 CostLog 與 costPolicy，調高預算或降低執行頻率',
        }
      : costLight === 'yellow'
        ? {
            reason: '有員工已達或超過成本上限',
            suggestion: '檢查超標員工的 spend 與預算設定',
          }
        : {}),
  };

  // 7) memory_freshness
  let memoryMetric: HealthMetric;
  if (!latestMemory) {
    memoryMetric = {
      key: 'memory_freshness',
      label: '記憶新鮮度',
      value: null,
      light: 'unknown',
      reason: '尚無 MemoryDoc 資料',
    };
  } else {
    const days = Math.max(
      0,
      (now - latestMemory.indexedAt.getTime()) / MS_DAY,
    );
    const daysRounded = Math.round(days * 10) / 10;
    const light = memoryFreshnessLight(days);
    memoryMetric = {
      key: 'memory_freshness',
      label: '記憶新鮮度',
      value: daysRounded,
      light,
      ...(light === 'red'
        ? {
            reason: '最近記憶索引距今過久',
            suggestion: '觸發員工記憶彙整／索引，確認 embedding 管線正常',
          }
        : light === 'yellow'
          ? {
              reason: '記憶索引稍舊',
              suggestion: '安排定期記憶彙整以保持 wiki／摘要最新',
            }
          : {}),
    };
  }

  // 8) runs_today — last 24h status counts + FAILED ratio
  let totalRuns = 0;
  let failedRuns = 0;
  for (const row of runs24hByStatus) {
    const n = row._count._all;
    totalRuns += n;
    if (row.status === 'FAILED') failedRuns = n;
  }
  let runsMetric: HealthMetric;
  if (totalRuns === 0) {
    runsMetric = {
      key: 'runs_today',
      label: '今日執行量/失敗',
      value: 'total=0 failed=0',
      light: 'green',
    };
  } else {
    const failRate = failedRuns / totalRuns;
    const light = failRateLight(failRate);
    runsMetric = {
      key: 'runs_today',
      label: '今日執行量/失敗',
      value: `total=${totalRuns} failed=${failedRuns}`,
      light,
      ...(light === 'red'
        ? {
            reason: '近 24 小時執行失敗佔比偏高',
            suggestion: '檢視失敗 Run 的錯誤與引擎日誌',
          }
        : light === 'yellow'
          ? {
              reason: '近 24 小時執行失敗佔比中等',
              suggestion: '追蹤失敗 Run 的共同原因',
            }
          : {}),
    };
  }

  // 9–10) no instrumentation yet → unknown (never fake green)
  const skillEvalMetric: HealthMetric = {
    key: 'skill_eval_pass',
    label: '技能 eval 通過率',
    value: null,
    light: 'unknown',
    reason: '尚未埋點（無 eval harness，P2）',
  };
  const sandboxMetric: HealthMetric = {
    key: 'sandbox_escape',
    label: '沙盒逃逸嘗試',
    value: null,
    light: 'unknown',
    reason: '尚未埋點（無沙盒隔離 / sandbox-exec，P1）',
  };

  return [
    verifyMetric,
    firstRoundMetric,
    reworkMetric,
    hitlMetric,
    auditMetric,
    costMetric,
    memoryMetric,
    runsMetric,
    skillEvalMetric,
    sandboxMetric,
  ];
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/health', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      return reply.send(ok(await computeHealthMetrics()));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/dashboard/summary', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const [
        agentsActive,
        skillsByReview,
        workflowsEnabled,
        runsTodayByStatus,
        accountsByProviderStatus,
      ] = await Promise.all([
        prisma.agent.count({ where: { status: 'ACTIVE', deletedAt: null } }),
        prisma.skill.groupBy({
          by: ['reviewStatus'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.workflow.count({ where: { enabled: true, deletedAt: null } }),
        prisma.run.groupBy({
          by: ['status'],
          where: { startedAt: { gte: startOfDay } },
          _count: { _all: true },
        }),
        prisma.connectedAccount.groupBy({
          by: ['provider', 'status'],
          _count: { _all: true },
        }),
      ]);

      return reply.send(
        ok({
          agents: { active: agentsActive },
          skills: Object.fromEntries(skillsByReview.map((s) => [s.reviewStatus, s._count._all])),
          workflows: { enabled: workflowsEnabled },
          runsToday: Object.fromEntries(runsTodayByStatus.map((r) => [r.status, r._count._all])),
          connectedAccounts: accountsByProviderStatus.map((a) => ({
            provider: a.provider,
            status: a.status,
            count: a._count._all,
          })),
          wsConnections: hub.connectionCount,
        }),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/api/dashboard/recent-runs',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const runs = await prisma.run.findMany({
          take: limit,
          orderBy: { startedAt: 'desc' },
          include: { agent: { select: { id: true, name: true, slug: true } } },
        });
        return reply.send(
          ok(
            runs.map((r) => ({
              id: r.id,
              status: r.status,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              triggeredBy: r.triggeredBy,
              workflowId: r.workflowId,
              agent: r.agent ? { id: r.agent.id, name: r.agent.name, slug: r.agent.slug } : null,
            })),
          ),
        );
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/audit',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const rows = await prisma.auditLog.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' },
        });
        return reply.send(ok(rows));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // ── Org chart: owner / trainers / members + agents grouped by department ──
  app.get('/api/org', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const [users, agents] = await Promise.all([
        prisma.user.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, displayName: true, email: true, role: true },
        }),
        prisma.agent.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: { _count: { select: { skills: true, workflows: { where: { deletedAt: null } } } } },
        }),
      ]);

      const owner = users.find((u) => u.role === 'OWNER') ?? null;
      const trainers = users.filter((u) => u.role === 'OWNER' || u.role === 'TRAINER');
      const members = users.filter((u) => u.role === 'MEMBER');

      const byDept = new Map<
        string,
        { name: string; agents: { id: string; name: string; description: string; status: string; skillCount: number; workflowCount: number; department: string }[] }
      >();
      for (const a of agents) {
        const deptName = a.department || '未分類';
        if (!byDept.has(deptName)) byDept.set(deptName, { name: deptName, agents: [] });
        byDept.get(deptName)!.agents.push({
          id: a.id,
          name: a.name,
          description: a.description,
          status: a.status,
          skillCount: a._count.skills,
          workflowCount: a._count.workflows,
          department: deptName,
        });
      }

      return ok({
        owner: owner ? { id: owner.id, displayName: owner.displayName, email: owner.email } : null,
        trainers: trainers.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, role: u.role })),
        members: members.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, role: u.role })),
        departments: Array.from(byDept.values()),
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── OWNER-only user management ─────────────────────────────────────────────
  app.get('/api/users', { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.user!.role !== 'OWNER') throw errors.forbidden('僅限 OWNER 操作');
      const users = await prisma.user.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, displayName: true, email: true, role: true },
      });
      return ok(users);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.patch('/api/users/:id/role', { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.user!.role !== 'OWNER') throw errors.forbidden('僅限 OWNER 操作');
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const body = z.object({ role: z.enum(['TRAINER', 'MEMBER']) }).parse(req.body);

      const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw errors.notFound('User not found');
      if (existing.role === 'OWNER') throw errors.forbidden('不可變更 OWNER 的角色');

      const updated = await prisma.user.update({
        where: { id },
        data: { role: body.role },
        select: { id: true, displayName: true, email: true, role: true },
      });
      await audit(req.user!.sub, 'user.role_changed', 'User', id, { role: body.role });
      return ok(updated);
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
