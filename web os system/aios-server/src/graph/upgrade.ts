// Deterministic aios.flow-graph/1 → aios.flow-graph/2 compatibility upgrade.
// Never mutates the input object.
import { createHash } from 'node:crypto';
import {
  GRAPH_SCHEMA_V1,
  GRAPH_SCHEMA_V2,
  type GraphEdge,
  type GraphNode,
  type GraphSpecV2,
  type NodeKind,
} from './types.js';

const KNOWN_V1_KINDS = new Set<string>([
  'input',
  'output',
  'tool.read',
  'tool.gated',
  'gateway.classify',
  'gateway.summarize',
  'gateway.verify',
  'approval.checkpoint',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stableShortId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

function defaultLabel(kind: string, id: string): string {
  return `${kind} (${id})`;
}

function asNodeKind(kind: string): NodeKind {
  if (KNOWN_V1_KINDS.has(kind)) return kind as NodeKind;
  // Unknown v1 kinds surface as-is only if they already match v2 enum; otherwise keep as input-like fallthrough via cast fail later.
  return kind as NodeKind;
}

export type UpgradeResult =
  | { ok: true; graph: GraphSpecV2; fromVersion: typeof GRAPH_SCHEMA_V1 }
  | { ok: false; error: string };

/**
 * Upgrade a v1 AIOS flow-graph artifact to GraphSpec v2.
 * Pure / deterministic. Does not mutate `input`.
 */
export function upgradeFlowGraphV1ToV2(input: unknown): UpgradeResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'v1 graph must be a plain object' };
  }

  // Deep clone so callers cannot observe mutation of nested structures we read.
  const src = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;

  const schemaVersion = src.schemaVersion;
  if (schemaVersion === GRAPH_SCHEMA_V2) {
    // Already v2 — still return a deep clone as GraphSpecV2-shaped if possible.
    return {
      ok: false,
      error: `expected ${GRAPH_SCHEMA_V1}, got ${GRAPH_SCHEMA_V2} (use validateGraph instead)`,
    };
  }
  if (schemaVersion !== GRAPH_SCHEMA_V1) {
    return {
      ok: false,
      error: `unsupported schemaVersion: ${String(schemaVersion)} (expected ${GRAPH_SCHEMA_V1})`,
    };
  }

  const nodesRaw = src.nodes;
  const edgesRaw = src.edges;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    return { ok: false, error: 'v1 graph.nodes must be a non-empty array' };
  }
  if (!Array.isArray(edgesRaw)) {
    return { ok: false, error: 'v1 graph.edges must be an array' };
  }

  const nodes: GraphNode[] = [];
  for (let i = 0; i < nodesRaw.length; i++) {
    const n = nodesRaw[i];
    if (!isPlainObject(n)) {
      return { ok: false, error: `v1 nodes[${i}] must be a plain object` };
    }
    const id = n.id;
    const kind = n.kind;
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `v1 nodes[${i}].id must be a non-empty string` };
    }
    if (typeof kind !== 'string' || kind.trim() === '') {
      return { ok: false, error: `v1 nodes[${i}].kind must be a non-empty string` };
    }
    if (!KNOWN_V1_KINDS.has(kind)) {
      return { ok: false, error: `v1 nodes[${i}].kind "${kind}" is not a known v1 kind` };
    }

    const config =
      n.config !== undefined && isPlainObject(n.config)
        ? (JSON.parse(JSON.stringify(n.config)) as Record<string, unknown>)
        : {};
    const node: GraphNode = {
      id,
      kind: asNodeKind(kind),
      label: typeof n.label === 'string' && n.label.trim() ? n.label : defaultLabel(kind, id),
      position: {
        x: 120 + i * 280,
        y: 160,
      },
      config,
    };
    if (typeof n.tool === 'string' && n.tool.trim()) {
      node.tool = n.tool;
    }
    nodes.push(node);
  }

  const edges: GraphEdge[] = [];
  for (let i = 0; i < edgesRaw.length; i++) {
    const e = edgesRaw[i];
    if (!isPlainObject(e)) {
      return { ok: false, error: `v1 edges[${i}] must be a plain object` };
    }
    const from = e.from;
    const to = e.to;
    if (typeof from !== 'string' || from.trim() === '') {
      return { ok: false, error: `v1 edges[${i}].from must be a non-empty string` };
    }
    if (typeof to !== 'string' || to.trim() === '') {
      return { ok: false, error: `v1 edges[${i}].to must be a non-empty string` };
    }
    const id =
      typeof e.id === 'string' && e.id.trim()
        ? e.id
        : `e_${stableShortId([from, to, String(i)])}`;
    edges.push({
      id,
      kind: 'default',
      source: from,
      target: to,
    });
  }

  const inputNode = nodes.find((n) => n.kind === 'input');
  const outputNodes = nodes.filter((n) => n.kind === 'output');
  const entryNodeId = inputNode?.id ?? nodes[0]!.id;
  const exitNodeIds =
    outputNodes.length > 0 ? outputNodes.map((n) => n.id) : [nodes[nodes.length - 1]!.id];

  const template = typeof src.template === 'string' ? src.template : 'upgraded-v1';
  const templateVersion =
    typeof src.templateVersion === 'string' ? src.templateVersion : '1';
  const graphId = `g_${stableShortId([template, templateVersion, entryNodeId, String(nodes.length)])}`;

  const graph: GraphSpecV2 = {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: graphId,
    name: template,
    revision: 1,
    stateSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    entryNodeId,
    exitNodeIds,
    nodes,
    edges,
  };

  return { ok: true, graph, fromVersion: GRAPH_SCHEMA_V1 };
}
