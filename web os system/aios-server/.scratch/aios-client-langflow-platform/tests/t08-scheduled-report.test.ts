/**
 * Ticket 08 — scheduled-report-v1 template (positive / deterministic).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t08-scheduled-report.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { prisma } from '../../../src/lib/db.js';
import { getVerifiedFlowArtifact } from '../../../src/lib/flowartifact.js';
import { CAPABILITY_ID_RE } from '../../../src/compiler/registry.js';
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

const ALLOWED_KINDS = new Set([
  'input',
  'tool.read',
  'gateway.classify',
  'gateway.summarize',
  'gateway.verify',
  'output',
]);

/** Second-scheduler tokens must never appear as node kind segments. */
const FORBIDDEN_SCHEDULER_TOKENS = ['cron', 'scheduler', 'schedule', 'timer', 'interval'] as const;

function makeIr(slots: Record<string, unknown>, name = 'daily-report-t08') {
  return {
    schemaVersion: 'aios.skill-ir/1' as const,
    template: 'scheduled-report-v1',
    name,
    description: 't08 positive scheduled report',
    slots,
  };
}

function baseSlots(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheduleRef: {
      scheduleId: 'sched-t08-demo',
      timezone: 'Asia/Taipei',
      cron: '0 9 * * *',
    },
    reportTitle: '每日營運報表',
    readTools: ['mcp:gmail:gmail_list_messages', 'mcp:drive:drive_list_files'],
    rubric: ['涵蓋關鍵指標', '無捏造數據', '語言清晰'],
    summaryLanguage: 'zh-TW' as const,
    ...overrides,
  };
}

function extractNodes(artifactJson: unknown): Array<Record<string, unknown>> {
  if (!artifactJson || typeof artifactJson !== 'object') return [];
  const nodes = (artifactJson as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => n && typeof n === 'object') as Array<Record<string, unknown>>;
}

function asGraph(artifactJson: unknown): Record<string, unknown> {
  if (!artifactJson || typeof artifactJson !== 'object') return {};
  return artifactJson as Record<string, unknown>;
}

