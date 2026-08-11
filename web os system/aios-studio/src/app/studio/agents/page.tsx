'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bot, Filter, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { API } from '@/lib/api';
import type { Agent } from '@/lib/types';
import { engineLabel } from '@/lib/presentation';
import { ErrorState, LoadingState, PageHeader, StatusBadge } from '@/components/ui';

export default function AgentsPage() {
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['agents'], queryFn: () => API.get<Agent[]>('/api/agents') });
  if (query.isLoading) return <LoadingState label="正在載入 Agent" />;
  if (query.error) return <ErrorState message="無法載入 Agent 清單。" />;
  const filtered = query.data?.filter((agent) => `${agent.name} ${agent.description} ${agent.department}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <><PageHeader eyebrow="AGENT WORKSPACE" title="Agent 配置" description="以員工為中心，逐步配置模型、工具、知識、技能與部署。" />
  <div className="toolbar"><label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋 Agent 名稱、部門或用途" /></label><button className="secondary-button"><Filter size={16} />篩選</button></div>
  <div className="agent-grid">{filtered.map((agent) => <Link href={`/studio/agents/${agent.id}`} className="agent-card" key={agent.id}><div className="agent-card-top"><div className="agent-avatar"><Bot size={22} /></div><StatusBadge status={agent.status} /></div><div><p className="agent-department">{agent.department || 'GENERAL'}</p><h2>{agent.name}</h2><p>{agent.description}</p></div><div className="agent-meta"><span><SlidersHorizontal size={15} />{engineLabel(agent.engineExecute)}</span><span>{agent.skillCount ?? 0} Skills</span><span>{agent.workflowCount ?? 0} Workflows</span></div><div className="card-action">開啟配置工作區 <ArrowRight size={16} /></div></Link>)}</div></>;
}
