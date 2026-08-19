/**
 * Pure self-test: Workbench V2 teach journey helpers
 * (validateTeachUpload / buildUploadTrainMessage / deriveDraftGaps /
 *  draftNextAction / draftCardActions / recordingImportTarget).
 *
 * Run: npx tsx src/lib/teachjourney.selftest.ts
 *
 * TDD RED: teachjourney.ts does not exist yet — expected to fail until
 * the pure module is implemented.
 */
import {
  MAX_TEACH_UPLOAD_BYTES,
  validateTeachUpload,
  buildUploadTrainMessage,
  deriveDraftGaps,
  draftNextAction,
  draftCardActions,
  recordingImportTarget,
} from './teachjourney';
import type { SkillUnderstanding } from '@/components/workbench/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

const BANNED = ['MCP', 'manifest', 'Flow', 'JSON', 'engine'] as const;

function assertNoBanned(s: string, label: string): void {
  for (const b of BANNED) {
    assert(!s.includes(b), `${label} must not contain banned term ${b}: ${s}`);
  }
}

function emptyUnderstanding(overrides: Partial<SkillUnderstanding> = {}): SkillUnderstanding {
  return {
    summary: '',
    capabilities: [],
    data_read: [],
    data_written: [],
    external_calls: [],
    irreversible_actions: [],
    risks: [],
    ...overrides,
  };
}

