// Dashboard summary, recent runs, audit log, and org/user-management endpoints.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { hub } from '../ws/hub.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/summary', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const [
        agentsActive,
        skillsByReview,
        workflowsEnabled,
        runsTodayByStatus,
        accountsByProviderStatus,
      ] = await Promise.all([
        prisma.agent.count({ where: { status: 'ACTIVE', deletedAt: null } }),
        prisma.skill.groupBy({
          by: ['reviewStatus'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.workflow.count({ where: { enabled: true, deletedAt: null } }),
        prisma.run.groupBy({
          by: ['status'],
          where: { startedAt: { gte: startOfDay } },
          _count: { _all: true },
        }),
        prisma.connectedAccount.groupBy({
          by: ['provider', 'status'],
          _count: { _all: true },
        }),
      ]);

      return reply.send(
        ok({
          agents: { active: agentsActive },
          skills: Object.fromEntries(skillsByReview.map((s) => [s.reviewStatus, s._count._all])),
          workflows: { enabled: workflowsEnabled },
          runsToday: Object.fromEntries(runsTodayByStatus.map((r) => [r.status, r._count._all])),
          connectedAccounts: accountsByProviderStatus.map((a) => ({
            provider: a.provider,
            status: a.status,
            count: a._count._all,
          })),
          wsConnections: hub.connectionCount,
        }),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/api/dashboard/recent-runs',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const runs = await prisma.run.findMany({
          take: limit,
          orderBy: { startedAt: 'desc' },
          include: { agent: { select: { id: true, name: true, slug: true } } },
        });
        return reply.send(
          ok(
            runs.map((r) => ({
              id: r.id,
              status: r.status,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              triggeredBy: r.triggeredBy,
              workflowId: r.workflowId,
              agent: r.agent ? { id: r.agent.id, name: r.agent.name, slug: r.agent.slug } : null,
            })),
          ),
        );
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/audit',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const rows = await prisma.auditLog.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' },
        });
        return reply.send(ok(rows));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // ── Org chart: owner / trainers / members + agents grouped by department ──
  app.get('/api/org', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const [users, agents] = await Promise.all([
        prisma.user.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, displayName: true, email: true, role: true },
        }),
        prisma.agent.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: { _count: { select: { skills: true, workflows: { where: { deletedAt: null } } } } },
        }),
      ]);

      const owner = users.find((u) => u.role === 'OWNER') ?? null;
      const trainers = users.filter((u) => u.role === 'OWNER' || u.role === 'TRAINER');
      const members = users.filter((u) => u.role === 'MEMBER');

      const byDept = new Map<
        string,
        { name: string; agents: { id: string; name: string; description: string; status: string; skillCount: number; workflowCount: number; department: string }[] }
      >();
      for (const a of agents) {
        const deptName = a.department || '未分類';
        if (!byDept.has(deptName)) byDept.set(deptName, { name: deptName, agents: [] });
        byDept.get(deptName)!.agents.push({
          id: a.id,
          name: a.name,
          description: a.description,
          status: a.status,
          skillCount: a._count.skills,
          workflowCount: a._count.workflows,
          department: deptName,
        });
      }

      return ok({
        owner: owner ? { id: owner.id, displayName: owner.displayName, email: owner.email } : null,
        trainers: trainers.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, role: u.role })),
        members: members.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, role: u.role })),
        departments: Array.from(byDept.values()),
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── OWNER-only user management ─────────────────────────────────────────────
  app.get('/api/users', { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.user!.role !== 'OWNER') throw errors.forbidden('僅限 OWNER 操作');
      const users = await prisma.user.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, displayName: true, email: true, role: true },
      });
      return ok(users);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.patch('/api/users/:id/role', { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (req.user!.role !== 'OWNER') throw errors.forbidden('僅限 OWNER 操作');
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const body = z.object({ role: z.enum(['TRAINER', 'MEMBER']) }).parse(req.body);

      const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw errors.notFound('User not found');
      if (existing.role === 'OWNER') throw errors.forbidden('不可變更 OWNER 的角色');

      const updated = await prisma.user.update({
        where: { id },
        data: { role: body.role },
        select: { id: true, displayName: true, email: true, role: true },
      });
      await audit(req.user!.sub, 'user.role_changed', 'User', id, { role: body.role });
      return ok(updated);
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
