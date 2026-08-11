/**
 * Review 1 fixes — P0 source vs compiled artifacts, P1 fingerprint + topology, P2 gmail.
 * Run: npx tsx .scratch/graph-engineering/tests/t07-review1-fixes.test.ts
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
import { catalogueFingerprint } from '../../../src/graph/catalogue.js';
import {
  GRAPH_LANGFLOW_TEMPLATE_ID,
  GRAPH_SOURCE_TEMPLATE_ID,
} from '../../../src/graph/types.js';
import { validateGraph } from '../../../src/graph/validate.js';
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

function hasCode(issues: Array<{ code: string }>, code: string): boolean {
  return issues.some((i) => i.code === code);
}

function isNativeLangflowData(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) return false;
  if (!o.viewport || typeof o.viewport !== 'object') return false;
  return (o.nodes as unknown[]).every(
    (n) => n && typeof n === 'object' && (n as { type?: string }).type === 'genericNode',
  );
}

function isGraphSpecSource(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  return (json as { schemaVersion?: string }).schemaVersion === 'aios.flow-graph/2';
}

async function main(): Promise<void> {
  resetCounters();
  console.log('── t07-review1-fixes ──');

  const catalogue = loadMinCatalogue();
  const createdIds: string[] = [];

  // ════════════════════════════════════════════════════════════════════════
  // P1 — exact catalogue fingerprint
  // ════════════════════════════════════════════════════════════════════════
  {
    const a = structuredClone(catalogue) as Record<string, Record<string, Record<string, unknown>>>;
    const b = structuredClone(catalogue) as Record<string, Record<string, Record<string, unknown>>>;
    const fpA = catalogueFingerprint(a);
    const fpB = catalogueFingerprint(b);
    check(fpA === fpB, 'identical catalogues same fingerprint', '');

    // Change only a template/code leaf — names unchanged
    const chat = b.input_output?.ChatInput;
    if (chat && chat.template && typeof chat.template === 'object') {
      const tmpl = chat.template as Record<string, unknown>;
      const code = tmpl.code;
      if (code && typeof code === 'object') {
        (code as Record<string, unknown>).value =
          String((code as Record<string, unknown>).value ?? '') + '\n# fingerprint-probe';
      } else {
        tmpl.code = { type: 'code', value: 'fingerprint-probe-only' };
      }
    }
    const fpChanged = catalogueFingerprint(b);
    check(
      fpChanged !== fpA,
      'fingerprint changes when template/code leaf changes',
      `a=${fpA.slice(0, 12)} b=${fpChanged.slice(0, 12)}`,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // P1 — topology validation gaps
  // ════════════════════════════════════════════════════════════════════════
  {
    // entry kind wrong
    const g = echoGraph();
    g.nodes[0]!.kind = 'gateway.summarize';
    g.entryNodeId = 'n_start';
    // rewire so still reachable structure-ish
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_ENTRY_KIND'), 'entry must be input|control.start', JSON.stringify(v.issues));
  }
  {
    // exit kind wrong
    const g = echoGraph();
    g.nodes.push({
      id: 'n_mid',
      kind: 'gateway.summarize',
      label: 'mid',
      position: { x: 250, y: 100 },
      config: {},
    });
    g.edges = [
      { id: 'e1', kind: 'default', source: 'n_start', target: 'n_mid' },
      { id: 'e2', kind: 'default', source: 'n_mid', target: 'n_end' },
    ];
    g.exitNodeIds = ['n_mid']; // summarize is not a valid exit kind
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'INVALID_EXIT_KIND'), 'exit must be output|end|failure', JSON.stringify(v.issues));
  }
  {
    // exit with outgoing non-loop edge
    const g = echoGraph();
    g.nodes.push({
      id: 'n_after',
      kind: 'output',
      label: 'after',
      position: { x: 600, y: 100 },
      config: {},
    });
    g.exitNodeIds = ['n_end'];
    g.edges = [
      { id: 'e1', kind: 'default', source: 'n_start', target: 'n_end' },
      { id: 'e2', kind: 'default', source: 'n_end', target: 'n_after' }, // exit has outgoing
    ];
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'EXIT_HAS_OUTGOING'),
      'exit cannot have outgoing non-loop edges',
      JSON.stringify(v.issues),
    );
  }
  {
    // loop edge from non-loop node
    const g = echoGraph();
    g.edges.push({
      id: 'e_loop_bad',
      kind: 'loop',
      source: 'n_end',
      target: 'n_start',
      maxTraversals: 2,
    });
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'INVALID_LOOP_SOURCE'),
      'loop edge must originate from control.loop',
      JSON.stringify(v.issues),
    );
  }
  {
    // condition edges without exact true/false
    const g = echoGraph();
    g.nodes = [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'n_if',
        kind: 'control.condition',
        label: 'If',
        position: { x: 200, y: 0 },
        config: { operator: 'equals', matchText: 'x' },
      },
      {
        id: 'n_t',
        kind: 'control.end',
        label: 'T',
        position: { x: 400, y: 0 },
        config: {},
      },
      {
        id: 'n_f',
        kind: 'control.end',
        label: 'F',
        position: { x: 400, y: 100 },
        config: {},
      },
    ];
    g.exitNodeIds = ['n_t', 'n_f'];
    g.edges = [
      { id: 'e0', kind: 'default', source: 'n_start', target: 'n_if' },
      {
        id: 'e1',
        kind: 'condition',
        source: 'n_if',
        target: 'n_t',
        condition: { branch: 'true' },
      },
      {
        id: 'e2',
        kind: 'condition',
        source: 'n_if',
        target: 'n_f',
        condition: { branch: 'true' }, // duplicate true, missing false
      },
    ];
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'INVALID_CONDITION_FANOUT'),
      'condition needs exactly one true and one false branch',
      JSON.stringify(v.issues),
    );
  }
  {
    // condition edge from non-condition node
    const g = echoGraph();
    g.edges = [
      {
        id: 'e1',
        kind: 'condition',
        source: 'n_start',
        target: 'n_end',
        condition: { branch: 'true' },
      },
    ];
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'INVALID_CONDITION_SOURCE'),
      'condition edges only from control.condition',
      JSON.stringify(v.issues),
    );
  }
  {
    // parallel edge from non-parallel
    const g = echoGraph();
    g.edges = [
      { id: 'e1', kind: 'parallel', source: 'n_start', target: 'n_end' },
    ];
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'INVALID_PARALLEL_SOURCE'),
      'parallel edges only from control.parallel',
      JSON.stringify(v.issues),
    );
  }
  {
    // failure edge to non-failure terminal
    const g = echoGraph();
    g.nodes.push({
      id: 'n_fail_src',
      kind: 'gateway.summarize',
      label: 's',
      position: { x: 200, y: 100 },
      config: {},
    });
    g.edges = [
      { id: 'e1', kind: 'default', source: 'n_start', target: 'n_fail_src' },
      { id: 'e2', kind: 'failure', source: 'n_fail_src', target: 'n_end' }, // end is not control.failure
    ];
    const v = validateGraph(g);
    check(
      v.ok === false && hasCode(v.issues, 'INVALID_FAILURE_TARGET'),
      'failure edges must terminate at control.failure',
      JSON.stringify(v.issues),
    );
  }
  {
    // valid failure path
    const g = echoGraph();
    g.nodes = [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'n_work',
        kind: 'gateway.summarize',
        label: 'work',
        position: { x: 200, y: 0 },
        config: {},
      },
      {
        id: 'n_end',
        kind: 'control.end',
        label: 'End',
        position: { x: 400, y: 0 },
        config: {},
      },
      {
        id: 'n_fail',
        kind: 'control.failure',
        label: 'Fail',
        position: { x: 400, y: 120 },
        config: {},
      },
    ];
    g.exitNodeIds = ['n_end', 'n_fail'];
    g.edges = [
      { id: 'e1', kind: 'default', source: 'n_start', target: 'n_work' },
      { id: 'e2', kind: 'default', source: 'n_work', target: 'n_end' },
      { id: 'e3', kind: 'failure', source: 'n_work', target: 'n_fail' },
    ];
    const v = validateGraph(g);
    check(v.ok === true, 'valid failure routing accepted', JSON.stringify(v));
  }

  // ════════════════════════════════════════════════════════════════════════
  // P2 — gmail.com business text must not false-positive
  // ════════════════════════════════════════════════════════════════════════
  {
    const g = echoGraph();
    g.nodes[0]!.label = 'Route Gmail customer mail';
    g.nodes[0]!.config = { note: 'triage gmail.com inbox labels for support' };
    const v = validateGraph(g);
    check(v.ok === true, 'gmail.com in labels/notes allowed', JSON.stringify(v));
  }
  {
    // still reject provider endpoints / credential keys
    const g = echoGraph();
    g.nodes[0]!.config = { endpoint: 'https://api.openai.com/v1' };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'SECRET_OR_PROVIDER_MATERIAL'), 'provider endpoint still rejected', '');
  }
  {
    const g = echoGraph();
    g.nodes[0]!.config = { note: 'call api.openai.com' };
    const v = validateGraph(g);
    check(v.ok === false && hasCode(v.issues, 'SECRET_OR_PROVIDER_MATERIAL'), 'api.openai.com still rejected', '');
  }

  // ════════════════════════════════════════════════════════════════════════
  // P0 — source vs compiled native artifacts (API + real DB)
  // ════════════════════════════════════════════════════════════════════════
  const trainerToken = await signAccess({
    sub: 't07-graph-trainer',
    email: 't07-graph-trainer@test.local',
    role: 'TRAINER',
  });
  const memberToken = await signAccess({
    sub: 't07-graph-member',
    email: 't07-graph-member@test.local',
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
  // Trusted catalogue via server-side DI (never HTTP body).
  await app.register(graphRoutes, {
    fetchCatalogue: async () => catalogue,
  });

  try {
    const tag = ulid().slice(-6).toLowerCase();
    const g = echoGraph({ id: `g_rev1_${tag}`, name: `rev1-echo-${tag}` });

    // Create source artifact
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/graph/artifacts',
      headers: auth(trainerToken),
      payload: { graph: g },
    });
    const createBody = parseBody<{
      id: string;
      digest: string;
      template: string;
      runtimeKind: string;
      artifactKind: string;
    }>(createRes.body);
    check(createRes.statusCode === 200 && !!createBody.data?.id, 'source create ok', createRes.body.slice(0, 400));
    if (!createBody.data?.id) {
      fail('source create', 'no id');
      summary('t07-review1-fixes');
      return;
    }
    createdIds.push(createBody.data.id);

    check(
      createBody.data.template === GRAPH_SOURCE_TEMPLATE_ID,
      'source template id',
      String(createBody.data.template),
    );
    check(
      createBody.data.runtimeKind === 'NATIVE',
      'source runtimeKind is NATIVE (not LANGFLOW)',
      String(createBody.data.runtimeKind),
    );
    check(
      createBody.data.artifactKind === 'source',
      'source artifactKind',
      String(createBody.data.artifactKind),
    );

    const sourceRow = await getVerifiedFlowArtifact(createBody.data.id);
    check(sourceRow.runtimeKind === 'NATIVE', 'DB source runtimeKind NATIVE', sourceRow.runtimeKind);
    check(sourceRow.template === GRAPH_SOURCE_TEMPLATE_ID, 'DB source template', sourceRow.template);
    check(isGraphSpecSource(sourceRow.artifactJson), 'DB source is GraphSpec v2', '');
    check(!isNativeLangflowData(sourceRow.artifactJson), 'DB source is NOT native Langflow data', '');

    // MEMBER cannot compile
    {
      const res = await app.inject({
        method: 'POST',
        url: `/api/graph/artifacts/${createBody.data.id}/compile/langflow`,
        headers: auth(memberToken),
        payload: { environment: 'SANDBOX' },
      });
      check(res.statusCode === 403, 'MEMBER compile/langflow 403', String(res.statusCode));
    }

    const countBeforeCompile = await prisma.flowArtifact.count();

    // Compile to separate LANGFLOW native artifact (DI catalogue, no body.catalogue)
    const compileRes = await app.inject({
      method: 'POST',
      url: `/api/graph/artifacts/${createBody.data.id}/compile/langflow`,
      headers: auth(trainerToken),
      payload: { environment: 'SANDBOX' },
    });
    const compileBody = parseBody<{
      source: { id: string; digest: string; template: string; runtimeKind: string };
      compiled: {
        id: string;
        digest: string;
        template: string;
        runtimeKind: string;
        artifactKind: string;
        catalogueFingerprint: string;
      };
    }>(compileRes.body);
    check(compileRes.statusCode === 200 && !!compileBody.data?.compiled?.id, 'compile/langflow ok', compileRes.body.slice(0, 500));
    if (compileBody.data?.compiled?.id) createdIds.push(compileBody.data.compiled.id);

    check(
      compileBody.data?.source?.id === createBody.data.id,
      'compile returns source id',
      String(compileBody.data?.source?.id),
    );
    check(
      compileBody.data?.compiled?.id !== createBody.data.id,
      'compiled id differs from source',
      '',
    );
    check(
      compileBody.data?.compiled?.runtimeKind === 'LANGFLOW',
      'compiled runtimeKind LANGFLOW',
      String(compileBody.data?.compiled?.runtimeKind),
    );
    check(
      compileBody.data?.compiled?.template === GRAPH_LANGFLOW_TEMPLATE_ID,
      'compiled template',
      String(compileBody.data?.compiled?.template),
    );
    check(
      compileBody.data?.compiled?.artifactKind === 'langflow-native',
      'compiled artifactKind',
      String(compileBody.data?.compiled?.artifactKind),
    );

    if (compileBody.data?.compiled?.id) {
      const compiledRow = await getVerifiedFlowArtifact(compileBody.data.compiled.id);
      check(isNativeLangflowData(compiledRow.artifactJson), 'compiled JSON is native genericNode flow.data', '');
      check(!isGraphSpecSource(compiledRow.artifactJson), 'compiled is not GraphSpec', '');
      const meta = compiledRow.metadata as Record<string, unknown> | null;
      check(meta?.sourceArtifactId === createBody.data.id, 'metadata sourceArtifactId', '');
      check(typeof meta?.sourceDigest === 'string', 'metadata sourceDigest', '');
      check(typeof meta?.catalogueFingerprint === 'string', 'metadata catalogueFingerprint', '');
      check(Array.isArray(meta?.nodeMapping), 'metadata nodeMapping', '');
      check(meta?.environment === 'SANDBOX', 'metadata environment', String(meta?.environment));

      // Existing adapter validation path accepts native data as LANGFLOW
      const { LangflowAdapter } = await import('../../../src/runtime/langflow.js');
      const adapter = new LangflowAdapter({
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'local-validation-only',
      });
      const val = await adapter.validateArtifact({
        artifactId: compiledRow.id,
        artifactJson: compiledRow.artifactJson,
        digest: compiledRow.digest,
      });
      check(val.valid === true, 'LangflowAdapter validates compiled native data', val.errors.join(';'));

      // Source GraphSpec must NOT be treated as deployable LANGFLOW payload shape
      // (native validation requires nodes/edges — GraphSpec has them, but no genericNode).
      // Deployment suitability: only LANGFLOW runtimeKind + langflow template is deployable native.
      check(
        sourceRow.runtimeKind !== 'LANGFLOW',
        'source cannot use LANGFLOW deploy path',
        sourceRow.runtimeKind,
      );
    }

    // Unsupported compile → zero new rows
    {
      const badGraph = echoGraph({ id: `g_bad_${tag}`, name: `bad-${tag}` });
      badGraph.nodes.push({
        id: 'n_tool',
        kind: 'tool.read',
        label: 'read',
        position: { x: 250, y: 100 },
        tool: 'mcp:gmail:gmail_list_messages',
        config: {},
      });
      badGraph.edges = [
        { id: 'e1', kind: 'default', source: 'n_start', target: 'n_tool' },
        { id: 'e2', kind: 'default', source: 'n_tool', target: 'n_end' },
      ];
      const badCreate = await app.inject({
        method: 'POST',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
        payload: { graph: badGraph },
      });
      const badBody = parseBody<{ id: string }>(badCreate.body);
      if (badBody.data?.id) createdIds.push(badBody.data.id);
      const countMid = await prisma.flowArtifact.count();
      const badCompile = await app.inject({
        method: 'POST',
        url: `/api/graph/artifacts/${badBody.data?.id}/compile/langflow`,
        headers: auth(trainerToken),
        payload: { environment: 'SANDBOX' },
      });
      check(badCompile.statusCode === 400, 'unsupported compile 400', String(badCompile.statusCode));
      const countAfter = await prisma.flowArtifact.count();
      check(countAfter === countMid, 'unsupported compile zero new FlowArtifact rows', `${countMid}→${countAfter}`);
    }

    // List distinguishes source vs compiled
    {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/graph/artifacts',
        headers: auth(trainerToken),
      });
      const listBody = parseBody<{
        items: Array<{ id: string; artifactKind: string; template: string; runtimeKind: string }>;
      }>(listRes.body);
      check(listRes.statusCode === 200, 'list ok', '');
      const items = listBody.data?.items ?? [];
      const src = items.find((i) => i.id === createBody.data.id);
      const cmp = items.find((i) => i.id === compileBody.data?.compiled?.id);
      check(src?.artifactKind === 'source', 'list source kind', JSON.stringify(src));
      check(cmp?.artifactKind === 'langflow-native', 'list compiled kind', JSON.stringify(cmp));
      check(src?.runtimeKind === 'NATIVE' && cmp?.runtimeKind === 'LANGFLOW', 'list runtimeKinds', '');
    }

    void countBeforeCompile;
  } finally {
    for (const id of createdIds) {
      try {
        await prisma.flowArtifact.delete({ where: { id } });
      } catch {
        /* ignore */
      }
    }
    await app.close();
    await prisma.$disconnect();
  }

  summary('t07-review1-fixes');
}

main().catch(async (e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t07-review1-fixes');
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
