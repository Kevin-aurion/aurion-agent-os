/**
 * Ticket 13 — FDE unified review inbox (negative / fail-closed + reject zero-change).
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t13-review-inbox-negative.test.ts
 *
 * Real DB + Fastify inject. Does NOT modify src/. Does NOT delete AuditLog.
 * Token is signed JWT only (no User row). Agent.createdBy reuses an existing FDE user (FK).
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  createApproval,
  isRunApproved,
} from '../../../src/lib/approval.js';
import { createProposal } from '../../../src/lib/changeproposal.js';
import { proposalRoutes } from '../../../src/routes/proposals.js';
import { approvalRoutes } from '../../../src/routes/approvals.js';

let passed = 0;
let failed = 0;

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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function main(): Promise<void> {
  console.log('── t13-review-inbox-negative ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  if (!owner) {
    fail('setup', 'need existing OWNER/TRAINER user for Agent.createdBy FK');
    console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
    process.exit(1);
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const runId = ulid();
  let proposalId = '';
  let approvalId = '';
  const restrictionsSnap = { shell: false, webSearch: true };

  const memberToken = await signAccess({
    sub: 't13-member',
    email: 't13-member@test.local',
    role: 'MEMBER',
  });
  const trainerToken = await signAccess({
    sub: 't13-trainer',
    email: 't13-trainer@test.local',
    role: 'TRAINER',
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400) {
      return reply.code(anyErr.statusCode).send({
        success: false,
        error: { code: anyErr.code ?? 'ERROR', message: anyErr.message ?? 'error' },
      });
    }
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL', message: String(err) },
    });
  });
  await app.register(proposalRoutes);
  await app.register(approvalRoutes);

  try {
    // ── Setup ────────────────────────────────────────────────────────────
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t13-agent-${tag}`,
        name: `t13-agent-${tag}`,
        description: 't13 negative throwaway',
        rolePrompt: 't13 test agent',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
        riskTier: 'high',
        restrictions: restrictionsSnap,
        systemManaged: false,
      },
    });

    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: 't13-test',
        status: 'AWAITING_REVIEW',
        input: { purpose: 't13-negative' },
        runDir: `/tmp/t13-run-${tag}`,
      },
    });

    const approval = await createApproval({
      runId,
      agentId,
      reason: 't13 high-risk HITL gate',
      payload: { agentId, triggeredBy: 't13-test' },
    });
    approvalId = approval.id;

    const proposal = await createProposal({
      agentId,
      source: 'OPERATOR',
      proposedBy: 't13-member',
      targetType: 'RESTRICTION',
      proposedChange: { shell: true, t13Note: 'x' },
    });
    proposalId = proposal.id;

    const agent0 = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const snap = JSON.stringify(agent0.restrictions);
    check(
      snap === JSON.stringify(restrictionsSnap),
      'setup: restrictions snapshot',
      `got ${snap}`,
    );

    // ── [1] no token → 401 ───────────────────────────────────────────────
    console.log('\n── [1] unauthenticated GETs → 401 ──');
    {
      const rP = await app.inject({ method: 'GET', url: '/api/proposals' });
      check(rP.statusCode === 401, '1a GET /api/proposals no token → 401', `got ${rP.statusCode}`);

      const rA = await app.inject({ method: 'GET', url: '/api/approvals' });
      check(rA.statusCode === 401, '1b GET /api/approvals no token → 401', `got ${rA.statusCode}`);
    }

    // ── [2] MEMBER 全拒（六連發 + DB 零變更）────────────────────────────
    console.log('\n── [2] MEMBER all reject + DB zero change ──');
    {
      const rListP = await app.inject({
        method: 'GET',
        url: '/api/proposals',
        headers: auth(memberToken),
      });
      check(
        rListP.statusCode === 403,
        '2a MEMBER GET /api/proposals → 403',
        `got ${rListP.statusCode}`,
      );

      const rListA = await app.inject({
        method: 'GET',
        url: '/api/approvals',
        headers: auth(memberToken),
      });
      check(
        rListA.statusCode === 403,
        '2b MEMBER GET /api/approvals → 403',
        `got ${rListA.statusCode}`,
      );

      const rApprP = await app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/approve`,
        headers: auth(memberToken),
      });
      check(
        rApprP.statusCode === 403,
        '2c MEMBER POST proposal approve → 403',
        `got ${rApprP.statusCode}`,
      );
      {
        const p = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
        const a = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        check(p.status === 'PENDING', '2c DB proposal still PENDING', `got ${p.status}`);
        check(
          JSON.stringify(a.restrictions) === snap,
          '2c DB agent.restrictions unchanged after MEMBER approve',
          JSON.stringify(a.restrictions),
        );
      }

      const rRejP = await app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/reject`,
        headers: auth(memberToken),
      });
      check(
        rRejP.statusCode === 403,
        '2d MEMBER POST proposal reject → 403',
        `got ${rRejP.statusCode}`,
      );
      {
        const p = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
        check(p.status === 'PENDING', '2d DB proposal still PENDING', `got ${p.status}`);
      }

      const rApprA = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approvalId}/approve`,
        headers: auth(memberToken),
      });
      check(
        rApprA.statusCode === 403,
        '2e MEMBER POST approval approve → 403',
        `got ${rApprA.statusCode}`,
      );
      {
        const ap = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
        const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
        check(ap.status === 'PENDING', '2e DB approval still PENDING', `got ${ap.status}`);
        check(
          run.status === 'AWAITING_REVIEW',
          '2e DB run still AWAITING_REVIEW',
          `got ${run.status}`,
        );
      }

      const rRejA = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approvalId}/reject`,
        headers: auth(memberToken),
      });
      check(
        rRejA.statusCode === 403,
        '2f MEMBER POST approval reject → 403',
        `got ${rRejA.statusCode}`,
      );
      {
        const ap = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
        const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
        check(ap.status === 'PENDING', '2f DB approval still PENDING', `got ${ap.status}`);
        check(
          run.status === 'AWAITING_REVIEW',
          '2f DB run still AWAITING_REVIEW',
          `got ${run.status}`,
        );
      }
    }

    // ── [3] Langflow checkpoint 不是核准（票 13 不變量）────────────────
    // Runtime/Langflow 側任何「已核准」訊號都不改變 DB；
    // isRunApproved 只認 DB 的 APPROVED ApprovalRequest 列（fail-closed）。
    console.log('\n── [3] Langflow checkpoint is NOT approval (DB-only isRunApproved) ──');
    {
      const pendingOk = (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } }))
        .status === 'PENDING';
      check(pendingOk, '3 pre: approval still PENDING', 'expected PENDING');

      const a = await isRunApproved(runId);
      check(a === false, '3a isRunApproved(runId) while PENDING → false', `got ${a}`);

      const b = await isRunApproved(runId, '假的-approval-id');
      check(
        b === false,
        '3b isRunApproved(runId, fake-id) → false',
        `got ${b}`,
      );
    }

    // ── [4] FDE 駁回提案 → 目標物零變更 + audit hash ────────────────────
    console.log('\n── [4] trainer reject proposal → zero target change + audit ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/reject`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '4a trainer reject proposal → 200', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);

      const p = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
      check(p.status === 'REJECTED', '4b proposal status REJECTED', `got ${p.status}`);
      check(p.resultingVersionId === null, '4c resultingVersionId null', `got ${p.resultingVersionId}`);
      check(p.decidedBy === 't13-trainer', '4d decidedBy t13-trainer', `got ${p.decidedBy}`);

      const a = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      check(
        JSON.stringify(a.restrictions) === snap,
        '4e agent.restrictions === snapshot (zero change)',
        JSON.stringify(a.restrictions),
      );

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          entity: 'ChangeProposal',
          entityId: proposalId,
          action: 'proposal.rejected',
        },
        orderBy: { createdAt: 'desc' },
      });
      check(!!auditRow, '4f AuditLog proposal.rejected exists', 'not found');
      check(
        !!auditRow?.hash,
        '4g AuditLog hash non-null (chain evidence)',
        `hash=${auditRow?.hash ?? 'null'}`,
      );
    }

    // ── [5] FDE 駁回執行核准 ────────────────────────────────────────────
    console.log('\n── [5] trainer reject approval → CANCELLED + audit ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approvalId}/reject`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '5a trainer reject approval → 200', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);

      let bodyStatus: string | undefined;
      try {
        const body = JSON.parse(r.body) as { success?: boolean; data?: { status?: string } };
        bodyStatus = body.data?.status;
      } catch {
        bodyStatus = undefined;
      }
      check(bodyStatus === 'CANCELLED', "5b body data.status === 'CANCELLED'", `got ${bodyStatus}`);

      const ap = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
      // decideApproval(false) writes REJECTED on the ApprovalRequest row
      check(ap.status === 'REJECTED', '5c DB approval REJECTED', `got ${ap.status}`);

      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      check(run.status === 'CANCELLED', '5d DB run CANCELLED', `got ${run.status}`);

      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      check(
        JSON.stringify(agent.restrictions) === snap,
        '5e agent.restrictions still snapshot',
        JSON.stringify(agent.restrictions),
      );

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          entity: 'ApprovalRequest',
          entityId: approvalId,
          action: 'approval.rejected',
        },
        orderBy: { createdAt: 'desc' },
      });
      check(!!auditRow, '5f AuditLog approval.rejected exists', 'not found');
      check(
        !!auditRow?.hash,
        '5g AuditLog hash non-null',
        `hash=${auditRow?.hash ?? 'null'}`,
      );
    }

    // ── [6] 重複決策 → 409 ──────────────────────────────────────────────
    console.log('\n── [6] double reject proposal → 409, DB unchanged ──');
    {
      const before = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
      const beforeJson = JSON.stringify({
        status: before.status,
        decidedBy: before.decidedBy,
        resultingVersionId: before.resultingVersionId,
        decidedAt: before.decidedAt?.toISOString() ?? null,
      });

      const r = await app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/reject`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 409, '6a second reject → 409', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);

      const after = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
      const afterJson = JSON.stringify({
        status: after.status,
        decidedBy: after.decidedBy,
        resultingVersionId: after.resultingVersionId,
        decidedAt: after.decidedAt?.toISOString() ?? null,
      });
      check(afterJson === beforeJson, '6b DB proposal unchanged on conflict', `before=${beforeJson} after=${afterJson}`);
    }
  } finally {
    // Cleanup: only rows created by this test. NEVER delete AuditLog (append-only chain).
    try {
      if (proposalId) {
        await prisma.changeProposal.deleteMany({ where: { id: proposalId } });
      }
      // Also delete any stray proposals on this agent (safety)
      await prisma.changeProposal.deleteMany({ where: { agentId } });
      if (approvalId) {
        await prisma.approvalRequest.deleteMany({ where: { id: approvalId } });
      }
      await prisma.approvalRequest.deleteMany({ where: { agentId } });
      await prisma.run.deleteMany({ where: { id: runId } });
      await prisma.agent.deleteMany({ where: { id: agentId } });
    } catch (e) {
      console.error('cleanup error:', e instanceof Error ? e.message : e);
    }
    await app.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => {});
});
