/**
 * Ticket 07 — Skill IR Compiler (positive / deterministic).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t07-compiler-deterministic.test.ts
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

const FORBIDDEN_KIND_SUBSTR = ['send', 'python', 'filesystem'] as const;

function makeIr(slots: Record<string, unknown>, name: string) {
  return {
    schemaVersion: 'aios.skill-ir/1' as const,
    template: 'email-triage-readonly-v1',
    name,
    description: 't07 positive',
    slots,
  };
}

function extractNodes(artifactJson: unknown): Array<Record<string, unknown>> {
  if (!artifactJson || typeof artifactJson !== 'object') return [];
  const nodes = (artifactJson as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => n && typeof n === 'object') as Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const createdIds: string[] = [];

  try {
    const complaintSlots = {
      readTools: ['mcp:gmail:gmail_list_messages', 'mcp:gmail:gmail_get_message'],
      categories: ['客訴', 'urgent'],
      summaryLanguage: 'zh-TW' as const,
      query: 'is:unread label:inbox',
    };
    const quotationSlots = {
      readTools: ['mcp:gmail:gmail_list_messages'],
      categories: ['詢價', 'quotation'],
      summaryLanguage: 'en' as const,
    };

    const complaintIr = makeIr(complaintSlots, 'email-triage-complaint');
    const quotationIr = makeIr(quotationSlots, 'email-triage-quotation');

    console.log('── [1] compile complaint + quotation (success, digests differ) ──');
    const c1 = compileSkillIr(complaintIr);
    const q1 = compileSkillIr(quotationIr);
    check(c1.ok === true, 'complaint compile ok', `got ${JSON.stringify(c1)}`);
    check(q1.ok === true, 'quotation compile ok', `got ${JSON.stringify(q1)}`);
    if (c1.ok && q1.ok) {
      check(
        c1.digest !== q1.digest,
        'complaint vs quotation digests differ',
        `c=${c1.digest} q=${q1.digest}`,
      );
      check(c1.template === 'email-triage-readonly-v1', 'complaint template id', c1.template);
      check(c1.compilerVersion === 'aios-compiler/1', 'compilerVersion', c1.compilerVersion);
      check(!!c1.templateVersion, 'templateVersion present', String(c1.templateVersion));
    }

    console.log('\n── [2] deterministic digest (repeat + scrambled slot keys) ──');
    if (c1.ok) {
      const c2 = compileSkillIr(complaintIr);
      check(c2.ok === true && c2.ok && c2.digest === c1.digest, 'same IR → same digest', '');
      if (c2.ok) {
        check(c2.digest === c1.digest, 'repeat compile identical digest', `a=${c1.digest} b=${c2.digest}`);
      }

      // Scramble top-level IR key order and nested slots key order
      const scrambled = {
        slots: {
          query: complaintSlots.query,
          summaryLanguage: complaintSlots.summaryLanguage,
          categories: [...complaintSlots.categories],
          readTools: [...complaintSlots.readTools],
        },
        description: 't07 positive',
        name: 'email-triage-complaint',
        template: 'email-triage-readonly-v1',
        schemaVersion: 'aios.skill-ir/1' as const,
      };
      const c3 = compileSkillIr(scrambled);
      check(c3.ok === true, 'scrambled keys compile ok', JSON.stringify(c3));
      if (c3.ok) {
        check(
          c3.digest === c1.digest,
          'scrambled slot/IR keys → same digest (canonical)',
          `a=${c1.digest} b=${c3.digest}`,
        );
      }
    }

    console.log('\n── [3] artifactJson structure (allowlist + capability ids) ──');
    if (c1.ok) {
      const nodes = extractNodes(c1.artifactJson);
      check(nodes.length > 0, 'artifactJson has nodes array', `len=${nodes.length}`);

      const kinds = nodes.map((n) => String(n.kind ?? ''));
      const allAllowed = kinds.every((k) => ALLOWED_KINDS.has(k));
      check(allAllowed, 'all node kinds in allowlist', `kinds=${kinds.join(',')}`);

      for (const sub of FORBIDDEN_KIND_SUBSTR) {
        const bad = kinds.some((k) => k === sub || k.includes(sub));
        // allow gateway.* etc.; only flag exact forbidden kinds or kind that IS those words
        // Spec: 不存在 send/python/filesystem 字樣的 node kind
        const hasForbiddenKind = kinds.some((k) => {
          const lower = k.toLowerCase();
          // "gateway.summarize" contains neither as a kind token; check whole kind equality or path segment
          return lower === sub || lower.split(/[._-]/).includes(sub);
        });
        check(!hasForbiddenKind, `no node kind with ${sub}`, `kinds=${kinds.join(',')}`);
      }

      const toolNodes = nodes.filter((n) => n.kind === 'tool.read');
      check(toolNodes.length >= 1, 'has tool.read nodes', `count=${toolNodes.length}`);
      const toolsOk = toolNodes.every((n) => {
        const tool = String(n.tool ?? '');
        return CAPABILITY_ID_RE.test(tool);
      });
      check(toolsOk, 'all tool.read tools match CAPABILITY_ID_RE', JSON.stringify(toolNodes.map((n) => n.tool)));

      // Fixed pipeline shape
      check(kinds.includes('input'), 'has input node', kinds.join(','));
      check(kinds.includes('gateway.classify'), 'has gateway.classify', kinds.join(','));
      check(kinds.includes('gateway.summarize'), 'has gateway.summarize', kinds.join(','));
      check(kinds.includes('gateway.verify'), 'has gateway.verify', kinds.join(','));
      check(kinds.includes('output'), 'has output node', kinds.join(','));
    }

    console.log('\n── [4] compileAndStore create + content-addressed reuse ──');
    const store1 = await compileAndStore(complaintIr, { createdBy: 't07-test' });
    check(store1.ok === true, 'compileAndStore first ok', JSON.stringify(store1));
    if (store1.ok && 'artifactId' in store1) {
      createdIds.push(store1.artifactId);
      check(store1.reused === false, 'first store reused=false', `got ${store1.reused}`);
      check(
        store1.storedDigest === store1.digest,
        'storedDigest === digest',
        `stored=${store1.storedDigest} digest=${store1.digest}`,
      );

      const store2 = await compileAndStore(complaintIr, { createdBy: 't07-test' });
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

      console.log('\n── [5] getVerifiedFlowArtifact ──');
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
