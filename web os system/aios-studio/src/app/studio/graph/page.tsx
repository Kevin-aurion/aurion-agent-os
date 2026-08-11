'use client';

import dynamic from 'next/dynamic';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, FlaskConical, GitBranch, LoaderCircle, Save, ShieldCheck, Wand2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { GraphDrawer, type DrawerTab } from '@/components/graph/graph-drawer';
import { GraphInspector } from '@/components/graph/graph-inspector';
import { GraphPalette } from '@/components/graph/graph-palette';
import {
  Badge, ErrorState, GateNotice, LoadingState, PageHeader,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { isFde, useAuth } from '@/lib/auth';
import {
  clearedSemanticVerdicts,
  isPositionOnlyNodePatch,
  saveCurrentThenCompile,
} from '@/lib/graph/actions';
import {
  detailIssues,
  detailNodeMapping,
  graphApi,
} from '@/lib/graph/api';
import {
  addEdge,
  addNode,
  applyIssueHighlights,
  createDefaultEchoGraph,
  createNodeFromKind,
  graphToFlow,
  issueFocusTarget,
  removeEdge,
  removeNode,
  updateEdge,
  updateNodeFields,
} from '@/lib/graph/model';
import {
  canAccessGraphWorkbench,
  formatCompileNativeActionNote,
  governanceSaveCopy,
} from '@/lib/graph/presentation';
import { GRAPH_TEMPLATES, type GraphTemplateId } from '@/lib/graph/templates';
import type {
  GraphDiffResult,
  GraphEdge,
  GraphEnvironment,
  GraphFlowEdge,
  GraphFlowNode,
  GraphIssue,
  GraphNode,
  GraphSpecV2,
  GraphTraceItem,
  NodeCompileMapping,
  NodeKind,
  PaletteItem,
  StateSchema,
} from '@/lib/graph/types';

const GraphCanvas = dynamic(
  () => import('@/components/graph/graph-canvas').then((m) => m.GraphCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="graph-canvas-host graph-canvas-loading" data-testid="graph-canvas">
        <LoaderCircle className="spin" size={18} />
        <span>載入畫布</span>
      </div>
    ),
  },
);

function withCompileHints(
  flow: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] },
  mapping: NodeCompileMapping[],
  palette: PaletteItem[] | undefined,
): { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] } {
  const byId = new Map(mapping.map((m) => [m.aiosNodeId, m]));
  const nativeByKind = new Map((palette ?? []).map((p) => [p.kind, p.langflowNative]));
  return {
    nodes: flow.nodes.map((n) => {
      const m = byId.get(n.id);
      return {
        ...n,
        data: {
          ...n.data,
          compileStatus: m?.status,
          langflowNative: nativeByKind.get(n.data.kind),
        },
      };
    }),
    edges: flow.edges,
  };
}

