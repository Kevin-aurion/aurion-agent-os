import {
  APPROVAL_FIXED_CONFIG,
  ENTRY_KINDS,
  EXIT_KINDS,
  GRAPH_SCHEMA_V2,
  type ApprovalRiskLevel,
  type EdgeKind,
  type GraphEdge,
  type GraphFlowDocument,
  type GraphFlowEdge,
  type GraphFlowNode,
  type GraphIssue,
  type GraphMeta,
  type GraphNode,
  type GraphSpecV2,
  type NodeKind,
} from './types';

function normalizeApprovalRisk(value: unknown): ApprovalRiskLevel {
  return value === 'medium' || value === 'high' ? value : 'high';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function shortId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Deterministic default echo graph that compiles live (control.start → control.end). */
export function createDefaultEchoGraph(): GraphSpecV2 {
  return {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: 'g_echo_default',
    name: 'Langflow Echo',
    revision: 1,
    stateSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    entryNodeId: 'n_start',
    exitNodeIds: ['n_end'],
    nodes: [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 120, y: 160 },
        config: {},
      },
      {
        id: 'n_end',
        kind: 'control.end',
        label: 'End',
        position: { x: 420, y: 160 },
        config: {},
      },
    ],
    edges: [
      {
        id: 'e_start_end',
        kind: 'default',
        source: 'n_start',
        target: 'n_end',
      },
    ],
  };
}

/**
 * Infer entry/exit only from explicit node kinds.
 * Never silently chooses an arbitrary node when none match.
 */
export function inferEntryExit(
  nodes: ReadonlyArray<Pick<GraphNode, 'id' | 'kind'> & Partial<GraphNode>>,
): { entryNodeId: string | null; exitNodeIds: string[] } {
  const entry = nodes.find((n) => ENTRY_KINDS.has(n.kind));
  const exits = nodes.filter((n) => EXIT_KINDS.has(n.kind)).map((n) => n.id);
  return {
    entryNodeId: entry?.id ?? null,
    exitNodeIds: exits,
  };
}

export function graphToFlow(graph: GraphSpecV2): GraphFlowDocument {
  const nodes: GraphFlowNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: 'graphNode',
    position: { x: node.position.x, y: node.position.y },
    data: {
      kind: node.kind,
      label: node.label,
      config: clone(node.config ?? {}),
      inputSchema: node.inputSchema ? clone(node.inputSchema) : undefined,
      outputSchema: node.outputSchema ? clone(node.outputSchema) : undefined,
      tool: node.tool,
    },
  }));

  const edges: GraphFlowEdge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    data: {
      kind: edge.kind,
      condition: edge.condition ? clone(edge.condition) : undefined,
      maxTraversals: edge.maxTraversals,
      label: edge.label,
    },
  }));

  return { nodes, edges };
}

/**
 * Convert React Flow document back to GraphSpec v2.
 * Entry/exit are re-inferred from explicit kinds only; if missing, falls back to
 * previous meta only when still present and kind-valid — otherwise empty and caller
 * must fix (never invents an arbitrary node).
 */
export function flowToGraph(flow: GraphFlowDocument, meta: GraphMeta): GraphSpecV2 {
  const nodes: GraphNode[] = flow.nodes.map((n) => {
    const node: GraphNode = {
      id: n.id,
      kind: n.data.kind,
      label: n.data.label,
      position: { x: n.position.x, y: n.position.y },
    };
    if (n.data.config && Object.keys(n.data.config).length > 0) {
      node.config = clone(n.data.config);
    } else {
      node.config = {};
    }
    if (n.data.inputSchema) node.inputSchema = clone(n.data.inputSchema);
    if (n.data.outputSchema) node.outputSchema = clone(n.data.outputSchema);
    if (n.data.tool) node.tool = n.data.tool;
    if (n.data.kind === 'approval.checkpoint') {
      node.config = {
        ...clone(n.data.config ?? {}),
        ...APPROVAL_FIXED_CONFIG,
        reason: typeof n.data.config?.reason === 'string' ? n.data.config.reason : '',
        risk: normalizeApprovalRisk(n.data.config?.risk),
      };
    }
    return node;
  });

  const edges: GraphEdge[] = flow.edges.map((e) => {
    const edge: GraphEdge = {
      id: e.id,
      kind: (e.data?.kind ?? 'default') as EdgeKind,
      source: e.source,
      target: e.target,
    };
    const label = e.data?.label ?? (typeof e.label === 'string' ? e.label : undefined);
    if (label) edge.label = label;
    if (e.data?.condition) edge.condition = clone(e.data.condition);
    if (typeof e.data?.maxTraversals === 'number') edge.maxTraversals = e.data.maxTraversals;
    return edge;
  });

  const inferred = inferEntryExit(nodes);
  let entryNodeId = inferred.entryNodeId ?? '';
  let exitNodeIds = inferred.exitNodeIds;

  // If inference found nothing, do not invent — leave empty so validation fails closed.
  // Prefer stable ids when present and still kind-valid (already handled by inference).

  return {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: meta.id,
    name: meta.name,
    revision: meta.revision,
    stateSchema: clone(meta.stateSchema),
    entryNodeId,
    exitNodeIds,
    nodes,
    edges,
  };
}

