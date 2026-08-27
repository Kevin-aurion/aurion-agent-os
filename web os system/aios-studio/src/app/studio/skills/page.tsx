'use client';
import { useQuery } from '@tanstack/react-query';
import { FileCode2, Puzzle, Search, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { API } from '@/lib/api';
import type { Skill } from '@/lib/types';
import { ErrorState, GateNotice, LoadingState, PageHeader, Section, StatusBadge } from '@/components/ui';

export default function SkillsPage() {
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['skills'], queryFn: () => API.get<Skill[]>('/api/skills') });
  if (query.isLoading) return <LoadingState label="正在讀取 Skill Registry" />;
  if (query.error) return <ErrorState message="無法載入 Skill Registry。" />;
  const items = query.data?.filter((skill) => `${skill.name} ${skill.kind} ${skill.origin}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <><PageHeader eyebrow="VERSIONED CAPABILITIES" title="Skill 配置" description="把指令、輸入輸出、限制、測試與版本視為正式資產管理。" /><GateNotice><strong>Skill 永不自動確認。</strong><span> 新建與修改內容都停在待確認狀態，只有 FDE 能產生可掛載版本。</span></GateNotice><div className="toolbar"><label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋 Skill" /></label></div><Section title="Skill Registry" description={`${items.length} 個能力資產。`}><div className="registry-table skill-table"><div className="table-head"><span>Skill</span><span>Kind</span><span>Runtime</span><span>Origin</span><span>Review</span></div>{items.map((skill) => <div className="table-row" key={skill.id}><div className="registry-name"><div className="entity-icon"><Puzzle size={17} /></div><span><strong>{skill.name}</strong><small>{skill.slug}</small></span></div><span>{skill.kind}</span><span>{skill.executionEnv}</span><span>{skill.origin}</span><StatusBadge status={skill.reviewStatus} /></div>)}</div></Section><div className="double-grid"><div className="mini-panel"><FileCode2 /><h3>Immutable versions</h3><p>內容雜湊相同時重用版本；rollback 只切換指標，不刪資料。</p></div><div className="mini-panel"><ShieldCheck /><h3>Evaluation gate</h3><p>升級前必須通過 EvalSuite、紅隊案例與跨模型驗證。</p></div></div></>;
}
