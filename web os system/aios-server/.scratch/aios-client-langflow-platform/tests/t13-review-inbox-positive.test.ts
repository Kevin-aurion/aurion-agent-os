/**
 * Ticket 13 — FDE unified review inbox (positive / persistence).
 *
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t13-review-inbox-positive.test.ts
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
  decideApproval,
  isRunApproved,
} from '../../../src/lib/approval.js';
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
  console.log('── t13-review-inbox-positive ──');

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
  const initialRestrictions = {
    shell: false,
    webSearch: true,
    computerUse: false,
    sendEmail: false,
    cloudWrite: false,
  };

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
    // ── Setup throwaway agent / run / PENDING approval ───────────────────
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t13p-agent-${tag}`,
        name: `t13p-agent-${tag}`,
        description: 't13 positive throwaway',
        rolePrompt: 't13p test agent',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
        riskTier: 'high',
        restrictions: initialRestrictions,
        systemManaged: false,
      },
    });

    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: 't13p-test',
        status: 'AWAITING_REVIEW',
        input: { purpose: 't13-positive' },
        runDir: `/tmp/t13p-run-${tag}`,
      },
    });

    const approval = await createApproval({
      runId,
      agentId,
      reason: 't13p HITL gate',
      payload: { agentId, triggeredBy: 't13p-test' },
    });
    approvalId = approval.id;

    // ── [1] MEMBER 可提案（角色範圍不變）────────────────────────────────
    console.log('\n── [1] MEMBER can create proposal ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/proposals`,
        headers: auth(memberToken),
        payload: {
          targetType: 'RESTRICTION',
          proposedChange: { webSearch: false, t13pFlag: true },
        },
      });
      check(r.statusCode === 200, '1a MEMBER POST proposal → 200', `got ${r.statusCode} body=${r.body.slice(0, 240)}`);

      let data: {
        id?: string;
        status?: string;
        source?: string;
        proposedBy?: string;
      } = {};
      try {
        const body = JSON.parse(r.body) as { success?: boolean; data?: typeof data };
        data = body.data ?? {};
      } catch {
        /* ignore */
      }
      proposalId = data.id ?? '';
      check(data.status === 'PENDING', '1b status PENDING', `got ${data.status}`);
      check(data.source === 'OPERATOR', '1c source OPERATOR', `got ${data.source}`);
      check(
        data.proposedBy === 't13-member',
        "1d proposedBy === 't13-member'",
        `got ${data.proposedBy}`,
      );
      check(!!proposalId, '1e proposal id returned', 'missing id');
    }

    // ── [2] FDE 收件匣看得到真資料 ──────────────────────────────────────
    console.log('\n── [2] trainer inbox lists proposal + approval ──');
    {
      const rP = await app.inject({
        method: 'GET',
        url: '/api/proposals',
        headers: auth(trainerToken),
      });
      check(rP.statusCode === 200, '2a trainer GET /api/proposals → 200', `got ${rP.statusCode}`);
      let listP: Array<{ id: string }> = [];
      try {
        const body = JSON.parse(rP.body) as { data?: Array<{ id: string }> };
        listP = body.data ?? [];
      } catch {
        /* ignore */
      }
      check(
        listP.some((p) => p.id === proposalId),
        '2b proposals list contains step-1 proposal',
        `ids=${listP.map((p) => p.id).slice(0, 5).join(',')}`,
      );

      const rA = await app.inject({
        method: 'GET',
        url: '/api/approvals',
        headers: auth(trainerToken),
      });
      check(rA.statusCode === 200, '2c trainer GET /api/approvals → 200', `got ${rA.statusCode}`);
      let listA: Array<{ id: string }> = [];
      try {
        const body = JSON.parse(rA.body) as { data?: Array<{ id: string }> };
        listA = body.data ?? [];
      } catch {
        /* ignore */
      }
      check(
        listA.some((a) => a.id === approvalId),
        '2d approvals list contains setup PENDING approval',
        `ids=${listA.map((a) => a.id).slice(0, 5).join(',')}`,
      );
    }

    // ── [3] FDE 核准 RESTRICTION（DB merge 生效）────────────────────────
    console.log('\n── [3] trainer approve RESTRICTION → merge + audit ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/approve`,
        headers: auth(trainerToken),
      });
      check(r.statusCode === 200, '3a trainer approve → 200', `got ${r.statusCode} body=${r.body.slice(0, 240)}`);

      const p = await prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } });
      check(p.status === 'APPROVED', '3b proposal APPROVED', `got ${p.status}`);
      check(p.decidedBy === 't13-trainer', '3c decidedBy t13-trainer', `got ${p.decidedBy}`);

      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const rest = (agent.restrictions ?? {}) as Record<string, unknown>;
      check(rest.webSearch === false, '3d restrictions.webSearch === false', `got ${String(rest.webSearch)}`);
      check(rest.t13pFlag === true, '3e restrictions.t13pFlag === true', `got ${String(rest.t13pFlag)}`);

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          entity: 'ChangeProposal',
          entityId: proposalId,
          action: 'proposal.approved',
        },
        orderBy: { createdAt: 'desc' },
      });
      check(!!auditRow, '3f AuditLog proposal.approved exists', 'not found');
      check(
        !!auditRow?.hash,
        '3g AuditLog hash non-null',
        `hash=${auditRow?.hash ?? 'null'}`,
      );
    }

    // ── [4] FDE 核准執行核准 — 用 lib，不用 route ───────────────────────
    // Route POST /api/approvals/:id/approve calls decideApproval then runAgent
    // with resumeToken — that would really resume the run and burn engine cost.
    // Test layer only validates decision persistence via decideApproval().
    console.log('\n── [4] decideApproval(true) persistence (lib only, no engine) ──');
    {
      await decideApproval(approvalId, true, 't13-trainer');

      const approved = await isRunApproved(runId);
      check(approved === true, '4a isRunApproved(runId) === true', `got ${approved}`);

      const ap = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
      check(ap.status === 'APPROVED', '4b DB approval APPROVED', `got ${ap.status}`);
      check(ap.decidedBy === 't13-trainer', '4c decidedBy t13-trainer', `got ${ap.decidedBy}`);
    }
  } finally {
    // Cleanup: only rows created by this test. NEVER delete AuditLog.
    try {
      if (proposalId) {
        await prisma.changeProposal.deleteMany({ where: { id: proposalId } });
      }
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
