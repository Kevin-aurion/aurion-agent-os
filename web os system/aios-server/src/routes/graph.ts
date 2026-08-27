// FDE-only Graph Engineering API (GraphSpec v2).
// MEMBER / scoped OAuth → 403. Invalid input → 400 with zero writes.
//
// Artifact separation:
// - POST /api/graph/artifacts stores SOURCE GraphSpec only
//   (template=graph-engineering-v2-source, runtimeKind=NATIVE, authoring-only).
// - POST /api/graph/artifacts/:id/compile/langflow stores a SEPARATE
//   content-addressed LANGFLOW native flow.data artifact.
//
// Catalogue trust boundary (Review 2):
// - HTTP bodies NEVER accept `catalogue` (strict schemas).
// - Catalogue always comes from resolveRuntimeAdapter(...).fetchComponentCatalogue()
//   or from server-side GraphRouteOptions.fetchCatalogue DI (tests only).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTrainer } from '../lib/guard.js';
import { errors, ok, sendError } from '../lib/http.js';
import { stopWriteGuard } from '../lib/stopwrite.js';
import { prisma } from '../lib/db.js';
import {
  createFlowArtifact,
  FlowArtifactError,
  getVerifiedFlowArtifact,
} from '../lib/flowartifact.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import {
  compileGraphToLangflow,
  diffGraphs,
  GRAPH_COMPILER_VERSION,
  GRAPH_LANGFLOW_TEMPLATE_ID,
  GRAPH_PALETTE,
  GRAPH_SOURCE_TEMPLATE_ID,
  graphArtifactKindFromTemplate,
  isLangflowNativeFlowData,
  upgradeFlowGraphV1ToV2,
  validateGraph,
  type GraphSpecV2,
} from '../graph/index.js';
import { resolveRuntimeAdapter } from '../lib/runtimedeployment.js';
import { RuntimeAdapterError } from '../runtime/adapter.js';
import { LangflowAdapter } from '../runtime/langflow.js';

export type GraphEnvironment = 'SANDBOX' | 'STAGING' | 'PRODUCTION';

/**
 * Server-side options only. Never populated from HTTP.
 * Tests inject fetchCatalogue with a frozen fixture; production omits it.
 */
export type GraphRouteOptions = {
  fetchCatalogue?: (environment: GraphEnvironment) => Promise<unknown>;
};

function asHttpError(e: unknown): unknown {
  if (e instanceof z.ZodError) {
    return errors.badRequest('Invalid request', e.issues);
  }
  if (e instanceof FlowArtifactError) {
    if (e.code === 'NOT_FOUND') return errors.notFound(e.message);
    if (e.code === 'DIGEST_MISMATCH') return errors.conflict(e.message);
    return errors.badRequest(e.message);
  }
  if (e instanceof RuntimeAdapterError) {
    if (e.code === 'VALIDATION_FAILED') return errors.badRequest(e.message);
    if (e.code === 'NOT_FOUND') return errors.notFound(e.message);
    if (e.code === 'TIMEOUT' || e.code === 'RUNTIME_UNREACHABLE') {
      return errors.conflict(e.message);
    }
    return errors.badRequest(e.message);
  }
  return e;
}

const envEnum = z.enum(['SANDBOX', 'STAGING', 'PRODUCTION']);

const diffBodySchema = z
  .object({
    before: z.unknown(),
    after: z.unknown(),
  })
  .strict();

const compileBodySchema = z
  .object({
    graph: z.unknown(),
    environment: envEnum.optional(),
  })
  .strict();

const artifactCompileBodySchema = z
  .object({
    environment: envEnum.optional(),
  })
  .strict();

const artifactCreateSchema = z
  .object({
    graph: z.unknown(),
    workflowId: z.string().min(1).optional(),
    skillVersionId: z.string().min(1).optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

/** Accept either `{ graph }` envelope or a raw graph object. */
function extractGraphPayload(body: unknown): unknown {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'graph' in body &&
    !('schemaVersion' in body)
  ) {
    return (body as { graph: unknown }).graph;
  }
  return body;
}

const artifactsListQuery = z
  .object({
    limit: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined) return 50;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1) return 50;
        return Math.min(200, Math.floor(n));
      }),
    kind: z.enum(['source', 'langflow-native', 'all']).optional(),
  })
  .strict();

