'use client';

import { Blocks, GripVertical } from 'lucide-react';
import { Badge, EmptyState, LoadingState } from '@/components/ui';
import { PALETTE_GROUP_ORDER, paletteGroupLabel } from '@/lib/graph/presentation';
import type { NodeKind, PaletteGroup, PaletteItem } from '@/lib/graph/types';
import { GRAPH_TEMPLATES, type GraphTemplateId } from '@/lib/graph/templates';

type Props = {
  items: PaletteItem[] | undefined;
  loading?: boolean;
  error?: string | null;
  onAddKind: (kind: NodeKind) => void;
  onApplyTemplate: (id: GraphTemplateId) => void;
};

export function GraphPalette({ items, loading, error, onAddKind, onApplyTemplate }: Props) {
  if (loading) return <div className="graph-side-panel"><LoadingState label="載入 palette" /></div>;
  if (error) return <div className="graph-side-panel"><EmptyState title="Palette 無法載入" description={error} /></div>;
  if (!items?.length) {
    return <div className="graph-side-panel"><EmptyState title="Palette 為空" description="後端未回傳節點種類。" /></div>;
  }

  const grouped = PALETTE_GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((i) => i.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="graph-side-panel graph-palette">
      <div className="graph-side-head">
        <Blocks size={16} />
        <div>
          <strong>節點 Palette</strong>
          <span>拖曳到畫布，或點擊新增</span>
        </div>
      </div>

      <div className="graph-template-list">
        <p className="graph-side-label">快速模板</p>
        {GRAPH_TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            className="graph-template-btn"
            data-testid={`graph-template-${tpl.id}`}
            onClick={() => onApplyTemplate(tpl.id)}
            title={tpl.description}
          >
            <span>
              <strong>{tpl.label}</strong>
              <small>{tpl.description}</small>
            </span>
            <Badge tone={tpl.langflowSupported ? 'positive' : 'warning'}>
              {tpl.langflowSupported ? 'Native OK' : 'AIOS-only'}
            </Badge>
          </button>
        ))}
      </div>

      {grouped.map(({ group, items: groupItems }) => (
        <div key={group} className="palette-group">
          <p className="graph-side-label">{paletteGroupLabel(group as PaletteGroup)}</p>
          <div className="palette-items">
            {groupItems.map((item) => (
              <button
                key={item.kind}
                type="button"
                className="palette-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/aios-node-kind', item.kind);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onAddKind(item.kind)}
                title={item.description}
              >
                <GripVertical size={14} className="palette-grip" />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.kind}</small>
                </span>
                <Badge tone={item.langflowNative ? 'positive' : 'warning'}>
                  {item.langflowNative ? 'Native' : 'AIOS-only'}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
