/**
 * Ticket 04 — SkillVersion Skill IR fields (schemaVersion + specJson).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t04-skill-ir-fields.test.ts
 *
 * Additive migration compatibility:
 * 1. legacy createSkillVersion → schemaVersion/specJson null
 * 2. promote/rollback behaviour unchanged
 * 3. IR round-trip via prisma update
 * 4. same contentHash dedup unchanged
 *
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import {
  createSkillVersion,
  promoteToStable,
  rollbackStable,
} from '../../../src/lib/skillversion.js';

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

/** Order-insensitive deep equality for JSON values (key order may change via PG/Prisma). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    if (ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

async function main(): Promise<void> {
  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const slug = `t04-skill-ir-${tag}`;
  const contentV1 = '# t04 skill v1\n\nlegacy content without IR\n';
  const contentV2 = '# t04 skill v2\n\nsecond version for promote/rollback\n';

  const irSpec = {
    name: '測試技能',
    steps: [
      { key: 'do', action: '執行', nested: { a: 1, b: ['中文', 'ok'] } },
    ],
    meta: { version: 1, tags: ['ir', 'phase3'] },
  };

  console.log('── setup: t04 test skill ──');
  try {
    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: `T04 Skill IR ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: contentV1,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    // ── 1. legacy 相容：createSkillVersion 不帶 IR → null ──────────────
    console.log('\n── [1] legacy createSkillVersion → null IR fields ──');
    const v1 = await createSkillVersion(skillId, contentV1);
    const row1 = await prisma.skillVersion.findUnique({ where: { id: v1.id } });
    check(!!row1, 'legacy: row exists', `id=${v1.id}`);
    check(
      row1?.schemaVersion === null || row1?.schemaVersion === undefined,
      'legacy: schemaVersion is null',
      `got ${JSON.stringify(row1?.schemaVersion)}`,
    );
    check(
      row1?.specJson === null || row1?.specJson === undefined,
      'legacy: specJson is null',
      `got ${JSON.stringify(row1?.specJson)}`,
    );

    // ── 2. promote / rollback 行為不變 ─────────────────────────────────
    console.log('\n── [2] promoteToStable / rollbackStable unchanged ──');
    const v2 = await createSkillVersion(skillId, contentV2);
    check(v2.id !== v1.id, 'v2 is new version', `v1=${v1.id} v2=${v2.id}`);
    check(v2.version === v1.version + 1, 'v2 version = v1+1', `v1=${v1.version} v2=${v2.version}`);

    await promoteToStable(skillId, v2.id);
    const skillAfterPromote = await prisma.skill.findUnique({ where: { id: skillId } });
    check(
      skillAfterPromote?.stableVersionId === v2.id,
      'promote: stableVersionId === v2.id',
      `got ${skillAfterPromote?.stableVersionId}`,
    );
    const v2AfterPromote = await prisma.skillVersion.findUnique({ where: { id: v2.id } });
    check(v2AfterPromote?.channel === 'stable', 'promote: v2 channel=stable', `got ${v2AfterPromote?.channel}`);
    const v1AfterPromote = await prisma.skillVersion.findUnique({ where: { id: v1.id } });
    check(!!v1AfterPromote, 'promote: v1 still exists', 'v1 missing');
    // v1 was never stable; channel should remain canary (createSkillVersion default)
    check(
      v1AfterPromote?.channel === 'canary',
      'promote: v1 channel unaffected (still canary)',
      `got ${v1AfterPromote?.channel}`,
    );

    await rollbackStable(skillId, v1.id);
    const skillAfterRollback = await prisma.skill.findUnique({ where: { id: skillId } });
    check(
      skillAfterRollback?.stableVersionId === v1.id,
      'rollback: stableVersionId === v1.id',
      `got ${skillAfterRollback?.stableVersionId}`,
    );
    const v1AfterRollback = await prisma.skillVersion.findUnique({ where: { id: v1.id } });
    check(v1AfterRollback?.channel === 'stable', 'rollback: v1 channel=stable', `got ${v1AfterRollback?.channel}`);
    const v2AfterRollback = await prisma.skillVersion.findUnique({ where: { id: v2.id } });
    check(!!v2AfterRollback, 'rollback: v2 not deleted', 'v2 missing');
    check(
      v2AfterRollback?.channel === 'archived',
      'rollback: prior stable v2 archived',
      `got ${v2AfterRollback?.channel}`,
    );

    // ── 3. IR round-trip ───────────────────────────────────────────────
    console.log('\n── [3] IR round-trip via prisma.skillVersion.update ──');
    await prisma.skillVersion.update({
      where: { id: v1.id },
      data: {
        schemaVersion: 'aios.skill-ir/1',
        specJson: irSpec,
      },
    });
    const irRow = await prisma.skillVersion.findUnique({ where: { id: v1.id } });
    check(
      irRow?.schemaVersion === 'aios.skill-ir/1',
      'IR: schemaVersion round-trip',
      `got ${JSON.stringify(irRow?.schemaVersion)}`,
    );
    check(
      deepEqual(irRow?.specJson, irSpec),
      'IR: specJson deep equal (nested + 中文)',
      `got ${JSON.stringify(irRow?.specJson)}`,
    );

    // ── 4. contentHash 去重 ────────────────────────────────────────────
    console.log('\n── [4] same contentHash dedup unchanged ──');
    const beforeCount = await prisma.skillVersion.count({ where: { skillId } });
    const again = await createSkillVersion(skillId, contentV2);
    check(again.id === v2.id, 'dedup: returns existing v2.id', `got ${again.id} expected ${v2.id}`);
    const afterCount = await prisma.skillVersion.count({ where: { skillId } });
    check(afterCount === beforeCount, 'dedup: no new row', `before=${beforeCount} after=${afterCount}`);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
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
