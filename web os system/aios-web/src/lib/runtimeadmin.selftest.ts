/**
 * Pure self-test: FDE Runtime admin projections
 * (readinessLabel / summarizeReadiness / shortDigest / deploymentActions /
 *  groupDeployments / sandboxUrl / artifactStatusTone).
 *
 * Run: npx tsx src/lib/runtimeadmin.selftest.ts
 */
import {
  readinessLabel,
  summarizeReadiness,
  shortDigest,
  deploymentActions,
  groupDeployments,
  sandboxUrl,
  artifactStatusTone,
  type DeploymentRow,
  type ReadinessReport,
} from './runtimeadmin';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function main() {
  // ── 1. readinessLabel dictionary ───────────────────────────────────────
  {
    assert(readinessLabel('digest_ok') === '內容雜湊 Digest', '1a digest_ok');
    assert(readinessLabel('status_validated') === 'Runtime 驗證', '1b status_validated');
    assert(readinessLabel('skill_confirmed') === 'FDE 技能確認', '1c skill_confirmed');
    assert(readinessLabel('eval_passed') === '評測通過', '1d eval_passed');
    assert(readinessLabel('no_unresolved_high_risk') === '無未解高風險', '1e high_risk');
    assert(
      readinessLabel('model_family_distinct') === '執行/驗證模型分離',
      '1f model_family',
    );
    assert(readinessLabel('unknown_key_xyz') === 'unknown_key_xyz', '1g unknown passthrough');
  }

  // ── 2. summarizeReadiness: all ok ──────────────────────────────────────
  {
    const r: ReadinessReport = {
      canActivate: true,
      checks: [
        { key: 'digest_ok', ok: true, reason: 'ok' },
        { key: 'status_validated', ok: true, reason: 'ok' },
        { key: 'skill_confirmed', ok: true, reason: 'ok' },
        { key: 'eval_passed', ok: true, reason: 'ok' },
        { key: 'no_unresolved_high_risk', ok: true, reason: 'ok' },
        { key: 'model_family_distinct', ok: true, reason: 'ok' },
      ],
    };
    const s = summarizeReadiness(r);
    assert(s.canActivate === true, '2a canActivate true');
    assert(s.gaps.length === 0, '2b no gaps');
  }

  // ── 3. summarizeReadiness: multiple gaps ───────────────────────────────
  {
    const r: ReadinessReport = {
      canActivate: false,
      checks: [
        { key: 'digest_ok', ok: false, reason: 'digest 不符：內容遭改動' },
        { key: 'status_validated', ok: false, reason: '尚未驗證' },
        { key: 'skill_confirmed', ok: true, reason: 'ok' },
        { key: 'eval_passed', ok: false, reason: '沒有通過的評測執行' },
        { key: 'no_unresolved_high_risk', ok: true, reason: 'ok' },
        { key: 'model_family_distinct', ok: true, reason: 'ok' },
      ],
    };
    const snap = deepClone(r);
    const s = summarizeReadiness(r);
    assert(s.canActivate === false, '3a canActivate false');
    assert(s.gaps.length === 3, `3b gaps 3 got ${s.gaps.length}`);
    assert(s.gaps[0]!.key === 'digest_ok', '3c first gap digest_ok');
    assert(s.gaps[0]!.label === '內容雜湊 Digest', '3d first label');
    assert(s.gaps[0]!.reason.includes('digest'), '3e first reason');
    assert(s.gaps[1]!.key === 'status_validated', '3f second gap');
    assert(s.gaps[2]!.key === 'eval_passed', '3g third gap');
    assert(JSON.stringify(r) === JSON.stringify(snap), '3h input not mutated');
  }

  // ── 4. shortDigest boundaries ──────────────────────────────────────────
  {
    assert(shortDigest('abcdef0123456789ffff') === 'abcdef012345', '4a first 12');
    assert(shortDigest('') === '—', '4b empty');
    assert(shortDigest('not-hex!!!') === '—', '4c non-hex');
    assert(shortDigest(null as unknown as string) === '—', '4d null');
    assert(shortDigest('abc') === 'abc', '4e short hex');
  }

  // ── 5. deploymentActions ───────────────────────────────────────────────
  {
    const a = deploymentActions({ active: true });
    assert(a.canKill === true && a.canRollback === false, '5a active → kill only');
    const b = deploymentActions({ active: false });
    assert(b.canKill === false && b.canRollback === true, '5b inactive → rollback only');
  }

  // ── 6. artifactStatusTone ──────────────────────────────────────────────
  {
    assert(artifactStatusTone('VALIDATED') === 'ok', '6a VALIDATED');
    assert(artifactStatusTone('COMPILED') === 'warn', '6b COMPILED');
    assert(artifactStatusTone('REJECTED') === 'bad', '6c REJECTED');
    assert(artifactStatusTone('SUPERSEDED') === 'muted', '6d SUPERSEDED');
    assert(artifactStatusTone('OTHER') === 'muted', '6e other');
  }

  // ── 7. groupDeployments + immutability ─────────────────────────────────
  {
    const rows: DeploymentRow[] = [
      {
        id: 'd1',
        artifactId: 'a1',
        skillId: 's1',
        environment: 'PRODUCTION',
        channel: 'CANARY',
        deployedBy: null,
        active: false,
        activatedAt: '2026-01-01T00:00:00.000Z',
        deactivatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'd2',
        artifactId: 'a1',
        skillId: 's1',
        environment: 'PRODUCTION',
        channel: 'CANARY',
        deployedBy: null,
        active: true,
        activatedAt: '2026-01-03T00:00:00.000Z',
        deactivatedAt: null,
      },
      {
        id: 'd3',
        artifactId: 'a2',
        skillId: 's1',
        environment: 'STAGING',
        channel: 'STABLE',
        deployedBy: null,
        active: true,
        activatedAt: '2026-01-04T00:00:00.000Z',
        deactivatedAt: null,
      },
    ];
    const snap = deepClone(rows);
    const groups = groupDeployments(rows);
    assert(JSON.stringify(rows) === JSON.stringify(snap), '7a input array not mutated');
    assert(groups.length === 2, `7b two groups got ${groups.length}`);

    const prodCanary = groups.find(
      (g) => g.environment === 'PRODUCTION' && g.channel === 'CANARY',
    );
    assert(prodCanary, '7c PRODUCTION/CANARY group');
    assert(prodCanary!.active?.id === 'd2', '7d active is d2');
    assert(prodCanary!.history.length === 1 && prodCanary!.history[0]!.id === 'd1', '7e history d1');

    const staging = groups.find(
      (g) => g.environment === 'STAGING' && g.channel === 'STABLE',
    );
    assert(staging?.active?.id === 'd3', '7f STAGING active d3');
    assert(staging!.history.length === 0, '7g no history');

    // PRODUCTION group should sort before STAGING
    assert(groups[0]!.environment === 'PRODUCTION', '7h PRODUCTION first');
  }

  // ── 8. sandboxUrl fallback ─────────────────────────────────────────────
  {
    const prev = process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL;
    try {
      delete process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL;
      assert(
        sandboxUrl() === 'http://127.0.0.1:7860',
        `8a default fallback got ${sandboxUrl()}`,
      );
      process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL = 'http://example.test:9999';
      assert(sandboxUrl() === 'http://example.test:9999', '8b env override');
      process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL = '   ';
      assert(sandboxUrl() === 'http://127.0.0.1:7860', '8c blank → fallback');
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL;
      else process.env.NEXT_PUBLIC_AIOS_LANGFLOW_SANDBOX_URL = prev;
    }
  }

  console.log('runtimeadmin.selftest: all assertions passed');
}

main();
