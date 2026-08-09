// Agent Builder REST — durable CEO-friendly agent factory.
// Auth: requireAuth. MEMBER may interview + request authorize (AWAITING_FDE only).
// FDE may authorize build, finalize. Ownership fail-closed (404 for foreigners).
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { fileToText } from '../lib/filecontext.js';
import { buildAgentPackage } from '../lib/agentpackage.js';
import {
  createBuilderSession,
  getBuilderSession,
  getLatestBuilderSession,
  postBuilderMessage,
  authorizeBuilderSession,
  submitBuilderTestData,
  runBuilderTest,
  finalizeBuilderSession,
  attachBuilderSourceFile,
  listBuilderReviewQueue,
  listBuilderEvolutionSessions,
  listAllBuilderEvolutionSessions,
  listBuilderSessions,
  getBuilderDraft,
  saveBuilderDraft,
} from '../lib/agentbuilder.js';
import {
  createExternalBuilderSession,
  guardExternalBuilderStop,
  importExternalBuilderArtifact,
  listOwnedBuilderAgents,
  prepareExternalBuilderPrompt,
  requestOwnedAgentRename,
  setExternalBuilderName,
  submitExternalBuilderForReview,
  syncExternalBuilderTurn,
  upsertExternalBuilderSnapshot,
} from '../lib/externalagentbuilder.js';

const messageSchema = z.object({
  message: z.string().min(1),
});

const authorizeSchema = z.object({
  strategy: z.enum(['reuse', 'create']),
  targetAgentId: z.string().min(1).optional(),
});

const testDataSchema = z.object({
  data: z.unknown().refine((value) => value !== undefined && value !== null && value !== '', {
    message: 'data is required',
  }),
  expected: z.unknown().refine((value) => value !== undefined && value !== null && value !== '', {
    message: 'expected is required',
  }),
});

const draftQuerySchema = z.object({ sessionId: z.string().min(1).optional() });
const builderFileQuerySchema = z.object({
  useAsTemplate: z.enum(['true', 'false']).optional().default('false'),
});
const draftBodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  reply: z.string().max(8_000).default(''),
  testData: z.string().max(30_000).default(''),
  testExpected: z.string().max(12_000).default(''),
});

