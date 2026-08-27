'use client';
import { useQuery } from '@tanstack/react-query';
import { Activity, KeyRound, Network, PlugZap, ShieldCheck } from 'lucide-react';
import { API } from '@/lib/api';
import type { McpServer } from '@/lib/types';
import { EmptyState, ErrorState, GateNotice, LoadingState, PageHeader, Section, StatusBadge } from '@/components/ui';

export default function ToolsPage() {
  const query = useQuery({ queryKey: ['mcp-servers'], queryFn: () => API.get<McpServer[]>('/mcp/servers') });
  if (query.isLoading) return <LoadingState label="正在讀取 MCP Registry" />;
  if (query.error) return <ErrorState message="無法載入 MCP Registry。" />;
  return <><PageHeader eyebrow="CAPABILITY REGISTRY" title="Tool 與 MCP" description="集中管理連線、信任層級、allowlist、風險與人工核准。" /><GateNotice><strong>Credential 只保存引用，不送到瀏覽器。</strong><span> Remote HTTP 預設關閉；本機 MCP 必須通過 loopback 與工具 allowlist。</span></GateNotice><Section title="MCP Registry" description={`${query.data?.length ?? 0} 個伺服器已登錄。`}>{query.data?.length ? <div className="registry-table"><div className="table-head"><span>連線</span><span>Transport</span><span>Trust</span><span>Scope</span><span>Health</span></div>{query.data.map((server) => <div className="table-row" key={server.id}><div className="registry-name"><div className="entity-icon"><PlugZap size={17} /></div><span><strong>{server.name}</strong><small>{server.serverId}</small></span></div><span>{server.transport}</span><StatusBadge status={server.trustTier} /><span>{server.readWriteClass}{server.approvalRequired ? ' · Approval' : ''}</span><StatusBadge status={server.enabled ? server.healthStatus : 'DISABLED'} /></div>)}</div> : <EmptyState title="尚未註冊 MCP" description="Registry 目前保持空白。請由 FDE 以最小權限新增需要的本機工具連線。" />}</Section><div className="triple-grid"><div className="mini-panel"><Network /><h3>Loopback only</h3><p>第一階段只允許本機連線，避免任意遠端 MCP。</p></div><div className="mini-panel"><KeyRound /><h3>Credential broker</h3><p>只辨識 env: 或 keychain: 引用，拒絕明文密鑰。</p></div><div className="mini-panel"><Activity /><h3>Health probe</h3><p>健康檢查 fail-safe，但工具執行與授權 fail-closed。</p></div></div></>;
}
