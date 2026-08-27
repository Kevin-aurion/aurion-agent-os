/**
 * Stage-1 S1-2: cross-model verify pairing + prompt collapse to one source.
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/stage1/verify-consolidation.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from '@prisma/client';
import { resolveVerifyEngine as fromVerify } from '../../src/engine/verify.ts';
import { resolveVerifyEngine as fromRunner } from '../../src/engine/runner.ts';
import { resolveVerifyEngine as fromGateway } from '../../src/lib/modelgateway.ts';
import { resolveVerifyEngine as fromEval } from '../../src/lib/eval.ts';
import { isApproved } from '../../src/engine/codex.ts';
import { buildVerifyPrompt } from '../../src/engine/verify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../../src');

const ENGINES: Engine[] = ['CLAUDE_CODE', 'CODEX', 'GROK'];

const EXPECTED: Record<Engine, Engine> = {
  CLAUDE_CODE: 'CODEX',
  CODEX: 'CLAUDE_CODE',
  GROK: 'CLAUDE_CODE',
};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTsFiles(abs));
    else if (ent.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

test('three modules return the same verifyEngine for each executeEngine', () => {
  assert.equal(fromRunner, fromVerify);
  assert.equal(fromGateway, fromVerify);
  assert.equal(fromEval, fromVerify);

  for (const execute of ENGINES) {
    const expected = EXPECTED[execute];
    const a = fromRunner(execute);
    const b = fromGateway(execute);
    const c = fromEval(execute);
    assert.equal(a, expected, `runner pairing for ${execute}`);
    assert.equal(b, expected, `modelgateway pairing for ${execute}`);
    assert.equal(c, expected, `eval pairing for ${execute}`);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.notEqual(a, execute, 'execute ≠ verify');
  }
});

test('verify engine selection logic has a single definition in src', () => {
  const files = walkTsFiles(SRC_ROOT);
  const oldImpl = /\b(?:export\s+)?(?:async\s+)?function\s+(?:chooseVerifyEngine|crossVerifyEngine)\b/;
  const oldAssign = /\b(?:chooseVerifyEngine|crossVerifyEngine)\s*=\s*(?:function|\()/;
  const pairing =
    /===\s*['"]CLAUDE_CODE['"]\s*\?\s*['"]CODEX['"]\s*:\s*['"]CLAUDE_CODE['"]/;
  const resolveDef = /\bexport\s+function\s+resolveVerifyEngine\b/;

  const oldHits: string[] = [];
  const pairingHits: string[] = [];
  const resolveHits: string[] = [];

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_ROOT, file);
    if (oldImpl.test(src) || oldAssign.test(src)) oldHits.push(rel);
    if (pairing.test(src)) pairingHits.push(rel);
    if (resolveDef.test(src)) resolveHits.push(rel);
    assert.equal(
      src.includes('function chooseVerifyEngine'),
      false,
      `${rel} still defines chooseVerifyEngine`,
    );
    assert.equal(
      src.includes('function crossVerifyEngine'),
      false,
      `${rel} still defines crossVerifyEngine`,
    );
    assert.equal(
      src.includes('function buildGatewayVerifyPrompt'),
      false,
      `${rel} still defines buildGatewayVerifyPrompt`,
    );
  }

  assert.deepEqual(oldHits, [], 'old selection functions must not have independent implementations');
  assert.deepEqual(pairingHits, ['engine/verify.ts'], 'opposite-engine ternary must live only in verify.ts');
  assert.deepEqual(resolveHits, ['engine/verify.ts'], 'resolveVerifyEngine must be defined once');
});

test('isApproved is fail-closed: REJECTED / ISSUES FOUND beats APPROVED', () => {
  assert.equal(isApproved('## Verdict\nAPPROVED\n'), true);
  assert.equal(isApproved('## Verdict\nAPPROVED.'), true);
  assert.equal(isApproved('looks fine\nAPPROVED'), true);

  assert.equal(isApproved('## Verdict\nISSUES FOUND: missing total\n'), false);
  assert.equal(isApproved('## Verdict\nISSUES FOUND\n## Verdict\nAPPROVED\n'), false);
  assert.equal(
    isApproved('## Verdict\nAPPROVED\n\nISSUES FOUND: later objection\n'),
    false,
  );
  assert.equal(isApproved('REMAINING ISSUES: still wrong\nAPPROVED'), false);
  assert.equal(isApproved('## Verdict\nAPPROVED (or) ISSUES FOUND\n'), false);
  assert.equal(isApproved(''), false);
  assert.equal(isApproved('please APPROVED this'), false);
});

test('shared verify prompt still uses the Verdict oracle format', () => {
  const prompt = buildVerifyPrompt('rubric-x', 'artifact-y', 'source-z', false);
  assert.match(prompt, /## Verdict/);
  assert.match(prompt, /APPROVED/);
  assert.match(prompt, /ISSUES FOUND/);
  assert.match(prompt, /\[Verification rubric\]\nrubric-x/);
  assert.match(prompt, /\[Artifact under review\]\nartifact-y/);
  assert.equal(prompt.includes('## Overstep'), false);

  const withCard = buildVerifyPrompt('r', 'a', 's', false, {
    oneLiner: 'clerk',
    purpose: 'file',
    canDo: ['draft'],
    cannotDo: ['send'],
    servedAudience: 'ops',
    exampleCommands: [],
  });
  assert.match(withCard, /## Verdict/);
  assert.match(withCard, /## Overstep/);
  assert.match(withCard, /does NOT affect APPROVED/);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