const externalSourceSchema = z.enum(['CLAUDE_DESKTOP', 'CLAUDE_CODE', 'CHATGPT', 'CURSOR', 'OTHER']);
const externalSessionSchema = z.object({
  source: externalSourceSchema,
  initialRequest: z.string().min(1).max(12_000),
  externalConversationId: z.string().min(1).max(160).optional(),
  externalConversationTitle: z.string().max(240).optional(),
  requestedAgentName: z.string().max(120).optional(),
  targetAgentId: z.string().min(1).optional(),
}).strict();
const setBuilderNameSchema = z.object({ name: z.string().min(2).max(120) }).strict();
const requestAgentRenameSchema = z.object({ name: z.string().min(2).max(120) }).strict();
const externalTurnsSchema = z.object({
  source: externalSourceSchema,
  externalEventId: z.string().min(1).max(160),
  turns: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().min(1).max(24_000),
  }).strict()).min(1).max(6),
  summary: z.string().max(2_000).optional(),
}).strict();
const externalSkillSchema = z.object({
  name: z.string().min(1).max(120),
  purpose: z.string().max(1_200).optional(),
  instructions: z.array(z.string().max(1_200)).max(30).optional(),
  inputs: z.array(z.string().max(600)).max(20).optional(),
  outputs: z.array(z.string().max(600)).max(20).optional(),
  edgeCases: z.array(z.string().max(800)).max(20).optional(),
  contentMd: z.string().max(60_000).optional(),
}).strict();
const externalWorkflowStepSchema = z.object({
  stepKey: z.string().min(1).max(100),
  type: z.enum(['DO', 'TOOL', 'AGENT', 'CONDITION', 'NOTIFY', 'COMPUTER_CONTROL']),
  config: z.record(z.unknown()).optional(),
  verifyRubric: z.string().max(2_000).nullable().optional(),
  onFail: z.record(z.unknown()).nullable().optional(),
}).strict();
const externalArtifactSchema = z.object({
  source: externalSourceSchema,
  externalEventId: z.string().min(1).max(160),
  artifact: z.object({
    identity: z.object({
      name: z.string().min(1).max(120),
      purpose: z.string().min(1).max(1_500),
      workingStyle: z.array(z.string().max(800)).max(20).optional(),
    }).strict(),
    agentMarkdown: z.string().max(60_000).optional(),
    claudeMarkdown: z.string().max(60_000).optional(),
    skills: z.array(externalSkillSchema).max(12).optional(),
    memory: z.object({
      facts: z.array(z.string().max(1_200)).max(60).optional(),
      preferences: z.array(z.string().max(1_200)).max(40).optional(),
      glossary: z.array(z.string().max(600)).max(60).optional(),
      documents: z.array(z.object({
        path: z.string().min(1).max(240),
        contentMd: z.string().min(1).max(40_000),
        purpose: z.string().max(500).optional(),
      }).strict()).max(24).optional(),
    }).strict().optional(),
    tools: z.array(z.object({
      name: z.string().min(1).max(180),
      purpose: z.string().max(800).optional(),
      status: z.enum(['AVAILABLE', 'NEEDS_FDE', 'NOT_NEEDED']).optional(),
    }).strict()).max(30).optional(),
    policies: z.object({
      allowed: z.array(z.string().max(800)).max(30).optional(),
      requiresApproval: z.array(z.string().max(800)).max(30).optional(),
      forbidden: z.array(z.string().max(800)).max(30).optional(),
    }).strict().optional(),
    tests: z.array(z.object({
      name: z.string().min(1).max(180),
      input: z.string().min(1).max(5_000),
      expected: z.string().min(1).max(5_000),
    }).strict()).max(20).optional(),
    workflows: z.array(z.object({
      name: z.string().min(1).max(160),
      description: z.string().max(1_200).optional(),
      trigger: z.record(z.unknown()).optional(),
      durable: z.boolean().optional(),
      steps: z.array(externalWorkflowStepSchema).max(40).optional(),
    }).strict()).max(12).optional(),
    understanding: z.object({
      northStar: z.string().max(1_500).optional(),
      painPoints: z.array(z.string().max(1_000)).max(20).optional(),
      facts: z.array(z.object({
        statement: z.string().min(1).max(1_200),
        source: z.string().max(240),
      }).strict()).max(40).optional(),
      hypotheses: z.array(z.object({
        statement: z.string().min(1).max(1_000),
        confidence: z.enum(['low', 'medium', 'high']),
      }).strict()).max(20).optional(),
      decisions: z.array(z.object({
        topic: z.string().min(1).max(240),
        decision: z.string().min(1).max(1_500),
        status: z.enum(['provisional', 'confirmed', 'revised']),
      }).strict()).max(40).optional(),
      openBranches: z.array(z.object({
        topic: z.string().min(1).max(240),
        whyItMatters: z.string().min(1).max(1_000),
        recommendation: z.string().max(1_000),
      }).strict()).max(20).optional(),
      contradictions: z.array(z.string().max(1_000)).max(20).optional(),
      confidence: z.number().min(0).max(100).optional(),
    }).strict().optional(),
    changes: z.array(z.object({
      area: z.enum(['identity', 'skill', 'memory', 'tool', 'policy', 'test', 'workflow']),
      action: z.enum(['added', 'updated', 'removed']),
      summary: z.string().min(1).max(500),
      reason: z.string().max(600),
    }).strict()).max(40).optional(),
    userSummary: z.string().max(1_500).optional(),
    fdeSummary: z.string().max(4_000).optional(),
  }).strict(),
}).strict();
const externalSnapshotSchema = z.object({
  source: externalSourceSchema,
  externalEventId: z.string().min(1).max(120),
  turns: externalTurnsSchema.shape.turns,
  summary: externalTurnsSchema.shape.summary,
  artifact: externalArtifactSchema.shape.artifact,
}).strict();
const externalSubmitReviewSchema = z.object({
  strategy: z.enum(['create', 'reuse']).default('create'),
  targetAgentId: z.string().min(1).optional(),
}).strict();
const externalStopGuardSchema = z.object({
  source: externalSourceSchema.default('CLAUDE_CODE'),
  externalConversationId: z.string().min(1).max(160),
  lastUserMessage: z.string().max(24_000).optional(),
  lastUserMessageAt: z.string().datetime().optional(),
  lastAssistantMessage: z.string().max(24_000).optional(),
  stopHookActive: z.boolean().default(false),
}).strict();
const externalPromptHookSchema = z.object({
  source: externalSourceSchema.default('CLAUDE_CODE'),
  externalConversationId: z.string().min(1).max(160),
  prompt: z.string().min(1).max(12_000),
}).strict();