function main() {
  // ── 1. validateTeachUpload ──────────────────────────────────────────────
  {
    assert(MAX_TEACH_UPLOAD_BYTES === 200_000, '1: MAX_TEACH_UPLOAD_BYTES is 200000');

    for (const name of ['guide.md', 'GUIDE.MD', 'notes.markdown', 'NOTES.MARKDOWN', 'memo.txt', 'MEMO.TXT']) {
      const r = validateTeachUpload({ name, size: 100 });
      assert(r.ok === true, `1: ${name} should be ok`);
      if (r.ok) {
        if (name.toLowerCase().endsWith('.txt')) {
          assert(r.kind === 'txt', `1: ${name} kind txt`);
        } else {
          assert(r.kind === 'md', `1: ${name} kind md`);
        }
      }
    }

    for (const name of ['x.pdf', 'a.zip', 'b.exe', 'noext', 'file']) {
      const r = validateTeachUpload({ name, size: 100 });
      assert(r.ok === false, `1: ${name} should reject`);
      if (!r.ok) {
        assert(r.reason.includes('只支援') || r.reason.includes('.md') || r.reason.includes('.txt'), `1: reason for ${name}`);
        assertNoBanned(r.reason, `1: reason ${name}`);
      }
    }

    const empty = validateTeachUpload({ name: 'a.md', size: 0 });
    assert(empty.ok === false, '1: size 0 reject');
    if (!empty.ok) {
      assert(empty.reason.includes('空'), '1: size 0 reason mentions empty');
      assertNoBanned(empty.reason, '1: empty reason');
    }

    const tooBig = validateTeachUpload({ name: 'a.md', size: 200_001 });
    assert(tooBig.ok === false, '1: size 200001 reject');
    if (!tooBig.ok) {
      assert(tooBig.reason.includes('大') || tooBig.reason.includes('200'), '1: too big reason');
      assertNoBanned(tooBig.reason, '1: too big reason');
    }

    const maxOk = validateTeachUpload({ name: 'a.md', size: 200_000 });
    assert(maxOk.ok === true, '1: size 200000 ok');
    if (maxOk.ok) assert(maxOk.kind === 'md', '1: max size kind md');
  }

  // ── 2. buildUploadTrainMessage ──────────────────────────────────────────
  {
    const msg = buildUploadTrainMessage('demo.md', '步驟一：開信箱\n步驟二：匯出');
    assert(msg.includes('demo.md'), '2: includes file name');
    assert(msg.includes('步驟一：開信箱'), '2: includes content');
    assert(msg.includes('請整理成技能草稿') || msg.includes('技能草稿'), '2: draft intent');
    assertNoBanned(msg, '2: train message');

    const a = buildUploadTrainMessage('x.txt', 'hello');
    const b = buildUploadTrainMessage('x.txt', 'hello');
    assert(a === b, '2: deterministic same input same output');

    let threw = false;
    try {
      buildUploadTrainMessage('empty.md', '   \n  ');
    } catch (e) {
      threw = true;
      const m = e instanceof Error ? e.message : String(e);
      assert(m.length > 0, '2: empty throw has message');
      assertNoBanned(m, '2: empty throw message');
    }
    assert(threw, '2: blank content throws');
  }

  // ── 3. deriveDraftGaps ──────────────────────────────────────────────────
  {
    const gNull = deriveDraftGaps(null);
    assert(Array.isArray(gNull) && gNull.length === 1, '3: null → one gap');
    assert(gNull[0].includes('尚未產生理解') || gNull[0].includes('補充'), '3: null message');
    assertNoBanned(gNull[0], '3: null gap');

    const gAllEmpty = deriveDraftGaps(emptyUnderstanding());
    assert(gAllEmpty.length >= 2, '3: all-empty has multiple gaps');
    assert(
      gAllEmpty.some((g) => g.includes('目的') || g.includes('補充') || g.includes('說明')),
      '3: empty summary gap',
    );
    assert(
      gAllEmpty.some((g) => g.includes('步驟')),
      '3: empty capabilities gap',
    );
    assert(
      gAllEmpty.some((g) => g.includes('資料') || g.includes('讀取') || g.includes('修改')),
      '3: empty data gap',
    );
    // external/irreversible/risks empty must NOT create gaps
    assert(
      !gAllEmpty.some((g) => g.includes('外部') || g.includes('不可逆') || g.includes('風險')),
      '3: external/risk empty not gaps',
    );
    for (const g of gAllEmpty) assertNoBanned(g, '3: all-empty gap');

    const gPartial = deriveDraftGaps(
      emptyUnderstanding({
        summary: '整理每日帳款',
        capabilities: [],
        data_read: ['信箱'],
        data_written: [],
      }),
    );
    assert(gPartial.some((g) => g.includes('步驟')), '3: partial missing capabilities');
    assert(
      !gPartial.some((g) => g.includes('資料') && (g.includes('讀取') || g.includes('修改'))),
      '3: partial has data_read so no data gap',
    );
    for (const g of gPartial) assertNoBanned(g, '3: partial gap');

    const full = deriveDraftGaps(
      emptyUnderstanding({
        summary: '整理每日帳款',
        capabilities: ['掃描郵件', '產表'],
        data_read: ['Gmail'],
        data_written: ['試算表'],
        external_calls: [],
        irreversible_actions: [],
        risks: [],
      }),
    );
    assert(full.length === 0, '3: complete understanding → empty gaps');

    // returns new array, not shared
    const a1 = deriveDraftGaps(null);
    const a2 = deriveDraftGaps(null);
    assert(a1 !== a2, '3: new array each call');
    a1.push('mut');
    assert(a2.length === 1 && a2[0] !== 'mut', '3: arrays not shared');
  }

  // ── 4. draftNextAction ──────────────────────────────────────────────────
  {
    const confirmed = draftNextAction({ reviewStatus: 'CONFIRMED', isFde: true });
    assert(confirmed.includes('已確認') && confirmed.includes('交代工作'), '4: CONFIRMED branch');
    assertNoBanned(confirmed, '4: confirmed');

    const proposed = draftNextAction({
      reviewStatus: 'AWAITING_USER_CONFIRM',
      isFde: false,
      statusNote: '已送出提案，等待 FDE 審核',
    });
    assert(proposed.includes('提案') && proposed.includes('審核'), '4: proposal branch');
    assertNoBanned(proposed, '4: proposed');

    const fdePending = draftNextAction({
      reviewStatus: 'AWAITING_USER_CONFIRM',
      isFde: true,
    });
    assert(fdePending.includes('確認掛載') || fdePending.includes('確認'), '4: FDE pending');
    assertNoBanned(fdePending, '4: fde pending');

    const memberPending = draftNextAction({
      reviewStatus: 'AWAITING_USER_CONFIRM',
      isFde: false,
    });
    assert(memberPending.includes('提案') && memberPending.includes('訓練師'), '4: MEMBER pending');
    assertNoBanned(memberPending, '4: member pending');
  }

  // ── 5. draftCardActions ─────────────────────────────────────────────────
  {
    const statuses = ['AWAITING_USER_CONFIRM', 'DRAFT', 'CONFIRMED', 'REJECTED'] as const;
    const notes: Array<string | undefined> = [undefined, '已送出提案，等待 FDE 審核'];

    for (const reviewStatus of statuses) {
      for (const statusNote of notes) {
        const m = draftCardActions({ isFde: false, reviewStatus, statusNote });
        assert(
          m.showConfirm === false,
          `5: MEMBER showConfirm always false (${reviewStatus}, ${String(statusNote)})`,
        );
      }
    }

    const fdeAwait = draftCardActions({
      isFde: true,
      reviewStatus: 'AWAITING_USER_CONFIRM',
    });
    assert(fdeAwait.showConfirm === true, '5: FDE AWAITING showConfirm true');
    assert(fdeAwait.showPropose === false, '5: FDE AWAITING showPropose false');

    const fdeConfirmed = draftCardActions({
      isFde: true,
      reviewStatus: 'CONFIRMED',
    });
    assert(fdeConfirmed.showConfirm === false, '5: CONFIRMED showConfirm false');
    assert(fdeConfirmed.showPropose === false, '5: CONFIRMED showPropose false');

    const fdeProposed = draftCardActions({
      isFde: true,
      reviewStatus: 'AWAITING_USER_CONFIRM',
      statusNote: '已送出提案，等待 FDE 審核',
    });
    assert(fdeProposed.showConfirm === false, '5: proposed note → no confirm');
    assert(fdeProposed.showPropose === false, '5: proposed note → no propose');

    const memberAwait = draftCardActions({
      isFde: false,
      reviewStatus: 'AWAITING_USER_CONFIRM',
    });
    assert(memberAwait.showConfirm === false, '5: MEMBER await showConfirm false');
    assert(memberAwait.showPropose === true, '5: MEMBER await showPropose true');
  }

  // ── 6. recordingImportTarget ────────────────────────────────────────────
  {
    const mismatch = recordingImportTarget('agent-a', 'agent-b');
    assert(mismatch.ok === false, '6: mismatch reject');
    if (!mismatch.ok) {
      assert(
        mismatch.reason.includes('另一位') && mismatch.reason.includes('切回'),
        '6: mismatch reason',
      );
      assertNoBanned(mismatch.reason, '6: mismatch reason');
    }

    const bothEmpty = recordingImportTarget(null, undefined);
    assert(bothEmpty.ok === false, '6: both empty reject');
    if (!bothEmpty.ok) {
      assert(bothEmpty.reason.includes('選擇') || bothEmpty.reason.includes('員工'), '6: empty reason');
      assertNoBanned(bothEmpty.reason, '6: empty reason');
    }

    const boundOnly = recordingImportTarget('agent-a', null);
    assert(boundOnly.ok === true && boundOnly.agentId === 'agent-a', '6: bound-only ok');

    const selectedOnly = recordingImportTarget(undefined, 'agent-b');
    assert(selectedOnly.ok === true && selectedOnly.agentId === 'agent-b', '6: selected-only ok');

    const same = recordingImportTarget('agent-x', 'agent-x');
    assert(same.ok === true && same.agentId === 'agent-x', '6: same ok');
  }

  // ── 7. banned-term scan across all public outputs ───────────────────────
  {
    const outputs: string[] = [];

    const vOk = validateTeachUpload({ name: 'a.md', size: 10 });
    if (vOk.ok) outputs.push(vOk.kind);
    const vBad = validateTeachUpload({ name: 'a.pdf', size: 10 });
    if (!vBad.ok) outputs.push(vBad.reason);
    const vEmpty = validateTeachUpload({ name: 'a.md', size: 0 });
    if (!vEmpty.ok) outputs.push(vEmpty.reason);
    const vBig = validateTeachUpload({ name: 'a.md', size: 999_999 });
    if (!vBig.ok) outputs.push(vBig.reason);

    outputs.push(buildUploadTrainMessage('t.md', '內容一段'));
    outputs.push(...deriveDraftGaps(null));
    outputs.push(...deriveDraftGaps(emptyUnderstanding()));
    outputs.push(
      draftNextAction({ reviewStatus: 'CONFIRMED', isFde: true }),
      draftNextAction({
        reviewStatus: 'AWAITING_USER_CONFIRM',
        isFde: false,
        statusNote: '已送出提案',
      }),
      draftNextAction({ reviewStatus: 'AWAITING_USER_CONFIRM', isFde: true }),
      draftNextAction({ reviewStatus: 'AWAITING_USER_CONFIRM', isFde: false }),
    );
    const r1 = recordingImportTarget(null, null);
    if (!r1.ok) outputs.push(r1.reason);
    const r2 = recordingImportTarget('a', 'b');
    if (!r2.ok) outputs.push(r2.reason);

    for (const s of outputs) {
      for (const b of BANNED) {
        assert(!s.includes(b), `7: banned ${b} in: ${s}`);
      }
    }
  }

  console.log('teachjourney selftest: ALL PASS');
}

main();