function requireValidGraph(raw: unknown): GraphSpecV2 {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as { schemaVersion?: string }).schemaVersion === 'aios.flow-graph/1'
  ) {
    const upgraded = upgradeFlowGraphV1ToV2(raw);
    if (!upgraded.ok) {
      throw errors.badRequest(upgraded.error, {
        issues: [{ code: 'UPGRADE_FAILED', path: 'graph', message: upgraded.error }],
      });
    }
    const v = validateGraph(upgraded.graph);
    if (!v.ok) {
      throw errors.badRequest('Graph validation failed', { issues: v.issues });
    }
    return v.graph;
  }
  const v = validateGraph(raw);
  if (!v.ok) {
    throw errors.badRequest('Graph validation failed', { issues: v.issues });
  }
  return v.graph;
}

async function resolveTrustedCatalogue(
  environment: GraphEnvironment,
  opts: GraphRouteOptions,
): Promise<unknown> {
  if (opts.fetchCatalogue) {
    return opts.fetchCatalogue(environment);
  }
  const adapter = resolveRuntimeAdapter('LANGFLOW', environment);
  if (!(adapter instanceof LangflowAdapter)) {
    throw errors.conflict('LANGFLOW adapter required for catalogue fetch');
  }
  return adapter.fetchComponentCatalogue();
}

