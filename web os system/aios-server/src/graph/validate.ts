// Fail-closed topology + governance validator for GraphSpec v2.
import { deepRedactSecrets } from '../memory/deepredact.js';
import { computeFlowArtifactDigest } from '../lib/flowartifact.js';
import {
  GRAPH_SCHEMA_V2,
  graphSpecV2Schema,
  type GraphEdge,
  type GraphIssue,
  type GraphNode,
  type GraphSpecV2,
  type GraphValidationResult,
} from './types.js';

const CAPABILITY_ID_RE = /^mcp:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;

const FORBIDDEN_CONFIG_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'credential',
  'accessToken',
  'refreshToken',
  'passwordHash',
  'authorization',
]);

const FORBIDDEN_PROVIDER_KEYS = new Set([
  'provider',
  'modelprovider',
  'baseurl',
  'api_base',
  'apibase',
  'endpoint',
  'openai_api_key',
  'anthropic_api_key',
]);

/**
 * Provider / secret markers in free-form string leaves.
 * Deliberately excludes bare `gmail.com` so ordinary business labels
 * ("triage gmail.com inbox") are not false-positives. Credential keys and
 * explicit API hostnames (api.openai.com / api.anthropic.com) still reject.
 */
const PROVIDER_MARKERS_RE =
  /\b(openai|anthropic|sk-[A-Za-z0-9]{8,}|api\.openai\.com|api\.anthropic\.com)\b/i;

const CHECKPOINT_CONFIG_KEYS = new Set([
  'reason',
  'risk',
  'authority',
  'emits',
  'resumeRequires',
]);

function issue(
  code: string,
  path: string,
  message: string,
  extra?: { nodeId?: string; edgeId?: string },
): GraphIssue {
  return {
    code,
    path,
    message,
    ...(extra?.nodeId ? { nodeId: extra.nodeId } : {}),
    ...(extra?.edgeId ? { edgeId: extra.edgeId } : {}),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function walkSecrets(value: unknown, path: string, out: GraphIssue[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (PROVIDER_MARKERS_RE.test(value)) {
      out.push(issue('SECRET_OR_PROVIDER_MATERIAL', path, 'forbidden provider/secret marker in string leaf'));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkSecrets(item, `${path}[${i}]`, out));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, child] of Object.entries(value)) {
    const kl = k.toLowerCase();
    if (FORBIDDEN_CONFIG_KEYS.has(kl) || FORBIDDEN_CONFIG_KEYS.has(k)) {
      out.push(issue('SECRET_OR_PROVIDER_MATERIAL', `${path}.${k}`, `forbidden credential key "${k}"`));
    }
    if (FORBIDDEN_PROVIDER_KEYS.has(kl)) {
      out.push(issue('SECRET_OR_PROVIDER_MATERIAL', `${path}.${k}`, `forbidden provider field "${k}"`));
    }
    walkSecrets(child, `${path}.${k}`, out);
  }
}

function assertApprovalCheckpoint(node: GraphNode, path: string, out: GraphIssue[]): void {
  const config = node.config;
  if (!isPlainObject(config)) {
    out.push(
      issue('INVALID_CHECKPOINT_CONFIG', `${path}.config`, 'approval.checkpoint requires config object', {
        nodeId: node.id,
      }),
    );
    return;
  }
  for (const k of Object.keys(config)) {
    if (!CHECKPOINT_CONFIG_KEYS.has(k)) {
      out.push(
        issue('INVALID_CHECKPOINT_CONFIG', `${path}.config.${k}`, `unknown checkpoint key "${k}"`, {
          nodeId: node.id,
        }),
      );
    }
  }
  for (const required of CHECKPOINT_CONFIG_KEYS) {
    if (!(required in config)) {
      out.push(
        issue('INVALID_CHECKPOINT_CONFIG', `${path}.config.${required}`, `missing checkpoint key "${required}"`, {
          nodeId: node.id,
        }),
      );
    }
  }
  if (typeof config.reason !== 'string' || config.reason.trim() === '') {
    out.push(
      issue('INVALID_CHECKPOINT_CONFIG', `${path}.config.reason`, 'reason must be non-empty string', {
        nodeId: node.id,
      }),
    );
  }
  if (config.risk !== 'medium' && config.risk !== 'high') {
    out.push(
      issue('INVALID_CHECKPOINT_CONFIG', `${path}.config.risk`, "risk must be 'medium' or 'high'", {
        nodeId: node.id,
      }),
    );
  }
  if (config.authority !== 'AIOS') {
    out.push(
      issue('INVALID_CHECKPOINT_CONFIG', `${path}.config.authority`, "authority must be exactly 'AIOS'", {
        nodeId: node.id,
      }),
    );
  }
  if (config.emits !== 'approval.required') {
    out.push(
      issue('INVALID_CHECKPOINT_CONFIG', `${path}.config.emits`, "emits must be 'approval.required'", {
        nodeId: node.id,
      }),
    );
  }
  if (config.resumeRequires !== 'aios.approvalRequest.APPROVED') {
    out.push(
      issue(
        'INVALID_CHECKPOINT_CONFIG',
        `${path}.config.resumeRequires`,
        "resumeRequires must be 'aios.approvalRequest.APPROVED'",
        { nodeId: node.id },
      ),
    );
  }
}

function assertSubgraphRef(node: GraphNode, path: string, out: GraphIssue[]): void {
  const config = node.config;
  if (!isPlainObject(config)) {
    out.push(
      issue('INVALID_SUBGRAPH_REF', `${path}.config`, 'subgraph requires config with artifactId+digest', {
        nodeId: node.id,
      }),
    );
    return;
  }
  const artifactId = config.artifactId;
  const digest = config.digest;
  if (typeof artifactId !== 'string' || artifactId.trim() === '') {
    out.push(
      issue('INVALID_SUBGRAPH_REF', `${path}.config.artifactId`, 'subgraph.artifactId must be non-empty', {
        nodeId: node.id,
      }),
    );
  }
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    out.push(
      issue(
        'INVALID_SUBGRAPH_REF',
        `${path}.config.digest`,
        'subgraph.digest must be 64-char lowercase sha256 hex',
        { nodeId: node.id },
      ),
    );
  }
}

