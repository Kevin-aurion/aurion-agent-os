/** GraphSpec v2 client types — mirrors aios-server `src/graph/types.ts`. */

export const GRAPH_SCHEMA_V2 = 'aios.flow-graph/2' as const;

export const NODE_KINDS = [
  'input',
  'output',
  'tool.read',
  'tool.gated',
  'gateway.classify',
  'gateway.summarize',
  'gateway.verify',
  'approval.checkpoint',
  'control.start',
  'control.end',
  'control.condition',
  'control.parallel',
  'control.join',
  'control.loop',
  'control.failure',
  'subgraph',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = ['default', 'condition', 'parallel', 'failure', 'loop'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export type GraphPosition = { x: number; y: number };

export type StateSchema = {
  type?: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  title?: string;
  description?: string;
  [key: string]: unknown;
};

/** Supported condition operators — keep in sync with aios-server GraphSpec zod enum. */
export const CONDITION_OPERATORS = [
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
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Approval checkpoint risk — medium | high only (no low). */
export const APPROVAL_RISK_LEVELS = ['medium', 'high'] as const;
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];

export type DeclarativeCondition = {
  branch?: 'true' | 'false';
  operator?: ConditionOperator;
  matchText?: string;
  caseSensitive?: boolean;
  label?: string;
};

export type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  position: GraphPosition;
  config?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tool?: string;
};

export type GraphEdge = {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  condition?: DeclarativeCondition;
  maxTraversals?: number;
  label?: string;
};

export type GraphSpecV2 = {
  schemaVersion: typeof GRAPH_SCHEMA_V2;
  id: string;
  name: string;
  revision: number;
  stateSchema: StateSchema;
  entryNodeId: string;
  exitNodeIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphIssue = {
  code: string;
  path: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

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

export type PaletteGroup =
  | 'input_output'
  | 'reasoning'
  | 'tool'
  | 'governance'
  | 'control'
  | 'composition';

export type PaletteItem = {
  kind: NodeKind;
  group: PaletteGroup;
  label: string;
  description: string;
  langflowNative: boolean;
};

export type GraphEnvironment = 'SANDBOX' | 'STAGING' | 'PRODUCTION';

export type GraphArtifactKind = 'source' | 'langflow-native' | 'unknown';

export type GraphArtifactSummary = {
  id: string;
  digest: string;
  status: string;
  template: string;
  templateVersion?: string;
  compilerVersion?: string;
  runtimeKind: string;
  artifactKind: GraphArtifactKind;
  langflowDeployable: boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt?: string;
  workflowId?: string | null;
  skillVersionId?: string | null;
  metadata?: unknown;
};

export type GraphArtifactDetail = GraphArtifactSummary & {
  artifactJson: unknown;
};

export type GraphTraceItem = {
  id: string;
  runId: string;
  agentId: string;
  outcome: string;
  runtimeKind?: string | null;
  artifactId?: string | null;
  createdAt: string;
  selectedSkills?: unknown;
  trajectory?: unknown;
  verifierFeedback?: unknown;
  trajectoryKey?: string | null;
  engineExecute?: string | null;
  engineVerify?: string | null;
};

/** React Flow presentation data (no credentials). */
export type GraphFlowNodeData = {
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tool?: string;
  hasError?: boolean;
  compileStatus?: NodeCompileStatus;
  langflowNative?: boolean;
};

export type GraphFlowNode = {
  id: string;
  type: 'graphNode';
  position: GraphPosition;
  data: GraphFlowNodeData;
  selected?: boolean;
};

export type GraphFlowEdgeData = {
  kind: EdgeKind;
  condition?: DeclarativeCondition;
  maxTraversals?: number;
  label?: string;
  hasError?: boolean;
};

export type GraphFlowEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  data: GraphFlowEdgeData;
  selected?: boolean;
};

export type GraphFlowDocument = {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
};

export type GraphMeta = {
  id: string;
  name: string;
  revision: number;
  stateSchema: StateSchema;
};

export const ENTRY_KINDS = new Set<NodeKind>(['control.start', 'input']);
export const EXIT_KINDS = new Set<NodeKind>(['control.end', 'output', 'control.failure']);

export const APPROVAL_FIXED_CONFIG = {
  authority: 'AIOS',
  emits: 'approval.required',
  resumeRequires: 'aios.approvalRequest.APPROVED',
} as const;
