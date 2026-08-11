/**
 * Review 2 — authoring-only source guard, trusted catalogue boundary, artifact detail.
 * Run: npx tsx .scratch/graph-engineering/tests/t08-review2-deploy-guard.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { signAccess } from '../../../src/lib/auth.js';
import { prisma } from '../../../src/lib/db.js';
import {
  createFlowArtifact,
  getVerifiedFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  activateDeployment,
  validateArtifactForRuntime,
} from '../../../src/lib/runtimedeployment.js';
import {
  GRAPH_LANGFLOW_TEMPLATE_ID,
  GRAPH_SOURCE_TEMPLATE_ID,
  isLangflowNativeFlowData,
} from '../../../src/graph/types.js';
import { graphRoutes } from '../../../src/routes/graph.js';
import { runtimeRoutes } from '../../../src/routes/runtime.js';
import {
  check,
  echoGraph,
  fail,
  loadMinCatalogue,
  resetCounters,
  summary,
} from './helpers.js';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

type Envelope<T> = {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string; detail?: unknown };
};

function parseBody<T>(body: string): Envelope<T> {
  try {
    return JSON.parse(body) as Envelope<T>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  resetCounters();
  console.log('── t08-review2-deploy-guard ──');

  const catalogue = loadMinCatalogue();
  const createdIds: string[] = [];
  const trainerToken = await signAccess({
    sub: 't08-graph-trainer',
    email: 't08-graph-trainer@test.local',
    role: 'TRAINER',
  });
  const memberToken = await signAccess({
    sub: 't08-graph-member',
    email: 't08-graph-member@test.local',
    role: 'MEMBER',
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message, detail: err.detail },
      });
    }
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL', message: String(err) },
    });
  });

  // Server-side DI for trusted frozen catalogue (never via HTTP body).
  await app.register(graphRoutes, {
    fetchCatalogue: async () => catalogue,
  });
  await app.register(runtimeRoutes);

  try {
    const tag = ulid().slice(-6).toLowerCase();
    const g = echoGraph({ id: `g_r2_${tag}`, name: `r2-echo-${tag}` });

    // ── Create source ────────────────────────────────────────────────────
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/graph/artifacts',
      headers: auth(trainerToken),
      payload: { graph: g },
    });
    const created = parseBody<{ id: string; digest: string }>(createRes.body);
    check(createRes.statusCode === 200 && !!created.data?.id, 'source create', createRes.body.slice(0, 300));
    if (!created.data?.id) {
      summary('t08-review2-deploy-guard');
      return;
    }
    const sourceId = created.data.id;
    createdIds.push(sourceId);

    // ── P0: source cannot validate via runtime API ───────────────────────
    {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runtime/artifacts/${sourceId}/validate`,
        headers: auth(trainerToken),
      });
      const body = parseBody<unknown>(res.body);
      check(res.statusCode === 409, 'source validate HTTP 409', String(res.statusCode));
      check(
        body.error?.code === 'GRAPH_SOURCE_AUTHORING_ONLY',
        'source validate stable code',
        String(body.error?.code),
      );
      check(
        typeof body.error?.message === 'string' &&
          body.error.message.toLowerCase().includes('authoring-only'),
        'source validate message mentions authoring-only',
        String(body.error?.message),
      );
      const row = await prisma.flowArtifact.findUnique({ where: { id: sourceId } });
      check(row?.status === 'COMPILED', 'source status stays COMPILED after reject', String(row?.status));
    }

    // Direct lib call also rejects
    {
      let code = '';
      try {
        await validateArtifactForRuntime({
          artifactId: sourceId,
          actorId: 't08',
          actorRole: 'TRAINER',
        });
      } catch (e) {
        if (e instanceof ApiError) code = e.code;
      }
      check(code === 'GRAPH_SOURCE_AUTHORING_ONLY', 'lib validate rejects source', code);
    }

    // ── P0: activation rejects even if status forced to VALIDATED ────────
    {
      await prisma.flowArtifact.update({
        where: { id: sourceId },
        data: { status: 'VALIDATED' },
      });
      let code = '';
      let msg = '';
      try {
        await activateDeployment({
          artifactId: sourceId,
          environment: 'SANDBOX',
          channel: 'CANARY',
          actorId: 't08',
          actorRole: 'TRAINER',
        });
      } catch (e) {
        if (e instanceof ApiError) {
          code = e.code;
          msg = e.message;
        }
      }
      check(code === 'GRAPH_SOURCE_AUTHORING_ONLY', 'activate rejects forced-VALIDATED source', code);
      check(msg.toLowerCase().includes('authoring-only'), 'activate message authoring-only', msg);
      // restore COMPILED for cleanliness
      await prisma.flowArtifact.update({
        where: { id: sourceId },
        data: { status: 'COMPILED' },
      });
    }

    // Runtime HTTP activate also rejects
    {
      await prisma.flowArtifact.update({
        where: { id: sourceId },
        data: { status: 'VALIDATED' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/runtime/deployments',
        headers: auth(trainerToken),
        payload: {
          artifactId: sourceId,
          environment: 'SANDBOX',
          channel: 'CANARY',
        },
      });
      const body = parseBody<unknown>(res.body);
      check(res.statusCode === 409, 'source activate HTTP 409', String(res.statusCode));
      check(
        body.error?.code === 'GRAPH_SOURCE_AUTHORING_ONLY',
        'source activate stable code',
        String(body.error?.code),
      );
      await prisma.flowArtifact.update({
        where: { id: sourceId },
        data: { status: 'COMPILED' },
      });
    }

    // ── Compile via DI catalogue (no body.catalogue) ─────────────────────
    const compileRes = await app.inject({
      method: 'POST',
      url: `/api/graph/artifacts/${sourceId}/compile/langflow`,
      headers: auth(trainerToken),
      payload: { environment: 'SANDBOX' },
    });
    const compiled = parseBody<{
      compiled: { id: string; digest: string; template: string; runtimeKind: string };
    }>(compileRes.body);
    check(compileRes.statusCode === 200 && !!compiled.data?.compiled?.id, 'compile via DI ok', compileRes.body.slice(0, 400));
    const compiledId = compiled.data?.compiled?.id;
    if (compiledId) createdIds.push(compiledId);

    // ── P0: body.catalogue rejected (strict schema) ──────────────────────
    {
      const countBefore = await prisma.flowArtifact.count();
      const res = await app.inject({
        method: 'POST',
        url: `/api/graph/artifacts/${sourceId}/compile/langflow`,
        headers: auth(trainerToken),
        payload: {
          environment: 'SANDBOX',
          catalogue: { evil: { Python: { template: { code: { value: 'os.system("x")' } } } } },
        },
      });
      check(res.statusCode === 400, 'catalogue body rejected 400', String(res.statusCode));
      const countAfter = await prisma.flowArtifact.count();
      check(countAfter === countBefore, 'catalogue body zero new artifacts', `${countBefore}→${countAfter}`);
    }
    {
      const countBefore = await prisma.flowArtifact.count();
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/langflow/compile',
        headers: auth(trainerToken),
        payload: {
          graph: g,
          catalogue: { evil: true },
          environment: 'SANDBOX',
        },
      });
      check(res.statusCode === 400, 'ephemeral compile rejects catalogue body', String(res.statusCode));
      const countAfter = await prisma.flowArtifact.count();
      check(countAfter === countBefore, 'ephemeral catalogue body zero writes', `${countBefore}→${countAfter}`);
    }
    {
      // unknown keys also rejected
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
        payload: { graph: g, unexpected: true },
      });
      check(res.statusCode === 400, 'strict create rejects unknown keys', String(res.statusCode));
    }

    // ── Compiled native can pass Langflow validation path ────────────────
    if (compiledId) {
      const row = await getVerifiedFlowArtifact(compiledId);
      check(row.template === GRAPH_LANGFLOW_TEMPLATE_ID, 'compiled template', row.template);
      check(row.runtimeKind === 'LANGFLOW', 'compiled runtimeKind', row.runtimeKind);
      check(isLangflowNativeFlowData(row.artifactJson), 'compiled is native flow.data', '');

      const val = await validateArtifactForRuntime({
        artifactId: compiledId,
        actorId: 't08',
        actorRole: 'TRAINER',
      });
      check(val.status === 'VALIDATED', 'compiled validates to VALIDATED', val.status);
      check(val.runtimeKind === 'LANGFLOW', 'validated runtimeKind', val.runtimeKind);

      const httpVal = await app.inject({
        method: 'POST',
        url: `/api/runtime/artifacts/${compiledId}/validate`,
        headers: auth(trainerToken),
      });
      check(httpVal.statusCode === 200, 'compiled validate HTTP 200', String(httpVal.statusCode));
    }

    // ── P1 shape guard: langflow template with non-native json rejected ──
    {
      const fake = await createFlowArtifact({
        runtimeKind: 'LANGFLOW',
        template: GRAPH_LANGFLOW_TEMPLATE_ID,
        templateVersion: '2',
        compilerVersion: 't08-fake',
        artifactJson: {
          schemaVersion: 'aios.flow-graph/2',
          nodes: [{ id: 'n1', kind: 'input' }],
          edges: [],
        },
        createdBy: 't08',
      });
      createdIds.push(fake.id);
      let code = '';
      try {
        await validateArtifactForRuntime({
          artifactId: fake.id,
          actorId: 't08',
          actorRole: 'TRAINER',
        });
      } catch (e) {
        if (e instanceof ApiError) code = e.code;
      }
      check(
        code === 'GRAPH_LANGFLOW_SHAPE_INVALID' || code === 'CONFLICT',
        'non-native langflow template shape rejected',
        code,
      );
      // Prefer stable dedicated code
      check(
        code === 'GRAPH_LANGFLOW_SHAPE_INVALID',
        'stable GRAPH_LANGFLOW_SHAPE_INVALID code',
        code,
      );
    }

    // ── P1: GET artifact detail ──────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/artifacts/${sourceId}`,
        headers: auth(trainerToken),
      });
      const body = parseBody<{
        id: string;
        digest: string;
        artifactKind: string;
        langflowDeployable: boolean;
        artifactJson: { schemaVersion?: string };
        template: string;
        runtimeKind: string;
        status: string;
        compilerVersion: string;
        createdAt: string;
      }>(res.body);
      check(res.statusCode === 200, 'detail source 200', String(res.statusCode));
      check(body.data?.artifactKind === 'source', 'detail source kind', String(body.data?.artifactKind));
      check(body.data?.langflowDeployable === false, 'detail source not deployable', '');
      check(body.data?.artifactJson?.schemaVersion === 'aios.flow-graph/2', 'detail GraphSpec', '');
      check(body.data?.template === GRAPH_SOURCE_TEMPLATE_ID, 'detail template', '');
      check(typeof body.data?.digest === 'string', 'detail digest', '');
      check(typeof body.data?.createdAt === 'string', 'detail createdAt', '');
    }
    if (compiledId) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/artifacts/${compiledId}`,
        headers: auth(trainerToken),
      });
      const body = parseBody<{
        artifactKind: string;
        langflowDeployable: boolean;
        artifactJson: { nodes?: unknown[]; viewport?: unknown };
      }>(res.body);
      check(res.statusCode === 200, 'detail compiled 200', String(res.statusCode));
      check(body.data?.artifactKind === 'langflow-native', 'detail compiled kind', '');
      check(body.data?.langflowDeployable === true, 'detail compiled deployable', '');
      check(Array.isArray(body.data?.artifactJson?.nodes), 'detail native nodes', '');
      check(body.data?.artifactJson?.viewport != null, 'detail viewport', '');
    }
    {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/artifacts/${sourceId}`,
        headers: auth(memberToken),
      });
      check(res.statusCode === 403, 'detail MEMBER 403', String(res.statusCode));
    }
    {
      const res = await app.inject({
        method: 'GET',
        url: '/api/graph/artifacts/does-not-exist-id',
        headers: auth(trainerToken),
      });
      check(res.statusCode === 404, 'detail not found 404', String(res.statusCode));
    }

    // Ephemeral compile without catalogue body works via DI
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/langflow/compile',
        headers: auth(trainerToken),
        payload: { graph: g, environment: 'SANDBOX' },
      });
      check(res.statusCode === 200, 'ephemeral compile via DI', String(res.statusCode));
    }
  } finally {
    for (const id of createdIds) {
      try {
        await prisma.runtimeDeployment.deleteMany({ where: { artifactId: id } });
      } catch {
        /* ignore */
      }
      try {
        await prisma.flowArtifact.delete({ where: { id } });
      } catch {
        /* ignore */
      }
    }
    await app.close();
    await prisma.$disconnect();
  }

  summary('t08-review2-deploy-guard');
}

main().catch(async (e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t08-review2-deploy-guard');
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
