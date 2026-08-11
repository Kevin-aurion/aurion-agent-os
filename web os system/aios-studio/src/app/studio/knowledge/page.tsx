'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Bot, Database, FileText, LockKeyhole, Search } from 'lucide-react';
import { API } from '@/lib/api';
import type { Agent } from '@/lib/types';
import { ErrorState, GateNotice, LoadingState, PageHeader, Section, StatusBadge } from '@/components/ui';

export default function KnowledgePage() {
  const query = useQuery({ queryKey: ['agents'], queryFn: () => API.get<Agent[]>('/api/agents') });
  if (query.isLoading) return <LoadingState label="正在整理 Knowledge scope" />;
  if (query.error) return <ErrorState message="無法載入 Knowledge 配置。" />;
  return <><PageHeader eyebrow="KNOWLEDGE CONTROL" title="Knowledge 配置" description="以 Agent 為邊界管理來源、檢索、引用與寫入權限。" /><GateNotice><strong>Knowledge 不是共用資料夾。</strong><span> 每次檢索都要綁定 Agent、deployment 與只讀 capability，Runtime 不可直接連向量資料庫。</span></GateNotice><div className="metric-grid compact"><div className="metric"><p>Agent scopes</p><strong>{query.data?.length ?? 0}</strong><span>獨立知識邊界</span></div><div className="metric"><p>Gateway policy</p><strong>Read</strong><span>預設唯讀</span></div><div className="metric"><p>Redaction</p><strong>Always</strong><span>無法關閉</span></div></div><Section title="依 Agent 管理" description="選擇一位 Agent 設定它可以看見的知識。"><div className="entity-list">{query.data?.map((agent) => <Link className="entity-row" href={`/studio/agents/${agent.id}?tab=knowledge`} key={agent.id}><div className="entity-icon"><Bot size={18} /></div><div className="entity-main"><strong>{agent.name}</strong><span>{agent.department || 'General'} · 開啟來源與 scope</span></div><StatusBadge status="SCOPED" /><ArrowUpRight size={16} /></Link>)}</div></Section><div className="triple-grid"><div className="mini-panel"><FileText /><h3>Sources</h3><p>檔案、雲端參照與正式 Knowledge Base。</p></div><div className="mini-panel"><Search /><h3>Retrieval</h3><p>經 Gateway 檢索並回傳 path、score 與引用。</p></div><div className="mini-panel"><LockKeyhole /><h3>Write policy</h3><p>新增、覆寫與刪除永遠是獨立的受核准能力。</p></div></div></>;
}
