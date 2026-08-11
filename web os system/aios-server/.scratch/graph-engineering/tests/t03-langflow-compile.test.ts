/**
 * T03 — Native Langflow compiler (frozen catalogue fixture).
 * Run: npx tsx .scratch/graph-engineering/tests/t03-langflow-compile.test.ts
 */
import { catalogueFingerprint } from '../../../src/graph/catalogue.js';
import { compileGraphToLangflow } from '../../../src/graph/compile-langflow.js';
import {
  approvalGatedGraph,
  check,
  echoGraph,
  fail,
  linearIoGraph,
  loadMinCatalogue,
  resetCounters,
  summary,
} from './helpers.js';

async function main(): Promise<void> {
  resetCounters();
  console.log('── t03-langflow-compile ──');

  const catalogue = loadMinCatalogue();
  const fp = catalogueFingerprint(catalogue);
  check(typeof fp === 'string' && /^[a-f0-9]{64}$/.test(fp), 'catalogue fingerprint', fp);

  // Echo graph → ChatInput + ChatOutput
  {
    const r1 = compileGraphToLangflow(echoGraph(), catalogue);
    const r2 = compileGraphToLangflow(echoGraph(), catalogue);
    check(r1.ok === true, 'echo compile ok', JSON.stringify(r1.issues));
    if (r1.ok && r2.ok) {
      check(r1.catalogueFingerprint === fp, 'fingerprint matches', r1.catalogueFingerprint);
      check(
        JSON.stringify(r1.flow) === JSON.stringify(r2.flow),
        'compile deterministic',
        '',
      );
      const nodes = r1.flow.data.nodes as Array<Record<string, unknown>>;
      check(nodes.length === 2, 'two native nodes', String(nodes.length));
      check(
        nodes.every((n) => n.type === 'genericNode'),
        'genericNode type',
        '',
      );
      const types = nodes.map((n) => (n.data as { type?: string })?.type).sort();
      check(
        types[0] === 'ChatInput' && types[1] === 'ChatOutput',
        'ChatInput+ChatOutput mapping',
        types.join(','),
      );
      check(
        Array.isArray(r1.flow.data.edges) && r1.flow.data.edges.length === 1,
        'one edge',
        '',
      );
      check(
        r1.flow.data.viewport && typeof r1.flow.data.viewport.zoom === 'number',
        'viewport present',
        '',
      );
      check(
        r1.nodeMapping.every((m) => m.status === 'mapped'),
        'all mapped',
        '',
      );
    }
  }

  // input/output kinds
  {
    const r = compileGraphToLangflow(linearIoGraph(), catalogue);
    check(r.ok === true, 'input/output compile ok', JSON.stringify(r));
  }

  // Unsupported: never no-op Pass for approval/tool
  {
    const r = compileGraphToLangflow(approvalGatedGraph(), catalogue);
    check(r.ok === false, 'approval-gated compile fails closed', '');
    if (!r.ok) {
      check(
        r.issues.some((i) => i.code === 'UNSUPPORTED_NODE_KIND'),
        'UNSUPPORTED_NODE_KIND present',
        r.issues.map((i) => i.code).join(','),
      );
      check(
        r.nodeMapping.some((m) => m.kind === 'approval.checkpoint' && m.status === 'unsupported'),
        'approval not mapped to Human Input',
        '',
      );
      check(
        r.nodeMapping.some((m) => m.kind === 'tool.gated' && m.status === 'unsupported'),
        'tool.gated unsupported',
        '',
      );
      // Ensure no Pass substitution pretending success
      check(r.flow === null, 'no flow on failure', '');
      const passMapped = r.nodeMapping.some((m) => m.componentType === 'Pass');
      check(!passMapped, 'no Pass no-op substitution', '');
    }
  }

  // Condition with full contract maps to ConditionalRouter
  {
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
        config: { operator: 'equals', matchText: 'yes', caseSensitive: true },
      },
      {
        id: 'n_t',
        kind: 'control.end',
        label: 'TrueEnd',
        position: { x: 400, y: -80 },
        config: {},
      },
      {
        id: 'n_f',
        kind: 'control.end',
        label: 'FalseEnd',
        position: { x: 400, y: 80 },
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
        condition: { branch: 'false' },
      },
    ];
    const r = compileGraphToLangflow(g, catalogue);
    check(r.ok === true, 'condition compile ok', JSON.stringify(r.issues));
    if (r.ok) {
      const types = (r.flow.data.nodes as Array<{ data?: { type?: string } }>).map(
        (n) => n.data?.type,
      );
      check(types.includes('ConditionalRouter'), 'uses ConditionalRouter', types.join(','));
    }
  }

  // Condition without operator/matchText → unsupported (not silent Pass)
  {
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
        config: {}, // incomplete
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
        condition: { branch: 'false' },
      },
    ];
    const r = compileGraphToLangflow(g, catalogue);
    check(r.ok === false, 'incomplete condition unsupported', '');
  }

  // Invalid graph never compiles
  {
    const g = echoGraph();
    g.entryNodeId = 'missing';
    const r = compileGraphToLangflow(g, catalogue);
    check(r.ok === false, 'invalid graph compile fails', '');
  }

  // No credentials in compiled output
  {
    const r = compileGraphToLangflow(echoGraph(), catalogue);
    if (r.ok) {
      const blob = JSON.stringify(r.flow);
      check(!/sk-[A-Za-z0-9]{8,}/.test(blob), 'no sk- secrets in flow', '');
      check(!/api[_-]?key/i.test(blob) || blob.includes('"name":"code"'), 'no api key fields injected', '');
    }
  }

  summary('t03-langflow-compile');
}

main().catch((e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t03-langflow-compile');
  process.exit(1);
});
