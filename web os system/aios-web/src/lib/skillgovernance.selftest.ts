/**
 * Pure self-test: FDE Skill governance projections
 * (diffLines / buildVersionTimeline / summarizeGate / describeRollback).
 *
 * Run: npx tsx src/lib/skillgovernance.selftest.ts
 *
 * TDD RED: skillgovernance.ts 尚未存在時本檔預期失敗。
 */
import {
  diffLines,
  buildVersionTimeline,
  summarizeGate,
  describeRollback,
  type SkillVersionInput,
  type PromoteGateInput,
} from './skillgovernance';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function main() {
  // ── 1. diffLines: basic three states ───────────────────────────────────
  {
    const before = 'a\nb\nc';
    const after = 'a\nx\nc';
    const rows = diffLines(before, after);
    assert(rows.length === 4, `1a length 4 got ${rows.length}`);
    assert(rows[0]!.type === 'same' && rows[0]!.text === 'a', '1b same a');
    assert(rows[1]!.type === 'del' && rows[1]!.text === 'b', '1c del b');
    assert(rows[2]!.type === 'add' && rows[2]!.text === 'x', '1d add x');
    assert(rows[3]!.type === 'same' && rows[3]!.text === 'c', '1e same c');
  }

  // ── 2. empty strings ───────────────────────────────────────────────────
  {
    assert(diffLines('', '').length === 0, '2a both empty → []');
    const onlyAdd = diffLines('', 'hello');
    assert(onlyAdd.length === 1 && onlyAdd[0]!.type === 'add' && onlyAdd[0]!.text === 'hello', '2b empty→hello');
    const onlyDel = diffLines('bye', '');
    assert(onlyDel.length === 1 && onlyDel[0]!.type === 'del' && onlyDel[0]!.text === 'bye', '2c bye→empty');
  }

  // ── 3. CJK lines ───────────────────────────────────────────────────────
  {
    const before = '第一行\n第二行\n第三行';
    const after = '第一行\n第二行改了\n第三行';
    const rows = diffLines(before, after);
    assert(rows.some((r) => r.type === 'del' && r.text === '第二行'), '3a del 第二行');
    assert(rows.some((r) => r.type === 'add' && r.text === '第二行改了'), '3b add 第二行改了');
    assert(rows.filter((r) => r.type === 'same').length === 2, '3c two same lines');
  }

  // ── 4. zero mutation of inputs (deepClone compare) ─────────────────────
  {
    const before = 'α\nβ\nγ';
    const after = 'α\nδ\nγ';
    const beforeSnap = deepClone(before);
    const afterSnap = deepClone(after);
    void diffLines(before, after);
    assert(before === beforeSnap, '4a before string unchanged');
    assert(after === afterSnap, '4b after string unchanged');

    const versions: SkillVersionInput[] = [
      {
        id: 'v1',
        version: 1,
        channel: 'canary',
        contentHash: 'aaa',
        createdAt: '2026-01-01T00:00:00.000Z',
        contentMd: '# v1',
      },
      {
        id: 'v2',
        version: 2,
        channel: 'stable',
        contentHash: 'bbb',
        createdAt: '2026-01-02T00:00:00.000Z',
        contentMd: '# v2',
      },
    ];
    const snap = deepClone(versions);
    void buildVersionTimeline(versions, 'v2', 'v1');
    assert(JSON.stringify(versions) === JSON.stringify(snap), '4c versions array not mutated');
    void describeRollback(versions, 'v2', 'v1');
    assert(JSON.stringify(versions) === JSON.stringify(snap), '4d describeRollback no mutation');

    const gate: PromoteGateInput = {
      canPromote: false,
      checks: [{ key: 'skill_confirmed', ok: false, reason: 'x' }],
    };
    const gateSnap = deepClone(gate);
    void summarizeGate(gate);
    assert(JSON.stringify(gate) === JSON.stringify(gateSnap), '4e gate not mutated');
  }

  // ── 5. buildVersionTimeline roles ──────────────────────────────────────
  {
    // unsorted input: v1 then v3 then v2
    const versions: SkillVersionInput[] = [
      { id: 'v1', version: 1, channel: 'archived', contentHash: 'h1', createdAt: 'a' },
      { id: 'v3', version: 3, channel: 'canary', contentHash: 'h3', createdAt: 'c' },
      { id: 'v2', version: 2, channel: 'stable', contentHash: 'h2', createdAt: 'b' },
    ];
    const tl = buildVersionTimeline(versions, 'v2', 'v3');
    assert(tl.length === 3, '5a length 3');
    assert(tl[0]!.version === 3 && tl[0]!.id === 'v3', '5b first is v3 desc');
    assert(tl[1]!.version === 2, '5c second v2');
    assert(tl[2]!.version === 1, '5d third v1');
    assert(
      JSON.stringify(tl[0]!.roles) === JSON.stringify(['canary']),
      `5e v3 roles canary got ${JSON.stringify(tl[0]!.roles)}`,
    );
    assert(
      JSON.stringify(tl[1]!.roles) === JSON.stringify(['stable']),
      `5f v2 roles stable got ${JSON.stringify(tl[1]!.roles)}`,
    );
    assert(tl[2]!.roles.length === 0, '5g v1 no roles');
    assert(tl[0]!.channel === 'canary', '5h channel preserved');
    assert(tl[1]!.channel === 'stable', '5i channel preserved');

    // same version is both stable and canary
    const same = buildVersionTimeline(
      [{ id: 'only', version: 1, channel: 'stable', contentHash: 'x', createdAt: 't' }],
      'only',
      'only',
    );
    assert(
      same[0]!.roles.includes('stable') && same[0]!.roles.includes('canary'),
      `5j dual role got ${JSON.stringify(same[0]!.roles)}`,
    );
    assert(same[0]!.roles[0] === 'stable', '5k stable before canary');
  }

  // ── 6. summarizeGate gaps ──────────────────────────────────────────────
  {
    const allFail: PromoteGateInput = {
      canPromote: false,
      checks: [
        { key: 'skill_confirmed', ok: false, reason: '技能尚未經 FDE 確認，不可發布' },
        { key: 'version_exists', ok: true, reason: '' },
        { key: 'eval_passed', ok: false, reason: '沒有通過的評測執行（fail-closed）' },
        { key: 'no_unresolved_high_risk', ok: false, reason: '存在 1 筆未解的高風險' },
        { key: 'codex_gate', ok: false, reason: '請改為 CODEX' },
      ],
    };
    const s = summarizeGate(allFail);
    assert(s.canPromote === false, '6a canPromote false');
    assert(s.gaps.length === 4, `6b 4 gaps got ${s.gaps.length}`);
    const byKey = new Map(s.gaps.map((g) => [g.key, g]));
    assert(byKey.get('skill_confirmed')?.label === 'FDE 確認', '6c label FDE 確認');
    assert(byKey.get('eval_passed')?.label === '評測通過', '6d label 評測通過');
    assert(byKey.get('no_unresolved_high_risk')?.label === '無未解高風險', '6e label 高風險');
    assert(byKey.get('codex_gate')?.label === '執行引擎合規', '6f label 引擎');
    assert(!byKey.has('version_exists'), '6g version_exists not in gaps');
    assert(
      byKey.get('skill_confirmed')?.reason === '技能尚未經 FDE 確認，不可發布',
      '6h reason preserved',
    );

    const allOk = summarizeGate({
      canPromote: true,
      checks: [
        { key: 'skill_confirmed', ok: true, reason: '' },
        { key: 'version_exists', ok: true, reason: '' },
        { key: 'eval_passed', ok: true, reason: '', evalRunId: 'run-1' },
        { key: 'no_unresolved_high_risk', ok: true, reason: '' },
        { key: 'codex_gate', ok: true, reason: '' },
      ],
    });
    assert(allOk.canPromote === true, '6i canPromote true');
    assert(allOk.gaps.length === 0, '6j gaps empty when all ok');
    // version_exists fail alone
    const ve = summarizeGate({
      canPromote: false,
      checks: [{ key: 'version_exists', ok: false, reason: '目標版本不存在' }],
    });
    assert(ve.gaps[0]?.label === '版本存在', '6k version_exists label');
  }

  // ── 7. describeRollback ────────────────────────────────────────────────
  {
    const versions: SkillVersionInput[] = [
      { id: 'v1', version: 1, channel: 'archived', contentHash: 'h1', createdAt: 'a' },
      { id: 'v2', version: 2, channel: 'stable', contentHash: 'h2', createdAt: 'b' },
      { id: 'v3', version: 3, channel: 'canary', contentHash: 'h3', createdAt: 'c' },
    ];
    const d = describeRollback(versions, 'v2', 'v1');
    assert(d.fromVersion === 2, `7a fromVersion 2 got ${d.fromVersion}`);
    assert(d.toVersion === 1, `7b toVersion 1 got ${d.toVersion}`);
    assert(d.retainedCount === versions.length, `7c retainedCount ${d.retainedCount}`);

    const missing = describeRollback(versions, 'nope', 'v3');
    assert(missing.fromVersion === undefined, '7d missing from');
    assert(missing.toVersion === 3, '7e to still found');
    assert(missing.retainedCount === 3, '7f retained still length');
  }

  console.log('skillgovernance selftest: ALL PASS');
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
