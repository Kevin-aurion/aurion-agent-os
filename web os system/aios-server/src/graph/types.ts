// GraphSpec v2 contract: aios.flow-graph/2
// Strict typed surface for the Graph Workbench + validators + Langflow compiler.
import { z } from 'zod';

export const GRAPH_SCHEMA_V1 = 'aios.flow-graph/1' as const;
export const GRAPH_SCHEMA_V2 = 'aios.flow-graph/2' as const;

export const NODE_KINDS = [
  // Data / AIOS
  'input',
  'output',
  'tool.read',
  'tool.gated',
  'gateway.classify',
  'gateway.summarize',
  'gateway.verify',
  'approval.checkpoint',
  // Control
  'control.start',
  'control.end',
  'control.condition',
  'control.parallel',
  'control.join',
  'control.loop',
  'control.failure',
  // Composition
  'subgraph',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  'default',
  'condition',
  'parallel',
  'failure',
  'loop',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export const positionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export type GraphPosition = z.infer<typeof positionSchema>;

/** JSON-Schema-like declarative state object (never executable code). */
export const stateSchemaSchema = z
  .object({
    type: z.literal('object').optional(),
    properties: z.record(z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()
  .passthrough();

export type StateSchema = z.infer<typeof stateSchemaSchema>;

const nonEmptyId = z.string().min(1).max(128);

/** Declarative condition on condition edges / condition nodes (no code). */
export const declarativeConditionSchema = z
  .object({
    /** ConditionalRouter branch target when compiling. */
    branch: z.enum(['true', 'false']).optional(),
    operator: z
      .enum([
        'equals',
        'not equals',
        'contains',
        'starts with',
        'ends with',
        'regex',
        'less than',
        'less than or equal',
        'greater than',
        'greater than or equal',
      ])
      .optional(),
    matchText: z.string().optional(),
    caseSensitive: z.boolean().optional(),
    /** Optional free-form predicate label (declarative only; never executed as code). */
    label: z.string().max(256).optional(),
  })
  .strict();

export type DeclarativeCondition = z.infer<typeof declarativeConditionSchema>;

export const graphNodeSchema = z
  .object({
    id: nonEmptyId,
    kind: z.enum(NODE_KINDS),
    label: z.string().min(1).max(256),
    position: positionSchema,
    config: z.record(z.unknown()).optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
    /** Capability id for tool.* nodes (mcp:<server>:<tool>). */
    tool: z.string().min(1).optional(),
  })
  .strict();

export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z
  .object({
    id: nonEmptyId,
    kind: z.enum(EDGE_KINDS),
    source: nonEmptyId,
    target: nonEmptyId,
    /** Required for kind=condition. */
    condition: declarativeConditionSchema.optional(),
    /** Required for kind=loop; bounds 1..50. */
    maxTraversals: z.number().int().min(1).max(50).optional(),
    label: z.string().max(256).optional(),
  })
  .strict();

export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphSpecV2Schema = z
  .object({
    schemaVersion: z.literal(GRAPH_SCHEMA_V2),
    id: nonEmptyId,
    name: z.string().min(1).max(256),
    revision: z.number().int().min(1),
    stateSchema: stateSchemaSchema,
    entryNodeId: nonEmptyId,
    exitNodeIds: z.array(nonEmptyId).min(1),
    nodes: z.array(graphNodeSchema).min(1),
    edges: z.array(graphEdgeSchema),
  })
  .strict();

export type GraphSpecV2 = z.infer<typeof graphSpecV2Schema>;

/** Structured validation / compile issue (fail-closed). */
export type GraphIssue = {
  code: string;
  path: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type GraphValidationResult =
  | { ok: true; graph: GraphSpecV2; issues: [] }
  | { ok: false; issues: GraphIssue[] };

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type GraphDiffChange =
  | { type: 'node.add'; nodeId: string }
  | { type: 'node.remove'; nodeId: string }
  | { type: 'node.change'; nodeId: string; fields: string[] }
  | { type: 'node.move'; nodeId: string; from: GraphPosition; to: GraphPosition }
  | { type: 'edge.add'; edgeId: string }
  | { type: 'edge.remove'; edgeId: string }
  | { type: 'edge.change'; edgeId: string; fields: string[] }
  | { type: 'entry.change'; from: string; to: string }
  | { type: 'exit.change'; added: string[]; removed: string[] }
  | { type: 'stateSchema.change' };

export type GraphDiffResult = {
  changes: GraphDiffChange[];
  risk: RiskLevel;
  summary: string;
};

export type NodeCompileStatus = 'mapped' | 'unsupported';

export type NodeCompileMapping = {
  aiosNodeId: string;
  kind: NodeKind;
  status: NodeCompileStatus;
  langflowNodeId?: string;
  componentType?: string;
  reason?: string;
};

export type LangflowCompileResult =
  | {
      ok: true;
      flow: {
        name: string;
        description: string;
        data: {
          nodes: unknown[];
          edges: unknown[];
          viewport: { x: number; y: number; zoom: number };
        };
      };
      nodeMapping: NodeCompileMapping[];
      catalogueFingerprint: string;
      issues: [];
    }
  | {
      ok: false;
      flow: null;
      nodeMapping: NodeCompileMapping[];
      catalogueFingerprint: string | null;
      issues: GraphIssue[];
    };

/** Palette entry for Workbench (FDE-only). */
export type PaletteItem = {
  kind: NodeKind;
  group: 'input_output' | 'reasoning' | 'tool' | 'governance' | 'control' | 'composition';
  label: string;
  description: string;
  langflowNative: boolean;
};

export const GRAPH_COMPILER_VERSION = 'aios-graph-compiler/2';

/**
 * Immutable AIOS GraphSpec v2 source artifact (source of truth).
 * runtimeKind MUST be NATIVE — never LANGFLOW — so RuntimeDeployment cannot
 * post GraphSpec JSON to Langflow `/api/v1/flows/`.
 */
export const GRAPH_SOURCE_TEMPLATE_ID = 'graph-engineering-v2-source';

/**
 * Content-addressed native Langflow flow.data artifact (nodes/edges/viewport).
 * runtimeKind LANGFLOW; only this shape is deployable to Langflow.
 */
export const GRAPH_LANGFLOW_TEMPLATE_ID = 'graph-engineering-v2-langflow';

/** @deprecated Use GRAPH_SOURCE_TEMPLATE_ID; kept as alias for callers mid-migration. */
export const GRAPH_TEMPLATE_ID = GRAPH_SOURCE_TEMPLATE_ID;

export type GraphArtifactKind = 'source' | 'langflow-native';

export function graphArtifactKindFromTemplate(template: string): GraphArtifactKind | 'unknown' {
  if (template === GRAPH_SOURCE_TEMPLATE_ID) return 'source';
  if (template === GRAPH_LANGFLOW_TEMPLATE_ID) return 'langflow-native';
  return 'unknown';
}

/** True when artifactJson is deployable native Langflow flow.data. */
export function isLangflowNativeFlowData(json: unknown): boolean {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) return false;
  if (o.viewport === null || typeof o.viewport !== 'object' || Array.isArray(o.viewport)) {
    return false;
  }
  for (const n of o.nodes) {
    if (n === null || typeof n !== 'object' || Array.isArray(n)) return false;
    if ((n as { type?: unknown }).type !== 'genericNode') return false;
  }
  return true;
}