export function addNode(graph: GraphSpecV2, node: GraphNode): GraphSpecV2 {
  if (graph.nodes.some((n) => n.id === node.id)) {
    throw new Error(`duplicate node id: ${node.id}`);
  }
  const next = clone(graph);
  next.nodes = [...next.nodes, clone(node)];
  const inferred = inferEntryExit(next.nodes);
  if (inferred.entryNodeId) next.entryNodeId = inferred.entryNodeId;
  if (inferred.exitNodeIds.length) next.exitNodeIds = inferred.exitNodeIds;
  return next;
}

export function updateNodeLabel(graph: GraphSpecV2, nodeId: string, label: string): GraphSpecV2 {
  const next = clone(graph);
  next.nodes = next.nodes.map((n) => (n.id === nodeId ? { ...n, label } : n));
  return next;
}

export function updateNodeConfig(
  graph: GraphSpecV2,
  nodeId: string,
  config: Record<string, unknown>,
): GraphSpecV2 {
  const next = clone(graph);
  next.nodes = next.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    if (n.kind === 'approval.checkpoint') {
      return {
        ...n,
        config: {
          ...APPROVAL_FIXED_CONFIG,
          reason: typeof config.reason === 'string' ? config.reason : String(config.reason ?? ''),
          risk: normalizeApprovalRisk(config.risk),
        },
      };
    }
    return { ...n, config: clone(config) };
  });
  return next;
}

export function updateNodeFields(
  graph: GraphSpecV2,
  nodeId: string,
  patch: Partial<Pick<GraphNode, 'label' | 'config' | 'tool' | 'inputSchema' | 'outputSchema' | 'position'>>,
): GraphSpecV2 {
  const next = clone(graph);
  next.nodes = next.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const updated: GraphNode = { ...n, ...patch };
    if (patch.config) updated.config = clone(patch.config);
    if (patch.inputSchema) updated.inputSchema = clone(patch.inputSchema);
    if (patch.outputSchema) updated.outputSchema = clone(patch.outputSchema);
    if (n.kind === 'approval.checkpoint' && patch.config) {
      updated.config = {
        ...APPROVAL_FIXED_CONFIG,
        reason: typeof patch.config.reason === 'string' ? patch.config.reason : '',
        risk: normalizeApprovalRisk(patch.config.risk),
      };
    }
    return updated;
  });
  return next;
}

export function removeNode(graph: GraphSpecV2, nodeId: string): GraphSpecV2 {
  const next = clone(graph);
  next.nodes = next.nodes.filter((n) => n.id !== nodeId);
  next.edges = next.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  const inferred = inferEntryExit(next.nodes);
  next.entryNodeId = inferred.entryNodeId ?? '';
  next.exitNodeIds = inferred.exitNodeIds;
  return next;
}

export function addEdge(graph: GraphSpecV2, edge: GraphEdge): GraphSpecV2 {
  if (graph.edges.some((e) => e.id === edge.id)) {
    throw new Error(`duplicate edge id: ${edge.id}`);
  }
  const next = clone(graph);
  next.edges = [...next.edges, clone(edge)];
  return next;
}

