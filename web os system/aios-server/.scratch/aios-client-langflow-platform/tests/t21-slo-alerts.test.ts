/**
 * Ticket 21 — SLO alerts pure function + route (Phase 6).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t21-slo-alerts.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { sendError } from '../../../src/lib/http.js';
import type { PilotSloMetrics } from '../../../src/lib/slo.js';

let failed = 0;
let passed = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}
function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

function emptyMetrics(total = 0): PilotSloMetrics {
  return {
    windowDays: 7,
    runs: {
      total,
      succeeded: 0,
      failed: 0,
      awaitingReview: 0,
      running: 0,
    },
    runLatencyMs: null,
    errorCounters: {
      adapterTimeout: 0,
      budgetExceeded: 0,
      noTerminalEvent: 0,
      other: 0,
    },
    approvalLatencyMs: null,
    costUsd: 0,
  };
}

async function main(): Promise<void> {
  console.log('── t21-slo-alerts ──');

  const tag = ulid().slice(-8).toLowerCase();
  const ownerId = ulid();

  try {
    const { evaluateSloAlerts, DEFAULT_SLO_THRESHOLDS } = await import(
      '../../../src/lib/slo.js'
    );
    const { dashboardRoutes } = await import('../../../src/routes/dashboard.js');

    // ── no-data ─────────────────────────────────────────────────────────
    console.log('\n── no-data ──');
    const none = evaluateSloAlerts(emptyMetrics(0));
    check(none.insufficientData === true, 'no-data: insufficientData true', '');
    check(none.alerts.length === 0, 'no-data: zero alerts (no false breach)', `n=${none.alerts.length}`);
    check(typeof none.evaluatedAt === 'string', 'no-data: evaluatedAt string', none.evaluatedAt);

    // ── healthy metrics ─────────────────────────────────────────────────
    console.log('\n── healthy ──');
    const healthy: PilotSloMetrics = {
      ...emptyMetrics(10),
      runs: {
        total: 10,
        succeeded: 9,
        failed: 1,
        awaitingReview: 0,
        running: 0,
      },
      runLatencyMs: { avg: 1000, p95: 2000 },
      approvalLatencyMs: { avg: 1000, count: 2 },
      errorCounters: {
        adapterTimeout: 0,
        budgetExceeded: 0,
        noTerminalEvent: 0,
        other: 1,
      },
    };
    const h = evaluateSloAlerts(healthy);
    check(h.insufficientData === false, 'healthy: sufficient data', '');
    check(h.alerts.length === 0, 'healthy: no alerts', JSON.stringify(h.alerts));

    // ── error rate breach ───────────────────────────────────────────────
    console.log('\n── thresholds ──');
    const highErr: PilotSloMetrics = {
      ...emptyMetrics(10),
      runs: {
        total: 10,
        succeeded: 5,
        failed: 5,
        awaitingReview: 0,
        running: 0,
      },
    };
    const er = evaluateSloAlerts(highErr);
    check(
      er.alerts.some((a) => a.key === 'error_rate'),
      'errorRate > 20% → alert',
      JSON.stringify(er.alerts),
    );

    // ── p95 latency ─────────────────────────────────────────────────────
    const slow: PilotSloMetrics = {
      ...healthy,
      runLatencyMs: { avg: 10_000, p95: 90_000 },
    };
    const sl = evaluateSloAlerts(slow);
    check(
      sl.alerts.some((a) => a.key === 'p95_latency_ms'),
      'p95 > 60s → alert',
      JSON.stringify(sl.alerts),
    );

    // ── approval latency ────────────────────────────────────────────────
    const slowAppr: PilotSloMetrics = {
      ...healthy,
      approvalLatencyMs: { avg: 4_000_000, count: 1 },
    };
    const sa = evaluateSloAlerts(slowAppr);
    check(
      sa.alerts.some((a) => a.key === 'approval_latency_avg_ms'),
      'approval avg > 1h → alert',
      JSON.stringify(sa.alerts),
    );

    // ── adapter timeout ─────────────────────────────────────────────────
    const to: PilotSloMetrics = {
      ...healthy,
      errorCounters: {
        adapterTimeout: 2,
        budgetExceeded: 0,
        noTerminalEvent: 0,
        other: 0,
      },
    };
    const ta = evaluateSloAlerts(to);
    check(
      ta.alerts.some((a) => a.key === 'adapter_timeout' && a.severity === 'critical'),
      'adapterTimeout > 0 → critical',
      JSON.stringify(ta.alerts),
    );

    // ── null latency fields do not false-alarm ──────────────────────────
    const nullLat: PilotSloMetrics = {
      ...emptyMetrics(5),
      runs: {
        total: 5,
        succeeded: 5,
        failed: 0,
        awaitingReview: 0,
        running: 0,
      },
      runLatencyMs: null,
      approvalLatencyMs: null,
    };
    const nl = evaluateSloAlerts(nullLat);
    check(
      !nl.alerts.some((a) => a.key.includes('latency')),
      'null latency → no latency alerts',
      JSON.stringify(nl.alerts),
    );

    // ── threshold override ──────────────────────────────────────────────
    const override = evaluateSloAlerts(highErr, { errorRate: 0.6 });
    check(
      !override.alerts.some((a) => a.key === 'error_rate'),
      'override errorRate 0.6: 50% no alert',
      JSON.stringify(override.alerts),
    );
    check(
      DEFAULT_SLO_THRESHOLDS.errorRate === 0.2,
      'default errorRate 0.2',
      String(DEFAULT_SLO_THRESHOLDS.errorRate),
    );

    // ── route inject ────────────────────────────────────────────────────
    console.log('\n── route ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t21-slo-owner-${tag}@aios.test`,
        displayName: 'T21 SLO Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    const jwt = await signAccess({
      sub: ownerId,
      email: `t21-slo-owner-${tag}@aios.test`,
      role: 'OWNER',
    });

    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    await app.register(dashboardRoutes);
    await app.ready();

    const rNo = await app.inject({
      method: 'GET',
      url: '/api/dashboard/slo-alerts',
    });
    check(
      rNo.statusCode === 401 || rNo.statusCode === 403,
      'slo-alerts unauth → 401/403',
      `got ${rNo.statusCode}`,
    );

    const rOk = await app.inject({
      method: 'GET',
      url: '/api/dashboard/slo-alerts',
      headers: { authorization: `Bearer ${jwt}` },
    });
    check(rOk.statusCode === 200, 'slo-alerts auth 200', `got ${rOk.statusCode} ${rOk.body.slice(0, 200)}`);
    const body = rOk.json() as {
      success?: boolean;
      data?: {
        metrics?: PilotSloMetrics;
        alerts?: unknown[];
        evaluatedAt?: string;
        insufficientData?: boolean;
      };
    };
    check(body.success === true, 'envelope success', JSON.stringify(body).slice(0, 120));
    check(body.data != null && typeof body.data === 'object', 'data object', '');
    check(Array.isArray(body.data?.alerts), 'alerts array', String(body.data?.alerts));
    check(typeof body.data?.evaluatedAt === 'string', 'evaluatedAt present', String(body.data?.evaluatedAt));
    check(
      typeof body.data?.insufficientData === 'boolean',
      'insufficientData boolean',
      String(body.data?.insufficientData),
    );
    check(body.data?.metrics != null, 'metrics nested', '');

    await app.close();
  } catch (e) {
    fail('suite error', String(e));
    console.error(e);
  } finally {
    try {
      await prisma.user.deleteMany({ where: { id: ownerId } });
    } catch (ce) {
      console.warn('cleanup warning', ce);
    }
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