export async function graphRoutes(
  app: FastifyInstance,
  opts: GraphRouteOptions = {},
): Promise<void> {
  app.get(
    '/api/graph/palette',
    { preHandler: requireTrainer },
    async (_req, reply) => {
      return reply.send(ok({ items: GRAPH_PALETTE }));
    },
  );

  app.post(
    '/api/graph/validate',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const raw = extractGraphPayload(req.body);
        const result = validateGraph(raw);
        if (!result.ok) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Graph validation failed',
              detail: { issues: result.issues },
            },
          });
        }
        return reply.send(
          ok({
            valid: true,
            graph: deepRedactSecrets(result.graph),
            issues: [],
          }),
        );
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.post(
    '/api/graph/diff',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = diffBodySchema.parse(req.body ?? {});
        const before = requireValidGraph(body.before);
        const after = requireValidGraph(body.after);
        const diff = diffGraphs(before, after);
        return reply.send(ok(deepRedactSecrets(diff)));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  /** Ephemeral compile (does not persist). Catalogue is never accepted from HTTP. */
  app.post(
    '/api/graph/langflow/compile',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = compileBodySchema.parse(req.body ?? {});
        const graph = requireValidGraph(body.graph);
        const env = body.environment ?? 'SANDBOX';
        const catalogue = await resolveTrustedCatalogue(env, opts);

        const compiled = compileGraphToLangflow(graph, catalogue);
        if (!compiled.ok) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Langflow compile failed',
              detail: deepRedactSecrets({
                issues: compiled.issues,
                nodeMapping: compiled.nodeMapping,
                catalogueFingerprint: compiled.catalogueFingerprint,
              }),
            },
          });
        }
        return reply.send(ok(deepRedactSecrets(compiled)));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  /**
   * Persist governed GraphSpec v2 as an immutable SOURCE artifact.
   * runtimeKind=NATIVE + template=graph-engineering-v2-source (authoring-only).
   */
  app.post(
    '/api/graph/artifacts',
    { preHandler: [requireTrainer, stopWriteGuard('langflowRuntime')] },
    async (req, reply) => {
      try {
        const body = artifactCreateSchema.parse(req.body ?? {});
        const graph = requireValidGraph(body.graph);
        const redacted = deepRedactSecrets(graph);

        const stored = await createFlowArtifact({
          runtimeKind: 'NATIVE',
          template: GRAPH_SOURCE_TEMPLATE_ID,
          templateVersion: '2',
          compilerVersion: GRAPH_COMPILER_VERSION,
          artifactJson: redacted,
          workflowId: body.workflowId ?? null,
          skillVersionId: body.skillVersionId ?? null,
          metadata:
            body.metadata === undefined
              ? { artifactKind: 'source', schemaVersion: 'aios.flow-graph/2' }
              : deepRedactSecrets({
                  ...(typeof body.metadata === 'object' &&
                  body.metadata !== null &&
                  !Array.isArray(body.metadata)
                    ? (body.metadata as Record<string, unknown>)
                    : { userMetadata: body.metadata }),
                  artifactKind: 'source',
                  schemaVersion: 'aios.flow-graph/2',
                }),
          createdBy: req.user!.sub,
        });

        return reply.send(
          ok({
            id: stored.id,
            digest: stored.digest,
            status: stored.status,
            reused: stored.reused,
            template: GRAPH_SOURCE_TEMPLATE_ID,
            compilerVersion: GRAPH_COMPILER_VERSION,
            runtimeKind: 'NATIVE',
            artifactKind: 'source' as const,
            langflowDeployable: false,
          }),
        );
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  /**
   * Compile a stored SOURCE artifact into a separate LANGFLOW native artifact.
   * Catalogue is never taken from the HTTP body.
   */
  app.post(
    '/api/graph/artifacts/:id/compile/langflow',
    { preHandler: [requireTrainer, stopWriteGuard('langflowRuntime')] },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        if (typeof id !== 'string' || id.trim() === '') {
          throw errors.badRequest('artifact id required');
        }
        // Empty body allowed; catalogue key rejected by .strict().
        const body = artifactCompileBodySchema.parse(
          req.body === undefined || req.body === null ? {} : req.body,
        );
        const environment = body.environment ?? 'SANDBOX';

        let source;
        try {
          source = await getVerifiedFlowArtifact(id);
        } catch (e) {
          throw asHttpError(e);
        }

        if (source.template !== GRAPH_SOURCE_TEMPLATE_ID) {
          throw errors.badRequest(
            `artifact is not a GraphSpec source (template=${source.template}; expected ${GRAPH_SOURCE_TEMPLATE_ID})`,
          );
        }
        if (source.runtimeKind !== 'NATIVE') {
          throw errors.badRequest(
            `source artifact runtimeKind must be NATIVE (got ${source.runtimeKind})`,
          );
        }

        const graph = requireValidGraph(source.artifactJson);
        const catalogue = await resolveTrustedCatalogue(environment, opts);
        const compiled = compileGraphToLangflow(graph, catalogue);
        if (!compiled.ok) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Langflow compile failed',
              detail: deepRedactSecrets({
                issues: compiled.issues,
                nodeMapping: compiled.nodeMapping,
                catalogueFingerprint: compiled.catalogueFingerprint,
              }),
            },
          });
        }

        const flowData = compiled.flow.data;
        if (!isLangflowNativeFlowData(flowData)) {
          throw errors.badRequest(
            'compiler produced non-native Langflow data (refusing to store)',
          );
        }

        const provenance = deepRedactSecrets({
          artifactKind: 'langflow-native',
          sourceArtifactId: source.id,
          sourceDigest: source.digest,
          catalogueFingerprint: compiled.catalogueFingerprint,
          nodeMapping: compiled.nodeMapping,
          environment,
          flowName: compiled.flow.name,
          flowDescription: compiled.flow.description,
        });

        const stored = await createFlowArtifact({
          runtimeKind: 'LANGFLOW',
          template: GRAPH_LANGFLOW_TEMPLATE_ID,
          templateVersion: '2',
          compilerVersion: GRAPH_COMPILER_VERSION,
          artifactJson: deepRedactSecrets(flowData),
          workflowId: source.workflowId,
          skillVersionId: source.skillVersionId,
          metadata: provenance,
          createdBy: req.user!.sub,
        });

        return reply.send(
          ok(
            deepRedactSecrets({
              source: {
                id: source.id,
                digest: source.digest,
                template: source.template,
                runtimeKind: source.runtimeKind,
                artifactKind: 'source' as const,
                langflowDeployable: false,
              },
              compiled: {
                id: stored.id,
                digest: stored.digest,
                status: stored.status,
                reused: stored.reused,
                template: GRAPH_LANGFLOW_TEMPLATE_ID,
                compilerVersion: GRAPH_COMPILER_VERSION,
                runtimeKind: 'LANGFLOW',
                artifactKind: 'langflow-native' as const,
                langflowDeployable: true,
                catalogueFingerprint: compiled.catalogueFingerprint,
              },
            }),
          ),
        );
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.get(
    '/api/graph/artifacts',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const q = artifactsListQuery.parse(req.query ?? {});
        const templates: string[] = [];
        if (!q.kind || q.kind === 'all') {
          templates.push(GRAPH_SOURCE_TEMPLATE_ID, GRAPH_LANGFLOW_TEMPLATE_ID);
        } else if (q.kind === 'source') {
          templates.push(GRAPH_SOURCE_TEMPLATE_ID);
        } else {
          templates.push(GRAPH_LANGFLOW_TEMPLATE_ID);
        }

        const rows = await prisma.flowArtifact.findMany({
          where: {
            template: { in: templates },
          },
          orderBy: { createdAt: 'desc' },
          take: q.limit,
          select: {
            id: true,
            digest: true,
            status: true,
            template: true,
            templateVersion: true,
            compilerVersion: true,
            runtimeKind: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            workflowId: true,
            skillVersionId: true,
            metadata: true,
          },
        });

        const items = rows.map((r) => {
          const artifactKind = graphArtifactKindFromTemplate(r.template);
          return {
            id: r.id,
            digest: r.digest,
            status: r.status,
            template: r.template,
            templateVersion: r.templateVersion,
            compilerVersion: r.compilerVersion,
            runtimeKind: r.runtimeKind,
            artifactKind,
            langflowDeployable:
              r.runtimeKind === 'LANGFLOW' && r.template === GRAPH_LANGFLOW_TEMPLATE_ID,
            createdBy: r.createdBy,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            workflowId: r.workflowId,
            skillVersionId: r.skillVersionId,
            metadata: r.metadata === null ? null : deepRedactSecrets(r.metadata),
          };
        });

        return reply.send(ok({ items }));
      } catch (e) {
        return sendError(reply, asHttpError(e));
      }
    },
  );

  /**
   * FDE artifact detail for Workbench load/diff.
   * Registered before /:id/traces so path matching is unambiguous.
   */
  app.get(
    '/api/graph/artifacts/:id',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        if (typeof id !== 'string' || id.trim() === '') {
          throw errors.badRequest('artifact id required');
        }

        let row;
        try {
          row = await getVerifiedFlowArtifact(id);
        } catch (e) {
          if (e instanceof FlowArtifactError && e.code === 'DIGEST_MISMATCH') {
            throw errors.conflict(e.message);
          }
          throw asHttpError(e);
        }

        // Only graph-engineering templates are exposed on this surface.
        if (
          row.template !== GRAPH_SOURCE_TEMPLATE_ID &&
          row.template !== GRAPH_LANGFLOW_TEMPLATE_ID
        ) {
          throw errors.notFound(`FlowArtifact not found: ${id}`);
        }

        const artifactKind = graphArtifactKindFromTemplate(row.template);
        const langflowDeployable =
          row.runtimeKind === 'LANGFLOW' && row.template === GRAPH_LANGFLOW_TEMPLATE_ID;

        return reply.send(
          ok(
            deepRedactSecrets({
              id: row.id,
              digest: row.digest,
              status: row.status,
              template: row.template,
              templateVersion: row.templateVersion,
              compilerVersion: row.compilerVersion,
              runtimeKind: row.runtimeKind,
              artifactKind,
              langflowDeployable,
              workflowId: row.workflowId,
              skillVersionId: row.skillVersionId,
              createdBy: row.createdBy,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              metadata: row.metadata,
              artifactJson: row.artifactJson,
            }),
          ),
        );
      } catch (e) {
        if (e instanceof Error) {
          e.message = redactSecrets(e.message);
        }
        return sendError(reply, asHttpError(e));
      }
    },
  );

  app.get(
    '/api/graph/artifacts/:id/traces',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        if (typeof id !== 'string' || id.trim() === '') {
          throw errors.badRequest('artifact id required');
        }

        const artifact = await prisma.flowArtifact.findUnique({
          where: { id },
          select: { id: true, digest: true, template: true },
        });
        if (!artifact) {
          throw errors.notFound(`FlowArtifact not found: ${id}`);
        }

        const traces = await prisma.runTrace.findMany({
          where: { artifactId: id },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });

        const items = traces.map((t) => ({
          id: t.id,
          runId: t.runId,
          agentId: t.agentId,
          outcome: t.outcome,
          runtimeKind: t.runtimeKind,
          artifactId: t.artifactId,
          createdAt: t.createdAt.toISOString(),
          selectedSkills: deepRedactSecrets(t.selectedSkills),
          trajectory: deepRedactSecrets(t.trajectory),
          verifierFeedback: deepRedactSecrets(t.verifierFeedback),
          trajectoryKey: t.trajectoryKey,
          engineExecute: t.engineExecute,
          engineVerify: t.engineVerify,
        }));

        return reply.send(
          ok({
            artifactId: artifact.id,
            digest: artifact.digest,
            items,
          }),
        );
      } catch (e) {
        if (e instanceof Error) {
          e.message = redactSecrets(e.message);
        }
        return sendError(reply, asHttpError(e));
      }
    },
  );
}
