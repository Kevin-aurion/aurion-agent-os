'use client';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo } from 'react';
import { GraphNodeCard } from './graph-node';
import type { GraphFlowEdge, GraphFlowNode, NodeKind } from '@/lib/graph/types';

const nodeTypes = { graphNode: GraphNodeCard };

export type GraphCanvasProps = {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
  onNodePositionChange: (nodeId: string, position: { x: number; y: number }) => void;
  onConnect: (connection: { source: string; target: string }) => void;
  onNodesDelete: (ids: string[]) => void;
  onEdgesDelete: (ids: string[]) => void;
  onSelectionChange: (selection: { nodeId: string | null; edgeId: string | null }) => void;
  focusNodeId?: string | null;
  focusEdgeId?: string | null;
  onDropKind?: (kind: NodeKind, position: { x: number; y: number }) => void;
};

function CanvasInner({
  nodes,
  edges,
  onNodePositionChange,
  onConnect,
  onNodesDelete,
  onEdgesDelete,
  onSelectionChange,
  focusNodeId,
  focusEdgeId,
  onDropKind,
}: GraphCanvasProps) {
  const { screenToFlowPosition, fitView, setCenter, getNode } = useReactFlow();

  useEffect(() => {
    if (!focusNodeId) return;
    const n = getNode(focusNodeId);
    if (n) setCenter(n.position.x + 90, n.position.y + 40, { zoom: 1.15, duration: 280 });
  }, [focusNodeId, getNode, setCenter]);

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'graphNode',
        position: n.position,
        data: n.data,
        selected: n.id === focusNodeId || Boolean(n.selected),
      })),
    [nodes, focusNodeId],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        const hasError = Boolean(e.data?.hasError);
        const selected = e.id === focusEdgeId || Boolean(e.selected);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          label: e.label ?? e.data?.label,
          data: e.data,
          selected,
          animated: hasError,
          deletable: true,
          style: {
            stroke: hasError ? '#ff6e83' : selected ? '#9b7cff' : '#6b74a8',
            strokeWidth: selected ? 2.4 : 1.6,
          },
          labelStyle: { fill: '#aeb4c4', fontSize: 10 },
        };
      }),
    [edges, focusEdgeId],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position && change.dragging === false) {
          onNodePositionChange(change.id, change.position);
        } else if (change.type === 'position' && change.position && change.dragging) {
          // live drag — still commit so UI stays responsive
          onNodePositionChange(change.id, change.position);
        } else if (change.type === 'remove') {
          onNodesDelete([change.id]);
        }
      }
    },
    [onNodePositionChange, onNodesDelete],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length) onEdgesDelete(removed);
    },
    [onEdgesDelete],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      onConnect({ source: connection.source, target: connection.target });
    },
    [onConnect],
  );

  const onSelection = useCallback(
    ({ nodes: selNodes, edges: selEdges }: OnSelectionChangeParams) => {
      onSelectionChange({
        nodeId: selNodes[0]?.id ?? null,
        edgeId: selEdges[0]?.id ?? null,
      });
    },
    [onSelectionChange],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData('application/aios-node-kind') as NodeKind;
      if (!kind || !onDropKind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onDropKind(kind, position);
    },
    [onDropKind, screenToFlowPosition],
  );

  return (
    <div className="graph-canvas-host" data-testid="graph-canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onSelectionChange={onSelection}
        nodeTypes={nodeTypes}
        fitView
        selectionMode={SelectionMode.Partial}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode="Shift"
        panOnScroll
        selectionOnDrag
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: true }}
        onInit={() => fitView({ padding: 0.22 })}
        minZoom={0.25}
        maxZoom={1.8}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2a3348" />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(8,11,18,.72)"
          nodeColor={() => '#7c83ff'}
          className="graph-minimap"
        />
        <Controls showInteractive className="graph-controls" />
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
