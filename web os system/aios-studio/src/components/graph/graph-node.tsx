'use client';

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ShieldAlert, Waypoints } from 'lucide-react';
import { memo } from 'react';
import { Badge } from '@/components/ui';
import { nodeKindBadge } from '@/lib/graph/presentation';
import type { GraphFlowNodeData } from '@/lib/graph/types';

type GraphRfNode = Node<GraphFlowNodeData, 'graphNode'>;

function GraphNodeCardInner({ data, selected }: NodeProps<GraphRfNode>) {
  const kind = nodeKindBadge(data.kind);
  const error = Boolean(data.hasError);
  const unsupported = data.compileStatus === 'unsupported';
  const mapped = data.compileStatus === 'mapped';

  return (
    <div
      className={[
        'gnode',
        selected ? 'gnode-selected' : '',
        error ? 'gnode-error' : '',
        unsupported ? 'gnode-unsupported' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-kind={data.kind}
    >
      <Handle type="target" position={Position.Left} className="gnode-handle" />
      <div className="gnode-top">
        <span className="gnode-icon"><Waypoints size={14} /></span>
        <Badge tone={kind.tone}>{kind.label}</Badge>
        {data.langflowNative === true && <Badge tone="positive">Native</Badge>}
        {data.langflowNative === false && <Badge tone="warning">AIOS-only</Badge>}
        {mapped && <Badge tone="positive">Mapped</Badge>}
        {unsupported && <Badge tone="danger">Unsupported</Badge>}
        {error && <ShieldAlert size={14} className="gnode-err-icon" />}
      </div>
      <strong className="gnode-label">{data.label}</strong>
      <code className="gnode-kind">{data.kind}</code>
      {data.tool && <span className="gnode-meta">{data.tool}</span>}
      <Handle type="source" position={Position.Right} className="gnode-handle" />
    </div>
  );
}

export const GraphNodeCard = memo(GraphNodeCardInner);
