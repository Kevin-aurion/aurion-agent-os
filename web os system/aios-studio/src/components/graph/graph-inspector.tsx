'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui';
import { parseJsonSafe } from '@/lib/graph/model';
import {
  APPROVAL_FIXED_CONFIG,
  APPROVAL_RISK_LEVELS,
  CONDITION_OPERATORS,
  EDGE_KINDS,
  type ApprovalRiskLevel,
  type ConditionOperator,
  type GraphEdge,
  type GraphNode,
  type GraphSpecV2,
  type StateSchema,
} from '@/lib/graph/types';

type Props = {
  graph: GraphSpecV2;
  node: GraphNode | null;
  edge: GraphEdge | null;
  onUpdateNode: (nodeId: string, patch: Partial<GraphNode>) => void;
  onUpdateEdge: (edgeId: string, patch: Partial<GraphEdge>) => void;
  onUpdateStateSchema: (stateSchema: StateSchema) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
};

function JsonField({
  label,
  value,
  onValid,
  testId,
}: {
  label: string;
  value: unknown;
  onValid: (next: Record<string, unknown>) => void;
  testId?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value ?? {}, null, 2));
    setError(null);
  }, [value]);

  return (
    <label className="graph-field">
      <span>{label}</span>
      <textarea
        className={error ? 'json-input json-invalid' : 'json-input'}
        rows={5}
        value={text}
        data-testid={testId}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const parsed = parseJsonSafe(next);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          if (
            parsed.value === null ||
            typeof parsed.value !== 'object' ||
            Array.isArray(parsed.value)
          ) {
            setError('Must be a JSON object');
            return;
          }
          setError(null);
          onValid(parsed.value as Record<string, unknown>);
        }}
      />
      {error && <em className="json-error">Parse error: {error}</em>}
    </label>
  );
}

function GraphSettingsPanel({
  graph,
  onUpdateStateSchema,
}: {
  graph: GraphSpecV2;
  onUpdateStateSchema: (stateSchema: StateSchema) => void;
}) {
  return (
    <div className="graph-side-panel graph-inspector" data-testid="graph-settings">
      <div className="graph-side-head">
        <div>
          <strong>Graph 設定</strong>
          <span>未選取節點時可編輯 typed state</span>
        </div>
      </div>
      <p className="graph-hint">
        在畫布選取節點或連線以編輯細節。此處僅接受宣告式 JSON object，不含可執行程式碼。
      </p>
      <p className="graph-hint">
        {graph.schemaVersion} · {graph.nodes.length} nodes · {graph.edges.length} edges · rev {graph.revision}
      </p>
      <JsonField
        label="stateSchema (JSON object)"
        value={graph.stateSchema ?? { type: 'object', properties: {} }}
        testId="graph-state-schema"
        onValid={(stateSchema) => onUpdateStateSchema(stateSchema as StateSchema)}
      />
    </div>
  );
}

