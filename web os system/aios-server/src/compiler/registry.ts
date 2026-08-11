// Template registry + graph safety checks (defense in depth).
import type { ZodTypeAny } from 'zod';
import { emailTriageReadonlyV1 } from './templates/email-triage-readonly-v1.js';
import { scheduledReportV1 } from './templates/scheduled-report-v1.js';
import { approvalGatedActionV1 } from './templates/approval-gated-action-v1.js';

/** Central MCP capability id: mcp:<serverId>:<tool> */
export const CAPABILITY_ID_RE = /^mcp:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;

export interface TemplateDefinition {
  id: string;
  version: string;
  /** Zod strict schema for template slots. */
  slotSchema: ZodTypeAny;
  /** Pure deterministic graph builder. */
  buildGraph: (slots: Record<string, unknown>) => unknown;
}

/** Only registered templates may compile — never free-form generation. */
export const TEMPLATE_REGISTRY: Record<string, TemplateDefinition> = {
  [emailTriageReadonlyV1.id]: emailTriageReadonlyV1,
  [scheduledReportV1.id]: scheduledReportV1,
  [approvalGatedActionV1.id]: approvalGatedActionV1,
};

export function getTemplate(id: string): TemplateDefinition | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  return TEMPLATE_REGISTRY[id];
}

const ALLOWED_NODE_KINDS = new Set([
  'input',
  'tool.read',
  'gateway.classify',
  'gateway.summarize',
  'gateway.verify',
  'output',
  'approval.checkpoint',
  'tool.gated',
]);

/** Substrings forbidden in tool.read capability last segment (case-insensitive). */
const FORBIDDEN_TOOL_SUBSTR = [
  'send',
  'create',
  'delete',
  'update',
  'upload',
  'write',
  'draft',
  'move',
  'trash',
  'modify',
  'insert',
  'patch',
  'remove',
] as const;

/** Governance/publish/permission substrings banned on tool.gated last segment. */
const GOVERNANCE_TOOL_SUBSTR = [
  'confirm',
  'approve',
  'approval',
  'publish',
  'permission',
  'grant',
  'skill',
  'role',
  'policy',
  'deploy',
] as const;

/** Exact key set required on approval.checkpoint config (nothing else). */
const CHECKPOINT_CONFIG_KEYS = new Set([
  'reason',
  'risk',
  'authority',
  'emits',
  'resumeRequires',
]);

/** Node kinds that are always banned (substring / equality). */
const FORBIDDEN_KIND_TOKENS = new Set([
  'python',
  'custom',
  'code',
  'shell',
  'filesystem',
  'db',
  'provider',
  'send',
  'write',
  // Second-scheduler red line: Flow must never own cron/timer (AIOS Schedule owns scheduling).
  'cron',
  'scheduler',
  'schedule',
  'timer',
  'interval',
]);

/** Config keys that must never appear (credential material). */
const FORBIDDEN_CONFIG_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'credential',
]);

