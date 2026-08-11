/**
 * Ticket 05 — FlowArtifact digest + create (positive).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t05-flowartifact-digest.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { computeArtifactDigest } from '../../../src/runtime/adapter.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
  getVerifiedFlowArtifact,
  verifyArtifactDigest,
} from '../../../src/lib/flowartifact.js';

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

const HEX64 = /^[a-f0-9]{64}$/;

async function main(): Promise<void> {
  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const slug = `t05-flow-art-${tag}`;
  const contentV1 = '# t05 flow artifact\n\ntest skill for digest\n';

  // Nested object with scrambled key order (including nested).
  const nestedA = {
    z: 1,
    a: {
      m: '中文',
      b: [3, { y: 2, x: 1 }],
      c: true,
    },
    mid: null as null,
  };
  const nestedB = {
    mid: null as null,
    a: {
      c: true,
      b: [3, { x: 1, y: 2 }],
      m: '中文',
    },
    z: 1,
  };

  console.log('── [1] digest stability (key order independent) ──');
  const d1 = computeFlowArtifactDigest(nestedA);
  const d2 = computeFlowArtifactDigest(nestedB);
  const d1b = computeFlowArtifactDigest(nestedA);
  check(HEX64.test(d1), 'digest is 64-char hex', `got ${d1}`);
  check(d1 === d2, 'same digest for scrambled key order (nested)', `d1=${d1} d2=${d2}`);
  check(d1 === d1b, 'repeat call same digest', `d1=${d1} d1b=${d1b}`);

  console.log('\n── [2] single source of truth vs runtime/adapter ──');
  const adapterDigest = computeArtifactDigest(nestedA);
  check(
    d1 === adapterDigest,
    'computeFlowArtifactDigest === computeArtifactDigest',
    `flow=${d1} adapter=${adapterDigest}`,
  );

  console.log('\n── setup: t05 test skill + skillVersion ──');
  let skillVersionId = '';
  try {
    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: `T05 FlowArtifact ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: contentV1,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, contentV1);
    skillVersionId = sv.id;

    const artifactJson = {
      template: 'email-triage-readonly-v1',
      nodes: [
        { id: 'n1', type: 'read', label: '讀取郵件', cfg: { folder: 'INBOX', limit: 10 } },
        { id: 'n2', type: 'classify', nested: { rules: ['urgent', '中文標籤'], thr: 0.8 } },
      ],
      meta: { locale: 'zh-TW', version: 1 },
    };

    console.log('\n── [3] createFlowArtifact positive ──');
    const created = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: 't05-test-1',
      artifactJson,
    });
    check(!!created.id, 'create: has id', `id=${created.id}`);
    check(HEX64.test(created.digest), 'create: digest is 64-hex', `got ${created.digest}`);
    check(created.status === 'COMPILED', 'create: status=COMPILED', `got ${created.status}`);
    check(created.reused === false, 'create: reused=false first time', `got ${created.reused}`);

    const row = await prisma.flowArtifact.findUnique({ where: { id: created.id } });
    check(!!row, 'create: DB row exists', `id=${created.id}`);
    const recomputed = computeFlowArtifactDigest(row!.artifactJson);
    check(
      row!.digest === recomputed && row!.digest === created.digest,
      'create: DB digest matches recompute',
      `db=${row?.digest} recompute=${recomputed} ret=${created.digest}`,
    );

    console.log('\n── [4] content-addressed reuse ──');
    const countBefore = await prisma.flowArtifact.count();
    const again = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: 't05-test-1',
      artifactJson,
    });
    const countAfter = await prisma.flowArtifact.count();
    check(again.id === created.id, 'reuse: same id', `got ${again.id} expected ${created.id}`);
    check(again.reused === true, 'reuse: reused===true', `got ${again.reused}`);
    check(countAfter === countBefore, 'reuse: no new row', `before=${countBefore} after=${countAfter}`);

    console.log('\n── [5] getVerifiedFlowArtifact positive ──');
    let verifiedOk = false;
    try {
      const verified = await getVerifiedFlowArtifact(created.id);
      verifiedOk = verified.id === created.id && verified.digest === created.digest;
    } catch (e) {
      fail('getVerified: no throw', String(e));
    }
    if (verifiedOk) check(true, 'getVerified: returns row without throw', created.id);

    console.log('\n── [6] verifyArtifactDigest positive ──');
    try {
      verifyArtifactDigest(row!.artifactJson, row!.digest);
      pass('verifyArtifactDigest: no throw on match');
    } catch (e) {
      fail('verifyArtifactDigest: no throw on match', String(e));
    }
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
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
