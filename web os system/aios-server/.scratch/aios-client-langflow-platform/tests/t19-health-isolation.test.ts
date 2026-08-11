/**
 * Ticket 19 — Langflow health lights isolation (dead ports / non-loopback / unset).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t19-health-isolation.test.ts
 *
 * Does not mutate DB. Restores process.env after run.
 */
import { computeHealthMetrics } from '../../../src/routes/dashboard.js';

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

/** Existing ten health metric keys — must stay byte-identical in order. */
const LEGACY_TEN_KEYS = [
  'verify_pass_rate',
  'first_round_pass',
  'avg_rework_rounds',
  'hitl_backlog',
  'audit_chain_integrity',
  'cost_overrun',
  'memory_freshness',
  'runs_today',
  'skill_eval_pass',
  'sandbox_escape',
] as const;

async function main(): Promise<void> {
  console.log('── t19-health-isolation ──');

  const prevRuntime = process.env.AIOS_LANGFLOW_RUNTIME_URL;
  const prevSandbox = process.env.AIOS_LANGFLOW_SANDBOX_URL;

  try {
    // ── 1. dead loopback ports → red, no throw, <8s, first 10 keys intact ──
    console.log('\n── [1] dead ports ──');
    process.env.AIOS_LANGFLOW_RUNTIME_URL = 'http://127.0.0.1:59993';
    process.env.AIOS_LANGFLOW_SANDBOX_URL = 'http://127.0.0.1:59994';

    const t0 = Date.now();
    let metrics;
    try {
      metrics = await computeHealthMetrics();
      pass('computeHealthMetrics does not throw (dead ports)');
    } catch (e) {
      fail('computeHealthMetrics does not throw (dead ports)', String(e));
      return;
    }
    const elapsed = Date.now() - t0;
    check(elapsed < 8000, 'total duration < 8s', `elapsedMs=${elapsed}`);

    const first10 = metrics.slice(0, 10).map((m) => m.key);
    check(
      first10.length === 10 && first10.every((k, i) => k === LEGACY_TEN_KEYS[i]),
      'first 10 metric keys order unchanged',
      `got=${JSON.stringify(first10)}`,
    );

    const sandbox = metrics.find((m) => m.key === 'langflow_sandbox_health');
    const production = metrics.find((m) => m.key === 'langflow_production_health');
    check(Boolean(sandbox), 'langflow_sandbox_health present', 'missing');
    check(Boolean(production), 'langflow_production_health present', 'missing');
    check(sandbox?.light === 'red', 'sandbox dead port → red', `light=${sandbox?.light} reason=${sandbox?.reason}`);
    check(
      production?.light === 'red',
      'production dead port → red',
      `light=${production?.light} reason=${production?.reason}`,
    );

    // ── 2. non-loopback sandbox → red (rejected), others unaffected ──────
    console.log('\n── [2] non-loopback sandbox ──');
    process.env.AIOS_LANGFLOW_SANDBOX_URL = 'http://evil.example.com:7860';
    process.env.AIOS_LANGFLOW_RUNTIME_URL = 'http://127.0.0.1:59993';

    let metrics2;
    try {
      metrics2 = await computeHealthMetrics();
      pass('computeHealthMetrics does not throw (non-loopback)');
    } catch (e) {
      fail('computeHealthMetrics does not throw (non-loopback)', String(e));
      return;
    }
    const first10b = metrics2.slice(0, 10).map((m) => m.key);
    check(
      first10b.every((k, i) => k === LEGACY_TEN_KEYS[i]),
      'first 10 keys still intact after non-loopback probe',
      JSON.stringify(first10b),
    );
    const sandbox2 = metrics2.find((m) => m.key === 'langflow_sandbox_health');
    check(
      sandbox2?.light === 'red',
      'non-loopback sandbox → red',
      `light=${sandbox2?.light} reason=${sandbox2?.reason}`,
    );
    check(
      typeof sandbox2?.reason === 'string' && /loopback|拒絕|reject/i.test(sandbox2.reason),
      'non-loopback reason mentions loopback reject',
      `reason=${sandbox2?.reason}`,
    );

    // ── 3. both unset → unknown ─────────────────────────────────────────
    console.log('\n── [3] env unset → unknown ──');
    delete process.env.AIOS_LANGFLOW_RUNTIME_URL;
    delete process.env.AIOS_LANGFLOW_SANDBOX_URL;

    let metrics3;
    try {
      metrics3 = await computeHealthMetrics();
      pass('computeHealthMetrics does not throw (unset env)');
    } catch (e) {
      fail('computeHealthMetrics does not throw (unset env)', String(e));
      return;
    }
    const sandbox3 = metrics3.find((m) => m.key === 'langflow_sandbox_health');
    const production3 = metrics3.find((m) => m.key === 'langflow_production_health');
    check(
      sandbox3?.light === 'unknown',
      'unset sandbox → unknown',
      `light=${sandbox3?.light} reason=${sandbox3?.reason}`,
    );
    check(
      production3?.light === 'unknown',
      'unset production → unknown',
      `light=${production3?.light} reason=${production3?.reason}`,
    );
    check(
      typeof sandbox3?.reason === 'string' && sandbox3.reason.includes('AIOS_LANGFLOW_SANDBOX_URL'),
      'unset sandbox reason mentions env name',
      `reason=${sandbox3?.reason}`,
    );
    check(
      typeof production3?.reason === 'string' &&
        production3.reason.includes('AIOS_LANGFLOW_RUNTIME_URL'),
      'unset production reason mentions env name',
      `reason=${production3?.reason}`,
    );
  } finally {
    if (prevRuntime === undefined) delete process.env.AIOS_LANGFLOW_RUNTIME_URL;
    else process.env.AIOS_LANGFLOW_RUNTIME_URL = prevRuntime;
    if (prevSandbox === undefined) delete process.env.AIOS_LANGFLOW_SANDBOX_URL;
    else process.env.AIOS_LANGFLOW_SANDBOX_URL = prevSandbox;
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
