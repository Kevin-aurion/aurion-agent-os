'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Bot, Boxes, CheckCircle2, GitBranch, Radio, ShieldCheck, Sparkles } from 'lucide-react';
import { API } from '@/lib/api';
import type { Agent, DashboardSummary, Deployment } from '@/lib/types';
import { ErrorState, GateNotice, LoadingState, Metric, PageHeader, Section, StatusBadge } from '@/components/ui';
import { useAuth, isFde } from '@/lib/auth';

export default function StudioOverview() {
  const { user } = useAuth();
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => API.get<DashboardSummary>('/api/dashboard/summary') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => API.get<Agent[]>('/api/agents') });
  const deployments = useQuery({ queryKey: ['deployments'], enabled: isFde(user?.role), queryFn: () => API.get<Deployment[]>('/api/runtime/deployments') });
  if (summary.isLoading || agents.isLoading) return <LoadingState label="正在整理 AIOS 工作空間" />;
  if (summary.error || agents.error) return <ErrorState message="無法載入控制平面資料，請確認 AIOS Server 已啟動。" />;
  const pendingSkills = Object.entries(summary.data?.skills ?? {}).filter(([key]) => key !== 'CONFIRMED').reduce((sum, [, value]) => sum + value, 0);
  return <>
    <PageHeader eyebrow="STUDIO OVERVIEW" title={`早安，${user?.displayName || 'Kevin'}`} description="從一個畫面掌握 AI 員工、能力資產與受治理的 Runtime。" actions={<Link className="primary-button" href="/studio/agents"><Bot size={17} />配置 Agent</Link>} />
    <GateNotice><strong>正式生效仍由 AIOS 治理。</strong><span> Studio 只改善操作與資訊呈現，不會繞過 Skill 確認、跨模型驗證、FDE 核准或 Production 閘門。</span></GateNotice>
    <div className="metric-grid"><Metric label="啟用中的 Agent" value={summary.data?.agents.active ?? 0} hint={`${agents.data?.length ?? 0} 位員工已建立`} tone="positive" /><Metric label="等待治理" value={pendingSkills} hint="Skill 與提案仍需確認" tone="warning" /><Metric label="啟用工作流" value={summary.data?.workflows.enabled ?? 0} hint="由 Runtime 持續管理" /><Metric label="Runtime 連線" value={<span className="metric-inline"><span className="pulse-dot" />Online</span>} hint={`${summary.data?.wsConnections ?? 0} 個即時連線`} tone="positive" /></div>
    <div className="overview-grid"><Section title="最近的 AI 員工" description="快速進入個別 Agent 的漸進式配置。" actions={<Link className="text-link" href="/studio/agents">查看全部 <ArrowUpRight size={15} /></Link>}><div className="entity-list">{agents.data?.slice(0, 5).map((agent) => <Link href={`/studio/agents/${agent.id}`} className="entity-row" key={agent.id}><div className="entity-icon"><Bot size={19} /></div><div className="entity-main"><strong>{agent.name}</strong><span>{agent.department || '未分類'} · {agent.skillCount ?? 0} 個 Skill</span></div><StatusBadge status={agent.status} /><ArrowUpRight size={16} /></Link>)}</div></Section>
    <Section title="治理管線" description="每一個正式版本都沿同一條安全路徑前進。"><div className="governance-path"><div><Sparkles /><strong>建立草稿</strong><span>對話或配置</span></div><i /><div><Boxes /><strong>能力組裝</strong><span>Model · Tool · Knowledge</span></div><i /><div><GitBranch /><strong>跨模型驗證</strong><span>Execute ≠ Verify</span></div><i /><div><ShieldCheck /><strong>FDE 放行</strong><span>Immutable version</span></div></div></Section></div>
    {isFde(user?.role) && <Section title="Deployment 摘要" description="Sandbox 與 Production 狀態保持清楚分離。"><div className="deployment-strip"><div><Radio size={18} /><span>Sandbox</span><strong>{deployments.data?.filter((item) => item.environment === 'SANDBOX' && item.active).length ?? 0}</strong></div><div><CheckCircle2 size={18} /><span>Production</span><strong>{deployments.data?.filter((item) => item.environment === 'PRODUCTION' && item.active).length ?? 0}</strong></div><Link href="/studio/runtime">開啟 Runtime 工作區 <ArrowUpRight size={15} /></Link></div></Section>}
  </>;
}