export async function agentBuilderRoutes(app: FastifyInstance) {
  /** Claude Code UserPromptSubmit hook: auto-start/resume and queue a build. */
  app.post('/api/agent-builder/external/prompt-hook', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = externalPromptHookSchema.parse(req.body);
      return ok(await prepareExternalBuilderPrompt({ userId: req.user!.sub, ...body }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Claude Code Stop hook: mirror final text and require one final full snapshot. */
  app.post('/api/agent-builder/external/stop-guard', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = externalStopGuardSchema.parse(req.body);
      return ok(await guardExternalBuilderStop({ userId: req.user!.sub, ...body }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Start a Claude/Cursor-owned build log without injecting AIOS's own interviewer reply. */
  app.post('/api/agent-builder/external/sessions', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = externalSessionSchema.parse(req.body);
      return ok(await createExternalBuilderSession({
        userId: req.user!.sub,
        ...body,
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** OAuth Builder-safe catalog: always owner-scoped, including OWNER accounts. */
  app.get('/api/agent-builder/agents', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return ok(await listOwnedBuilderAgents(req.user!.sub));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Name an inert build draft; this never renames a live Agent. */
  app.patch('/api/agent-builder/sessions/:id/name', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = setBuilderNameSchema.parse(req.body);
      return ok(await setExternalBuilderName({
        sessionId: id,
        userId: req.user!.sub,
        role: req.user!.role,
        name: body.name,
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** A customer may request a live Agent rename; only FDE approval applies it. */
  app.post('/api/agent-builder/agents/:id/rename-proposal', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = requestAgentRenameSchema.parse(req.body);
      return ok(await requestOwnedAgentRename({
        agentId: id,
        userId: req.user!.sub,
        name: body.name,
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Append exact externally-authored turns; externalEventId makes client retries idempotent. */
  app.post(
    '/api/agent-builder/sessions/:id/external-turns',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = externalTurnsSchema.parse(req.body);
        return ok(await syncExternalBuilderTurn({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          ...body,
        }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /** Import a full Agent/Skill/Memory/Workflow/Test shadow snapshot. Never promotes it. */
  app.post(
    '/api/agent-builder/sessions/:id/external-artifact',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = externalArtifactSchema.parse(req.body);
        return ok(await importExternalBuilderArtifact({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          ...body,
        }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /**
   * ChatGPT-style clients have no reliable Stop hook. Persist the exact paired
   * turn and complete shadow artifact as one retry-safe convergent operation.
   */
  app.post(
    '/api/agent-builder/sessions/:id/external-snapshot',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = externalSnapshotSchema.parse(req.body);
        return ok(await upsertExternalBuilderSnapshot({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          ...body,
        }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /** Always stop at AWAITING_FDE, even when the caller authenticated as OWNER. */
  app.post(
    '/api/agent-builder/sessions/:id/submit-review',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = externalSubmitReviewSchema.parse(req.body ?? {});
        return ok(await submitExternalBuilderForReview({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          ...body,
        }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /** Account-scoped build portal: every role sees only this login's builds. */
  app.get('/api/agent-builder/evolution-queue', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return ok(await listBuilderEvolutionSessions({
        userId: req.user!.sub,
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Separate FDE ledger. Never use this endpoint from the customer portal. */
  app.get('/api/agent-builder/admin/evolution-queue', { preHandler: requireTrainer }, async (req, reply) => {
    try {
      return ok(await listAllBuilderEvolutionSessions({ viewerUserId: req.user!.sub }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** FDE inbox for build authorization and final activation. */
  app.get('/api/agent-builder/review-queue', { preHandler: requireTrainer }, async (_req, reply) => {
    try {
      return ok(await listBuilderReviewQueue());
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Resume the signed-in user's latest unfinished front-end Builder flow. */
  app.get('/api/agent-builder/sessions/latest', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return ok(await getLatestBuilderSession({ userId: req.user!.sub }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Explicit chooser: every unfinished flow owned by the signed-in user. */
  app.get('/api/agent-builder/sessions', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return ok(await listBuilderSessions({ userId: req.user!.sub }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Cross-device unsent UI fields for a new or existing owned flow. */
  app.get('/api/agent-builder/draft', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const query = draftQuerySchema.parse(req.query);
      return ok(await getBuilderDraft({ userId: req.user!.sub, sessionId: query.sessionId }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.put('/api/agent-builder/draft', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = draftBodySchema.parse(req.body);
      return ok(await saveBuilderDraft({
        userId: req.user!.sub,
        sessionId: body.sessionId,
        draft: { reply: body.reply, testData: body.testData, testExpected: body.testExpected },
      }));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Start a new builder session with the first business outcome message. */
  app.post('/api/agent-builder/sessions', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const parsed = messageSchema.safeParse(req.body);
      if (!parsed.success) throw errors.badRequest('message is required');
      const result = await createBuilderSession({
        userId: req.user!.sub,
        message: parsed.data.message,
      });
      return ok(result);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Read session (owner or FDE). Foreign users → 404. */
  app.get('/api/agent-builder/sessions/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const session = await getBuilderSession({
        sessionId: id,
        userId: req.user!.sub,
        role: req.user!.role,
      });
      return ok(session);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Download an ACTIVE, FDE-approved Agent as a portable, redacted ZIP package. */
  app.get('/api/agent-builder/sessions/:id/export', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const exported = await buildAgentPackage({
        sessionId: id,
        userId: req.user!.sub,
        // A public Builder OAuth token may be owned by an OWNER account, but
        // it remains customer-scoped and must never inherit cross-user FDE access.
        role: req.user!.scope ? 'MEMBER' : req.user!.role,
      });
      const encoded = encodeURIComponent(exported.filename);
      return reply
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="agent-package.zip"; filename*=UTF-8''${encoded}`)
        .header('content-length', String(exported.buffer.length))
        .header('x-content-type-options', 'nosniff')
        .type('application/zip')
        .send(exported.buffer);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Upload a business source through the end-user Builder UI and parse it locally. */
  app.post(
    '/api/agent-builder/sessions/:id/files',
    { preHandler: requireAuth },
    async (req, reply) => {
      let tmpDir: string | undefined;
      try {
        const { id } = req.params as { id: string };
        const query = builderFileQuerySchema.parse(req.query ?? {});
        const file = await req.file();
        if (!file) throw errors.badRequest('No training file uploaded');
        const filename = path.basename(file.filename || 'training-source');
        const ext = path.extname(filename).toLowerCase();
        const allowed = new Set([
          '.xlsx', '.xls', '.csv', '.tsv', '.md', '.txt', '.pdf', '.docx',
          '.json', '.yaml', '.yml', '.html',
        ]);
        if (!allowed.has(ext)) throw errors.badRequest('Unsupported training file type');
        const buf = await file.toBuffer();
        if (buf.length > 10 * 1024 * 1024) throw errors.badRequest('Training file exceeds 10 MB');
        tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aios-builder-source-'));
        const localPath = path.join(tmpDir, filename);
        await writeFile(localPath, buf);
        const content = await fileToText(localPath, filename, file.mimetype);
        return ok(
          await attachBuilderSourceFile({
            sessionId: id,
            userId: req.user!.sub,
            role: req.user!.role,
            name: filename,
            mimeType: file.mimetype,
            size: buf.length,
            content,
            useAsTemplate: query.useAsTemplate === 'true',
          }),
        );
      } catch (e) {
        return sendError(reply, e);
      } finally {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  /** Continue discovery interview (owner only write). */
  app.post(
    '/api/agent-builder/sessions/:id/messages',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const parsed = messageSchema.safeParse(req.body);
        if (!parsed.success) throw errors.badRequest('message is required');
        const result = await postBuilderMessage({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          message: parsed.data.message,
        });
        return ok(result);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /** FDE clicks approve in the admin review inbox; uses the operator-selected strategy. */
  app.post(
    '/api/agent-builder/sessions/:id/approve-build',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const session = await getBuilderSession({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
        });
        if (session.status !== 'AWAITING_FDE') {
          throw errors.conflict(`Cannot approve build from status=${session.status}`);
        }
        const strategy = session.strategy === 'reuse' ? 'reuse' : 'create';
        return ok(
          await authorizeBuilderSession({
            sessionId: id,
            userId: req.user!.sub,
            role: req.user!.role,
            strategy,
            targetAgentId: session.targetAgentId ?? undefined,
          }),
        );
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /**
   * Authorize build: MEMBER → AWAITING_FDE (no mutation);
   * FDE → create PAUSED agent / inert skill draft.
   */
  app.post(
    '/api/agent-builder/sessions/:id/authorize',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const parsed = authorizeSchema.safeParse(req.body);
        if (!parsed.success) throw errors.badRequest('strategy must be reuse|create');
        const result = await authorizeBuilderSession({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          strategy: parsed.data.strategy,
          targetAgentId: parsed.data.targetAgentId,
        });
        return ok(result);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /** Submit redacted manual fixture data + expected result. */
  app.post(
    '/api/agent-builder/sessions/:id/test-data',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const parsed = testDataSchema.safeParse(req.body);
        if (!parsed.success) throw errors.badRequest('data and expected are required');
        const result = await submitBuilderTestData({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          data: parsed.data.data,
          expected: parsed.data.expected,
        });
        return ok(result);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /**
   * Run a real asynchronous runAgent test against submitted fixture data.
   * Never fake-passes. Injectable runner is for focused tests only (not HTTP).
   */
  app.post(
    '/api/agent-builder/sessions/:id/test',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const result = await runBuilderTest({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
          background: true,
        });
        return ok(result);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  /** FDE-only finalize after PASSED: confirm drafts, activate created agent. */
  app.post(
    '/api/agent-builder/sessions/:id/finalize',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const result = await finalizeBuilderSession({
          sessionId: id,
          userId: req.user!.sub,
          role: req.user!.role,
        });
        return ok(result);
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );
}
