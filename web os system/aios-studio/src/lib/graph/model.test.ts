import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addEdge,
  addNode,
  createDefaultEchoGraph,
  flowToGraph,
  graphToFlow,
  groupIssuesByTarget,
  inferEntryExit,
  issueFocusTarget,
  removeEdge,
  removeNode,
  updateEdge,
  updateNodeConfig,
  updateNodeLabel,
} from './model';
import {
  approvalGatedToolTemplate,
  conditionalRouteTemplate,
  langflowEchoTemplate,
  parallelJoinTemplate,
} from './templates';
import type { GraphIssue, GraphSpecV2 } from './types';

test('default echo graph is strict aios.flow-graph/2 with start→end', () => {
  const graph = createDefaultEchoGraph();
  assert.equal(graph.schemaVersion, 'aios.flow-graph/2');
  assert.equal(graph.revision, 1);
  assert.ok(graph.stateSchema && typeof graph.stateSchema === 'object');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0]!.kind, 'control.start');
  assert.equal(graph.nodes[1]!.kind, 'control.end');
  assert.equal(graph.entryNodeId, graph.nodes[0]!.id);
  assert.deepEqual(graph.exitNodeIds, [graph.nodes[1]!.id]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.source, graph.entryNodeId);
  assert.equal(graph.edges[0]!.target, graph.exitNodeIds[0]);
});

test('graph ↔ React Flow conversion is lossless for default echo', () => {
  const original = createDefaultEchoGraph();
  const flow = graphToFlow(original);
  assert.equal(flow.nodes.length, 2);
  assert.equal(flow.edges.length, 1);
  const restored = flowToGraph(flow, {
    id: original.id,
    name: original.name,
    revision: original.revision,
    stateSchema: original.stateSchema,
  });
  assert.deepEqual(restored, original);
});