function reachableFrom(
  start: string,
  adj: Map<string, string[]>,
  nodes: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const q = [start];
  while (q.length > 0) {
    const cur = q.shift()!;
    if (!nodes.has(cur) || seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) q.push(n);
  }
  return seen;
}

/**
 * Every path from entry to gated is protected iff, after removing all
 * approval.checkpoint nodes, entry cannot reach gated.
 */
function everyPathProtectedByApproval(
  entryId: string,
  gatedId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): boolean {
  const approvalIds = new Set(
    nodes.filter((n) => n.kind === 'approval.checkpoint').map((n) => n.id),
  );
  if (approvalIds.size === 0) return false;

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    // Skip edges into/out-of approval nodes so they act as cut vertices.
    if (approvalIds.has(e.source) || approvalIds.has(e.target)) continue;
    adj.get(e.source)?.push(e.target);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const reach = reachableFrom(entryId, adj, nodeIds);
  return !reach.has(gatedId);
}

/**
 * Validate GraphSpec v2 (schema + topology + governance). Fail-closed.
 * Does not mutate input.
 */
export function validateGraph(input: unknown): GraphValidationResult {
  const issues: GraphIssue[] = [];

  const parsed = graphSpecV2Schema.safeParse(input);
  if (!parsed.success) {
    for (const ziss of parsed.error.issues) {
      issues.push(
        issue(
          'SCHEMA_INVALID',
          ziss.path.length ? ziss.path.join('.') : '(root)',
          ziss.message,
        ),
      );
    }
    return { ok: false, issues };
  }

  const graph = parsed.data;
  if (graph.schemaVersion !== GRAPH_SCHEMA_V2) {
    issues.push(issue('SCHEMA_INVALID', 'schemaVersion', `expected ${GRAPH_SCHEMA_V2}`));
  }

  // Secret gate: deep-redact must not change digest of the graph payload.
  try {
    const before = computeFlowArtifactDigest(graph);
    const redacted = deepRedactSecrets(graph);
    const after = computeFlowArtifactDigest(redacted);
    if (before !== after) {
      issues.push(
        issue(
          'SECRET_OR_PROVIDER_MATERIAL',
          '(root)',
          'graph digest changed after deepRedactSecrets (secret material present)',
        ),
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push(issue('SCHEMA_INVALID', '(root)', `canonicalization failed: ${msg}`));
  }

  walkSecrets(graph, 'graph', issues);

  const nodeById = new Map<string, GraphNode>();
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i]!;
    if (nodeById.has(n.id)) {
      issues.push(issue('DUPLICATE_NODE_ID', `nodes[${i}].id`, `duplicate node id "${n.id}"`, { nodeId: n.id }));
    } else {
      nodeById.set(n.id, n);
    }
  }

  const edgeById = new Map<string, GraphEdge>();
  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i]!;
    if (edgeById.has(e.id)) {
      issues.push(issue('DUPLICATE_EDGE_ID', `edges[${i}].id`, `duplicate edge id "${e.id}"`, { edgeId: e.id }));
    } else {
      edgeById.set(e.id, e);
    }

    if (!nodeById.has(e.source)) {
      issues.push(
        issue('MISSING_ENDPOINT', `edges[${i}].source`, `edge source "${e.source}" is not a node`, {
          edgeId: e.id,
        }),
      );
    }
    if (!nodeById.has(e.target)) {
      issues.push(
        issue('MISSING_ENDPOINT', `edges[${i}].target`, `edge target "${e.target}" is not a node`, {
          edgeId: e.id,
        }),
      );
    }

    if (e.kind === 'condition') {
      if (!e.condition || Object.keys(e.condition).length === 0) {
        issues.push(
          issue('INVALID_CONDITION', `edges[${i}].condition`, 'condition edges require declarative condition', {
            edgeId: e.id,
          }),
        );
      }
    }
    if (e.kind === 'loop') {
      if (e.maxTraversals === undefined) {
        issues.push(
          issue('INVALID_LOOP', `edges[${i}].maxTraversals`, 'loop edges require maxTraversals in 1..50', {
            edgeId: e.id,
          }),
        );
      }
    } else if (e.maxTraversals !== undefined) {
      issues.push(
        issue('INVALID_LOOP', `edges[${i}].maxTraversals`, 'maxTraversals is only valid on loop edges', {
          edgeId: e.id,
        }),
      );
    }
  }

  if (!nodeById.has(graph.entryNodeId)) {
    issues.push(
      issue('MISSING_ENTRY', 'entryNodeId', `entryNodeId "${graph.entryNodeId}" is not a node`, {
        nodeId: graph.entryNodeId,
      }),
    );
  } else {
    const entry = nodeById.get(graph.entryNodeId)!;
    if (entry.kind !== 'input' && entry.kind !== 'control.start') {
      issues.push(
        issue(
          'INVALID_ENTRY_KIND',
          'entryNodeId',
          `entryNodeId kind must be input or control.start, got "${entry.kind}"`,
          { nodeId: graph.entryNodeId },
        ),
      );
    }
  }

  const EXIT_KINDS = new Set(['output', 'control.end', 'control.failure']);
  for (let i = 0; i < graph.exitNodeIds.length; i++) {
    const id = graph.exitNodeIds[i]!;
    if (!nodeById.has(id)) {
      issues.push(issue('MISSING_EXIT', `exitNodeIds[${i}]`, `exit node "${id}" is not a node`, { nodeId: id }));
    } else {
      const exitNode = nodeById.get(id)!;
      if (!EXIT_KINDS.has(exitNode.kind)) {
        issues.push(
          issue(
            'INVALID_EXIT_KIND',
            `exitNodeIds[${i}]`,
            `exit node kind must be output|control.end|control.failure, got "${exitNode.kind}"`,
            { nodeId: id },
          ),
        );
      }
    }
  }

  // Edge origin / target contracts (fail-closed).
  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i]!;
    const src = nodeById.get(e.source);
    const tgt = nodeById.get(e.target);
    if (!src || !tgt) continue;

    if (e.kind === 'loop' && src.kind !== 'control.loop') {
      issues.push(
        issue(
          'INVALID_LOOP_SOURCE',
          `edges[${i}]`,
          'loop edge must originate from control.loop',
          { edgeId: e.id, nodeId: e.source },
        ),
      );
    }
    if (e.kind === 'condition' && src.kind !== 'control.condition') {
      issues.push(
        issue(
          'INVALID_CONDITION_SOURCE',
          `edges[${i}]`,
          'condition edges may originate only from control.condition',
          { edgeId: e.id, nodeId: e.source },
        ),
      );
    }
    if (e.kind === 'parallel' && src.kind !== 'control.parallel') {
      issues.push(
        issue(
          'INVALID_PARALLEL_SOURCE',
          `edges[${i}]`,
          'parallel edges may originate only from control.parallel',
          { edgeId: e.id, nodeId: e.source },
        ),
      );
    }
    if (e.kind === 'failure' && tgt.kind !== 'control.failure') {
      issues.push(
        issue(
          'INVALID_FAILURE_TARGET',
          `edges[${i}]`,
          'failure edges must terminate at control.failure',
          { edgeId: e.id, nodeId: e.target },
        ),
      );
    }
  }

  // Exit nodes cannot have outgoing non-loop execution edges.
  for (const exitId of graph.exitNodeIds) {
    if (!nodeById.has(exitId)) continue;
    const outgoingNonLoop = graph.edges.filter(
      (e) => e.source === exitId && e.kind !== 'loop',
    );
    if (outgoingNonLoop.length > 0) {
      issues.push(
        issue(
          'EXIT_HAS_OUTGOING',
          `exitNodeIds`,
          `exit node "${exitId}" cannot have outgoing non-loop edges`,
          { nodeId: exitId },
        ),
      );
    }
  }

  // Build adjacency (all edges / non-loop edges).
  const fwdAll = new Map<string, string[]>();
  const fwdNonLoop = new Map<string, string[]>();
  const revAll = new Map<string, string[]>();
  for (const id of nodeById.keys()) {
    fwdAll.set(id, []);
    fwdNonLoop.set(id, []);
    revAll.set(id, []);
  }
  for (const e of graph.edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    fwdAll.get(e.source)!.push(e.target);
    revAll.get(e.target)!.push(e.source);
    if (e.kind !== 'loop') {
      fwdNonLoop.get(e.source)!.push(e.target);
    }
  }

  const nodeIds = new Set(nodeById.keys());

  // Reachability from entry.
  if (nodeById.has(graph.entryNodeId)) {
    const fromEntry = reachableFrom(graph.entryNodeId, fwdAll, nodeIds);
    for (const id of nodeIds) {
      if (!fromEntry.has(id)) {
        issues.push(
          issue('UNREACHABLE_NODE', `nodes[id=${id}]`, `node "${id}" is unreachable from entry`, { nodeId: id }),
        );
      }
    }
  }

  // Terminal set: explicit exits + control.failure / control.end / output nodes listed or kind-based.
  const terminals = new Set<string>(graph.exitNodeIds);
  for (const n of graph.nodes) {
    if (n.kind === 'control.failure' || n.kind === 'control.end' || n.kind === 'output') {
      terminals.add(n.id);
    }
  }

  // Reverse reachability to terminals.
  const revAdj = revAll;
  const canReachTerminal = new Set<string>();
  {
    const q = [...terminals];
    while (q.length > 0) {
      const cur = q.shift()!;
      if (canReachTerminal.has(cur)) continue;
      canReachTerminal.add(cur);
      for (const p of revAdj.get(cur) ?? []) q.push(p);
    }
  }
  for (const id of nodeIds) {
    if (!canReachTerminal.has(id)) {
      issues.push(
        issue(
          'NO_PATH_TO_TERMINAL',
          `nodes[id=${id}]`,
          `node "${id}" cannot reach an exit/failure terminal`,
          { nodeId: id },
        ),
      );
    }
  }

  // Cycles without loop edges: non-loop subgraph must be a DAG.
  {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of nodeIds) color.set(id, WHITE);
    const dfs = (u: string): boolean => {
      color.set(u, GRAY);
      for (const v of fwdNonLoop.get(u) ?? []) {
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) return true;
        if (c === WHITE && dfs(v)) return true;
      }
      color.set(u, BLACK);
      return false;
    };
    for (const id of nodeIds) {
      if ((color.get(id) ?? WHITE) === WHITE && dfs(id)) {
        issues.push(
          issue(
            'UNBOUNDED_CYCLE',
            'edges',
            'cycle detected without an explicit loop edge (fail-closed)',
          ),
        );
        break;
      }
    }
  }

  // Per-node structural rules.
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i]!;
    const path = `nodes[${i}]`;
    const outgoing = graph.edges.filter((e) => e.source === n.id);
    const incoming = graph.edges.filter((e) => e.target === n.id);

    if (n.kind === 'control.condition') {
      const condOut = outgoing.filter((e) => e.kind === 'condition');
      const trueBranches = condOut.filter((e) => e.condition?.branch === 'true');
      const falseBranches = condOut.filter((e) => e.condition?.branch === 'false');
      // Native deterministic contract: exactly one true and one false branch.
      if (trueBranches.length !== 1 || falseBranches.length !== 1 || condOut.length !== 2) {
        issues.push(
          issue(
            'INVALID_CONDITION_FANOUT',
            path,
            'control.condition requires exactly one condition.branch=true and one condition.branch=false edge',
            { nodeId: n.id },
          ),
        );
      }
      // Node-level condition config should declare operator/match for native compile path.
      const cfg = n.config ?? {};
      if (isPlainObject(cfg)) {
        const op = cfg.operator;
        const match = cfg.matchText;
        if (op !== undefined || match !== undefined) {
          if (typeof op !== 'string' || typeof match !== 'string') {
            issues.push(
              issue(
                'INVALID_CONDITION',
                `${path}.config`,
                'condition config operator/matchText must both be strings when present',
                { nodeId: n.id },
              ),
            );
          }
        }
      }
    }

    if (n.kind === 'control.parallel') {
      const parOut = outgoing.filter((e) => e.kind === 'parallel' || e.kind === 'default');
      if (parOut.length < 2) {
        issues.push(
          issue(
            'INVALID_PARALLEL',
            path,
            'control.parallel requires at least two outgoing branches',
            { nodeId: n.id },
          ),
        );
      }
    }

    if (n.kind === 'control.join') {
      if (incoming.length < 2) {
        issues.push(
          issue('INVALID_JOIN', path, 'control.join requires at least two incoming edges', {
            nodeId: n.id,
          }),
        );
      }
    }

    if (n.kind === 'control.loop') {
      const loopEdges = outgoing.filter((e) => e.kind === 'loop');
      if (loopEdges.length < 1) {
        issues.push(
          issue('INVALID_LOOP', path, 'control.loop requires at least one outgoing loop edge', {
            nodeId: n.id,
          }),
        );
      }
    }

    if (n.kind === 'approval.checkpoint') {
      assertApprovalCheckpoint(n, path, issues);
    }

    if (n.kind === 'subgraph') {
      assertSubgraphRef(n, path, issues);
    }

    if (n.kind === 'tool.read' || n.kind === 'tool.gated') {
      if (typeof n.tool !== 'string' || !CAPABILITY_ID_RE.test(n.tool)) {
        issues.push(
          issue(
            'INVALID_TOOL',
            `${path}.tool`,
            `${n.kind} requires capability id tool matching mcp:<server>:<tool>`,
            { nodeId: n.id },
          ),
        );
      }
    }

    if (n.kind === 'tool.gated') {
      if (nodeById.has(graph.entryNodeId)) {
        const protectedOk = everyPathProtectedByApproval(
          graph.entryNodeId,
          n.id,
          graph.nodes,
          graph.edges,
        );
        if (!protectedOk) {
          issues.push(
            issue(
              'GATED_WITHOUT_APPROVAL',
              path,
              'tool.gated must be protected on every incoming path by approval.checkpoint',
              { nodeId: n.id },
            ),
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, graph, issues: [] };
}

/** Parse-only (schema) without topology — useful for upgrade path checks. */
export function parseGraphSpecV2(input: unknown): GraphValidationResult {
  return validateGraph(input);
}
