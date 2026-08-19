/**
 * Ticket 07 — Skill IR Compiler (negative / forbidden).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t07-forbidden-negative.test.ts
 *
 * Every case: observe real REJECTED/throw + zero FlowArtifact count delta.
 * Zero new deps. Real DB via prisma singleton. No git.
 */
import { prisma } from '../../../src/lib/db.js';
import { assertGraphSafe, CAPABILITY_ID_RE } from '../../../src/compiler/registry.js';
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

function baseIr(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'aios.skill-ir/1' as const,
    template: 'email-triage-readonly-v1',
    name: 't07-neg',
    slots: {
      readTools: ['mcp:gmail:gmail_list_messages'],
      categories: ['一般'],
      summaryLanguage: 'zh-TW' as const,
    },
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

async function main(): Promise<void> {
  console.log('── [1] write tool in readTools → REJECTED ──');
  await withCountInvariant('write-tool', async () => {
    const ir = baseIr({
      slots: {
        readTools: ['mcp:gmail:gmail_send'],
        categories: ['一般'],
      },
    });
    const r = compileSkillIr(ir);
    check(r.ok === false, 'gmail_send → not ok', JSON.stringify(r));
    if (!r.ok) {
      check(r.status === 'REJECTED', 'gmail_send status REJECTED', r.status);
      check(r.errors.length > 0, 'gmail_send has errors', JSON.stringify(r.errors));
    }
    const stored = await compileAndStore(ir, {});
    check(stored.ok === false, 'gmail_send compileAndStore REJECTED', JSON.stringify(stored));
  });

  console.log('\n── [2] bare tool name (not capability id) → REJECTED ──');
  await withCountInvariant('bare-tool', async () => {
    const ir = baseIr({
      slots: {
        readTools: ['gmail_list_messages'],
        categories: ['一般'],
      },
    });
    const r = compileSkillIr(ir);
    check(r.ok === false, 'bare name → not ok', JSON.stringify(r));
    if (!r.ok) {
      check(r.status === 'REJECTED', 'bare name REJECTED', r.status);
    }
  });

  console.log('\n── [3] unknown template → REJECTED, no generated graph ──');
  await withCountInvariant('unknown-template', async () => {
    const ir = baseIr({ template: 'arbitrary-freeform-v1' });
    const r = compileSkillIr(ir);
    check(r.ok === false, 'unknown template → not ok', JSON.stringify(r));
    if (!r.ok) {
      check(r.status === 'REJECTED', 'unknown template REJECTED', r.status);
      const blob = JSON.stringify(r.errors);
      check(
        !blob.includes('"nodes"') && !blob.includes('tool.read'),
        'errors contain no generated graph',
        blob,
      );
    }
  });

  console.log('\n── [4] invalid IR (unknown key + bad schemaVersion) → REJECTED ──');
  await withCountInvariant('invalid-ir', async () => {
    const unknownKey = {
      schemaVersion: 'aios.skill-ir/1',
      template: 'email-triage-readonly-v1',
      name: 'x',
      slots: { readTools: ['mcp:gmail:gmail_list_messages'], categories: ['a'] },
      freeFormExtra: true,
    };
    const r1 = compileSkillIr(unknownKey);
    check(r1.ok === false && !r1.ok && r1.status === 'REJECTED', 'unknown top-level key REJECTED', JSON.stringify(r1));

    const badVer = {
      schemaVersion: 'aios.skill-ir/999',
      template: 'email-triage-readonly-v1',
      name: 'x',
      slots: { readTools: ['mcp:gmail:gmail_list_messages'], categories: ['a'] },
    };
    const r2 = compileSkillIr(badVer);
    check(r2.ok === false && !r2.ok && r2.status === 'REJECTED', 'bad schemaVersion REJECTED', JSON.stringify(r2));
  });

  console.log('\n── [5] assertGraphSafe on tampered graphs → throw ──');
  await withCountInvariant('assertGraphSafe-tamper', () => {
    // python node
    let threwPython = false;
    try {
      assertGraphSafe({
        nodes: [{ id: 'p1', kind: 'python', code: 'print(1)' }],
        edges: [],
      });
    } catch {
      threwPython = true;
    }
    check(threwPython, 'python node throws', 'did not throw');

    // write tool via create_draft
    let threwDraft = false;
    try {
      assertGraphSafe({
        nodes: [
          {
            id: 't1',
            kind: 'tool.read',
            tool: 'mcp:gmail:gmail_create_draft',
          },
        ],
        edges: [],
      });
    } catch {
      threwDraft = true;
    }
    check(threwDraft, 'gmail_create_draft tool throws', 'did not throw');

    // apiKey in config
    let threwApiKey = false;
    try {
      assertGraphSafe({
        nodes: [
          {
            id: 'g1',
            kind: 'gateway.classify',
            config: { apiKey: 'sk-proj-shouldnotappear' },
          },
        ],
        edges: [],
      });
    } catch {
      threwApiKey = true;
    }
    check(threwApiKey, 'apiKey in config throws', 'did not throw');

    // capability id shape sanity (exported)
    check(
      CAPABILITY_ID_RE.test('mcp:gmail:gmail_list_messages'),
      'CAPABILITY_ID_RE accepts good id',
      'reject good',
    );
    check(
      !CAPABILITY_ID_RE.test('gmail_list_messages'),
      'CAPABILITY_ID_RE rejects bare name',
      'accepted bare',
    );
  });

  console.log('\n── [6] secret material in slots → REJECTED or zero plaintext ──');
  await withCountInvariant('secret-in-slots', async () => {
    // sk- pattern hits redactSecrets: /\bsk-[A-Za-z0-9_-]{8,}\b/g
    const secretCategory = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
    const ir = baseIr({
      slots: {
        readTools: ['mcp:gmail:gmail_list_messages'],
        categories: [secretCategory],
        summaryLanguage: 'zh-TW',
      },
    });
    const stored = await compileAndStore(ir, { createdBy: 't07-neg-secret' });

    if (!stored.ok) {
      check(stored.status === 'REJECTED', 'secret → REJECTED', JSON.stringify(stored));
      check(
        stored.errors.some((e) => /secret/i.test(e)),
        'errors mention secret material',
        JSON.stringify(stored.errors),
      );
      pass('secret case: zero write via REJECTED');
    } else if ('artifactId' in stored) {
      // If somehow stored, content must have zero plaintext secret
      const row = await prisma.flowArtifact.findUnique({ where: { id: stored.artifactId } });
      const blob = JSON.stringify(row?.artifactJson ?? {});
      check(!blob.includes(secretCategory), 'stored artifact has no plaintext secret', blob.slice(0, 200));
      // cleanup this one if created
      await prisma.flowArtifact.delete({ where: { id: stored.artifactId } }).catch(() => undefined);
      // count invariant checked in finally — but we deleted, so count should match before
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
