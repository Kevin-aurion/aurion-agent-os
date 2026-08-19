// Pure SLO alert evaluation (Phase 6 / Ticket 21).
// no-data ≠ breach: null metrics do not raise false alarms.

export type PilotSloMetrics = {
  windowDays: number;
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    awaitingReview: number;
    running: number;
  };
  runLatencyMs: { avg: number; p95: number } | null;
  errorCounters: {
    adapterTimeout: number;
    budgetExceeded: number;
    noTerminalEvent: number;
    other: number;
  };
  approvalLatencyMs: { avg: number; count: number } | null;
  costUsd: number;
};

export type SloAlertSeverity = 'warning' | 'critical';

export type SloAlert = {
  key: string;
  severity: SloAlertSeverity;
  message: string;
  value: number;
  threshold: number;
};

export type SloThresholds = {
  /** Error rate (failed/total) as fraction 0–1. Default 0.20 */
  errorRate: number;
  /** p95 run latency ms. Default 60000 */
  p95LatencyMs: number;
  /** Average approval latency ms. Default 3600000 (1h) */
  approvalLatencyAvgMs: number;
  /** Any adapter timeout count above this fires. Default 0 (any >0) */
  adapterTimeout: number;
};

export const DEFAULT_SLO_THRESHOLDS: Readonly<SloThresholds> = {
  errorRate: 0.2,
  p95LatencyMs: 60_000,
  approvalLatencyAvgMs: 3_600_000,
  adapterTimeout: 0,
};

export type SloAlertResult = {
  alerts: SloAlert[];
  evaluatedAt: string;
  insufficientData: boolean;
};

/**
 * Evaluate pilot SLO metrics against thresholds.
 * When total runs === 0 → insufficientData, no breach alerts.
 */
export function evaluateSloAlerts(
  metrics: PilotSloMetrics,
  thresholds?: Partial<SloThresholds>,
): SloAlertResult {
  const t: SloThresholds = { ...DEFAULT_SLO_THRESHOLDS, ...thresholds };
  const evaluatedAt = new Date().toISOString();
  const alerts: SloAlert[] = [];

  if (!metrics || metrics.runs.total === 0) {
    return { alerts: [], evaluatedAt, insufficientData: true };
  }

  const errorRate =
    metrics.runs.total > 0 ? metrics.runs.failed / metrics.runs.total : 0;
  if (errorRate > t.errorRate) {
    alerts.push({
      key: 'error_rate',
      severity: errorRate > t.errorRate * 1.5 ? 'critical' : 'warning',
      message: `Pilot error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(t.errorRate * 100).toFixed(0)}%`,
      value: errorRate,
      threshold: t.errorRate,
    });
  }

  if (metrics.runLatencyMs != null) {
    if (metrics.runLatencyMs.p95 > t.p95LatencyMs) {
      alerts.push({
        key: 'p95_latency_ms',
        severity: 'warning',
        message: `Pilot p95 latency ${metrics.runLatencyMs.p95}ms exceeds ${t.p95LatencyMs}ms`,
        value: metrics.runLatencyMs.p95,
        threshold: t.p95LatencyMs,
      });
    }
  }

  if (metrics.approvalLatencyMs != null) {
    if (metrics.approvalLatencyMs.avg > t.approvalLatencyAvgMs) {
      alerts.push({
        key: 'approval_latency_avg_ms',
        severity: 'warning',
        message: `Approval avg latency ${metrics.approvalLatencyMs.avg}ms exceeds ${t.approvalLatencyAvgMs}ms`,
        value: metrics.approvalLatencyMs.avg,
        threshold: t.approvalLatencyAvgMs,
      });
    }
  }

  if (metrics.errorCounters.adapterTimeout > t.adapterTimeout) {
    alerts.push({
      key: 'adapter_timeout',
      severity: 'critical',
      message: `Adapter timeouts ${metrics.errorCounters.adapterTimeout} exceed threshold ${t.adapterTimeout}`,
      value: metrics.errorCounters.adapterTimeout,
      threshold: t.adapterTimeout,
    });
  }

  return { alerts, evaluatedAt, insufficientData: false };
}
