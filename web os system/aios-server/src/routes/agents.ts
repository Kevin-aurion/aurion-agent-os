import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { hub } from '../ws/hub.js';
import { slugify } from '../lib/slug.js';
import { buildAgentSkillCatalog } from '../lib/skillmanifest.js';
import {
  isBuilderAgentReleased,
  rejectUnreleasedBuilderAgents,
} from '../lib/builderrelease.js';

const EngineEnum = z.enum(['CLAUDE_CODE', 'CODEX', 'GROK']);

// 能力限制（詳見 engine/restrictions.ts；未提供的欄位採安全預設）
const RestrictionsSchema = z
  .object({
    webSearch: z.boolean().optional(),
    computerUse: z.boolean().optional(),
    sendEmail: z.boolean().optional(),
    cloudWrite: z.boolean().optional(),
    shell: z.boolean().optional(),
    cloudEmbedding: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
  })
  .optional();

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  department: z.string().min(1).optional(),
  avatar: z.string().optional(),
  rolePrompt: z.string().min(1),
  engineExecute: EngineEnum.optional(),
  engineVerify: EngineEnum.nullable().optional(), // null = 自動（與執行引擎相反）
  restrictions: RestrictionsSchema,
  maxRounds: z.number().int().positive().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  avatar: z.string().nullable().optional(),
  rolePrompt: z.string().min(1).optional(),
  engineExecute: EngineEnum.optional(),
  engineVerify: EngineEnum.nullable().optional(),
  restrictions: RestrictionsSchema,
  maxRounds: z.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
});

const addSkillSchema = z.object({
  skillId: z.string().min(1),
});

const fileTargetsSchema = z.object({
  targets: z.array(
    z.object({
      cloudFileRefId: z.string().min(1),
      purpose: z.string().optional(),
    }),
  ),
});

const listQuerySchema = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
});

