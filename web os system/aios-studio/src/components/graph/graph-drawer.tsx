'use client';

import Link from 'next/link';
import { ArrowUpRight, CircleAlert, FileStack, GitCompare, History, Map as MapIcon } from 'lucide-react';
import { Badge, EmptyState, StatusBadge } from '@/components/ui';
import {
  artifactKindLabel,
  artifactKindTone,
  compileStatusTone,
  isLangflowDeployableArtifact,
  riskTone,
} from '@/lib/graph/presentation';
import type {
  GraphArtifactSummary,
  GraphDiffResult,
  GraphIssue,
  GraphTraceItem,
  NodeCompileMapping,
} from '@/lib/graph/types';

export type DrawerTab = 'issues' | 'langflow' | 'diff' | 'artifacts' | 'traces';

type Props = {
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  issues: GraphIssue[];
  onFocusIssue: (issue: GraphIssue) => void;
  nodeMapping: NodeCompileMapping[];
  compileOk: boolean | null;
  compileMessage: string | null;
  diff: GraphDiffResult | null;
  artifacts: GraphArtifactSummary[];
  selectedArtifactId: string | null;
  onSelectArtifact: (id: string) => void;
  onLoadSource: (id: string) => void;
  traces: GraphTraceItem[];
  hasCompiledArtifact: boolean;
};

const TABS: Array<{ id: DrawerTab; label: string; icon: typeof CircleAlert }> = [
  { id: 'issues', label: 'Validation', icon: CircleAlert },
  { id: 'langflow', label: 'Langflow map', icon: MapIcon },
  { id: 'diff', label: 'Version diff', icon: GitCompare },
  { id: 'artifacts', label: 'Artifacts', icon: FileStack },
  { id: 'traces', label: 'Traces', icon: History },
];

