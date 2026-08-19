import { API } from '../api';
import type {
  GraphArtifactDetail,
  GraphArtifactSummary,
  GraphDiffResult,
  GraphEnvironment,
  GraphIssue,
  GraphSpecV2,
  GraphTraceItem,
  LangflowCompileResult,
  NodeCompileMapping,
  PaletteItem,
} from './types';

export type ValidateGraphResponse = {
  valid: boolean;
  graph?: GraphSpecV2;
  issues: GraphIssue[];
};

export type SaveArtifactResponse = {
  id: string;
  digest: string;
  status: string;
  reused: boolean;
  template: string;
  compilerVersion: string;
  runtimeKind: string;
  artifactKind: 'source';
  langflowDeployable: false;
};

export type CompileArtifactResponse = {
  source: {
    id: string;
    digest: string;
    template: string;
    runtimeKind: string;
    artifactKind: 'source';
    langflowDeployable: false;
  };
  compiled: {
    id: string;
    digest: string;
    status: string;
    reused: boolean;
    template: string;
    compilerVersion: string;
    runtimeKind: string;
    artifactKind: 'langflow-native';
    langflowDeployable: true;
    catalogueFingerprint: string;
  };
};

export const graphApi = {
  palette: () => API.get<{ items: PaletteItem[] }>('/api/graph/palette'),
  validate: (graph: GraphSpecV2) =>
    API.post<ValidateGraphResponse>('/api/graph/validate', { graph }),
  diff: (before: GraphSpecV2, after: GraphSpecV2) =>
    API.post<GraphDiffResult>('/api/graph/diff', { before, after }),
  compilePreview: (graph: GraphSpecV2, environment: GraphEnvironment) =>
    API.post<LangflowCompileResult>('/api/graph/langflow/compile', { graph, environment }),
  saveSource: (graph: GraphSpecV2, metadata?: Record<string, unknown>) =>
    API.post<SaveArtifactResponse>('/api/graph/artifacts', { graph, metadata }),
  listArtifacts: (kind: 'all' | 'source' | 'langflow-native' = 'all') =>
    API.get<{ items: GraphArtifactSummary[] }>(`/api/graph/artifacts?kind=${kind}`),
  getArtifact: (id: string) => API.get<GraphArtifactDetail>(`/api/graph/artifacts/${id}`),
  compileArtifact: (id: string, environment: GraphEnvironment) =>
    API.post<CompileArtifactResponse>(`/api/graph/artifacts/${id}/compile/langflow`, { environment }),
  traces: (id: string) =>
    API.get<{ artifactId: string; digest: string; items: GraphTraceItem[] }>(
      `/api/graph/artifacts/${id}/traces`,
    ),
};

/** Extract issues + nodeMapping from ApiError.detail when present. */
export function detailIssues(detail: unknown): GraphIssue[] {
  if (!detail || typeof detail !== 'object') return [];
  const issues = (detail as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (i): i is GraphIssue =>
      !!i &&
      typeof i === 'object' &&
      typeof (i as GraphIssue).code === 'string' &&
      typeof (i as GraphIssue).message === 'string',
  );
}

export function detailNodeMapping(detail: unknown): NodeCompileMapping[] {
  if (!detail || typeof detail !== 'object') return [];
  const mapping = (detail as { nodeMapping?: unknown }).nodeMapping;
  if (!Array.isArray(mapping)) return [];
  return mapping as NodeCompileMapping[];
}
