/**
 * Graph Workbench action helpers — pure sequencing / invalidation logic
 * so UI state cannot compile a stale source id after semantic edits.
 */

import type {
  GraphDiffResult,
  GraphEnvironment,
  GraphIssue,
  GraphSpecV2,
  NodeCompileMapping,
} from './types';

/** Result of content-addressing the current graph as an immutable source artifact. */
export type SavedSourceRef = {
  id: string;
  reused?: boolean;
  digest?: string;
};

/** Minimal compile response surface used by the sequencing helper. */
export type CompiledNativeRef = {
  source?: { id: string };
  compiled: { id: string; digest?: string };
};

export type SaveThenCompileDeps<TCompile = CompiledNativeRef> = {
  /** Always save the *current* GraphSpec; content-addressing may reuse an identical prior source. */
  saveSource: (graph: GraphSpecV2) => Promise<SavedSourceRef>;
  /** Compile only the source id returned by saveSource — never a cached UI id. */
  compileArtifact: (sourceId: string, environment: GraphEnvironment) => Promise<TCompile>;
};

export type SaveThenCompileResult<TCompile = CompiledNativeRef> = {
  sourceId: string;
  reused: boolean;
  compile: TCompile;
};

/**
 * Always content-address the current graph, then compile that exact source id.
 * Callers must not pass a stale `lastSourceId` — the save response is the only id used.
 */
export async function saveCurrentThenCompile<TCompile = CompiledNativeRef>(
  graph: GraphSpecV2,
  environment: GraphEnvironment,
  deps: SaveThenCompileDeps<TCompile>,
): Promise<SaveThenCompileResult<TCompile>> {
  const saved = await deps.saveSource(graph);
  if (!saved?.id || typeof saved.id !== 'string') {
    throw new Error('saveSource must return a source artifact id');
  }
  const compile = await deps.compileArtifact(saved.id, environment);
  return {
    sourceId: saved.id,
    reused: Boolean(saved.reused),
    compile,
  };
}

/** Verdict / preview state that becomes stale after a semantic graph edit. */
export type GraphVerdictState = {
  issues: GraphIssue[];
  nodeMapping: NodeCompileMapping[];
  compileOk: boolean | null;
  compileMessage: string | null;
  diff: GraphDiffResult | null;
  actionNote: string | null;
};

/**
 * Cleared verdicts after a semantic edit (node/edge/meta/template/stateSchema).
 * Pure position-only moves must not use this — they may keep validation/compat.
 */
export function clearedSemanticVerdicts(): GraphVerdictState {
  return {
    issues: [],
    nodeMapping: [],
    compileOk: null,
    compileMessage: null,
    diff: null,
    actionNote: null,
  };
}

/**
 * Whether a node field patch is purely geometric (canvas drag / position spinboxes).
 * Semantic patches (label, config, tool, schemas) must invalidate verdicts.
 */
export function isPositionOnlyNodePatch(
  patch: Partial<{
    label: string;
    config: unknown;
    tool: string;
    inputSchema: unknown;
    outputSchema: unknown;
    position: unknown;
    kind: unknown;
  }>,
): boolean {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  return keys.length > 0 && keys.every((k) => k === 'position');
}