export function GraphDrawer({
  tab,
  onTabChange,
  issues,
  onFocusIssue,
  nodeMapping,
  compileOk,
  compileMessage,
  diff,
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
  onLoadSource,
  traces,
  hasCompiledArtifact,
}: Props) {
  return (
    <div className="graph-drawer" data-testid="graph-drawer">
      <div className="graph-drawer-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'drawer-tab active' : 'drawer-tab'}
            data-testid={`graph-drawer-tab-${id}`}
            onClick={() => onTabChange(id)}
          >
            <Icon size={14} />
            {label}
            {id === 'issues' && issues.length > 0 && (
              <Badge tone="danger">{issues.length}</Badge>
            )}
          </button>
        ))}
      </div>

      <div className="graph-drawer-body">
        {tab === 'issues' && (
          issues.length === 0 ? (
            <EmptyState title="目前沒有 validation issues" description="通過 Validate 後，結構化錯誤會連到節點或連線。" />
          ) : (
            <div className="issue-list">
              {issues.map((issue, index) => (
                <button
                  key={`${issue.code}-${issue.path}-${index}`}
                  type="button"
                  className="issue-row"
                  onClick={() => onFocusIssue(issue)}
                >
                  <Badge tone="danger">{issue.code}</Badge>
                  <span>
                    <strong>{issue.message}</strong>
                    <small>
                      {issue.path}
                      {issue.nodeId ? ` · node ${issue.nodeId}` : ''}
                      {issue.edgeId ? ` · edge ${issue.edgeId}` : ''}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          )
        )}

        {tab === 'langflow' && (
          <div className="langflow-panel">
            {compileOk === null && !nodeMapping.length ? (
              <EmptyState
                title="尚未執行 Langflow compatibility preview"
                description="按工具列「Langflow 相容性」以對應每個節點；不支援時會明確阻擋 compile。"
              />
            ) : (
              <>
                <div className={`compile-banner ${compileOk === false ? 'compile-fail' : compileOk ? 'compile-ok' : 'compile-mixed'}`}>
                  <strong>
                    {compileOk === true
                      ? 'Native mapping complete'
                      : compileOk === false
                        ? 'Unsupported mapping — compile blocked'
                        : 'Compatibility preview'}
                  </strong>
                  <span>{compileMessage ?? (compileOk ? 'All nodes mapped without semantic loss.' : 'Review per-node reasons below.')}</span>
                </div>
                <div className="mapping-list">
                  {nodeMapping.map((m) => (
                    <div key={m.aiosNodeId} className="mapping-row">
                      <div>
                        <strong>{m.aiosNodeId}</strong>
                        <small>{m.kind}{m.componentType ? ` → ${m.componentType}` : ''}</small>
                      </div>
                      <Badge tone={compileStatusTone(m.status)}>{m.status}</Badge>
                      {m.reason && <span className="mapping-reason">{m.reason}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'diff' && (
          !diff ? (
            <EmptyState title="尚無 diff" description="儲存 Source 或載入 baseline 後會與目前圖比較；position-only 變更風險為 LOW。" />
          ) : (
            <div className="diff-panel">
              <div className="diff-summary">
                <Badge tone={riskTone(diff.risk)}>Risk {diff.risk}</Badge>
                <span>{diff.summary}</span>
              </div>
              <div className="diff-changes">
                {diff.changes.length === 0 ? (
                  <p className="graph-hint">No structural changes.</p>
                ) : (
                  diff.changes.map((change, i) => (
                    <div key={`${change.type}-${i}`} className="diff-row">
                      <code>{change.type}</code>
                      <span>{JSON.stringify(change)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        )}

        {tab === 'artifacts' && (
          <div className="artifact-panel">
            {!artifacts.length ? (
              <EmptyState title="尚無 graph artifacts" description="Validate 後可儲存不可變 Source；再 compile 為 Langflow Native（兩者視覺上分開）。" />
            ) : (
              <div className="artifact-list" data-testid="graph-artifact-list">
                {artifacts.map((item) => {
                  const deployable = isLangflowDeployableArtifact(item);
                  return (
                    <div
                      key={item.id}
                      data-testid={`graph-artifact-${item.id}`}
                      className={[
                        'artifact-row',
                        item.artifactKind === 'source' ? 'artifact-source' : 'artifact-native',
                        selectedArtifactId === item.id ? 'selected' : '',
                      ].join(' ')}
                    >
                      <button type="button" className="artifact-main" onClick={() => onSelectArtifact(item.id)}>
                        <span>
                          <strong>{item.id.slice(0, 12)}…</strong>
                          <small>
                            {new Date(item.createdAt).toLocaleString('zh-TW')} · digest {item.digest.slice(0, 12)}
                          </small>
                        </span>
                        <Badge tone={artifactKindTone(item.artifactKind)}>{artifactKindLabel(item.artifactKind)}</Badge>
                        <StatusBadge status={item.status} />
                        <Badge tone={deployable ? 'positive' : 'neutral'}>
                          {deployable ? 'Langflow deployable' : 'Not deployable'}
                        </Badge>
                      </button>
                      {item.artifactKind === 'source' && (
                        <button type="button" className="secondary-button" onClick={() => onLoadSource(item.id)}>
                          Load source
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {hasCompiledArtifact && (
              <Link href="/studio/runtime" className="runtime-link">
                前往 Runtime 治理部署 <ArrowUpRight size={14} />
              </Link>
            )}
          </div>
        )}

        {tab === 'traces' && (
          !traces.length ? (
            <EmptyState title="沒有 redacted traces" description="選取 artifact 後載入執行軌跡；不會顯示 credential。" />
          ) : (
            <div className="trace-mini-list">
              {traces.map((t) => (
                <div key={t.id} className="trace-mini-row">
                  <StatusBadge status={t.outcome} />
                  <span>
                    <strong>{t.id.slice(0, 10)}</strong>
                    <small>
                      Run {t.runId.slice(0, 10)} · {new Date(t.createdAt).toLocaleString('zh-TW')}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
