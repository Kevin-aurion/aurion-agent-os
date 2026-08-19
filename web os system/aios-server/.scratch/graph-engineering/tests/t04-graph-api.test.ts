/**
 * T04 — FDE Graph API (auth, role, validate, diff, compile, artifacts, traces).
 * Run: npx tsx .scratch/graph-engineering/tests/t04-graph-api.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { config } from '../../../src/config.js';
import { signAccess } from '../../../src/lib/auth.js';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import { graphRoutes } from '../../../src/routes/graph.js';
import {
  check,
  echoGraph,
  fail,
  loadMinCatalogue,
  pass,
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
  console.log('── t04-graph-api ──');

  const trainerToken = await signAccess({
    sub: 't04-graph-trainer',
    email: 't04-graph-trainer@test.local',
    role: 'TRAINER',
  });
  const memberToken = await signAccess({
    sub: 't04-graph-member',
    email: 't04-graph-member@test.local',
    role: 'MEMBER',
  });
  const scopedToken = await signAccess({
    sub: 't04-graph-scoped',
    email: 't04-graph-scoped@test.local',
    role: 'TRAINER',
    scope: 'aios:agent-builder',
    audience: config.remoteMcp.resourceUrl,
  });

  const catalogue = loadMinCatalogue();
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
  // Trusted catalogue via server-side DI only (never HTTP body).
  await app.register(graphRoutes, {
    fetchCatalogue: async () => catalogue,
  });

  const createdArtifactIds: string[] = [];

  try {
    // ── Unauthenticated ──────────────────────────────────────────────────
    {
      const res = await app.inject({ method: 'GET', url: '/api/graph/palette' });
      check(res.statusCode === 401, 'palette unauth 401', String(res.statusCode));
    }
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/validate',
        payload: echoGraph(),
      });
      check(res.statusCode === 401, 'validate unauth 401', String(res.statusCode));
    }

    // ── MEMBER 403 ───────────────────────────────────────────────────────
    for (const [method, url, payload] of [
      ['GET', '/api/graph/palette', undefined],
      ['POST', '/api/graph/validate', echoGraph()],
      ['POST', '/api/graph/diff', { before: echoGraph(), after: echoGraph() }],
      ['POST', '/api/graph/langflow/compile', { graph: echoGraph(), environment: 'SANDBOX' }],
      ['POST', '/api/graph/artifacts', { graph: echoGraph() }],
      ['GET', '/api/graph/artifacts', undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: auth(memberToken),
        payload,
      });
      check(res.statusCode === 403, `MEMBER 403 ${method} ${url}`, String(res.statusCode));
    }

    // ── Scoped OAuth 403 ─────────────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/validate',
        headers: auth(scopedToken),
        payload: echoGraph(),
      });
      check(res.statusCode === 403, 'scoped OAuth 403 validate', String(res.statusCode));
    }

    // ── FDE palette ──────────────────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'GET',
        url: '/api/graph/palette',
        headers: auth(trainerToken),
      });
      const body = parseBody<{ items: unknown[] }>(res.body);
      check(res.statusCode === 200 && body.success === true, 'palette FDE ok', res.body.slice(0, 200));
      check(Array.isArray(body.data?.items) && (body.data?.items.length ?? 0) > 0, 'palette items', '');
    }

    // ── Validate happy ───────────────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/validate',
        headers: auth(trainerToken),
        payload: { graph: echoGraph() },
      });
      const body = parseBody<{ valid: boolean }>(res.body);
      check(res.statusCode === 200 && body.data?.valid === true, 'validate ok', res.body.slice(0, 300));
    }

    // ── Malformed graph 400 ──────────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/validate',
        headers: auth(trainerToken),
        payload: { schemaVersion: 'aios.flow-graph/2', nodes: [] },
      });
      check(res.statusCode === 400, 'malformed 400', String(res.statusCode));
    }

    // ── Secret markers 400 ───────────────────────────────────────────────
    {
      const g = echoGraph();
      g.nodes[0]!.config = { api_key: 'sk-leaked-secret-value-abcdef' };
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/validate',
        headers: auth(trainerToken),
        payload: g,
      });
      check(res.statusCode === 400, 'secret marker 400', String(res.statusCode));
      check(!res.body.includes('sk-leaked-secret-value-abcdef'), 'secret not reflected', '');
    }

    // ── Diff ─────────────────────────────────────────────────────────────
    {
      const before = echoGraph();
      const after = echoGraph();
      after.nodes[1]!.position = { x: 500, y: 200 };
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/diff',
        headers: auth(trainerToken),
        payload: { before, after },
      });
      const body = parseBody<{ risk: string; changes: unknown[] }>(res.body);
      check(res.statusCode === 200 && body.data?.risk === 'LOW', 'diff move LOW', res.body.slice(0, 300));
    }

    // ── Compile with DI catalogue (no body.catalogue) ────────────────────
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/langflow/compile',
        headers: auth(trainerToken),
        payload: { graph: echoGraph(), environment: 'SANDBOX' },
      });
      const body = parseBody<{ ok: boolean; flow: { data: { nodes: unknown[] } } }>(res.body);
      check(res.statusCode === 200 && body.success === true, 'compile ok', res.body.slice(0, 200));
      check((body.data?.flow?.data?.nodes?.length ?? 0) === 2, 'compile 2 nodes', '');
    }

    // ── body.catalogue rejected ──────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/langflow/compile',
        headers: auth(trainerToken),
        payload: { graph: echoGraph(), catalogue: { evil: true } },
      });
      check(res.statusCode === 400, 'HTTP catalogue body rejected', String(res.statusCode));
    }

    // ── Unsupported compile 400 ──────────────────────────────────────────
    {
      const g = echoGraph();
      g.nodes.push({
        id: 'n_tool',
        kind: 'tool.read',
        label: 'read',
        position: { x: 250, y: 100 },
        tool: 'mcp:gmail:gmail_list_messages',
        config: {},
      });
      g.edges = [
        { id: 'e1', kind: 'default', source: 'n_start', target: 'n_tool' },
        { id: 'e2', kind: 'default', source: 'n_tool', target: 'n_end' },
      ];
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/langflow/compile',
        headers: auth(trainerToken),
        payload: { graph: g, environment: 'SANDBOX' },
      });
      check(res.statusCode === 400, 'unsupported compile 400', String(res.statusCode));
    }

    // ── Artifact create + list (zero writes on invalid) ──────────────────
    const SOURCE_TEMPLATE = 'graph-engineering-v2-source';
    const beforeCount = await prisma.flowArtifact.count({
      where: { template: SOURCE_TEMPLATE },
    });
    {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
        payload: { graph: { schemaVersion: 'aios.flow-graph/2' } },
      });
      check(bad.statusCode === 400, 'invalid artifact 400', String(bad.statusCode));
      const afterBad = await prisma.flowArtifact.count({
        where: { template: SOURCE_TEMPLATE },
      });
      check(afterBad === beforeCount, 'zero writes on invalid', `${beforeCount}→${afterBad}`);
    }
    {
      const tag = ulid().slice(-6);
      const g = echoGraph({ id: `g_art_${tag}`, name: `artifact-${tag}` });
      const res = await app.inject({
        method: 'POST',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
        payload: { graph: g, metadata: { note: 't04' } },
      });
      const body = parseBody<{
        id: string;
        digest: string;
        reused: boolean;
        runtimeKind: string;
        template: string;
        artifactKind: string;
      }>(res.body);
      check(res.statusCode === 200 && !!body.data?.id, 'artifact create ok', res.body.slice(0, 300));
      check(body.data?.runtimeKind === 'NATIVE', 'source runtimeKind NATIVE', String(body.data?.runtimeKind));
      check(body.data?.template === SOURCE_TEMPLATE, 'source template', String(body.data?.template));
      check(body.data?.artifactKind === 'source', 'source artifactKind', String(body.data?.artifactKind));
      if (body.data?.id) createdArtifactIds.push(body.data.id);

      // content-addressed reuse
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
        payload: { graph: g, metadata: { note: 't04' } },
      });
      const body2 = parseBody<{ id: string; reused: boolean }>(res2.body);
      check(body2.data?.reused === true, 'artifact content-addressed reuse', JSON.stringify(body2.data));
    }

    // ── List artifacts ───────────────────────────────────────────────────
    {
      const res = await app.inject({
        method: 'GET',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
      });
      const body = parseBody<{ items: Array<{ id: string }> }>(res.body);
      check(res.statusCode === 200 && Array.isArray(body.data?.items), 'list artifacts', '');
    }

    // ── Traces (empty ok) ────────────────────────────────────────────────
    if (createdArtifactIds[0]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/artifacts/${createdArtifactIds[0]}/traces`,
        headers: auth(trainerToken),
      });
      const body = parseBody<{ items: unknown[] }>(res.body);
      check(res.statusCode === 200 && Array.isArray(body.data?.items), 'traces list', res.body.slice(0, 200));
    }

    // MEMBER cannot list traces
    if (createdArtifactIds[0]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/graph/artifacts/${createdArtifactIds[0]}/traces`,
        headers: auth(memberToken),
      });
      check(res.statusCode === 403, 'MEMBER traces 403', String(res.statusCode));
    }
  } finally {
    // Cleanup created artifacts (best-effort)
    for (const id of createdArtifactIds) {
      try {
        await prisma.flowArtifact.delete({ where: { id } });
      } catch {
        /* ignore FK */
      }
    }
    await app.close();
    await prisma.$disconnect();
  }

  summary('t04-graph-api');
}

main().catch(async (e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t04-graph-api');
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
