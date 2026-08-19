/**
 * Ticket 08 — scheduled-report-v1 + scheduler red-line (negative).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t08-scheduler-negative.test.ts
 *
 * Every case: observe real REJECTED/throw + zero FlowArtifact count delta.
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { prisma } from '../../../src/lib/db.js';
import { assertGraphSafe } from '../../../src/compiler/registry.js';
import { compileAndStore, compileSkillIr } from '../../../src/compiler/compile.js';

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

function baseSlots(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheduleRef: {
      scheduleId: 'sched-t08-neg',
      timezone: 'Asia/Taipei',
      cron: '0 9 * * *',
    },
    reportTitle: '負向測試報表',
    readTools: ['mcp:gmail:gmail_list_messages'],
    rubric: ['準確'],
    summaryLanguage: 'zh-TW' as const,
    ...overrides,
  };
}

function baseIr(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'aios.skill-ir/1' as const,
    template: 'scheduled-report-v1',
    name: 't08-neg',
    slots: baseSlots(),
    ...overrides,
  };
}

async function withCountInvariant(
  label: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const before = await prisma.flowArtifact.count();
  try {
    await fn();
  } finally {
    const after = await prisma.flowArtifact.count();
    check(
      after === before,
      `${label}: flowArtifact.count unchanged`,
      `before=${before} after=${after}`,
    );
  }
}

function throwsAssertGraphSafe(graph: unknown): { threw: boolean; message: string } {
  try {
    assertGraphSafe(graph);
    return { threw: false, message: '' };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  console.log('── [1] runtime cron/scheduler/timer nodes → assertGraphSafe throws ──');
  await withCountInvariant('runtime-cron-nodes', () => {
    const cases: Array<{ label: string; graph: unknown }> = [
      {
        label: 'kind=cron',
        graph: {
          nodes: [{ id: 'c1', kind: 'cron', config: { pattern: '* * * * *' } }],
          edges: [],
        },
      },
      {
        label: 'kind=langflow.scheduler',
        graph: {
          nodes: [
            {
              id: 'c2',
              kind: 'langflow.scheduler',
              config: { cron: '0 * * * *' },
            },
          ],
          edges: [],
        },
      },
      {
        label: 'kind=timer.interval',
        graph: {
          nodes: [
            {
              id: 'c3',
              kind: 'timer.interval',
              config: { ms: 60000 },
            },
          ],
          edges: [],
        },
      },
    ];

    for (const c of cases) {
      const { threw, message } = throwsAssertGraphSafe(c.graph);
      check(threw, `${c.label} throws`, 'did not throw');
      if (threw) {
        check(
          /forbidden node kind|not in allowlist/i.test(message),
          `${c.label} message is forbidden/allowlist`,
          message,
        );
      }
    }
  });

  console.log('\n── [2] no Schedule → REJECTED ──');
  await withCountInvariant('no-schedule', async () => {
    const missingRef = baseIr({
      slots: {
        reportTitle: '無 schedule',
        readTools: ['mcp:gmail:gmail_list_messages'],
        rubric: ['準確'],
      },
    });
    const r1 = compileSkillIr(missingRef);
    check(r1.ok === false, 'missing scheduleRef → not ok', JSON.stringify(r1));
    if (!r1.ok) {
      check(r1.status === 'REJECTED', 'missing scheduleRef REJECTED', r1.status);
    }

    const emptyId = baseIr({
      slots: baseSlots({
        scheduleRef: {
          scheduleId: '',
          timezone: 'Asia/Taipei',
        },
      }),
    });
    const r2 = compileSkillIr(emptyId);
    check(r2.ok === false, 'empty scheduleId → not ok', JSON.stringify(r2));
    if (!r2.ok) {
      check(r2.status === 'REJECTED', 'empty scheduleId REJECTED', r2.status);
    }
  });

  console.log('\n── [3] no read capability → REJECTED ──');
  await withCountInvariant('no-read-tools', async () => {
    const ir = baseIr({
      slots: baseSlots({ readTools: [] }),
    });
    const r = compileSkillIr(ir);
    check(r.ok === false, 'empty readTools → not ok', JSON.stringify(r));
    if (!r.ok) {
      check(r.status === 'REJECTED', 'empty readTools REJECTED', r.status);
    }
  });

  console.log('\n── [4] write-only data source → REJECTED ──');
  await withCountInvariant('write-only-tools', async () => {
    const uploadIr = baseIr({
      slots: baseSlots({
        readTools: ['mcp:drive:drive_upload_file'],
      }),
    });
    const r1 = compileSkillIr(uploadIr);
    check(r1.ok === false, 'drive_upload_file → not ok', JSON.stringify(r1));
    if (!r1.ok) {
      check(r1.status === 'REJECTED', 'upload REJECTED', r1.status);
      const blob = r1.errors.join(' ');
      check(
        /forbidden|upload|write/i.test(blob),
        'upload errors mention forbidden substring',
        blob,
      );
    }

    const sendIr = baseIr({
      slots: baseSlots({
        readTools: ['mcp:gmail:gmail_send'],
      }),
    });
    const r2 = compileSkillIr(sendIr);
    check(r2.ok === false, 'gmail_send → not ok', JSON.stringify(r2));
    if (!r2.ok) {
      check(r2.status === 'REJECTED', 'gmail_send REJECTED', r2.status);
      const blob = r2.errors.join(' ');
      check(
        /forbidden|send/i.test(blob),
        'gmail_send errors mention forbidden substring',
        blob,
      );
    }
  });

  console.log('\n── [5] invalid timezone → REJECTED ──');
  await withCountInvariant('invalid-timezone', async () => {
    for (const tz of ['Not/AZone', 'GMT+99']) {
      const ir = baseIr({
        slots: baseSlots({
          scheduleRef: {
            scheduleId: 'sched-t08-neg',
            timezone: tz,
          },
        }),
      });
      const r = compileSkillIr(ir);
      check(r.ok === false, `tz=${tz} → not ok`, JSON.stringify(r));
      if (!r.ok) {
        check(r.status === 'REJECTED', `tz=${tz} REJECTED`, r.status);
        const blob = r.errors.join(' ').toLowerCase();
        check(
          blob.includes('timezone') || blob.includes('time zone') || blob.includes('timeZone'.toLowerCase()),
          `tz=${tz} errors mention timezone`,
          r.errors.join(' | '),
        );
      }
    }
  });

  console.log('\n── [6] strict unknown key → REJECTED ──');
  await withCountInvariant('strict-extra-key', async () => {
    const ir = baseIr({
      slots: {
        ...baseSlots(),
        cronNode: true,
      },
    });
    const r = compileSkillIr(ir);
    check(r.ok === false, 'unknown key cronNode → not ok', JSON.stringify(r));
    if (!r.ok) {
      check(r.status === 'REJECTED', 'unknown key REJECTED', r.status);
    }
  });

  console.log('\n── [7] secret in slots → REJECTED or zero plaintext ──');
  await withCountInvariant('secret-in-slots', async () => {
    const secretTitle = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
    const ir = baseIr({
      slots: baseSlots({
        reportTitle: secretTitle,
      }),
    });
    const stored = await compileAndStore(ir, { createdBy: 't08-neg-secret' });

    if (!stored.ok) {
      check(stored.status === 'REJECTED', 'secret → REJECTED', JSON.stringify(stored));
      check(
        stored.errors.some((e) => /secret/i.test(e)),
        'errors mention secret material',
        JSON.stringify(stored.errors),
      );
      pass('secret case: zero write via REJECTED');
    } else if ('artifactId' in stored) {
      const row = await prisma.flowArtifact.findUnique({ where: { id: stored.artifactId } });
      const blob = JSON.stringify(row?.artifactJson ?? {});
      check(!blob.includes(secretTitle), 'stored artifact has no plaintext secret', blob.slice(0, 200));
      await prisma.flowArtifact.delete({ where: { id: stored.artifactId } }).catch(() => undefined);
      pass('secret case: stored but redacted (cleaned up)');
    } else {
      fail('secret case', `unexpected result ${JSON.stringify(stored)}`);
    }
  });

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('FATAL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
