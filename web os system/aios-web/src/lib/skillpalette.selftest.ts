/**
 * Pure self-test: Workbench V2 skill palette / authorization / schedule
 * projection helpers (business language, read-only contract).
 *
 * Run: npx tsx src/lib/skillpalette.selftest.ts
 *
 * TDD RED: skillpalette.ts does not exist yet — expected to fail until
 * the pure module is implemented.
 */
import {
  skillStatusLabelZh,
  skillKindLabelZh,
  capabilityLabelZh,
  projectAuthorization,
  projectSkillPalette,
  describeCronZh,
  describeTriggerZh,
  lastRunLabelZh,
  projectSchedules,
  paletteControls,
} from './skillpalette';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

const BANNED = [
  'MCP',
  'manifest',
  'Flow',
  'JSON',
  'engine',
  'model',
  'riskTier',
  'restriction',
  'cron',
] as const;

function assertNoBanned(s: string, label: string): void {
  for (const b of BANNED) {
    assert(!s.includes(b), `${label} must not contain banned term ${b}: ${s}`);
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return obj;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

function main() {
  // ── 1. skillStatusLabelZh ───────────────────────────────────────────────
  {
    assert(skillStatusLabelZh('CONFIRMED') === '可以使用', '1: CONFIRMED');
    assert(skillStatusLabelZh('AWAITING_USER_CONFIRM') === '等待訓練師確認', '1: AWAITING');
    assert(skillStatusLabelZh('DRAFT') === '草稿', '1: DRAFT');
    assert(skillStatusLabelZh('REJECTED') === '已退回', '1: REJECTED');
    assert(skillStatusLabelZh('WEIRD_STATUS') === '審核中', '1: unknown → 審核中');
    assert(!skillStatusLabelZh('WEIRD_STATUS').includes('WEIRD_STATUS'), '1: no raw enum leak');
    for (const s of [
      skillStatusLabelZh('CONFIRMED'),
      skillStatusLabelZh('AWAITING_USER_CONFIRM'),
      skillStatusLabelZh('DRAFT'),
      skillStatusLabelZh('REJECTED'),
      skillStatusLabelZh('WEIRD_STATUS'),
      skillStatusLabelZh(''),
    ]) {
      assertNoBanned(s, '1: status label');
    }
  }

  // ── 2. skillKindLabelZh ─────────────────────────────────────────────────
  {
    assert(skillKindLabelZh('RECORDED') === '錄製示範技能', '2: RECORDED');
    assert(skillKindLabelZh('COMPUTER_CONTROL') === '電腦操作技能', '2: COMPUTER_CONTROL');
    assert(skillKindLabelZh('BUILTIN') === '內建技能', '2: BUILTIN');
    assert(skillKindLabelZh('PROMPT') === '一般技能', '2: PROMPT');
    assert(skillKindLabelZh('SOMETHING_ELSE') === '一般技能', '2: unknown → 一般技能');
    for (const s of [
      skillKindLabelZh('RECORDED'),
      skillKindLabelZh('COMPUTER_CONTROL'),
      skillKindLabelZh('BUILTIN'),
      skillKindLabelZh('PROMPT'),
      skillKindLabelZh('UNKNOWN_KIND'),
    ]) {
      assertNoBanned(s, '2: kind label');
    }
  }

  // ── 3. capabilityLabelZh ────────────────────────────────────────────────
  {
    assert(capabilityLabelZh('webSearch') === '上網查資料', '3: webSearch');
    assert(capabilityLabelZh('computerUse') === '操作電腦完成畫面工作', '3: computerUse');
    assert(capabilityLabelZh('sendEmail') === '寄送郵件', '3: sendEmail');
    assert(capabilityLabelZh('cloudWrite') === '建立或修改雲端文件', '3: cloudWrite');
    assert(capabilityLabelZh('shell') === '執行進階自動化', '3: shell');
    assert(capabilityLabelZh('cloudEmbedding') === '整理長期記憶', '3: cloudEmbedding');
    assert(capabilityLabelZh('sandbox') === '在隔離環境試做', '3: sandbox');
    assert(capabilityLabelZh('mcpTool') === null, '3: unknown key → null');
    assert(capabilityLabelZh('riskTier') === null, '3: riskTier → null');
    for (const key of [
      'webSearch',
      'computerUse',
      'sendEmail',
      'cloudWrite',
      'shell',
      'cloudEmbedding',
      'sandbox',
    ]) {
      const label = capabilityLabelZh(key);
      assert(label !== null, `3: ${key} has label`);
      assertNoBanned(label!, `3: capability ${key}`);
    }
  }

  // ── 4. projectAuthorization ─────────────────────────────────────────────
  {
    const allFalse = projectAuthorization(null);
    assert(allFalse.length === 5, '4: null → 5 items');
    assert(
      allFalse.every((x) => x.allowed === false),
      '4: null → all allowed=false (fail-closed)',
    );
    assert(
      allFalse.map((x) => x.key).join(',') ===
        'webSearch,computerUse,sendEmail,cloudWrite,shell',
      '4: fixed order',
    );

    const undef = projectAuthorization(undefined);
    assert(undef.every((x) => x.allowed === false), '4: undefined all false');

    const partial = projectAuthorization({ webSearch: true, notes: 'secret' });
    assert(partial.find((x) => x.key === 'webSearch')?.allowed === true, '4: webSearch true');
    assert(
      partial.filter((x) => x.key !== 'webSearch').every((x) => x.allowed === false),
      '4: only webSearch true',
    );
    assert(!partial.some((x) => x.key === 'notes'), '4: notes ignored');

    for (const item of [...allFalse, ...partial]) {
      assertNoBanned(item.label, '4: auth label');
      assertNoBanned(item.key, '4: auth key is known');
    }

    const frozenIn = deepFreeze({ webSearch: true, computerUse: false });
    const out = projectAuthorization(frozenIn);
    assert(Array.isArray(out), '4: freeze ok');
    assert(out !== (frozenIn as unknown as typeof out), '4: new array');
  }

  // ── 5. projectSkillPalette ──────────────────────────────────────────────
  {
    const palette = projectSkillPalette([
      {
        skillId: 's1',
        skill: { name: '帳款掃描', reviewStatus: 'CONFIRMED', kind: 'PROMPT' },
      },
      {
        skillId: 's2',
        skill: { name: '錄製技能', reviewStatus: 'AWAITING_USER_CONFIRM', kind: 'RECORDED' },
      },
      { skillId: 's3', skill: null },
      { skillId: 's4' },
    ]);
    assert(palette.length === 4, '5: four items');
    assert(palette[0]!.usable === true, '5: CONFIRMED usable');
    assert(palette[0]!.statusLabel === '可以使用', '5: confirmed label');
    assert(palette[1]!.usable === false, '5: awaiting not usable');
    assert(palette[1]!.statusLabel === '等待訓練師確認', '5: awaiting label');
    assert(palette[2]!.name === '未命名技能', '5: null skill name fallback');
    assert(palette[3]!.name === '未命名技能', '5: missing skill name fallback');
    assert(palette[2]!.statusLabel === '審核中', '5: missing status → 審核中');

    const empty = projectSkillPalette(null);
    assert(Array.isArray(empty) && empty.length === 0, '5: null → []');

    for (const p of palette) {
      assertNoBanned(p.name, '5: name');
      assertNoBanned(p.statusLabel, '5: status');
      assertNoBanned(p.kindLabel, '5: kind');
    }

    const input = deepFreeze([
      { skillId: 'x', skill: { name: 'A', reviewStatus: 'DRAFT', kind: 'BUILTIN' } },
    ]);
    const out = projectSkillPalette(input);
    assert(out !== (input as unknown as typeof out), '5: new array vs input');
    assert(out[0]!.kindLabel === '內建技能', '5: BUILTIN kind');
  }

  // ── 6. describeCronZh ───────────────────────────────────────────────────
  {
    assert(describeCronZh('0 9 * * *') === '每天 09:00', '6: daily 09:00');
    const fri = describeCronZh('30 18 * * 5');
    assert(fri.includes('每週五'), `6: weekly fri day: ${fri}`);
    assert(fri.includes('18:30'), `6: weekly fri time: ${fri}`);
    const mon1 = describeCronZh('0 8 1 * *');
    assert(mon1.includes('每月 1 日'), `6: monthly day: ${mon1}`);
    assert(mon1.includes('08:00'), `6: monthly time: ${mon1}`);
    assert(describeCronZh('*/15 * * * *') === '每 15 分鐘', '6: every 15 min');
    assert(describeCronZh('weird stuff') === '定期執行', '6: unparseable');
    assert(describeCronZh(null) === '定期執行', '6: null');
    assert(describeCronZh(undefined) === '定期執行', '6: undefined');

    const daily = describeCronZh('0 9 * * *');
    assert(!daily.includes('0 9'), '6: no raw "0 9"');
    assert(!daily.includes('*'), '6: no asterisk');
    assertNoBanned(daily, '6: daily banned');
    assertNoBanned(fri, '6: fri banned');
    assertNoBanned(mon1, '6: mon banned');
    assertNoBanned(describeCronZh('*/15 * * * *'), '6: interval banned');
    assertNoBanned(describeCronZh('weird stuff'), '6: weird banned');
    // must never echo the raw cron string
    assert(!describeCronZh('0 9 * * *').includes('0 9 * * *'), '6: no full cron echo');
  }

  // ── 7. describeTriggerZh ────────────────────────────────────────────────
  {
    const sched = describeTriggerZh({ type: 'schedule', cron: '0 9 * * *' });
    assert(sched === '每天 09:00', `7: schedule: ${sched}`);
    assertNoBanned(sched, '7: schedule');

    const kw = describeTriggerZh({ type: 'keyword', keywords: ['報價', '對帳'] });
    assert(kw.includes('報價') && kw.includes('對帳'), `7: keywords: ${kw}`);
    assert(kw.includes('聽到'), '7: keyword phrase');
    assertNoBanned(kw, '7: keyword');

    const kwMany = describeTriggerZh({
      type: 'keyword',
      keywords: ['a', 'b', 'c', 'd'],
    });
    assert(kwMany.includes('等'), `7: >3 keywords get 等: ${kwMany}`);
    assertNoBanned(kwMany, '7: keyword many');

    const kwEmpty = describeTriggerZh({ type: 'keyword', keywords: [] });
    assert(kwEmpty === '聽到關鍵字時執行', '7: empty keywords');
    assertNoBanned(kwEmpty, '7: keyword empty');

    assert(describeTriggerZh({ type: 'manual' }) === '手動交辦時執行', '7: manual');
    assert(describeTriggerZh({ type: 'webhook' }) === '由外部系統通知時執行', '7: webhook');
    assert(describeTriggerZh({ type: 'event' }) === '系統事件發生時執行', '7: event');
    assert(describeTriggerZh({ type: 'unknown_thing' }) === '依設定執行', '7: unknown type');
    assert(describeTriggerZh(null) === '依設定執行', '7: null');
    assert(describeTriggerZh(undefined) === '依設定執行', '7: undefined');
    assert(describeTriggerZh('string') === '依設定執行', '7: non-object');

    for (const s of [
      describeTriggerZh({ type: 'manual' }),
      describeTriggerZh({ type: 'webhook' }),
      describeTriggerZh({ type: 'event' }),
      describeTriggerZh({ type: 'weird' }),
    ]) {
      assertNoBanned(s, '7: trigger labels');
    }
  }

  // ── 8. lastRunLabelZh ───────────────────────────────────────────────────
  {
    assert(lastRunLabelZh('SUCCEEDED') === '上次順利完成', '8: SUCCEEDED');
    assert(lastRunLabelZh('FAILED') === '上次未完成', '8: FAILED');
    assert(lastRunLabelZh('CANCELLED') === '上次已取消', '8: CANCELLED');
    assert(lastRunLabelZh('RUNNING') === '正在執行', '8: RUNNING');
    assert(lastRunLabelZh('AWAITING_REVIEW') === '等待訓練師核准', '8: AWAITING_REVIEW');
    assert(lastRunLabelZh(null) === '還沒有執行紀錄', '8: null');
    assert(lastRunLabelZh(undefined) === '還沒有執行紀錄', '8: undefined');
    assert(lastRunLabelZh('WEIRD') === '還沒有執行紀錄', '8: unknown');
    for (const s of [
      lastRunLabelZh('SUCCEEDED'),
      lastRunLabelZh('FAILED'),
      lastRunLabelZh('CANCELLED'),
      lastRunLabelZh('RUNNING'),
      lastRunLabelZh('AWAITING_REVIEW'),
      lastRunLabelZh(null),
      lastRunLabelZh('WEIRD'),
    ]) {
      assertNoBanned(s!, '8: last run');
    }
  }

  // ── 9. projectSchedules ─────────────────────────────────────────────────
  {
    const nextIso = '2026-08-09T01:00:00.000Z';
    const workflows = [
      {
        id: 'w1',
        name: '每日帳款',
        enabled: true,
        trigger: { type: 'schedule', cron: '0 9 * * *' },
        schedule: {
          id: 'sch1',
          cron: '0 9 * * *',
          timezone: 'Asia/Taipei',
          enabled: true,
          lastFiredAt: null,
          nextFireAt: nextIso,
        },
      },
      {
        id: 'w2',
        name: '暫停工作',
        enabled: false,
        trigger: { type: 'schedule', cron: '0 10 * * *' },
        schedule: {
          id: 'sch2',
          cron: '0 10 * * *',
          timezone: 'Asia/Taipei',
          enabled: true,
          lastFiredAt: null,
          nextFireAt: nextIso,
        },
      },
      {
        id: 'w3',
        name: '排程關',
        enabled: true,
        trigger: { type: 'schedule', cron: '0 11 * * *' },
        schedule: {
          id: 'sch3',
          cron: '0 11 * * *',
          timezone: 'Asia/Taipei',
          enabled: false,
          lastFiredAt: null,
          nextFireAt: nextIso,
        },
      },
      {
        id: 'w4',
        name: '手動工作',
        enabled: true,
        trigger: { type: 'manual' },
        schedule: null,
      },
    ];

    const runs = [
      {
        id: 'r-old',
        agentId: 'a1',
        workflowId: 'w1',
        status: 'FAILED',
        triggeredBy: 'schedule',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T00:05:00.000Z',
      },
      {
        id: 'r-new',
        agentId: 'a1',
        workflowId: 'w1',
        status: 'SUCCEEDED',
        triggeredBy: 'schedule',
        startedAt: '2026-08-07T00:00:00.000Z',
        finishedAt: '2026-08-07T00:10:00.000Z',
      },
      // Out-of-order: newer run appears first in array but we pick max startedAt
      {
        id: 'r-mid',
        agentId: 'a1',
        workflowId: 'w1',
        status: 'CANCELLED',
        triggeredBy: 'manual',
        startedAt: '2026-08-05T00:00:00.000Z',
        finishedAt: null,
      },
    ];

    const projected = projectSchedules(workflows, runs);
    assert(projected.length === 4, '9: four workflows');
    assert(projected[0]!.workflowId === 'w1', '9: order preserved');
    assert(projected[0]!.nextRunAt === nextIso, '9: nextRunAt when enabled+schedule enabled');
    assert(projected[0]!.pausedReason === null, '9: no pause when both enabled');
    assert(projected[0]!.lastResultLabel === '上次順利完成', '9: max startedAt run wins');
    assert(projected[0]!.lastResultAt === '2026-08-07T00:10:00.000Z', '9: lastResultAt finishedAt');
    assertNoBanned(projected[0]!.triggerLabel, '9: triggerLabel no banned');
    assert(!projected[0]!.triggerLabel.includes('*'), '9: no cron star in trigger');

    assert(projected[1]!.pausedReason !== null, '9: disabled workflow pause');
    assert(
      projected[1]!.pausedReason === '訓練師已暫停這項工作',
      `9: pause reason: ${projected[1]!.pausedReason}`,
    );
    assert(projected[1]!.nextRunAt === null, '9: disabled → nextRunAt null');
    assertNoBanned(projected[1]!.pausedReason!, '9: pause banned');

    assert(projected[2]!.pausedReason !== null, '9: schedule disabled pause');
    assert(
      projected[2]!.pausedReason === '排程暫停中，請洽訓練師',
      `9: schedule pause: ${projected[2]!.pausedReason}`,
    );
    assert(projected[2]!.nextRunAt === null, '9: schedule disabled next null');
    assertNoBanned(projected[2]!.pausedReason!, '9: schedule pause banned');

    assert(projected[3]!.lastResultLabel === '還沒有執行紀錄', '9: no run');
    assert(projected[3]!.lastResultAt === null, '9: no run at');
    assert(projected[3]!.triggerLabel === '手動交辦時執行', '9: manual trigger');
    assert(projected[3]!.pausedReason === null, '9: manual no pause');
    assertNoBanned(projected[3]!.lastResultLabel, '9: no-run label');

    for (const row of projected) {
      assertNoBanned(row.name, '9: name');
      assertNoBanned(row.triggerLabel, '9: trigger');
      assertNoBanned(row.lastResultLabel, '9: lastResult');
      if (row.pausedReason) assertNoBanned(row.pausedReason, '9: paused');
    }

    // immutability
    const frozenW = deepFreeze(JSON.parse(JSON.stringify(workflows)));
    const frozenR = deepFreeze(JSON.parse(JSON.stringify(runs)));
    const out2 = projectSchedules(frozenW, frozenR);
    assert(Array.isArray(out2), '9: freeze ok');
    assert(out2 !== frozenW, '9: new array');
  }

  // ── 10. paletteControls (read-only contract) ────────────────────────────
  {
    const member = paletteControls(false);
    const fde = paletteControls(true);

    assert(member.canToggleSchedule === false, '10: member canToggleSchedule false');
    assert(member.canEditSkills === false, '10: member canEditSkills false');
    assert(member.canChangeAuthorization === false, '10: member canChangeAuthorization false');
    assert(member.canFullAuto === false, '10: member canFullAuto false');
    assert(member.showAdminLink === false, '10: member showAdminLink false');

    assert(fde.canToggleSchedule === false, '10: fde canToggleSchedule false');
    assert(fde.canEditSkills === false, '10: fde canEditSkills false');
    assert(fde.canChangeAuthorization === false, '10: fde canChangeAuthorization false');
    assert(fde.canFullAuto === false, '10: fde canFullAuto false');
    assert(fde.showAdminLink === true, '10: fde showAdminLink true');

    for (const [ctrl, label] of [
      [member, 'member'],
      [fde, 'fde'],
    ] as const) {
      for (const [k, v] of Object.entries(ctrl)) {
        if (k === 'showAdminLink') continue;
        assert(v === false, `10: ${label}.${k} must be false, got ${String(v)}`);
      }
    }
    assert(
      Object.entries(member).filter(([, v]) => v === true).length === 0,
      '10: member no true flags',
    );
    assert(
      Object.entries(fde).filter(([k, v]) => v === true && k !== 'showAdminLink').length === 0,
      '10: fde only showAdminLink may be true',
    );
  }

  console.log('skillpalette selftest: ALL PASS');
}

main();
