/**
 * Ticket 05 — FlowArtifact negative / security (must observe real throw + zero writes).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t05-flowartifact-negative.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { Engine, FlowArtifactStatus, RuntimeKind } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  canonicalJson,
  computeFlowArtifactDigest,
  createFlowArtifact,
  getVerifiedFlowArtifact,
  verifyArtifactDigest,
  FlowArtifactError,
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

function throwsWith(
  fn: () => unknown,
  label: string,
  pred: (err: unknown) => boolean,
): void {
  try {
    fn();
    fail(label, 'expected throw, got none');
  } catch (e) {
    if (pred(e)) pass(label);
    else fail(label, `threw but predicate failed: ${String(e)}`);
  }
}

async function throwsAsync(
  fn: () => Promise<unknown>,
  label: string,
  pred: (err: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    fail(label, 'expected throw, got none');
  } catch (e) {
    if (pred(e)) pass(label);
    else fail(label, `threw but predicate failed: ${String(e)}`);
  }
}

function isDigestMismatch(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof FlowArtifactError ? e.code : '';
  return (
    code === 'DIGEST_MISMATCH' ||
    /digest\s*mismatch/i.test(msg) ||
    /DIGEST_MISMATCH/i.test(msg)
  );
}

function isInvalidOrNotFound(e: unknown): boolean {
  if (e instanceof FlowArtifactError) {
    return e.code === 'INVALID_INPUT' || e.code === 'NOT_FOUND';
  }
  return true; // any throw is acceptable for fail-closed input cases
}

async function main(): Promise<void> {
  const tag = ulid().slice(-8).toLowerCase();
  const skillId = ulid();
  const slug = `t05-flow-neg-${tag}`;
  const contentV1 = '# t05 flow artifact negative\n\ntest\n';

  let skillVersionId = '';
  let artifactId = '';

  console.log('── setup: t05 negative test skill ──');
  try {
    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: `T05 FlowArtifact Neg ${tag}`,
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

    const baseArtifact = {
      nodes: [{ id: 'n1', type: 'read' }],
      meta: { v: 1 },
    };
    const created = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: 't05-neg-1',
      artifactJson: baseArtifact,
    });
    artifactId = created.id;
    const originalDigest = created.digest;

    // ── 1. tamper drift ────────────────────────────────────────────────
    console.log('\n── [1] tamper drift ──');
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: {
        artifactJson: {
          nodes: [{ id: 'n1', type: 'TAMPERED' }],
          meta: { v: 999 },
        },
      },
    });
    await throwsAsync(
      () => getVerifiedFlowArtifact(artifactId),
      'tamper: getVerifiedFlowArtifact throws digest mismatch',
      isDigestMismatch,
    );
    throwsWith(
      () =>
        verifyArtifactDigest(
          { nodes: [{ id: 'n1', type: 'TAMPERED' }], meta: { v: 999 } },
          originalDigest,
        ),
      'tamper: verifyArtifactDigest throws',
      isDigestMismatch,
    );

    // Restore row so cleanup can still find by skillVersionId; re-create clean for other tests
    await prisma.flowArtifact.delete({ where: { id: artifactId } }).catch(() => undefined);
    artifactId = '';

    // ── 2. secret redaction ────────────────────────────────────────────
    console.log('\n── [2] secret redaction ──');
    const secretArtifact = {
      apiKey: 'sk-test1234567890abcd',
      auth: 'Bearer abcdefghijklmnop123456',
      contact: 'alice@example.com',
      accessToken: 'raw-token-value',
      nested: { note: 'ok' },
    };
    const secretMeta = {
      token: 'sk-metaSecretKey99999',
      note: 'metadata',
    };
    const secretCreated = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 'email-triage-readonly-v1',
      compilerVersion: 't05-neg-secret',
      artifactJson: secretArtifact,
      metadata: secretMeta,
    });
    artifactId = secretCreated.id;
    const secretRow = await prisma.flowArtifact.findUnique({ where: { id: secretCreated.id } });
    const artStr = JSON.stringify(secretRow?.artifactJson ?? {});
    const metaStr = JSON.stringify(secretRow?.metadata ?? {});
    const forbidden = [
      'sk-test1234567890abcd',
      'abcdefghijklmnop123456',
      'alice@example.com',
      'raw-token-value',
      'sk-metaSecretKey99999',
    ];
    const hasPlain = forbidden.some((s) => artStr.includes(s) || metaStr.includes(s));
    check(!hasPlain, 'secret: no plaintext in artifactJson/metadata', `art=${artStr} meta=${metaStr}`);
    check(
      artStr.includes('[REDACTED') || metaStr.includes('[REDACTED'),
      'secret: contains [REDACTED marker',
      `art=${artStr} meta=${metaStr}`,
    );
    try {
      await getVerifiedFlowArtifact(secretCreated.id);
      pass('secret: getVerifiedFlowArtifact ok (digest after redact)');
    } catch (e) {
      fail('secret: getVerifiedFlowArtifact ok (digest after redact)', String(e));
    }

    // ── 3. invalid runtimeKind ─────────────────────────────────────────
    console.log('\n── [3] invalid runtimeKind ──');
    const countBeforeInvalid = await prisma.flowArtifact.count();
    await throwsAsync(
      () =>
        createFlowArtifact({
          skillVersionId,
          runtimeKind: 'CLAUDE_CODE' as 'LANGFLOW',
          template: 'email-triage-readonly-v1',
          compilerVersion: 't05-neg-rt',
          artifactJson: { x: 1 },
        }),
      'runtimeKind CLAUDE_CODE throws',
      isInvalidOrNotFound,
    );
    await throwsAsync(
      () =>
        createFlowArtifact({
          skillVersionId,
          runtimeKind: 'BOGUS' as 'LANGFLOW',
          template: 'email-triage-readonly-v1',
          compilerVersion: 't05-neg-rt',
          artifactJson: { x: 1 },
        }),
      'runtimeKind BOGUS throws',
      isInvalidOrNotFound,
    );
    const countAfterInvalid = await prisma.flowArtifact.count();
    check(
      countAfterInvalid === countBeforeInvalid,
      'invalid runtimeKind: zero new FlowArtifact rows',
      `before=${countBeforeInvalid} after=${countAfterInvalid}`,
    );

    // ── 4. Engine enum not polluted ────────────────────────────────────
    console.log('\n── [4] Engine enum not polluted ──');
    const engineVals = Object.values(Engine).sort();
    const runtimeVals = Object.values(RuntimeKind).sort();
    const statusVals = Object.values(FlowArtifactStatus).sort();
    check(
      engineVals.length === 3 &&
        engineVals.includes('CLAUDE_CODE') &&
        engineVals.includes('CODEX') &&
        engineVals.includes('GROK') &&
        !engineVals.includes('LANGFLOW' as Engine),
      'Engine values exactly CLAUDE_CODE/CODEX/GROK (no LANGFLOW)',
      `got ${JSON.stringify(engineVals)}`,
    );
    check(
      runtimeVals.length === 2 &&
        runtimeVals.includes('NATIVE') &&
        runtimeVals.includes('LANGFLOW'),
      'RuntimeKind exactly NATIVE/LANGFLOW',
      `got ${JSON.stringify(runtimeVals)}`,
    );
    check(
      statusVals.length === 4 &&
        statusVals.includes('COMPILED') &&
        statusVals.includes('VALIDATED') &&
        statusVals.includes('REJECTED') &&
        statusVals.includes('SUPERSEDED'),
      'FlowArtifactStatus exactly COMPILED/VALIDATED/REJECTED/SUPERSEDED',
      `got ${JSON.stringify(statusVals)}`,
    );
    const schemaPath = resolve(process.cwd(), 'prisma/schema.prisma');
    const schemaText = readFileSync(schemaPath, 'utf8');
    const engineBlockMatch = schemaText.match(/enum Engine \{[^}]+\}/);
    check(!!engineBlockMatch, 'schema has enum Engine block', 'not found');
    if (engineBlockMatch) {
      check(
        !engineBlockMatch[0].includes('LANGFLOW'),
        'schema enum Engine block has no LANGFLOW',
        engineBlockMatch[0],
      );
    }

    // ── 5. illegal JSON fail-closed ────────────────────────────────────
    console.log('\n── [5] illegal JSON input fail-closed ──');
    throwsWith(
      () => canonicalJson(undefined),
      'canonicalJson(undefined) throws',
      isInvalidOrNotFound,
    );
    throwsWith(
      () => computeFlowArtifactDigest({ a: 1, fn: () => 1 }),
      'digest object with function throws',
      isInvalidOrNotFound,
    );
    throwsWith(
      () => computeFlowArtifactDigest({ n: BigInt(1) }),
      'digest object with BigInt throws',
      isInvalidOrNotFound,
    );
    throwsWith(
      () => computeFlowArtifactDigest({ n: NaN }),
      'digest object with NaN throws',
      isInvalidOrNotFound,
    );
    throwsWith(
      () => computeFlowArtifactDigest({ n: Infinity }),
      'digest object with Infinity throws',
      isInvalidOrNotFound,
    );
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    throwsWith(
      () => computeFlowArtifactDigest(cyclic),
      'digest cyclic object throws',
      isInvalidOrNotFound,
    );
    const countBeforeIllegal = await prisma.flowArtifact.count();
    await throwsAsync(
      () =>
        createFlowArtifact({
          skillVersionId,
          runtimeKind: 'LANGFLOW',
          template: 'email-triage-readonly-v1',
          compilerVersion: 't05-neg-illegal',
          artifactJson: { n: NaN },
        }),
      'createFlowArtifact with NaN throws',
      isInvalidOrNotFound,
    );
    const countAfterIllegal = await prisma.flowArtifact.count();
    check(
      countAfterIllegal === countBeforeIllegal,
      'illegal JSON: zero new rows',
      `before=${countBeforeIllegal} after=${countAfterIllegal}`,
    );

    // ── 6. missing skillVersionId ──────────────────────────────────────
    console.log('\n── [6] nonexistent skillVersionId ──');
    const countBeforeMissing = await prisma.flowArtifact.count();
    await throwsAsync(
      () =>
        createFlowArtifact({
          skillVersionId: '01NONEXISTENT00000000000000',
          runtimeKind: 'LANGFLOW',
          template: 'email-triage-readonly-v1',
          compilerVersion: 't05-neg-missing',
          artifactJson: { x: 1 },
        }),
      'missing skillVersionId throws',
      (e) => {
        if (e instanceof FlowArtifactError) return e.code === 'NOT_FOUND';
        return /not\s*found/i.test(e instanceof Error ? e.message : String(e));
      },
    );
    const countAfterMissing = await prisma.flowArtifact.count();
    check(
      countAfterMissing === countBeforeMissing,
      'missing skillVersionId: zero new rows',
      `before=${countBeforeMissing} after=${countAfterMissing}`,
    );
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
    }
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