export async function agentRoutes(app: FastifyInstance) {
  // List non-deleted agents with counts.
  app.get('/api/agents', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const query = listQuerySchema.parse(req.query);
      if (
        query.scope === 'all' &&
        (req.user!.scope || !['OWNER', 'TRAINER'].includes(req.user!.role))
      ) {
        throw errors.forbidden('Only an unscoped FDE session may list all Agents');
      }
      const agents = await prisma.agent.findMany({
        where: {
          deletedAt: null,
          // Infrastructure agents are operated only by their dedicated admin
          // surfaces and must never appear as selectable workbench employees.
          systemManaged: false,
          ...(query.scope === 'mine' ? { createdBy: req.user!.sub } : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { skills: true, workflows: { where: { deletedAt: null } } } },
        },
      });
      const visible = await rejectUnreleasedBuilderAgents(agents);
      return ok(
        visible.map((a) => ({
          ...a,
          skillCount: a._count.skills,
          workflowCount: a._count.workflows,
          _count: undefined,
        })),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Create a new agent.
  app.post('/api/agents', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const body = createSchema.parse(req.body);
      const agent = await prisma.agent.create({
        data: {
          id: ulid(),
          slug: slugify(body.name),
          name: body.name,
          description: body.description,
          department: body.department ?? undefined,
          avatar: body.avatar,
          rolePrompt: body.rolePrompt,
          engineExecute: body.engineExecute ?? undefined,
          engineVerify: body.engineVerify ?? undefined,
          restrictions: body.restrictions ?? undefined,
          maxRounds: body.maxRounds ?? undefined,
          createdBy: req.user!.sub,
        },
      });
      await audit(req.user!.sub, 'agent.created', 'Agent', agent.id, { name: agent.name });
      hub.publish('agent.status', { id: agent.id, status: agent.status, event: 'created' });
      return ok(agent);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Compose a full AI employee from natural language (async blueprint + fan-out).
  app.post('/api/agents/compose', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const body = z
        .object({
          requirement: z.string().min(1),
          engine: EngineEnum.default('CLAUDE_CODE'),
        })
        .parse(req.body);

      const { composeAgentFromRequirement } = await import('../agents/compose.js');
      const { agentId } = await composeAgentFromRequirement({
        requirement: body.requirement,
        engine: body.engine,
        createdBy: req.user!.sub,
      });
      await audit(req.user!.sub, 'agent.compose', 'Agent', agentId, { engine: body.engine });
      hub.publish('agent.status', { id: agentId, status: 'ACTIVE', event: 'created' });
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      return ok({ ...agent, composing: true });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Agent detail incl. skills, fileTargets, workflows.
  app.get('/api/agents/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const query = listQuerySchema.parse(req.query);
      if (
        query.scope === 'all' &&
        (req.user!.scope || !['OWNER', 'TRAINER'].includes(req.user!.role))
      ) {
        throw errors.forbidden('Only an unscoped FDE session may read Agents across accounts');
      }
      const agent = await prisma.agent.findFirst({
        where: {
          id,
          deletedAt: null,
          systemManaged: false,
          ...(query.scope === 'mine' ? { createdBy: req.user!.sub } : {}),
        },
        include: {
          skills: { include: { skill: true } },
          fileTargets: { include: { cloudFileRef: true } },
          workflows: { select: { id: true, name: true, enabled: true } },
        },
      });
      if (!agent) throw errors.notFound('Agent not found');
      if (!(await isBuilderAgentReleased(agent.id))) throw errors.notFound('Agent not found');
      return ok(agent);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Update editable fields.
  app.patch('/api/agents/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = updateSchema.parse(req.body);
      const existing = await prisma.agent.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw errors.notFound('Agent not found');
      // Builder advisor (slug aios-agent-builder-advisor) is systemManaged, so
      // this PATCH cannot update its rolePrompt. V2-3 persona sync is DB→file
      // inside ensureBuilderAdvisor (src/lib/agentbuilder.ts), not this route.
      if (existing.systemManaged) throw errors.forbidden('系統管理 Agent 不可由一般編輯端修改');
      const agent = await prisma.agent.update({
        where: { id },
        data: body,
      });
      await audit(req.user!.sub, 'agent.updated', 'Agent', agent.id, body);
      hub.publish('agent.status', { id: agent.id, status: agent.status, event: 'updated' });
      return ok(agent);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Soft delete.
  app.delete('/api/agents/:id', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const existing = await prisma.agent.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw errors.notFound('Agent not found');
      if (existing.systemManaged) throw errors.forbidden('系統管理 Agent 不可刪除');
      const agent = await prisma.agent.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit(req.user!.sub, 'agent.deleted', 'Agent', agent.id);
      hub.publish('agent.status', { id: agent.id, status: agent.status, event: 'deleted' });
      return ok({ id: agent.id });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Attach a confirmed skill to an agent.
  app.post('/api/agents/:id/skills', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = addSkillSchema.parse(req.body);
      const agent = await prisma.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw errors.notFound('Agent not found');
      const skill = await prisma.skill.findFirst({ where: { id: body.skillId, deletedAt: null } });
      if (!skill) throw errors.notFound('Skill not found');
      if (skill.reviewStatus !== 'CONFIRMED') throw errors.conflict('skill not confirmed');

      // Idempotent if already linked (pre-linked RECORDED/training drafts).
      const existingLink = await prisma.agentSkill.findUnique({
        where: { agentId_skillId: { agentId: id, skillId: body.skillId } },
      });
      if (existingLink) {
        // Still enforce CODEX if this agent holds a RECORDED/CC skill (fail-closed).
        if (
          (skill.origin === 'RECORDED' || skill.kind === 'COMPUTER_CONTROL') &&
          agent.engineExecute !== 'CODEX'
        ) {
          throw errors.badRequest(
            '此類技能只能由 CODEX 引擎驅動，請將員工主引擎改為 CODEX',
          );
        }
        return ok(existingLink);
      }

      // Recorded / computer-control skills require CODEX as the execute engine (ADR 0005).
      if (
        (skill.origin === 'RECORDED' || skill.kind === 'COMPUTER_CONTROL') &&
        agent.engineExecute !== 'CODEX'
      ) {
        throw errors.badRequest(
          '此類技能只能由 CODEX 引擎驅動，請將員工主引擎改為 CODEX',
        );
      }
      const agentSkill = await prisma.agentSkill.create({
        data: { agentId: id, skillId: body.skillId },
      });
      await audit(req.user!.sub, 'agent.skill_added', 'Agent', id, { skillId: body.skillId });
      return ok(agentSkill);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Remove a skill from an agent.
  app.delete('/api/agents/:id/skills/:skillId', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id, skillId } = req.params as { id: string; skillId: string };
      const existing = await prisma.agentSkill.findUnique({
        where: { agentId_skillId: { agentId: id, skillId } },
      });
      if (!existing) throw errors.notFound('Agent skill not found');
      await prisma.agentSkill.delete({ where: { agentId_skillId: { agentId: id, skillId } } });
      await audit(req.user!.sub, 'agent.skill_removed', 'Agent', id, { skillId });
      return ok({ agentId: id, skillId });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Replace file targets for an agent.
  app.put('/api/agents/:id/file-targets', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = fileTargetsSchema.parse(req.body);
      const agent = await prisma.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw errors.notFound('Agent not found');

      await prisma.$transaction([
        prisma.agentFileTarget.deleteMany({ where: { agentId: id } }),
        ...(body.targets.length
          ? [
              prisma.agentFileTarget.createMany({
                data: body.targets.map((t) => ({
                  agentId: id,
                  cloudFileRefId: t.cloudFileRefId,
                  purpose: t.purpose,
                })),
              }),
            ]
          : []),
      ]);

      const fileTargets = await prisma.agentFileTarget.findMany({
        where: { agentId: id },
        include: { cloudFileRef: true },
      });
      await audit(req.user!.sub, 'agent.file_targets_replaced', 'Agent', id, { count: body.targets.length });
      return ok(fileTargets);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // L1 skill catalog for an agent (metadata + safe relPath only; no contentMd body).
  app.get('/api/agents/:id/skills/catalog', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const agent = await prisma.agent.findFirst({
        where: { id, deletedAt: null },
        include: { skills: { include: { skill: true } } },
      });
      if (!agent) throw errors.notFound('Agent not found');

      const confirmed = agent.skills
        .map((as) => as.skill)
        .filter((s) => s.reviewStatus === 'CONFIRMED' && !s.deletedAt);

      const catalog = buildAgentSkillCatalog(confirmed);
      return ok(
        catalog.map((c) => ({
          slug: c.slug,
          name: c.name,
          metadata: c.metadata,
          relPath: c.relPath,
          conflicted: c.conflicted,
        })),
      );
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
