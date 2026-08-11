import { APPROVAL_FIXED_CONFIG, GRAPH_SCHEMA_V2, type GraphSpecV2 } from './types';

const baseState = {
  type: 'object' as const,
  properties: {},
  additionalProperties: true,
};

/** Langflow Echo — supported, runnable start→end. */
export function langflowEchoTemplate(): GraphSpecV2 {
  return {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: 'g_tpl_echo',
    name: 'Langflow Echo',
    revision: 1,
    stateSchema: { ...baseState },
    entryNodeId: 'n_start',
    exitNodeIds: ['n_end'],
    nodes: [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 100, y: 140 },
        config: {},
      },
      {
        id: 'n_end',
        kind: 'control.end',
        label: 'End',
        position: { x: 420, y: 140 },
        config: {},
      },
    ],
    edges: [{ id: 'e_echo', kind: 'default', source: 'n_start', target: 'n_end' }],
  };
}

/** Conditional Route — supported native contract (condition + true/false branches). */
export function conditionalRouteTemplate(): GraphSpecV2 {
  return {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: 'g_tpl_route',
    name: 'Conditional Route',
    revision: 1,
    stateSchema: { ...baseState },
    entryNodeId: 'n_start',
    exitNodeIds: ['n_yes', 'n_no'],
    nodes: [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 80, y: 160 },
        config: {},
      },
      {
        id: 'n_cond',
        kind: 'control.condition',
        label: 'Contains OK?',
        position: { x: 300, y: 160 },
        config: { operator: 'contains', matchText: 'ok', caseSensitive: false },
      },
      {
        id: 'n_yes',
        kind: 'control.end',
        label: 'Yes path',
        position: { x: 560, y: 60 },
        config: {},
      },
      {
        id: 'n_no',
        kind: 'control.end',
        label: 'No path',
        position: { x: 560, y: 260 },
        config: {},
      },
    ],
    edges: [
      { id: 'e_start_cond', kind: 'default', source: 'n_start', target: 'n_cond' },
      {
        id: 'e_true',
        kind: 'condition',
        source: 'n_cond',
        target: 'n_yes',
        label: 'true',
        condition: { branch: 'true', operator: 'contains', matchText: 'ok' },
      },
      {
        id: 'e_false',
        kind: 'condition',
        source: 'n_cond',
        target: 'n_no',
        label: 'false',
        condition: { branch: 'false' },
      },
    ],
  };
}

/** Approval-gated Tool — valid AIOS graph, clearly Langflow-unsupported. */
export function approvalGatedToolTemplate(): GraphSpecV2 {
  return {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: 'g_tpl_gated',
    name: 'Approval-gated Tool',
    revision: 1,
    stateSchema: { ...baseState },
    entryNodeId: 'n_in',
    exitNodeIds: ['n_out'],
    nodes: [
      {
        id: 'n_in',
        kind: 'input',
        label: 'Input',
        position: { x: 60, y: 140 },
        config: {},
      },
      {
        id: 'n_cp',
        kind: 'approval.checkpoint',
        label: 'FDE Approval',
        position: { x: 260, y: 140 },
        config: {
          ...APPROVAL_FIXED_CONFIG,
          reason: 'gated side-effect requires human approval',
          risk: 'high',
        },
      },
      {
        id: 'n_gate',
        kind: 'tool.gated',
        label: 'Gated action',
        position: { x: 480, y: 140 },
        tool: 'mcp:example:side_effect',
        config: {},
      },
      {
        id: 'n_out',
        kind: 'output',
        label: 'Output',
        position: { x: 700, y: 140 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', kind: 'default', source: 'n_in', target: 'n_cp' },
      { id: 'e2', kind: 'default', source: 'n_cp', target: 'n_gate' },
      { id: 'e3', kind: 'default', source: 'n_gate', target: 'n_out' },
    ],
  };
}

/** Parallel/Join — valid AIOS graph, clearly Langflow-unsupported. */
export function parallelJoinTemplate(): GraphSpecV2 {
  return {
    schemaVersion: GRAPH_SCHEMA_V2,
    id: 'g_tpl_parallel',
    name: 'Parallel Join',
    revision: 1,
    stateSchema: { ...baseState },
    entryNodeId: 'n_start',
    exitNodeIds: ['n_end'],
    nodes: [
      {
        id: 'n_start',
        kind: 'control.start',
        label: 'Start',
        position: { x: 60, y: 180 },
        config: {},
      },
      {
        id: 'n_par',
        kind: 'control.parallel',
        label: 'Fan-out',
        position: { x: 260, y: 180 },
        config: {},
      },
      {
        id: 'n_a',
        kind: 'gateway.summarize',
        label: 'Branch A',
        position: { x: 480, y: 80 },
        config: {},
      },
      {
        id: 'n_b',
        kind: 'gateway.classify',
        label: 'Branch B',
        position: { x: 480, y: 280 },
        config: {},
      },
      {
        id: 'n_join',
        kind: 'control.join',
        label: 'Join',
        position: { x: 700, y: 180 },
        config: {},
      },
      {
        id: 'n_end',
        kind: 'control.end',
        label: 'End',
        position: { x: 920, y: 180 },
        config: {},
      },
    ],
    edges: [
      { id: 'e_s_p', kind: 'default', source: 'n_start', target: 'n_par' },
      { id: 'e_p_a', kind: 'parallel', source: 'n_par', target: 'n_a' },
      { id: 'e_p_b', kind: 'parallel', source: 'n_par', target: 'n_b' },
      { id: 'e_a_j', kind: 'default', source: 'n_a', target: 'n_join' },
      { id: 'e_b_j', kind: 'default', source: 'n_b', target: 'n_join' },
      { id: 'e_j_e', kind: 'default', source: 'n_join', target: 'n_end' },
    ],
  };
}

export type GraphTemplateId =
  | 'langflow-echo'
  | 'conditional-route'
  | 'approval-gated-tool'
  | 'parallel-join';

export const GRAPH_TEMPLATES: Array<{
  id: GraphTemplateId;
  label: string;
  description: string;
  langflowSupported: boolean;
  build: () => GraphSpecV2;
}> = [
  {
    id: 'langflow-echo',
    label: 'Langflow Echo',
    description: 'Supported start→end; compiles and runs in Sandbox.',
    langflowSupported: true,
    build: langflowEchoTemplate,
  },
  {
    id: 'conditional-route',
    label: 'Conditional Route',
    description: 'Native ConditionalRouter contract with true/false branches.',
    langflowSupported: true,
    build: conditionalRouteTemplate,
  },
  {
    id: 'approval-gated-tool',
    label: 'Approval-gated Tool',
    description: 'Valid AIOS graph; approval + gated tool are not native Langflow.',
    langflowSupported: false,
    build: approvalGatedToolTemplate,
  },
  {
    id: 'parallel-join',
    label: 'Parallel / Join',
    description: 'Valid AIOS control-flow; parallel/join are not native yet.',
    langflowSupported: false,
    build: parallelJoinTemplate,
  },
];