export function updateEdge(
  graph: GraphSpecV2,
  edgeId: string,
  patch: Partial<Pick<GraphEdge, 'kind' | 'label' | 'condition' | 'maxTraversals' | 'source' | 'target'>>,
): GraphSpecV2 {
  const next = clone(graph);
  next.edges = next.edges.map((e) => {
    if (e.id !== edgeId) return e;
    const updated: GraphEdge = { ...e, ...patch };
    if (patch.condition !== undefined) {
      updated.condition = patch.condition ? clone(patch.condition) : undefined;
    }
    return updated;
  });
  return next;
}

export function removeEdge(graph: GraphSpecV2, edgeId: string): GraphSpecV2 {
  const next = clone(graph);
  next.edges = next.edges.filter((e) => e.id !== edgeId);
  return next;
}

export function createNodeFromKind(
  kind: NodeKind,
  position: { x: number; y: number },
  label?: string,
): GraphNode {
  const id = shortId('n');
  const base: GraphNode = {
    id,
    kind,
    label: label ?? defaultLabelForKind(kind),
    position: { ...position },
    config: {},
  };
  if (kind === 'approval.checkpoint') {
    base.config = {
      ...APPROVAL_FIXED_CONFIG,
      reason: 'requires human approval',
      risk: 'high',
    };
  }
  if (kind === 'tool.read' || kind === 'tool.gated') {
    base.tool = 'mcp:server:tool';
  }
  if (kind === 'subgraph') {
    base.config = { artifactId: '', digest: '' };
  }
  if (kind === 'control.condition') {
    base.config = { operator: 'contains', matchText: '', caseSensitive: false };
  }
  if (kind === 'control.loop') {
    base.config = { maxTraversals: 3 };
  }
  return base;
}

export function defaultLabelForKind(kind: NodeKind): string {
  const map: Record<NodeKind, string> = {
    input: 'Input',
    output: 'Output',
    'tool.read': 'Read tool',
    'tool.gated': 'Gated tool',
    'gateway.classify': 'Classify',
    'gateway.summarize': 'Summarize',
    'gateway.verify': 'Verify',
    'approval.checkpoint': 'Approval',
    'control.start': 'Start',
    'control.end': 'End',
    'control.condition': 'Condition',
    'control.parallel': 'Parallel',
    'control.join': 'Join',
    'control.loop': 'Loop',
    'control.failure': 'Failure',
    subgraph: 'Subgraph',
  };
  return map[kind] ?? kind;
}

export function groupIssuesByTarget(issues: GraphIssue[]): {
  nodes: Map<string, GraphIssue[]>;
  edges: Map<string, GraphIssue[]>;
  global: GraphIssue[];
} {
  const nodes = new Map<string, GraphIssue[]>();
  const edges = new Map<string, GraphIssue[]>();
  const global: GraphIssue[] = [];
  for (const issue of issues) {
    if (issue.nodeId) {
      const list = nodes.get(issue.nodeId) ?? [];
      list.push(issue);
      nodes.set(issue.nodeId, list);
    } else if (issue.edgeId) {
      const list = edges.get(issue.edgeId) ?? [];
      list.push(issue);
      edges.set(issue.edgeId, list);
    } else {
      global.push(issue);
    }
  }
  return { nodes, edges, global };
}

export function issueFocusTarget(
  issue: GraphIssue,
): { type: 'node' | 'edge'; id: string } | null {
  if (issue.nodeId) return { type: 'node', id: issue.nodeId };
  if (issue.edgeId) return { type: 'edge', id: issue.edgeId };
  return null;
}

export function applyIssueHighlights(
  flow: GraphFlowDocument,
  issues: GraphIssue[],
): GraphFlowDocument {
  const grouped = groupIssuesByTarget(issues);
  return {
    nodes: flow.nodes.map((n) => ({
      ...n,
      data: { ...n.data, hasError: grouped.nodes.has(n.id) },
    })),
    edges: flow.edges.map((e) => ({
      ...e,
      data: { ...e.data, hasError: grouped.edges.has(e.id) },
    })),
  };
}

export function parseJsonSafe(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}