test('round-trip preserves revision, stateSchema, tool, schemas, and edge condition', () => {
  const original: GraphSpecV2 = {
    schemaVersion: 'aios.flow-graph/2',
    id: 'g_round',
    name: 'Round trip',
    revision: 7,
    stateSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    entryNodeId: 'n_in',
    exitNodeIds: ['n_out'],
    nodes: [
      {
        id: 'n_in',
        kind: 'input',
        label: 'In',
        position: { x: 10, y: 20 },
        config: { channel: 'chat' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'string' },
      },
      {
        id: 'n_cond',
        kind: 'control.condition',
        label: 'Route',
        position: { x: 200, y: 20 },
        config: { operator: 'contains', matchText: 'ok' },
      },
      {
        id: 'n_tool',
        kind: 'tool.read',
        label: 'Lookup',
        position: { x: 400, y: 0 },
        tool: 'mcp:search:lookup',
        config: {},
      },
      {
        id: 'n_out',
        kind: 'output',
        label: 'Out',
        position: { x: 600, y: 20 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', kind: 'default', source: 'n_in', target: 'n_cond' },
      {
        id: 'e2',
        kind: 'condition',
        source: 'n_cond',
        target: 'n_tool',
        label: 'yes',
        condition: { branch: 'true', operator: 'contains', matchText: 'ok' },
      },
      {
        id: 'e3',
        kind: 'condition',
        source: 'n_cond',
        target: 'n_out',
        condition: { branch: 'false' },
      },
      { id: 'e4', kind: 'default', source: 'n_tool', target: 'n_out' },
    ],
  };
  const restored = flowToGraph(graphToFlow(original), {
    id: original.id,
    name: original.name,
    revision: original.revision,
    stateSchema: original.stateSchema,
  });
  assert.deepEqual(restored, original);
});

test('entry/exit inference uses only explicit kinds and never picks arbitrary nodes', () => {
  const nodes = [
    { id: 'a', kind: 'gateway.summarize' as const, label: 'S', position: { x: 0, y: 0 } },
    { id: 'b', kind: 'tool.read' as const, label: 'T', position: { x: 1, y: 0 }, tool: 'mcp:x:y' },
    { id: 'c', kind: 'control.condition' as const, label: 'C', position: { x: 2, y: 0 } },
  ];
  const empty = inferEntryExit(nodes);
  assert.equal(empty.entryNodeId, null);
  assert.deepEqual(empty.exitNodeIds, []);

  const withStart = inferEntryExit([
    ...nodes,
    { id: 's', kind: 'control.start', label: 'Start', position: { x: -1, y: 0 } },
    { id: 'e', kind: 'control.end', label: 'End', position: { x: 9, y: 0 } },
    { id: 'f', kind: 'control.failure', label: 'Fail', position: { x: 9, y: 40 } },
  ]);
  assert.equal(withStart.entryNodeId, 's');
  assert.deepEqual(withStart.exitNodeIds, ['e', 'f']);
});

test('node and edge add/update/remove helpers mutate graph without data loss', () => {
  let graph = createDefaultEchoGraph();
  graph = addNode(graph, {
    id: 'n_mid',
    kind: 'gateway.classify',
    label: 'Classify',
    position: { x: 250, y: 100 },
    config: { taxonomy: 'topic' },
  });
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes.find((n) => n.id === 'n_mid')?.config?.taxonomy, 'topic');

  graph = updateNodeLabel(graph, 'n_mid', 'Topic classifier');
  graph = updateNodeConfig(graph, 'n_mid', { taxonomy: 'topic', mode: 'strict' });
  assert.equal(graph.nodes.find((n) => n.id === 'n_mid')?.label, 'Topic classifier');
  assert.deepEqual(graph.nodes.find((n) => n.id === 'n_mid')?.config, {
    taxonomy: 'topic',
    mode: 'strict',
  });

  const start = graph.nodes.find((n) => n.kind === 'control.start')!;
  const end = graph.nodes.find((n) => n.kind === 'control.end')!;
  // Replace direct edge with path through mid
  graph = removeEdge(graph, graph.edges[0]!.id);
  graph = addEdge(graph, {
    id: 'e_start_mid',
    kind: 'default',
    source: start.id,
    target: 'n_mid',
  });
  graph = addEdge(graph, {
    id: 'e_mid_end',
    kind: 'default',
    source: 'n_mid',
    target: end.id,
  });
  assert.equal(graph.edges.length, 2);

  graph = updateEdge(graph, 'e_mid_end', { label: 'done', kind: 'default' });
  assert.equal(graph.edges.find((e) => e.id === 'e_mid_end')?.label, 'done');

  graph = removeNode(graph, 'n_mid');
  assert.equal(graph.nodes.find((n) => n.id === 'n_mid'), undefined);
  assert.equal(graph.edges.length, 0); // incident edges removed
  // entry/exit still explicit
  assert.equal(graph.entryNodeId, start.id);
  assert.deepEqual(graph.exitNodeIds, [end.id]);
});

test('issue grouping and focus target select node or edge ids', () => {
  const issues: GraphIssue[] = [
    { code: 'A', path: 'nodes[0]', message: 'bad node', nodeId: 'n1' },
    { code: 'B', path: 'edges[0]', message: 'bad edge', edgeId: 'e1' },
    { code: 'C', path: 'graph', message: 'global' },
    { code: 'D', path: 'nodes[1]', message: 'also node', nodeId: 'n1' },
  ];
  const grouped = groupIssuesByTarget(issues);
  assert.equal(grouped.nodes.get('n1')?.length, 2);
  assert.equal(grouped.edges.get('e1')?.length, 1);
  assert.equal(grouped.global.length, 1);

  assert.deepEqual(issueFocusTarget(issues[0]!), { type: 'node', id: 'n1' });
  assert.deepEqual(issueFocusTarget(issues[1]!), { type: 'edge', id: 'e1' });
  assert.equal(issueFocusTarget(issues[2]!), null);
});

test('quick templates produce valid GraphSpec shapes with distinct support intent', () => {
  const echo = langflowEchoTemplate();
  assert.equal(echo.schemaVersion, 'aios.flow-graph/2');
  assert.equal(echo.nodes[0]!.kind, 'control.start');
  assert.equal(echo.nodes.at(-1)!.kind, 'control.end');

  const route = conditionalRouteTemplate();
  assert.ok(route.nodes.some((n) => n.kind === 'control.condition'));
  assert.ok(route.edges.some((e) => e.kind === 'condition'));

  const gated = approvalGatedToolTemplate();
  assert.ok(gated.nodes.some((n) => n.kind === 'approval.checkpoint'));
  assert.ok(gated.nodes.some((n) => n.kind === 'tool.gated'));
  const cp = gated.nodes.find((n) => n.kind === 'approval.checkpoint')!;
  assert.equal(cp.config?.authority, 'AIOS');
  assert.equal(cp.config?.emits, 'approval.required');

  const parallel = parallelJoinTemplate();
  assert.ok(parallel.nodes.some((n) => n.kind === 'control.parallel'));
  assert.ok(parallel.nodes.some((n) => n.kind === 'control.join'));
});
