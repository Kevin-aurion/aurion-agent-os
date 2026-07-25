/**
 * Ticket 06 — semantic overstep review on the verify gate.
 * Run: npx tsx .scratch/agent-training-governance/tests/t06.test.ts
 *
 * Seams:
 * 1. parseOverstep pure function
 * 2. HIGH → SEMANTIC proposal; LOW/NONE → no proposal
 * 3. no identityCard → no proposal
 * 4. isApproved behaviour unchanged (fail-closed)
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { isApproved } from '../../../src/engine/codex.js';
import { parseOverstep, applySemanticOverstepReview } from '../../../src/engine/runner.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER user');

  const tag = ulid().slice(-8).toLowerCase();
  const agentWithCard = ulid();
  const agentNoCard = ulid();
  const agentIds = [agentWithCard, agentNoCard];

  console.log('── setup: agents ──');
  await prisma.agent.create({
    data: {
      id: agentWithCard,
      slug: `t06-card-${tag}`,
      name: 'T06 With Identity Card',
      description: 'temp t06',
      rolePrompt: 'sales assistant',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
      identityCard: {
        oneLiner: '客服助理',
        purpose: '回答產品問題',
        canDo: ['答詢', '查詢訂單'],
        cannotDo: ['承諾折扣', '退款'],
        servedAudience: '客戶',
        exampleCommands: ['訂單進度？'],
      },
    },
  });
  await prisma.agent.create({
    data: {
      id: agentNoCard,
      slug: `t06-nocard-${tag}`,
      name: 'T06 No Identity Card',
      description: 'temp t06',
      rolePrompt: 'generic',
      engineExecute: 'CLAUDE_CODE',
      createdBy: owner.id,
      riskTier: 'low',
      // identityCard left null
    },
  });

  try {
    // ── [1] parseOverstep ────────────────────────────────────────────────
    console.log('\n── [1] parseOverstep ──');
    const high = parseOverstep('## Verdict\nAPPROVED\n\n## Overstep\nHIGH — 擅自承諾折扣');
    console.log('HIGH parse:', high);
    assert(high.level === 'HIGH', `expected HIGH, got ${high.level}`);
    assert(
      typeof high.reason === 'string' && high.reason.includes('折扣'),
      `reason should mention 折扣, got ${high.reason}`,
    );

    const none = parseOverstep('## Verdict\nAPPROVED\n\n## Overstep\nNONE — 未越權');
    assert(none.level === 'NONE', `expected NONE, got ${none.level}`);

    const low = parseOverstep('## Overstep\nLOW — 語氣略強硬');
    assert(low.level === 'LOW', `expected LOW, got ${low.level}`);

    const missing = parseOverstep('## Verdict\nAPPROVED\n\nLooks fine.');
    assert(missing.level !== 'HIGH', 'missing Overstep section must not be HIGH');
    assert(missing.level === 'UNKNOWN', `missing → UNKNOWN, got ${missing.level}`);

    const issuesHigh = parseOverstep(
      '## Verdict\nISSUES FOUND\n\n## Overstep\nHIGH — 超出 cannotDo',
    );
    assert(issuesHigh.level === 'HIGH', 'HIGH still parsed after ISSUES FOUND');
    console.log('PASS [1] parseOverstep');

    // ── [2] HIGH → SEMANTIC proposal; LOW/NONE → no ──────────────────────
    console.log('\n── [2] HIGH creates SEMANTIC; LOW/NONE do not ──');
    const runHigh = ulid();
    const runLow = ulid();
    const runNone = ulid();

    await applySemanticOverstepReview({
      agentId: agentWithCard,
      runId: runHigh,
      verdictText: '## Verdict\nAPPROVED\n\n## Overstep\nHIGH — 擅自承諾折扣',
      identityCard: {
        oneLiner: '客服助理',
        purpose: '回答產品問題',
        canDo: ['答詢'],
        cannotDo: ['承諾折扣'],
        servedAudience: '客戶',
        exampleCommands: ['hi'],
      },
    });
    await applySemanticOverstepReview({
      agentId: agentWithCard,
      runId: runLow,
      verdictText: '## Overstep\nLOW — minor tone',
      identityCard: {
        oneLiner: '客服助理',
        purpose: '回答產品問題',
        canDo: ['答詢'],
        cannotDo: ['承諾折扣'],
        servedAudience: '客戶',
        exampleCommands: ['hi'],
      },
    });
    await applySemanticOverstepReview({
      agentId: agentWithCard,
      runId: runNone,
      verdictText: '## Overstep\nNONE',
      identityCard: {
        oneLiner: '客服助理',
        purpose: '回答產品問題',
        canDo: ['答詢'],
        cannotDo: ['承諾折扣'],
        servedAudience: '客戶',
        exampleCommands: ['hi'],
      },
    });

    const highProps = await prisma.changeProposal.findMany({
      where: { agentId: agentWithCard, runId: runHigh, source: 'SEMANTIC' },
    });
    console.log('HIGH proposals:', highProps.length, highProps[0]?.proposedChange);
    assert(highProps.length === 1, `HIGH → 1 SEMANTIC proposal, got ${highProps.length}`);
    assert(highProps[0]!.status === 'PENDING', 'PENDING');
    assert(highProps[0]!.severity === 'high', 'severity high');
    assert(highProps[0]!.confidence === 0.8, `confidence 0.8, got ${highProps[0]!.confidence}`);
    assert(
      highProps[0]!.targetType === 'IDENTITY_CARD' || highProps[0]!.targetType === 'RESTRICTION',
      'targetType IDENTITY_CARD|RESTRICTION',
    );
    const change = highProps[0]!.proposedChange as { overstep?: string };
    assert(typeof change.overstep === 'string' && change.overstep.length > 0, 'overstep reason stored');

    const lowProps = await prisma.changeProposal.findMany({
      where: { agentId: agentWithCard, runId: runLow, source: 'SEMANTIC' },
    });
    const noneProps = await prisma.changeProposal.findMany({
      where: { agentId: agentWithCard, runId: runNone, source: 'SEMANTIC' },
    });
    assert(lowProps.length === 0, `LOW must not create proposal, got ${lowProps.length}`);
    assert(noneProps.length === 0, `NONE must not create proposal, got ${noneProps.length}`);
    console.log('PASS [2] HIGH only creates SEMANTIC proposal');

    // ── [3] no identityCard → no proposal even on HIGH text ──────────────
    console.log('\n── [3] no identityCard → no proposal ──');
    const runNoCard = ulid();
    await applySemanticOverstepReview({
      agentId: agentNoCard,
      runId: runNoCard,
      verdictText: '## Overstep\nHIGH — would overstep if card existed',
      identityCard: null,
    });
    await applySemanticOverstepReview({
      agentId: agentNoCard,
      runId: runNoCard,
      verdictText: '## Overstep\nHIGH — would overstep if card existed',
      identityCard: undefined,
    });
    const noCardProps = await prisma.changeProposal.findMany({
      where: { agentId: agentNoCard, source: 'SEMANTIC' },
    });
    assert(noCardProps.length === 0, `no card → 0 proposals, got ${noCardProps.length}`);
    console.log('PASS [3] no identityCard skips proposal');

    // ── [4] isApproved zero-change regression ────────────────────────────
    console.log('\n── [4] isApproved fail-closed unchanged ──');
    assert(
      isApproved('## Verdict\nAPPROVED\n') === true,
      'standard APPROVED',
    );
    assert(
      isApproved('## Verdict\nAPPROVED\n\n## Overstep\nHIGH — x') === true,
      'APPROVED with trailing Overstep still approved (Overstep must not flip verdict)',
    );
    assert(
      isApproved('## Verdict\nISSUES FOUND\n') === false,
      'ISSUES FOUND rejected',
    );
    assert(
      isApproved('## Verdict\nISSUES FOUND\n\n## Overstep\nNONE') === false,
      'ISSUES FOUND + Overstep still rejected',
    );
    // REJECTED_RE before APPROVED_RE: issues wording anywhere wins
    assert(
      isApproved('ISSUES FOUND\n## Verdict\nAPPROVED\n') === false,
      'ISSUES FOUND anywhere → not approved (fail-closed)',
    );
    assert(
      isApproved('I think this is APPROVED overall') === false,
      'mid-sentence APPROVED does not count',
    );
    assert(
      isApproved('Looks good.\n\nAPPROVED') === true,
      'bare last-line APPROVED fallback',
    );
    assert(
      isApproved('## Verdict\nAPPROVED (or) ISSUES FOUND\n') === false,
      'template echo must not approve',
    );
    console.log('PASS [4] isApproved unchanged');

    console.log('\n══ ALL t06 TESTS PASSED ══');
  } finally {
    console.log('\n── cleanup ──');
    try {
      await prisma.changeProposal.deleteMany({ where: { agentId: { in: agentIds } } });
    } catch {
      /* ignore */
    }
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('\nTEST FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