export function GraphInspector({
  graph,
  node,
  edge,
  onUpdateNode,
  onUpdateEdge,
  onUpdateStateSchema,
  onDeleteNode,
  onDeleteEdge,
}: Props) {
  if (!node && !edge) {
    return <GraphSettingsPanel graph={graph} onUpdateStateSchema={onUpdateStateSchema} />;
  }

  if (edge && !node) {
    const operatorValue = edge.condition?.operator ?? '';
    return (
      <div className="graph-side-panel graph-inspector" data-testid="graph-edge-inspector">
        <div className="graph-side-head">
          <div>
            <strong>Edge inspector</strong>
            <span>{edge.id}</span>
          </div>
          <button type="button" className="secondary-button" onClick={() => onDeleteEdge(edge.id)}>
            移除
          </button>
        </div>
        <label className="graph-field">
          <span>Edge kind</span>
          <select
            value={edge.kind}
            onChange={(e) =>
              onUpdateEdge(edge.id, { kind: e.target.value as GraphEdge['kind'] })
            }
          >
            {EDGE_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="graph-field">
          <span>Label</span>
          <input
            value={edge.label ?? ''}
            onChange={(e) => onUpdateEdge(edge.id, { label: e.target.value || undefined })}
          />
        </label>
        {edge.kind === 'condition' && (
          <>
            <label className="graph-field">
              <span>Branch</span>
              <select
                value={edge.condition?.branch ?? ''}
                onChange={(e) =>
                  onUpdateEdge(edge.id, {
                    condition: {
                      ...edge.condition,
                      branch: (e.target.value || undefined) as 'true' | 'false' | undefined,
                    },
                  })
                }
              >
                <option value="">(none)</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label className="graph-field">
              <span>Operator</span>
              <select
                data-testid="graph-condition-operator"
                value={operatorValue}
                onChange={(e) => {
                  const raw = e.target.value;
                  const operator = (raw || undefined) as ConditionOperator | undefined;
                  onUpdateEdge(edge.id, {
                    condition: {
                      ...edge.condition,
                      operator,
                    },
                  });
                }}
              >
                <option value="">(none)</option>
                {CONDITION_OPERATORS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
            </label>
            <label className="graph-field">
              <span>Match text</span>
              <input
                value={edge.condition?.matchText ?? ''}
                onChange={(e) =>
                  onUpdateEdge(edge.id, {
                    condition: { ...edge.condition, matchText: e.target.value },
                  })
                }
              />
            </label>
          </>
        )}
        {edge.kind === 'loop' && (
          <label className="graph-field">
            <span>maxTraversals (1–50)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={edge.maxTraversals ?? 1}
              onChange={(e) =>
                onUpdateEdge(edge.id, {
                  maxTraversals: Math.min(50, Math.max(1, Number(e.target.value) || 1)),
                })
              }
            />
          </label>
        )}
        <p className="graph-hint">Source {edge.source} → Target {edge.target}</p>
      </div>
    );
  }

  if (!node) return null;

  const isApproval = node.kind === 'approval.checkpoint';
  const isTool = node.kind === 'tool.read' || node.kind === 'tool.gated';
  const isSubgraph = node.kind === 'subgraph';
  const riskRaw = String(node.config?.risk ?? 'high');
  const riskValue: ApprovalRiskLevel =
    riskRaw === 'medium' || riskRaw === 'high' ? riskRaw : 'high';

  return (
    <div className="graph-side-panel graph-inspector" data-testid="graph-node-inspector">
      <div className="graph-side-head">
        <div>
          <strong>Node inspector</strong>
          <span>{node.kind}</span>
        </div>
        <button type="button" className="secondary-button" onClick={() => onDeleteNode(node.id)}>
          移除
        </button>
      </div>

      <label className="graph-field">
        <span>Label</span>
        <input
          value={node.label}
          onChange={(e) => onUpdateNode(node.id, { label: e.target.value })}
        />
      </label>

      <div className="graph-field-row">
        <label className="graph-field">
          <span>Position X</span>
          <input
            type="number"
            value={node.position.x}
            onChange={(e) =>
              onUpdateNode(node.id, {
                position: { ...node.position, x: Number(e.target.value) || 0 },
              })
            }
          />
        </label>
        <label className="graph-field">
          <span>Position Y</span>
          <input
            type="number"
            value={node.position.y}
            onChange={(e) =>
              onUpdateNode(node.id, {
                position: { ...node.position, y: Number(e.target.value) || 0 },
              })
            }
          />
        </label>
      </div>

      {isTool && (
        <label className="graph-field">
          <span>Tool capability id</span>
          <input
            value={node.tool ?? ''}
            onChange={(e) => onUpdateNode(node.id, { tool: e.target.value || undefined })}
            placeholder="mcp:server:tool"
          />
        </label>
      )}

      {isApproval && (
        <>
          <div className="graph-fixed-config">
            <Badge tone="warning">AIOS authority (fixed)</Badge>
            <ul>
              <li>authority = {APPROVAL_FIXED_CONFIG.authority}</li>
              <li>emits = {APPROVAL_FIXED_CONFIG.emits}</li>
              <li>resumeRequires = {APPROVAL_FIXED_CONFIG.resumeRequires}</li>
            </ul>
          </div>
          <label className="graph-field">
            <span>Reason</span>
            <input
              value={String(node.config?.reason ?? '')}
              onChange={(e) =>
                onUpdateNode(node.id, {
                  config: {
                    ...APPROVAL_FIXED_CONFIG,
                    reason: e.target.value,
                    risk: riskValue,
                  },
                })
              }
            />
          </label>
          <label className="graph-field">
            <span>Risk</span>
            <select
              data-testid="graph-approval-risk"
              value={riskValue}
              onChange={(e) =>
                onUpdateNode(node.id, {
                  config: {
                    ...APPROVAL_FIXED_CONFIG,
                    reason: String(node.config?.reason ?? ''),
                    risk: e.target.value as ApprovalRiskLevel,
                  },
                })
              }
            >
              {APPROVAL_RISK_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
        </>
      )}

      {isSubgraph && (
        <>
          <label className="graph-field">
            <span>Subgraph artifact id</span>
            <input
              value={String(node.config?.artifactId ?? '')}
              onChange={(e) =>
                onUpdateNode(node.id, {
                  config: { ...node.config, artifactId: e.target.value },
                })
              }
            />
          </label>
          <label className="graph-field">
            <span>Digest (sha256)</span>
            <input
              value={String(node.config?.digest ?? '')}
              onChange={(e) =>
                onUpdateNode(node.id, {
                  config: { ...node.config, digest: e.target.value },
                })
              }
            />
          </label>
        </>
      )}

      {!isApproval && (
        <JsonField
          label="Config (declarative JSON)"
          value={node.config ?? {}}
          onValid={(config) => onUpdateNode(node.id, { config })}
        />
      )}

      <JsonField
        label="Input schema JSON"
        value={node.inputSchema ?? {}}
        onValid={(inputSchema) => onUpdateNode(node.id, { inputSchema })}
      />
      <JsonField
        label="Output schema JSON"
        value={node.outputSchema ?? {}}
        onValid={(outputSchema) => onUpdateNode(node.id, { outputSchema })}
      />

      <p className="graph-hint">Node id · {node.id}</p>
    </div>
  );
}
