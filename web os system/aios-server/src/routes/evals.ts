// FDE REST for evaluation suites, runs, and skill promote/rollback gates.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { ok, sendError, errors } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { stopWriteGuard } from '../lib/stopwrite.js';
import {
  createSuite,
  addCase,
  getSuite,
  listSuitesForSkill,
  getRun,
  runSuite,
} from '../lib/eval.js';
import { promoteWithGate, rollbackWithGate } from '../lib/skillpromote.js';
import { listSkillVersions, readPromoteGate } from '../lib/skillgovernance.js';

const EngineEnum = z.enum(['CLAUDE_CODE', 'CODEX', 'GROK']);

const EvalCaseKindEnum = z.enum([
  'POSITIVE_TRIGGER',
  'NEGATIVE_TRIGGER',
  'CONFUSION_PAIR',
  'TRAJECTORY',
  'OUTPUT_RUBRIC',
  'PROMPT_INJECTION',
  'RED_TEAM',
]);

const createSuiteBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const addCaseBody = z.object({
  kind: EvalCaseKindEnum,
  name: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown().optional(),
  requiredTools: z.array(z.string()).optional(),
  forbiddenTools: z.array(z.string()).optional(),
  weight: z.number().int().positive().optional(),
});

const runSuiteBody = z.object({
  candidateVersionId: z.string().min(1).optional(),
  executeEngine: EngineEnum,
  verifyEngine: EngineEnum.optional(),
  agentId: z.string().min(1).optional(),
});

const promoteBody = z.object({
  versionId: z.string().min(1),
});

const rollbackBody = z.object({
  versionId: z.string().min(1),
});

const promoteGateQuery = z.object({
  versionId: z.string().min(1),
});

export async function evalRoutes(app: FastifyInstance) {
  // Create eval suite for a skill (FDE)
  app.post(
    '/api/skills/:skillId/eval-suites',
    { preHandler: [requireTrainer, stopWriteGuard('eval')] },
    async (req, reply) => {
      try {
        const { skillId } = req.params as { skillId: string };
        const body = createSuiteBody.parse(req.body);
        const suite = await createSuite({
          skillId,
          name: body.name,
          description: body.description,
          createdBy: req.user!.sub,
        });
        await audit(req.user!.sub, 'eval_suite.create', 'EvalSuite', suite.id, {
          skillId,
          name: suite.name,
        });
        return reply.send(ok(suite));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // List suites for skill (any auth)
  app.get(
    '/api/skills/:skillId/eval-suites',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { skillId } = req.params as { skillId: string };
        const suites = await listSuitesForSkill(skillId);
        return reply.send(ok(suites));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Add case to suite (FDE)
  app.post(
    '/api/eval-suites/:suiteId/cases',
    { preHandler: [requireTrainer, stopWriteGuard('eval')] },
    async (req, reply) => {
      try {
        const { suiteId } = req.params as { suiteId: string };
        const body = addCaseBody.parse(req.body);
        const c = await addCase({
          suiteId,
          kind: body.kind,
          name: body.name,
          input: body.input,
          expected: body.expected,
          requiredTools: body.requiredTools,
          forbiddenTools: body.forbiddenTools,
          weight: body.weight,
        });
        return reply.send(ok(c));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Get suite + cases
  app.get(
    '/api/eval-suites/:suiteId',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { suiteId } = req.params as { suiteId: string };
        const suite = await getSuite(suiteId);
        return reply.send(ok(suite));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Run suite (FDE only — MEMBER blocked by requireTrainer → 403)
  app.post(
    '/api/eval-suites/:suiteId/run',
    { preHandler: [requireTrainer, stopWriteGuard('eval')] },
    async (req, reply) => {
      try {
        const { suiteId } = req.params as { suiteId: string };
        const body = runSuiteBody.parse(req.body);
        const run = await runSuite({
          suiteId,
          candidateVersionId: body.candidateVersionId,
          executeEngine: body.executeEngine,
          verifyEngine: body.verifyEngine,
          agentId: body.agentId,
          triggeredBy: req.user!.sub,
        });
        return reply.send(ok(run));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Get run + results (evidence already redacted at write time)
  app.get(
    '/api/eval-runs/:runId',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { runId } = req.params as { runId: string };
        const run = await getRun(runId);
        return reply.send(ok(run));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Promote with fail-closed gates (FDE)
  app.post(
    '/api/skills/:skillId/promote',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { skillId } = req.params as { skillId: string };
        const body = promoteBody.parse(req.body);
        await promoteWithGate({
          skillId,
          versionId: body.versionId,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok({ skillId, versionId: body.versionId, promoted: true }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Rollback stable pointer (FDE)
  app.post(
    '/api/skills/:skillId/rollback',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { skillId } = req.params as { skillId: string };
        const body = rollbackBody.parse(req.body);
        await rollbackWithGate({
          skillId,
          versionId: body.versionId,
          actorId: req.user!.sub,
          actorRole: req.user!.role,
        });
        return reply.send(ok({ skillId, versionId: body.versionId, rolledBack: true }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // List skill versions (FDE read-only governance)
  app.get(
    '/api/skills/:skillId/versions',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { skillId } = req.params as { skillId: string };
        return reply.send(ok(await listSkillVersions(skillId)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  // Promote-gate dry-run (FDE read-only; zero DB writes)
  app.get(
    '/api/skills/:skillId/promote-gate',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { skillId } = req.params as { skillId: string };
        const query = promoteGateQuery.parse(req.query);
        return reply.send(ok(await readPromoteGate(skillId, query.versionId)));
      } catch (e) {
        if (e instanceof z.ZodError) {
          return sendError(reply, errors.badRequest('Invalid query', e.issues));
        }
        return sendError(reply, e);
      }
    },
  );
}
