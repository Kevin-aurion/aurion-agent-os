// Deterministic structural graph diff + governance risk classifier (no LLM).
import type {
  GraphDiffChange,
  GraphDiffResult,
  GraphPosition,
  GraphSpecV2,
  RiskLevel,
} from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive key-sorted JSON for stable comparisons. */
export function canonicalizeGraphValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeGraphValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalizeGraphValue(obj[key]);
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeGraphValue(value));
}

function posEqual(a: GraphPosition, b: GraphPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

const HIGH_KINDS = new Set([
  'tool.gated',
  'approval.checkpoint',
  'control.failure',
  'control.loop',
  'subgraph',
]);

const HIGH_EDGE_KINDS = new Set(['loop', 'failure']);

function nodeSemanticPayload(n: {
  kind: string;
  label: string;
  config?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tool?: string;
}): string {
  return stableStringify({
    kind: n.kind,
    label: n.label,
    config: n.config ?? {},
    inputSchema: n.inputSchema ?? null,
    outputSchema: n.outputSchema ?? null,
    tool: n.tool ?? null,
  });
}

function edgeSemanticPayload(e: {
  kind: string;
  source: string;
  target: string;
  condition?: unknown;
  maxTraversals?: number;
  label?: string;
}): string {
  return stableStringify({
    kind: e.kind,
    source: e.source,
    target: e.target,
    condition: e.condition ?? null,
    maxTraversals: e.maxTraversals ?? null,
    label: e.label ?? null,
  });
}

function classifyRisk(changes: GraphDiffChange[], before: GraphSpecV2, after: GraphSpecV2): RiskLevel {
  if (changes.length === 0) return 'LOW';

  let medium = false;

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  for (const c of changes) {
    if (c.type === 'node.move') {
      // pure position → stays low unless other changes raise it
      continue;
    }
    if (c.type === 'node.add') {
      const n = afterNodes.get(c.nodeId);
      if (n && HIGH_KINDS.has(n.kind)) return 'HIGH';
      medium = true;
      continue;
    }
    if (c.type === 'node.remove') {
      const n = beforeNodes.get(c.nodeId);
      if (n && HIGH_KINDS.has(n.kind)) return 'HIGH';
      // Removals of non-governance nodes are at least MEDIUM
      medium = true;
      continue;
    }
    if (c.type === 'node.change') {
      const n = afterNodes.get(c.nodeId) ?? beforeNodes.get(c.nodeId);
      if (n && HIGH_KINDS.has(n.kind)) return 'HIGH';
      if (c.fields.some((f) => f === 'kind' || f === 'tool' || f === 'config')) {
        medium = true;
      } else {
        medium = true;
      }
      continue;
    }
    if (c.type === 'edge.add') {
      const e = afterEdges.get(c.edgeId);
      if (e && HIGH_EDGE_KINDS.has(e.kind)) return 'HIGH';
      const tgt = e ? afterNodes.get(e.target) : undefined;
      const src = e ? afterNodes.get(e.source) : undefined;
      if ((tgt && HIGH_KINDS.has(tgt.kind)) || (src && HIGH_KINDS.has(src.kind))) return 'HIGH';
      medium = true;
      continue;
    }
    if (c.type === 'edge.remove') {
      const e = beforeEdges.get(c.edgeId);
      if (e && HIGH_EDGE_KINDS.has(e.kind)) return 'HIGH';
      const tgt = e ? beforeNodes.get(e.target) : undefined;
      const src = e ? beforeNodes.get(e.source) : undefined;
      if ((tgt && HIGH_KINDS.has(tgt.kind)) || (src && HIGH_KINDS.has(src.kind))) return 'HIGH';
      medium = true;
      continue;
    }
    if (c.type === 'edge.change') {
      const e = afterEdges.get(c.edgeId) ?? beforeEdges.get(c.edgeId);
      if (e && HIGH_EDGE_KINDS.has(e.kind)) return 'HIGH';
      medium = true;
      continue;
    }
    if (c.type === 'entry.change' || c.type === 'exit.change' || c.type === 'stateSchema.change') {
      medium = true;
    }
  }

  // Move-only → LOW
  const nonMove = changes.filter((c) => c.type !== 'node.move');
  if (nonMove.length === 0) return 'LOW';

  return medium ? 'MEDIUM' : 'LOW';
}

/**
 * Deterministic structural diff between two validated GraphSpec v2 graphs.
 * Does not mutate inputs.
 */
export function diffGraphs(before: GraphSpecV2, after: GraphSpecV2): GraphDiffResult {
  const changes: GraphDiffChange[] = [];

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  for (const id of beforeNodes.keys()) {
    if (!afterNodes.has(id)) {
      changes.push({ type: 'node.remove', nodeId: id });
    }
  }
  for (const id of afterNodes.keys()) {
    if (!beforeNodes.has(id)) {
      changes.push({ type: 'node.add', nodeId: id });
    }
  }
  for (const [id, a] of afterNodes) {
    const b = beforeNodes.get(id);
    if (!b) continue;
    if (!posEqual(b.position, a.position)) {
      changes.push({ type: 'node.move', nodeId: id, from: { ...b.position }, to: { ...a.position } });
    }
    const fields: string[] = [];
    if (b.kind !== a.kind) fields.push('kind');
    if (b.label !== a.label) fields.push('label');
    if ((b.tool ?? null) !== (a.tool ?? null)) fields.push('tool');
    if (stableStringify(b.config ?? {}) !== stableStringify(a.config ?? {})) fields.push('config');
    if (stableStringify(b.inputSchema ?? null) !== stableStringify(a.inputSchema ?? null)) {
      fields.push('inputSchema');
    }
    if (stableStringify(b.outputSchema ?? null) !== stableStringify(a.outputSchema ?? null)) {
      fields.push('outputSchema');
    }
    // semantic payload catch-all
    if (nodeSemanticPayload(b) !== nodeSemanticPayload(a) && fields.length === 0) {
      fields.push('semantic');
    }
    if (fields.length > 0) {
      changes.push({ type: 'node.change', nodeId: id, fields: fields.sort() });
    }
  }

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  for (const id of beforeEdges.keys()) {
    if (!afterEdges.has(id)) {
      changes.push({ type: 'edge.remove', edgeId: id });
    }
  }
  for (const id of afterEdges.keys()) {
    if (!beforeEdges.has(id)) {
      changes.push({ type: 'edge.add', edgeId: id });
    }
  }
  for (const [id, a] of afterEdges) {
    const b = beforeEdges.get(id);
    if (!b) continue;
    if (edgeSemanticPayload(b) !== edgeSemanticPayload(a)) {
      const fields: string[] = [];
      if (b.kind !== a.kind) fields.push('kind');
      if (b.source !== a.source) fields.push('source');
      if (b.target !== a.target) fields.push('target');
      if (stableStringify(b.condition ?? null) !== stableStringify(a.condition ?? null)) {
        fields.push('condition');
      }
      if ((b.maxTraversals ?? null) !== (a.maxTraversals ?? null)) fields.push('maxTraversals');
      if ((b.label ?? null) !== (a.label ?? null)) fields.push('label');
      if (fields.length === 0) fields.push('semantic');
      changes.push({ type: 'edge.change', edgeId: id, fields: fields.sort() });
    }
  }

  if (before.entryNodeId !== after.entryNodeId) {
    changes.push({ type: 'entry.change', from: before.entryNodeId, to: after.entryNodeId });
  }

  const beforeExits = new Set(before.exitNodeIds);
  const afterExits = new Set(after.exitNodeIds);
  const exitAdded = [...afterExits].filter((x) => !beforeExits.has(x)).sort();
  const exitRemoved = [...beforeExits].filter((x) => !afterExits.has(x)).sort();
  if (exitAdded.length > 0 || exitRemoved.length > 0) {
    changes.push({ type: 'exit.change', added: exitAdded, removed: exitRemoved });
  }

  if (stableStringify(before.stateSchema) !== stableStringify(after.stateSchema)) {
    changes.push({ type: 'stateSchema.change' });
  }

  // Stable order for determinism
  changes.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));

  const risk = classifyRisk(changes, before, after);
  const summary =
    changes.length === 0
      ? 'no structural changes'
      : `${changes.length} change(s); risk=${risk}`;

  return { changes, risk, summary };
}

/** Deep-clone helper for tests / callers that need isolation. */
export function cloneGraph(graph: GraphSpecV2): GraphSpecV2 {
  return JSON.parse(JSON.stringify(graph)) as GraphSpecV2;
}

export function isGraphSpecShape(v: unknown): v is GraphSpecV2 {
  return isPlainObject(v) && v.schemaVersion === 'aios.flow-graph/2';
}
