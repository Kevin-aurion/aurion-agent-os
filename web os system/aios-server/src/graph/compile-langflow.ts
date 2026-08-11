// Native Langflow compiler: GraphSpec v2 → Langflow flow JSON (supported subset only).
// Never substitutes unsupported semantics with a no-op Pass that pretends success.
import { createHash } from 'node:crypto';
import {
  catalogueFingerprint,
  deepCloneComponent,
  findComponent,
  type LangflowCatalogue,
} from './catalogue.js';
import { validateGraph } from './validate.js';
import type {
  GraphEdge,
  GraphIssue,
  GraphNode,
  GraphSpecV2,
  LangflowCompileResult,
  NodeCompileMapping,
  NodeKind,
} from './types.js';

const SUPPORTED_INPUT_KINDS = new Set<NodeKind>(['control.start', 'input']);
const SUPPORTED_OUTPUT_KINDS = new Set<NodeKind>(['control.end', 'output']);
const SUPPORTED_CONDITION = 'control.condition' as const;
const SUPPORTED_SUBGRAPH = 'subgraph' as const;

/** AIOS kinds that intentionally stay AIOS-only until a capability bridge exists. */
const EXPLICITLY_UNSUPPORTED = new Set<NodeKind>([
  'tool.read',
  'tool.gated',
  'gateway.classify',
  'gateway.summarize',
  'gateway.verify',
  'approval.checkpoint',
  'control.parallel',
  'control.join',
  'control.loop',
  'control.failure',
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

function lfNodeId(aiosId: string): string {
  // Deterministic, safe id: prefix + sanitized aios id
  const safe = aiosId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `lf_${safe}`;
}

function outputHandleName(def: { outputs?: unknown[] }): string {
  const outs = Array.isArray(def.outputs) ? def.outputs : [];
  for (const o of outs) {
    if (isPlainObject(o) && typeof o.name === 'string' && o.name) return o.name;
  }
  return 'message';
}

function outputTypes(def: { outputs?: unknown[] }, handleName: string): string[] {
  const outs = Array.isArray(def.outputs) ? def.outputs : [];
  for (const o of outs) {
    if (isPlainObject(o) && o.name === handleName && Array.isArray(o.types)) {
      return o.types.filter((t): t is string => typeof t === 'string');
    }
  }
  return ['Message'];
}

function pickInputField(
  def: { template?: Record<string, unknown> },
  preferred: string[],
): { fieldName: string; inputTypes: string[]; type: string } | null {
  const tmpl = def.template ?? {};
  for (const name of preferred) {
    const field = tmpl[name];
    if (!isPlainObject(field)) continue;
    if (field.name === 'code' || name === 'code' || name === '_type') continue;
    const inputTypes = Array.isArray(field.input_types)
      ? field.input_types.filter((t): t is string => typeof t === 'string')
      : [];
    // Prefer handle-capable fields
    if (inputTypes.length > 0 || field.type === 'other' || field._input_type === 'HandleInput') {
      return {
        fieldName: name,
        inputTypes: inputTypes.length > 0 ? inputTypes : ['Message'],
        type: typeof field.type === 'string' ? field.type : 'str',
      };
    }
  }
  // Fallback: first template field with input_types
  for (const [name, field] of Object.entries(tmpl)) {
    if (name === 'code' || name === '_type') continue;
    if (!isPlainObject(field)) continue;
    if (Array.isArray(field.input_types) && field.input_types.length > 0) {
      return {
        fieldName: name,
        inputTypes: field.input_types.filter((t): t is string => typeof t === 'string'),
        type: typeof field.type === 'string' ? field.type : 'str',
      };
    }
  }
  return null;
}

function buildGenericNode(
  aiosNode: GraphNode,
  componentType: string,
  def: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const id = lfNodeId(aiosNode.id);
  const nodeDef = deepCloneComponent(def as never);
  // Never inject credentials into template values.
  return {
    id,
    type: 'genericNode',
    position: {
      x: Number.isFinite(aiosNode.position.x) ? aiosNode.position.x : 120 + index * 280,
      y: Number.isFinite(aiosNode.position.y) ? aiosNode.position.y : 160,
    },
    data: {
      id,
      type: componentType,
      node: nodeDef,
    },
  };
}

function buildEdge(
  edge: GraphEdge,
  sourceLfId: string,
  targetLfId: string,
  sourceType: string,
  sourceHandle: string,
  sourceOutputTypes: string[],
  targetField: { fieldName: string; inputTypes: string[]; type: string },
  sourceHandleOverride?: string,
): Record<string, unknown> {
  const outName = sourceHandleOverride ?? sourceHandle;
  const sourceHandleObj = {
    dataType: sourceType,
    id: sourceLfId,
    name: outName,
    output_types: sourceOutputTypes,
  };
  const targetHandleObj = {
    fieldName: targetField.fieldName,
    id: targetLfId,
    inputTypes: targetField.inputTypes,
    type: targetField.type,
  };
  const id = `xy-edge__${sourceLfId}${JSON.stringify(sourceHandleObj)}-${targetLfId}${JSON.stringify(targetHandleObj)}`;
  return {
    id: edge.id || createHash('sha256').update(id).digest('hex').slice(0, 24),
    source: sourceLfId,
    target: targetLfId,
    sourceHandle: JSON.stringify(sourceHandleObj),
    targetHandle: JSON.stringify(targetHandleObj),
    data: {
      sourceHandle: sourceHandleObj,
      targetHandle: targetHandleObj,
    },
  };
}

function mapNodeKind(
  node: GraphNode,
  catalogue: unknown,
): { status: 'mapped'; componentType: string; def: Record<string, unknown> } | {
  status: 'unsupported';
  reason: string;
} {
  if (SUPPORTED_INPUT_KINDS.has(node.kind)) {
    const found = findComponent(catalogue, 'ChatInput');
    if (!found) return { status: 'unsupported', reason: 'ChatInput missing from catalogue' };
    return { status: 'mapped', componentType: 'ChatInput', def: found.def as Record<string, unknown> };
  }
  if (SUPPORTED_OUTPUT_KINDS.has(node.kind)) {
    const found = findComponent(catalogue, 'ChatOutput');
    if (!found) return { status: 'unsupported', reason: 'ChatOutput missing from catalogue' };
    return { status: 'mapped', componentType: 'ChatOutput', def: found.def as Record<string, unknown> };
  }
  if (node.kind === SUPPORTED_CONDITION) {
    const cfg = node.config ?? {};
    const operator = typeof cfg.operator === 'string' ? cfg.operator : null;
    const matchText = typeof cfg.matchText === 'string' ? cfg.matchText : null;
    if (!operator || matchText === null) {
      return {
        status: 'unsupported',
        reason:
          'control.condition requires declarative config.operator + config.matchText for ConditionalRouter',
      };
    }
    const found = findComponent(catalogue, 'ConditionalRouter');
    if (!found) {
      return { status: 'unsupported', reason: 'ConditionalRouter missing from catalogue' };
    }
    return {
      status: 'mapped',
      componentType: 'ConditionalRouter',
      def: found.def as Record<string, unknown>,
    };
  }
  if (node.kind === SUPPORTED_SUBGRAPH) {
    const cfg = node.config ?? {};
    const artifactId = typeof cfg.artifactId === 'string' ? cfg.artifactId : '';
    const digest = typeof cfg.digest === 'string' ? cfg.digest : '';
    if (!artifactId || !/^[a-f0-9]{64}$/.test(digest)) {
      return {
        status: 'unsupported',
        reason: 'subgraph requires immutable artifactId + sha256 digest binding',
      };
    }
    const found = findComponent(catalogue, 'SubFlow');
    if (!found) return { status: 'unsupported', reason: 'SubFlow missing from catalogue' };
    return { status: 'mapped', componentType: 'SubFlow', def: found.def as Record<string, unknown> };
  }

  if (EXPLICITLY_UNSUPPORTED.has(node.kind)) {
    return {
      status: 'unsupported',
      reason: `UNSUPPORTED_NODE_KIND: ${node.kind} has no semantics-preserving native Langflow mapping (AIOS-only until capability bridge)`,
    };
  }

  return {
    status: 'unsupported',
    reason: `UNSUPPORTED_NODE_KIND: ${node.kind}`,
  };
}

function applyConditionConfig(
  def: Record<string, unknown>,
  node: GraphNode,
): Record<string, unknown> {
  const cloned = deepCloneComponent(def as never) as Record<string, unknown>;
  const tmpl = isPlainObject(cloned.template) ? { ...cloned.template } : {};
  const cfg = node.config ?? {};
  if (isPlainObject(tmpl.match_text) && typeof cfg.matchText === 'string') {
    tmpl.match_text = { ...tmpl.match_text, value: cfg.matchText };
  }
  if (isPlainObject(tmpl.operator) && typeof cfg.operator === 'string') {
    tmpl.operator = { ...tmpl.operator, value: cfg.operator };
  }
  if (isPlainObject(tmpl.case_sensitive) && typeof cfg.caseSensitive === 'boolean') {
    tmpl.case_sensitive = { ...tmpl.case_sensitive, value: cfg.caseSensitive };
  }
  cloned.template = tmpl;
  return cloned;
}

function applySubflowConfig(
  def: Record<string, unknown>,
  node: GraphNode,
): Record<string, unknown> {
  const cloned = deepCloneComponent(def as never) as Record<string, unknown>;
  const tmpl = isPlainObject(cloned.template) ? { ...cloned.template } : {};
  const cfg = node.config ?? {};
  // Bind by immutable artifact digest reference — never embed credentials.
  // flow_name carries a non-secret governed binding label.
  if (isPlainObject(tmpl.flow_name)) {
    const label = `aios-artifact:${String(cfg.artifactId)}@${String(cfg.digest).slice(0, 12)}`;
    tmpl.flow_name = { ...tmpl.flow_name, value: label };
  }
  cloned.template = tmpl;
  return cloned;
}

/**
 * Compile a validated GraphSpec v2 into native Langflow flow JSON.
 * Fail-closed: any unsupported node kind aborts with structured issues (no no-op substitution).
 */
export function compileGraphToLangflow(
  input: unknown,
  catalogue: LangflowCatalogue | unknown,
): LangflowCompileResult {
  const validation = validateGraph(input);
  if (!validation.ok) {
    return {
      ok: false,
      flow: null,
      nodeMapping: [],
      catalogueFingerprint: null,
      issues: validation.issues,
    };
  }
  const graph: GraphSpecV2 = validation.graph;
  const fp = catalogueFingerprint(catalogue);
  const issues: GraphIssue[] = [];
  const nodeMapping: NodeCompileMapping[] = [];

  const mapped = new Map<
    string,
    {
      lfId: string;
      componentType: string;
      def: Record<string, unknown>;
      lfNode: Record<string, unknown>;
    }
  >();

  // Stable order: original node order
  graph.nodes.forEach((node, index) => {
    const mappedKind = mapNodeKind(node, catalogue);
    if (mappedKind.status === 'unsupported') {
      nodeMapping.push({
        aiosNodeId: node.id,
        kind: node.kind,
        status: 'unsupported',
        reason: mappedKind.reason,
      });
      issues.push(
        issue('UNSUPPORTED_NODE_KIND', `nodes[id=${node.id}]`, mappedKind.reason, {
          nodeId: node.id,
        }),
      );
      return;
    }

    let def = mappedKind.def;
    if (node.kind === 'control.condition') {
      def = applyConditionConfig(def, node);
    }
    if (node.kind === 'subgraph') {
      def = applySubflowConfig(def, node);
    }

    const lfNode = buildGenericNode(node, mappedKind.componentType, def, index);
    const lfId = String(lfNode.id);
    mapped.set(node.id, {
      lfId,
      componentType: mappedKind.componentType,
      def,
      lfNode,
    });
    nodeMapping.push({
      aiosNodeId: node.id,
      kind: node.kind,
      status: 'mapped',
      langflowNodeId: lfId,
      componentType: mappedKind.componentType,
    });
  });

  if (issues.length > 0) {
    return {
      ok: false,
      flow: null,
      nodeMapping,
      catalogueFingerprint: fp,
      issues,
    };
  }

  const lfNodes: unknown[] = [];
  for (const node of graph.nodes) {
    const m = mapped.get(node.id);
    if (m) lfNodes.push(m.lfNode);
  }

  const lfEdges: unknown[] = [];
  for (const edge of graph.edges) {
    const src = mapped.get(edge.source);
    const tgt = mapped.get(edge.target);
    if (!src || !tgt) {
      issues.push(
        issue('MISSING_ENDPOINT', `edges[id=${edge.id}]`, 'edge endpoint not mapped', {
          edgeId: edge.id,
        }),
      );
      continue;
    }

    const srcHandle = outputHandleName(src.def as { outputs?: unknown[] });
    let outTypes = outputTypes(src.def as { outputs?: unknown[] }, srcHandle);
    let handleName = srcHandle;

    // ConditionalRouter: branch-specific handles
    if (src.componentType === 'ConditionalRouter') {
      const branch =
        edge.condition?.branch ??
        (edge.kind === 'condition' && edge.label === 'false' ? 'false' : 'true');
      handleName = branch === 'false' ? 'false_result' : 'true_result';
      outTypes = outputTypes(src.def as { outputs?: unknown[] }, handleName);
    }

    const preferredInputs =
      tgt.componentType === 'ChatOutput'
        ? ['input_value']
        : tgt.componentType === 'Pass'
          ? ['input_message']
          : tgt.componentType === 'ConditionalRouter'
            ? ['input_text', 'true_case_message', 'false_case_message']
            : tgt.componentType === 'SubFlow'
              ? ['flow_name']
              : ['input_value', 'input_message', 'input_text'];

    // For ConditionalRouter true/false case messages, prefer connecting to case message fields
    // when the source is the condition's data path — default input_text for primary in-edge.
    let preferred = preferredInputs;
    if (tgt.componentType === 'ConditionalRouter' && edge.kind !== 'condition') {
      preferred = ['input_text'];
    }

    const targetField = pickInputField(tgt.def as { template?: Record<string, unknown> }, preferred);
    if (!targetField) {
      issues.push(
        issue(
          'INVALID_HANDLE',
          `edges[id=${edge.id}]`,
          `no compatible input handle on ${tgt.componentType}`,
          { edgeId: edge.id },
        ),
      );
      continue;
    }

    // SubFlow has no message input handle in 1.11 — only flow_name dropdown.
    // Connecting arbitrary AIOS edges into SubFlow is not semantics-preserving.
    if (tgt.componentType === 'SubFlow' && targetField.fieldName === 'flow_name') {
      // Only allow if source is start/input-like providing no data dependency — still weak.
      // Fail closed for data edges into SubFlow until governed bridge exists.
      if (!SUPPORTED_INPUT_KINDS.has(
        graph.nodes.find((n) => n.id === edge.source)?.kind as NodeKind,
      )) {
        issues.push(
          issue(
            'UNSUPPORTED_EDGE',
            `edges[id=${edge.id}]`,
            'SubFlow does not accept arbitrary data edges without AIOS capability bridge',
            { edgeId: edge.id },
          ),
        );
        continue;
      }
    }

    lfEdges.push(
      buildEdge(
        edge,
        src.lfId,
        tgt.lfId,
        src.componentType,
        handleName,
        outTypes,
        targetField,
        handleName,
      ),
    );
  }

  if (issues.length > 0) {
    return {
      ok: false,
      flow: null,
      nodeMapping,
      catalogueFingerprint: fp,
      issues,
    };
  }

  // Deterministic viewport
  const viewport = { x: 0, y: 0, zoom: 1 };

  return {
    ok: true,
    flow: {
      name: graph.name.slice(0, 128),
      description: `AIOS graph ${graph.id} rev ${graph.revision} (native compile; catalogue ${fp.slice(0, 12)})`,
      data: {
        nodes: lfNodes,
        edges: lfEdges,
        viewport,
      },
    },
    nodeMapping,
    catalogueFingerprint: fp,
    issues: [],
  };
}