async function main(): Promise<void> {
  const createdIds: string[] = [];

  try {
    const dailySlots = baseSlots();
    const dailyIr = makeIr(dailySlots);

    console.log('── [1] legal daily report IR compile ok ──');
    const r1 = compileSkillIr(dailyIr);
    check(r1.ok === true, 'daily report compile ok', `got ${JSON.stringify(r1)}`);
    if (r1.ok) {
      check(r1.template === 'scheduled-report-v1', 'template id', r1.template);
      check(r1.templateVersion === '1', 'templateVersion', String(r1.templateVersion));
      check(r1.compilerVersion === 'aios-compiler/1', 'compilerVersion', r1.compilerVersion);
    }

    console.log('\n── [2] deterministic digests ──');
    if (r1.ok) {
      const r2 = compileSkillIr(dailyIr);
      check(r2.ok === true, 'repeat compile ok', JSON.stringify(r2));
      if (r2.ok) {
        check(
          r2.digest === r1.digest,
          'same IR → same digest',
          `a=${r1.digest} b=${r2.digest}`,
        );
      }

      // Scramble top-level IR keys + nested slots keys
      const scrambled = {
        slots: {
          summaryLanguage: dailySlots.summaryLanguage,
          rubric: [...(dailySlots.rubric as string[])],
          readTools: [...(dailySlots.readTools as string[])],
          reportTitle: dailySlots.reportTitle,
          scheduleRef: {
            cron: (dailySlots.scheduleRef as { cron: string }).cron,
            timezone: (dailySlots.scheduleRef as { timezone: string }).timezone,
            scheduleId: (dailySlots.scheduleRef as { scheduleId: string }).scheduleId,
          },
        },
        description: 't08 positive scheduled report',
        name: 'daily-report-t08',
        template: 'scheduled-report-v1',
        schemaVersion: 'aios.skill-ir/1' as const,
      };
      const r3 = compileSkillIr(scrambled);
      check(r3.ok === true, 'scrambled keys compile ok', JSON.stringify(r3));
      if (r3.ok) {
        check(
          r3.digest === r1.digest,
          'scrambled slot/IR keys → same digest',
          `a=${r1.digest} b=${r3.digest}`,
        );
      }

      const differentTitleIr = makeIr(baseSlots({ reportTitle: '另一份報表標題' }));
      const r4 = compileSkillIr(differentTitleIr);
      check(r4.ok === true, 'different title compile ok', JSON.stringify(r4));
      if (r4.ok) {
        check(
          r4.digest !== r1.digest,
          'different reportTitle → different digest',
          `a=${r1.digest} b=${r4.digest}`,
        );
      }
    }

    console.log('\n── [3] structure: allowlist + no second scheduler + tools + verify + trigger ──');
    if (r1.ok) {
      const nodes = extractNodes(r1.artifactJson);
      const kinds = nodes.map((n) => String(n.kind ?? ''));
      check(nodes.length > 0, 'artifactJson has nodes', `len=${nodes.length}`);
      check(
        kinds.every((k) => ALLOWED_KINDS.has(k)),
        'all node kinds in allowlist',
        `kinds=${kinds.join(',')}`,
      );

      for (const token of FORBIDDEN_SCHEDULER_TOKENS) {
        const hasSchedulerKind = kinds.some((k) => {
          const lower = k.toLowerCase();
          return lower === token || lower.split(/[./_-]/).includes(token);
        });
        check(
          !hasSchedulerKind,
          `no node kind with ${token} (no second scheduler)`,
          `kinds=${kinds.join(',')}`,
        );
      }

      const toolNodes = nodes.filter((n) => n.kind === 'tool.read');
      check(toolNodes.length === 2, 'two tool.read nodes', `count=${toolNodes.length}`);
      const toolsOk = toolNodes.every((n) => CAPABILITY_ID_RE.test(String(n.tool ?? '')));
      check(
        toolsOk,
        'all tool.read match capability id regex',
        JSON.stringify(toolNodes.map((n) => n.tool)),
      );

      const verifyNode = nodes.find((n) => n.kind === 'gateway.verify');
      check(!!verifyNode, 'has gateway.verify', kinds.join(','));
      if (verifyNode) {
        const cfg = (verifyNode.config ?? {}) as { rubric?: unknown };
        const rubric = Array.isArray(cfg.rubric) ? cfg.rubric : [];
        check(
          JSON.stringify(rubric) === JSON.stringify(dailySlots.rubric),
          'gateway.verify config.rubric matches input',
          JSON.stringify(cfg),
        );
      }

      check(kinds.includes('input'), 'has input', kinds.join(','));
      check(kinds.includes('gateway.summarize'), 'has gateway.summarize', kinds.join(','));
      check(kinds.includes('output'), 'has output', kinds.join(','));

      const graph = asGraph(r1.artifactJson);
      const scheduleRef = graph.scheduleRef as Record<string, unknown> | undefined;
      check(
        !!scheduleRef && scheduleRef.scheduleId === 'sched-t08-demo',
        'graph.scheduleRef.scheduleId present',
        JSON.stringify(scheduleRef),
      );
      check(
        !!scheduleRef && scheduleRef.ownedBy === 'AIOS',
        'scheduleRef.ownedBy is AIOS',
        JSON.stringify(scheduleRef),
      );

      const trigger = graph.trigger as Record<string, unknown> | undefined;
      const keyTpl = String(trigger?.idempotencyKeyTemplate ?? '');
      check(!!trigger, 'graph.trigger present', JSON.stringify(trigger));
      check(
        keyTpl.includes('{scheduledFireAtIso}'),
        'idempotencyKeyTemplate has {scheduledFireAtIso} placeholder',
        keyTpl,
      );
      check(
        keyTpl.includes('sched-t08-demo'),
        'idempotencyKeyTemplate includes scheduleId',
        keyTpl,
      );
      // Must be a template string, not a concrete ISO timestamp
      check(
        !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(keyTpl),
        'idempotencyKeyTemplate has no concrete ISO time',
        keyTpl,
      );
      check(
        keyTpl === 'schedule:{scheduleId}:{scheduledFireAtIso}'.replace(
          '{scheduleId}',
          'sched-t08-demo',
        ) || keyTpl === 'schedule:sched-t08-demo:{scheduledFireAtIso}',
        'idempotencyKeyTemplate is template form',
        keyTpl,
      );
    }

    console.log('\n── [4] duplicate trigger contract + content-addressed store ──');
    if (r1.ok) {
      const again = compileSkillIr(dailyIr);
      check(again.ok === true, 'second compile ok', JSON.stringify(again));
      if (again.ok) {
        const t1 = String((asGraph(r1.artifactJson).trigger as { idempotencyKeyTemplate?: string })?.idempotencyKeyTemplate ?? '');
        const t2 = String((asGraph(again.artifactJson).trigger as { idempotencyKeyTemplate?: string })?.idempotencyKeyTemplate ?? '');
        check(t1 === t2, 'idempotencyKeyTemplate identical across compiles', `a=${t1} b=${t2}`);
      }

      const store1 = await compileAndStore(dailyIr, { createdBy: 't08-test' });
      check(store1.ok === true, 'compileAndStore first ok', JSON.stringify(store1));
      if (store1.ok && 'artifactId' in store1) {
        createdIds.push(store1.artifactId);
        check(store1.reused === false, 'first store reused=false', `got ${store1.reused}`);

        const store2 = await compileAndStore(dailyIr, { createdBy: 't08-test' });
        check(store2.ok === true, 'compileAndStore second ok', JSON.stringify(store2));
        if (store2.ok && 'artifactId' in store2) {
          if (!createdIds.includes(store2.artifactId)) createdIds.push(store2.artifactId);
          check(store2.reused === true, 'second store reused===true', `got ${store2.reused}`);
          check(
            store2.artifactId === store1.artifactId,
            'reuse same artifactId',
            `a=${store1.artifactId} b=${store2.artifactId}`,
          );
        }

        console.log('\n── [6] getVerifiedFlowArtifact ──');
        try {
          const verified = await getVerifiedFlowArtifact(store1.artifactId);
          check(
            verified.id === store1.artifactId && verified.digest === store1.digest,
            'getVerifiedFlowArtifact passes',
            verified.id,
          );
        } catch (e) {
          fail('getVerifiedFlowArtifact passes', String(e));
        }
      }
    }

    console.log('\n── [5] timezone affects digest ──');
    const nyIr = makeIr(
      baseSlots({
        scheduleRef: {
          scheduleId: 'sched-t08-demo',
          timezone: 'America/New_York',
          cron: '0 9 * * *',
        },
      }),
    );
    const ny = compileSkillIr(nyIr);
    const tp = compileSkillIr(dailyIr);
    check(ny.ok === true, 'America/New_York compile ok', JSON.stringify(ny));
    check(tp.ok === true, 'Asia/Taipei compile ok', JSON.stringify(tp));
    if (ny.ok && tp.ok) {
      check(
        ny.digest !== tp.digest,
        'America/New_York vs Asia/Taipei digests differ',
        `ny=${ny.digest} tp=${tp.digest}`,
      );
    }
  } finally {
    console.log('\n── cleanup test-owned FlowArtifact rows only ──');
    if (createdIds.length > 0) {
      await prisma.flowArtifact
        .deleteMany({ where: { id: { in: createdIds } } })
        .catch(() => undefined);
      pass('cleanup own artifacts', createdIds.join(','));
    }
  }

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