/** Direct provider / endpoint markers forbidden anywhere in string leaves under nodes. */
const PROVIDER_MARKERS_RE =
  /\b(openai|anthropic|gmail\.com|api\.openai\.com|api\.anthropic\.com)\b/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function walkForbiddenConfigKeys(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForbiddenConfigKeys(item, `${path}[${i}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, child] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEYS.has(k.toLowerCase())) {
      throw new Error(`assertGraphSafe: forbidden config key "${k}" at ${path}`);
    }
    walkForbiddenConfigKeys(child, `${path}.${k}`);
  }
}

function walkStringLeavesForProviders(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (PROVIDER_MARKERS_RE.test(value)) {
      throw new Error(`assertGraphSafe: forbidden provider/endpoint marker at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStringLeavesForProviders(item, `${path}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, child] of Object.entries(value)) {
      // Also ban provider-ish keys used as model/provider selectors on gateway nodes
      const kl = k.toLowerCase();
      if (
        kl === 'provider' ||
        kl === 'modelprovider' ||
        kl === 'baseurl' ||
        kl === 'api_base' ||
        kl === 'apibase' ||
        kl === 'endpoint'
      ) {
        throw new Error(`assertGraphSafe: forbidden provider field "${k}" at ${path}`);
      }
      walkStringLeavesForProviders(child, `${path}.${k}`);
    }
  }
}

function assertToolReadOnly(tool: string, path: string): void {
  if (!CAPABILITY_ID_RE.test(tool)) {
    throw new Error(`assertGraphSafe: tool must match capability id at ${path}: ${tool}`);
  }
  const segments = tool.split(':');
  const last = segments[segments.length - 1] ?? '';
  const lower = last.toLowerCase();
  for (const bad of FORBIDDEN_TOOL_SUBSTR) {
    if (lower.includes(bad)) {
      throw new Error(
        `assertGraphSafe: tool segment contains forbidden write-ish substring "${bad}" at ${path}: ${tool}`,
      );
    }
  }
}

/**
 * Validate edges array: must be array; each edge has non-empty string from/to
 * that reference existing node ids. Duplicate node ids → throw.
 * Empty edges array is valid (t07/t08 handcrafted negatives).
 */
function assertEdgesAndNodeIds(
  nodes: unknown[],
  edges: unknown,
): {
  nodeById: Map<string, Record<string, unknown>>;
  edgeList: Array<{ from: string; to: string }>;
} {
  if (!Array.isArray(edges)) {
    throw new Error('assertGraphSafe: graph.edges must be an array');
  }

  const nodeById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!isPlainObject(node)) continue;
    const id = node.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`assertGraphSafe: nodes[${i}].id must be a non-empty string`);
    }
    if (nodeById.has(id)) {
      throw new Error(`assertGraphSafe: duplicate node id "${id}"`);
    }
    nodeById.set(id, node);
  }

  const edgeList: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!isPlainObject(e)) {
      throw new Error(`assertGraphSafe: edges[${i}] must be a plain object`);
    }
    const from = e.from;
    const to = e.to;
    if (typeof from !== 'string' || from.trim() === '') {
      throw new Error(`assertGraphSafe: edges[${i}].from must be a non-empty string`);
    }
    if (typeof to !== 'string' || to.trim() === '') {
      throw new Error(`assertGraphSafe: edges[${i}].to must be a non-empty string`);
    }
    if (!nodeById.has(from)) {
      throw new Error(`assertGraphSafe: edges[${i}].from "${from}" is not a node id`);
    }
    if (!nodeById.has(to)) {
      throw new Error(`assertGraphSafe: edges[${i}].to "${to}" is not a node id`);
    }
    edgeList.push({ from, to });
  }

  return { nodeById, edgeList };
}

/** Reverse BFS: does nodeId have an ancestor whose kind is targetKind? */
function hasAncestorKind(
  nodeId: string,
  targetKind: string,
  edgeList: Array<{ from: string; to: string }>,
  nodeById: Map<string, Record<string, unknown>>,
): boolean {
  const reverse = new Map<string, string[]>();
  for (const e of edgeList) {
    const list = reverse.get(e.to) ?? [];
    list.push(e.from);
    reverse.set(e.to, list);
  }

  const visited = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const parents = reverse.get(cur) ?? [];
    for (const p of parents) {
      const parentNode = nodeById.get(p);
      if (parentNode && parentNode.kind === targetKind) return true;
      queue.push(p);
    }
  }
  return false;
}

function assertToolGatedSafe(
  node: Record<string, unknown>,
  path: string,
  edgeList: Array<{ from: string; to: string }>,
  nodeById: Map<string, Record<string, unknown>>,
): void {
  const tool = node.tool;
  if (typeof tool !== 'string') {
    throw new Error(`assertGraphSafe: tool.gated requires string tool at ${path}`);
  }
  if (!CAPABILITY_ID_RE.test(tool)) {
    throw new Error(`assertGraphSafe: tool.gated tool must match capability id at ${path}: ${tool}`);
  }
  const segments = tool.split(':');
  const last = (segments[segments.length - 1] ?? '').toLowerCase();
  for (const bad of GOVERNANCE_TOOL_SUBSTR) {
    if (last.includes(bad)) {
      throw new Error(
        `assertGraphSafe: tool.gated tool segment contains governance substring "${bad}" at ${path}: ${tool}`,
      );
    }
  }

  const id = node.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`assertGraphSafe: tool.gated node missing id at ${path}`);
  }
  if (!hasAncestorKind(id, 'approval.checkpoint', edgeList, nodeById)) {
    throw new Error(
      `assertGraphSafe: write without preceding approval.checkpoint at ${path} (id=${id})`,
    );
  }
}

function assertApprovalCheckpointConfig(node: Record<string, unknown>, path: string): void {
  const config = node.config;
  if (!isPlainObject(config)) {
    throw new Error(`assertGraphSafe: approval.checkpoint requires plain object config at ${path}`);
  }

  const keys = Object.keys(config);
  for (const k of keys) {
    if (!CHECKPOINT_CONFIG_KEYS.has(k)) {
      throw new Error(
        `assertGraphSafe: approval.checkpoint unknown config key "${k}" at ${path}`,
      );
    }
  }
  for (const required of CHECKPOINT_CONFIG_KEYS) {
    if (!(required in config)) {
      throw new Error(
        `assertGraphSafe: approval.checkpoint missing config key "${required}" at ${path}`,
      );
    }
  }

  if (typeof config.reason !== 'string' || config.reason.trim() === '') {
    throw new Error(`assertGraphSafe: approval.checkpoint reason must be non-empty string at ${path}`);
  }
  if (config.risk !== 'medium' && config.risk !== 'high') {
    throw new Error(
      `assertGraphSafe: approval.checkpoint risk must be 'medium' or 'high' at ${path}`,
    );
  }
  // Langflow has no governance authority — must be literal AIOS.
  if (config.authority !== 'AIOS') {
    throw new Error(
      `assertGraphSafe: approval.checkpoint authority must be exactly 'AIOS' at ${path}`,
    );
  }
  if (config.emits !== 'approval.required') {
    throw new Error(
      `assertGraphSafe: approval.checkpoint emits must be exactly 'approval.required' at ${path}`,
    );
  }
  if (config.resumeRequires !== 'aios.approvalRequest.APPROVED') {
    throw new Error(
      `assertGraphSafe: approval.checkpoint resumeRequires must be exactly 'aios.approvalRequest.APPROVED' at ${path}`,
    );
  }
}

/**
 * Structural safety validation for any template graph output.
 * Fail-closed: throws Error on any violation.
 */
export function assertGraphSafe(graph: unknown): void {
  if (!isPlainObject(graph)) {
    throw new Error('assertGraphSafe: graph must be a plain object');
  }

  const nodes = graph.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error('assertGraphSafe: graph.nodes must be an array');
  }

  // Edges + node id uniqueness (empty edges array is valid).
  const { nodeById, edgeList } = assertEdgesAndNodeIds(nodes, graph.edges);

  // At most one tool.gated write in the whole graph.
  let gatedCount = 0;
  for (const node of nodes) {
    if (isPlainObject(node) && node.kind === 'tool.gated') {
      gatedCount += 1;
    }
  }
  if (gatedCount > 1) {
    throw new Error(
      `assertGraphSafe: multiple tool.gated write nodes (count=${gatedCount})`,
    );
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const path = `nodes[${i}]`;
    if (!isPlainObject(node)) {
      throw new Error(`assertGraphSafe: ${path} must be a plain object`);
    }

    const kind = node.kind;
    if (typeof kind !== 'string' || kind.trim() === '') {
      throw new Error(`assertGraphSafe: ${path}.kind must be a non-empty string`);
    }

    const kindLower = kind.toLowerCase();
    // Ban forbidden kind tokens (exact kind or path segment)
    const kindParts = kindLower.split(/[./]/);
    for (const part of kindParts) {
      if (FORBIDDEN_KIND_TOKENS.has(part)) {
        throw new Error(`assertGraphSafe: forbidden node kind "${kind}" at ${path}`);
      }
    }
    if (FORBIDDEN_KIND_TOKENS.has(kindLower)) {
      throw new Error(`assertGraphSafe: forbidden node kind "${kind}" at ${path}`);
    }

    if (!ALLOWED_NODE_KINDS.has(kind)) {
      throw new Error(`assertGraphSafe: node kind not in allowlist: "${kind}" at ${path}`);
    }

    // tool.read: capability id + read-only last segment
    if (kind === 'tool.read') {
      const tool = node.tool;
      if (typeof tool !== 'string') {
        throw new Error(`assertGraphSafe: tool.read requires string tool at ${path}`);
      }
      assertToolReadOnly(tool, `${path}.tool`);
    }

    // tool.gated: capability id, no governance substrings, checkpoint ancestor
    if (kind === 'tool.gated') {
      assertToolGatedSafe(node, path, edgeList, nodeById);
    }

    // approval.checkpoint: exact config key set + AIOS authority contract
    if (kind === 'approval.checkpoint') {
      assertApprovalCheckpointConfig(node, path);
    }

    // gateway.* must be declarative ops only — no provider/model API address
    if (kind.startsWith('gateway.')) {
      walkStringLeavesForProviders(node, path);
    }

    // Credential keys anywhere under the node
    walkForbiddenConfigKeys(node, path);
  }

  // Also scan whole graph string leaves for provider markers (defense in depth)
  walkStringLeavesForProviders(graph, 'graph');
}