export default function GraphWorkbenchPage() {
  const { user } = useAuth();
  const fde = isFde(user?.role) && canAccessGraphWorkbench(user?.role);
  const client = useQueryClient();

  const [graph, setGraph] = useState<GraphSpecV2>(() => createDefaultEchoGraph());
  const [baseline, setBaseline] = useState<GraphSpecV2 | null>(null);
  const [environment, setEnvironment] = useState<GraphEnvironment>('SANDBOX');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusEdgeId, setFocusEdgeId] = useState<string | null>(null);
  const [issues, setIssues] = useState<GraphIssue[]>([]);
  const [nodeMapping, setNodeMapping] = useState<NodeCompileMapping[]>([]);
  const [compileOk, setCompileOk] = useState<boolean | null>(null);
  const [compileMessage, setCompileMessage] = useState<string | null>(null);
  const [diff, setDiff] = useState<GraphDiffResult | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('issues');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [traces, setTraces] = useState<GraphTraceItem[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [lastSourceId, setLastSourceId] = useState<string | null>(null);

  const paletteQuery = useQuery({
    queryKey: ['graph-palette'],
    enabled: fde,
    queryFn: async () => {
      const res = await graphApi.palette();
      return res.items;
    },
  });

  const artifactsQuery = useQuery({
    queryKey: ['graph-artifacts'],
    enabled: fde,
    queryFn: async () => {
      const res = await graphApi.listArtifacts('all');
      return res.items;
    },
  });

  const flowBase = useMemo(() => graphToFlow(graph), [graph]);
  const flowHighlighted = useMemo(
    () => applyIssueHighlights(flowBase, issues),
    [flowBase, issues],
  );
  const flow = useMemo(
    () => withCompileHints(flowHighlighted, nodeMapping, paletteQuery.data),
    [flowHighlighted, nodeMapping, paletteQuery.data],
  );

  const selectedNode: GraphNode | null = selectedNodeId
    ? graph.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedEdge: GraphEdge | null =
    selectedEdgeId && !selectedNodeId
      ? graph.edges.find((e) => e.id === selectedEdgeId) ?? null
      : null;

  const hasCompiledArtifact = Boolean(
    artifactsQuery.data?.some((a) => a.artifactKind === 'langflow-native' && a.langflowDeployable),
  );

  /** Apply a semantic graph change and clear stale validate/diff/compat/compile verdicts. */
  const applySemanticGraph = useCallback((next: GraphSpecV2, note?: string | null) => {
    setGraph(next);
    const cleared = clearedSemanticVerdicts();
    setIssues(cleared.issues);
    setNodeMapping(cleared.nodeMapping);
    setCompileOk(cleared.compileOk);
    setCompileMessage(cleared.compileMessage);
    setDiff(cleared.diff);
    setActionNote(note === undefined ? cleared.actionNote : note);
    setActionError(null);
  }, []);

  const applySemanticUpdater = useCallback(
    (updater: (prev: GraphSpecV2) => GraphSpecV2) => {
      setGraph((prev) => {
        const next = updater(prev);
        return next;
      });
      const cleared = clearedSemanticVerdicts();
      setIssues(cleared.issues);
      setNodeMapping(cleared.nodeMapping);
      setCompileOk(cleared.compileOk);
      setCompileMessage(cleared.compileMessage);
      setDiff(cleared.diff);
      setActionNote(cleared.actionNote);
      setActionError(null);
    },
    [],
  );

  const onAddKind = useCallback((kind: NodeKind) => {
    const offset = graph.nodes.length * 28;
    const node = createNodeFromKind(kind, { x: 180 + offset, y: 120 + (offset % 120) });
    applySemanticGraph(addNode(graph, node));
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setFocusNodeId(node.id);
  }, [applySemanticGraph, graph]);

  const onDropKind = useCallback((kind: NodeKind, position: { x: number; y: number }) => {
    const node = createNodeFromKind(kind, position);
    applySemanticGraph(addNode(graph, node));
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, [applySemanticGraph, graph]);

  const onApplyTemplate = useCallback((id: GraphTemplateId) => {
    const tpl = GRAPH_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const built = tpl.build();
    applySemanticGraph(built, `已套用模板：${tpl.label}`);
    setBaseline(null);
    setLastSourceId(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [applySemanticGraph]);

  /** Pure canvas geometry — does not clear validation / compatibility. */
  const onNodePositionChange = useCallback((nodeId: string, position: { x: number; y: number }) => {
    setGraph((prev) => updateNodeFields(prev, nodeId, { position }));
  }, []);

  const onConnect = useCallback((connection: { source: string; target: string }) => {
    applySemanticUpdater((prev) => {
      const id = `e_${connection.source}_${connection.target}_${Math.random().toString(36).slice(2, 6)}`;
      return addEdge(prev, {
        id,
        kind: 'default',
        source: connection.source,
        target: connection.target,
      });
    });
  }, [applySemanticUpdater]);

  const onNodesDelete = useCallback((ids: string[]) => {
    applySemanticUpdater((prev) => ids.reduce((g, id) => removeNode(g, id), prev));
    setSelectedNodeId(null);
  }, [applySemanticUpdater]);

  const onEdgesDelete = useCallback((ids: string[]) => {
    applySemanticUpdater((prev) => ids.reduce((g, id) => removeEdge(g, id), prev));
    setSelectedEdgeId(null);
  }, [applySemanticUpdater]);

  const onSelectionChange = useCallback((sel: { nodeId: string | null; edgeId: string | null }) => {
    setSelectedNodeId(sel.nodeId);
    setSelectedEdgeId(sel.nodeId ? null : sel.edgeId);
    if (sel.nodeId) setFocusNodeId(sel.nodeId);
    if (sel.edgeId && !sel.nodeId) setFocusEdgeId(sel.edgeId);
  }, []);

  const onUpdateNode = useCallback((nodeId: string, patch: Partial<GraphNode>) => {
    if (isPositionOnlyNodePatch(patch)) {
      setGraph((prev) => updateNodeFields(prev, nodeId, patch));
      return;
    }
    applySemanticUpdater((prev) => updateNodeFields(prev, nodeId, patch));
  }, [applySemanticUpdater]);

  const onUpdateEdge = useCallback((edgeId: string, patch: Partial<GraphEdge>) => {
    applySemanticUpdater((prev) => updateEdge(prev, edgeId, patch));
  }, [applySemanticUpdater]);

  const onUpdateStateSchema = useCallback((stateSchema: StateSchema) => {
    applySemanticUpdater((prev) => ({ ...prev, stateSchema }));
  }, [applySemanticUpdater]);

  const validateMut = useMutation({
    mutationFn: () => graphApi.validate(graph),
    onSuccess: (res) => {
      setIssues(res.issues ?? []);
      setActionError(null);
      setActionNote('Validation passed');
      setDrawerTab('issues');
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        const list = detailIssues(err.detail);
        setIssues(list);
        setActionError(err.message);
        setDrawerTab('issues');
        return;
      }
      setActionError('Validate failed');
    },
  });

  const compilePreviewMut = useMutation({
    mutationFn: () => graphApi.compilePreview(graph, environment),
    onSuccess: (res) => {
      if (res.ok) {
        setCompileOk(true);
        setCompileMessage('All nodes mapped to native Langflow components.');
        setNodeMapping(res.nodeMapping);
        setIssues([]);
        setActionNote('Langflow compatibility: supported');
      } else {
        setCompileOk(false);
        setCompileMessage('Unsupported native mapping — compile is blocked.');
        setNodeMapping(res.nodeMapping);
        setIssues(res.issues);
        setActionError('Langflow compile blocked (unsupported semantics)');
      }
      setDrawerTab('langflow');
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setCompileOk(false);
        setCompileMessage(err.message);
        setNodeMapping(detailNodeMapping(err.detail));
        setIssues(detailIssues(err.detail));
        setActionError(err.message);
        setDrawerTab('langflow');
        return;
      }
      setActionError('Compatibility preview failed');
    },
  });

  const saveMut = useMutation({
    mutationFn: () => graphApi.saveSource(graph, { name: graph.name, revision: graph.revision }),
    onSuccess: async (res) => {
      setLastSourceId(res.id);
      setBaseline(structuredClone(graph));
      setActionNote(`Saved immutable source ${res.id.slice(0, 10)}… (reused=${res.reused})`);
      setActionError(null);
      await client.invalidateQueries({ queryKey: ['graph-artifacts'] });
      setDrawerTab('artifacts');
      if (baseline) {
        try {
          const d = await graphApi.diff(baseline, graph);
          setDiff(d);
        } catch {
          /* ignore diff failure after save */
        }
      }
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setIssues(detailIssues(err.detail));
        setActionError(err.message);
        setDrawerTab('issues');
        return;
      }
      setActionError('Save source failed');
    },
  });

  const compileArtifactMut = useMutation({
    mutationFn: async () => {
      // Always save/content-address *current* graph, then compile that exact source id.
      // Never reuse lastSourceId from UI after edits (stale source would be a release bug).
      return saveCurrentThenCompile(graph, environment, {
        saveSource: async (g) => {
          const saved = await graphApi.saveSource(g, { name: g.name, revision: g.revision });
          return { id: saved.id, reused: saved.reused, digest: saved.digest };
        },
        compileArtifact: (sourceId, env) => graphApi.compileArtifact(sourceId, env),
      });
    },
    onSuccess: async (res) => {
      setLastSourceId(res.sourceId);
      setBaseline(structuredClone(graph));
      setCompileOk(true);
      setCompileMessage(`Compiled native artifact ${res.compile.compiled.id.slice(0, 10)}…`);
      // Prefer immutable compiled id (short + ellipsis); never digest — redactor may mask it.
      setActionNote(formatCompileNativeActionNote(res.compile.compiled.id));
      setActionError(null);
      await client.invalidateQueries({ queryKey: ['graph-artifacts'] });
      setSelectedArtifactId(res.compile.compiled.id);
      setDrawerTab('artifacts');
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setCompileOk(false);
        setCompileMessage(err.message);
        setNodeMapping(detailNodeMapping(err.detail));
        setIssues(detailIssues(err.detail));
        setActionError(err.message);
        setDrawerTab('langflow');
        return;
      }
      setActionError('Compile to Langflow artifact failed');
    },
  });

  const diffMut = useMutation({
    mutationFn: async () => {
      const before = baseline ?? createDefaultEchoGraph();
      return graphApi.diff(before, graph);
    },
    onSuccess: (res) => {
      setDiff(res);
      setDrawerTab('diff');
      setActionNote(`Diff risk ${res.risk}`);
    },
    onError: (err) => {
      setActionError(err instanceof ApiError ? err.message : 'Diff failed');
    },
  });

  const onFocusIssue = useCallback((issue: GraphIssue) => {
    const target = issueFocusTarget(issue);
    if (!target) return;
    if (target.type === 'node') {
      setSelectedNodeId(target.id);
      setSelectedEdgeId(null);
      setFocusNodeId(target.id);
    } else {
      setSelectedEdgeId(target.id);
      setSelectedNodeId(null);
      setFocusEdgeId(target.id);
    }
  }, []);

  const onSelectArtifact = useCallback(async (id: string) => {
    setSelectedArtifactId(id);
    setDrawerTab('traces');
    try {
      const res = await graphApi.traces(id);
      setTraces(res.items);
    } catch (err) {
      setTraces([]);
      setActionError(err instanceof ApiError ? err.message : 'Load traces failed');
    }
  }, []);

  const onLoadSource = useCallback(async (id: string) => {
    try {
      const detail = await graphApi.getArtifact(id);
      if (detail.artifactKind !== 'source') {
        setActionError('Only source GraphSpec artifacts can be loaded into the editor');
        return;
      }
      const loaded = detail.artifactJson as GraphSpecV2;
      if (!loaded || loaded.schemaVersion !== 'aios.flow-graph/2') {
        setActionError('Artifact is not aios.flow-graph/2');
        return;
      }
      setBaseline(structuredClone(loaded));
      applySemanticGraph(loaded, `Loaded source ${id.slice(0, 10)}…`);
      setLastSourceId(id);
      setSelectedArtifactId(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Load artifact failed');
    }
  }, [applySemanticGraph]);

  if (!fde) {
    return (
      <>
        <PageHeader
          eyebrow="GRAPH ENGINEERING"
          title="Graph 工程"
          description="FDE-only 視覺編排、驗證、diff、artifact 與 redacted traces。"
        />
        <GateNotice>
          <strong>你目前是 {user?.role ?? '未登入'}。</strong>
          <span> Graph Workbench 僅對 OWNER / TRAINER 開放；後端仍為最終權限權威。</span>
        </GateNotice>
      </>
    );
  }

  if (paletteQuery.isLoading && !paletteQuery.data) {
    return <LoadingState label="正在載入 Graph Workbench" />;
  }

  const busy =
    validateMut.isPending ||
    compilePreviewMut.isPending ||
    saveMut.isPending ||
    compileArtifactMut.isPending ||
    diffMut.isPending;

  return (
    <div className="graph-workbench" data-testid="graph-workbench">
      <PageHeader
        eyebrow="GRAPH ENGINEERING · v2"
        title="Graph 工程"
        description="以 GraphSpec v2 為真實來源編排節點；Langflow 僅是可替換 runtime。儲存與部署嚴格分離。"
        actions={
          <div className="graph-toolbar-actions">
            <label className="graph-env">
              <span>Environment</span>
              <select
                data-testid="graph-environment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as GraphEnvironment)}
              >
                <option value="SANDBOX">SANDBOX</option>
                <option value="STAGING">STAGING</option>
                <option value="PRODUCTION">PRODUCTION</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              data-testid="graph-validate"
              disabled={busy}
              onClick={() => validateMut.mutate()}
            >
              {validateMut.isPending ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
              Validate
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="graph-compat-preview"
              disabled={busy}
              onClick={() => compilePreviewMut.mutate()}
            >
              {compilePreviewMut.isPending ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}
              Langflow 相容性
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="graph-diff"
              disabled={busy}
              onClick={() => diffMut.mutate()}
            >
              <GitBranch size={15} />
              Diff
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="graph-save-source"
              disabled={busy}
              onClick={() => saveMut.mutate()}
            >
              {saveMut.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
              儲存 Source
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="graph-compile-native"
              disabled={busy || compileOk === false}
              onClick={() => compileArtifactMut.mutate()}
              title={compileOk === false ? 'Unsupported native mapping blocks compile' : 'Compile current graph: save source then compile that exact artifact'}
            >
              {compileArtifactMut.isPending ? <LoaderCircle className="spin" size={15} /> : <Wand2 size={15} />}
              Compile → Native
            </button>
          </div>
        }
      />

      <GateNotice>
        <strong>{governanceSaveCopy()}</strong>
        <span> 此頁沒有 Production activate；完成 compile 後請到 Runtime 走完整閘門。</span>
      </GateNotice>

      <div className="graph-meta-bar">
        <label>
          <span>Graph name</span>
          <input
            data-testid="graph-name"
            value={graph.name}
            onChange={(e) => applySemanticGraph({ ...graph, name: e.target.value })}
          />
        </label>
        <label>
          <span>Revision</span>
          <input
            data-testid="graph-revision"
            type="number"
            min={1}
            value={graph.revision}
            onChange={(e) =>
              applySemanticGraph({
                ...graph,
                revision: Math.max(1, Number(e.target.value) || 1),
              })
            }
          />
        </label>
        <div className="graph-meta-stats">
          <Badge tone="info">{graph.schemaVersion}</Badge>
          <Badge tone="neutral">{graph.nodes.length} nodes</Badge>
          <Badge tone="neutral">{graph.edges.length} edges</Badge>
          <Badge
            tone={issues.length ? 'danger' : 'positive'}
            data-testid="graph-issue-status"
          >
            {issues.length ? `${issues.length} issues` : 'clean'}
          </Badge>
          {compileOk === true && (
            <Badge tone="positive" data-testid="graph-compat-status">Native OK</Badge>
          )}
          {compileOk === false && (
            <Badge tone="danger" data-testid="graph-compat-status">Native blocked</Badge>
          )}
          {compileOk === null && (
            <span data-testid="graph-compat-status" hidden>compat unknown</span>
          )}
        </div>
      </div>

      {actionError && <ErrorState message={actionError} />}
      {actionNote && !actionError && (
        <div className="notice notice-governance" data-testid="graph-action-note">
          <CheckCircle2 size={18} />
          <span>{actionNote}</span>
        </div>
      )}

      <div className="graph-layout">
        <GraphPalette
          items={paletteQuery.data}
          loading={paletteQuery.isLoading}
          error={paletteQuery.error instanceof ApiError ? paletteQuery.error.message : paletteQuery.error ? 'Palette load failed' : null}
          onAddKind={onAddKind}
          onApplyTemplate={onApplyTemplate}
        />

        <div className="graph-center">
          <GraphCanvas
            nodes={flow.nodes}
            edges={flow.edges}
            onNodePositionChange={onNodePositionChange}
            onConnect={onConnect}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onSelectionChange={onSelectionChange}
            focusNodeId={focusNodeId}
            focusEdgeId={focusEdgeId}
            onDropKind={onDropKind}
          />
        </div>

        <GraphInspector
          graph={graph}
          node={selectedNode}
          edge={selectedEdge}
          onUpdateNode={onUpdateNode}
          onUpdateEdge={onUpdateEdge}
          onUpdateStateSchema={onUpdateStateSchema}
          onDeleteNode={(id) => {
            applySemanticGraph(removeNode(graph, id));
            setSelectedNodeId(null);
          }}
          onDeleteEdge={(id) => {
            applySemanticGraph(removeEdge(graph, id));
            setSelectedEdgeId(null);
          }}
        />
      </div>

      <GraphDrawer
        tab={drawerTab}
        onTabChange={setDrawerTab}
        issues={issues}
        onFocusIssue={onFocusIssue}
        nodeMapping={nodeMapping}
        compileOk={compileOk}
        compileMessage={compileMessage}
        diff={diff}
        artifacts={artifactsQuery.data ?? []}
        selectedArtifactId={selectedArtifactId}
        onSelectArtifact={onSelectArtifact}
        onLoadSource={onLoadSource}
        traces={traces}
        hasCompiledArtifact={hasCompiledArtifact}
      />
    </div>
  );
}
