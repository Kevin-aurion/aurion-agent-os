'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { BookOpen, Bot, BrainCircuit, Check, ChevronLeft, Code2, Database, Network, Puzzle, Rocket, Save, ShieldCheck, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { API } from '@/lib/api';
import type { Agent } from '@/lib/types';
import { canSaveEnginePair, engineLabel } from '@/lib/presentation';
import { Disclosure, ErrorState, GateNotice, LoadingState, PageHeader, Section, SettingRow, StatusBadge } from '@/components/ui';
import { isFde, useAuth } from '@/lib/auth';

const tabs = [
  ['overview', '總覽', Bot], ['models', '模型', BrainCircuit], ['tools', 'Tool 與 MCP', Network],
  ['knowledge', 'Knowledge', Database], ['skills', 'Skill', Puzzle], ['deployment', 'Deployment', Rocket],
] as const;

export default function AgentWorkspace() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const active = search.get('tab') || 'overview';
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['agent', id], queryFn: () => API.get<Agent>(`/api/agents/${id}`) });
  const [execute, setExecute] = useState('CLAUDE_CODE');
  const [verify, setVerify] = useState<string | null>(null);
  useEffect(() => { if (query.data) { setExecute(query.data.engineExecute); setVerify(query.data.engineVerify); } }, [query.data]);
  const update = useMutation({ mutationFn: (body: unknown) => API.patch<Agent>(`/api/agents/${id}`, body), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent', id] }) });
  if (query.isLoading) return <LoadingState label="正在載入 Agent 配置" />;
  if (query.error || !query.data) return <ErrorState message="找不到這位 Agent，或你沒有查看權限。" />;
  const agent = query.data;
  const canEdit = isFde(user?.role);
  return <><Link className="back-link" href="/studio/agents"><ChevronLeft size={16} />返回 Agent</Link><PageHeader eyebrow={agent.department || 'GENERAL'} title={agent.name} description={agent.description} actions={<StatusBadge status={agent.status} />} />
  <nav className="tabbar" aria-label="Agent 配置區段">{tabs.map(([key, label, Icon]) => <Link key={key} href={`/studio/agents/${id}?tab=${key}`} className={active === key ? 'active' : ''}><Icon size={16} />{label}</Link>)}</nav>
  {active === 'overview' && <div className="workspace-grid"><Section title="身分與工作方式" description="最常使用的設定先呈現，進階內容按需展開。"><SettingRow icon={<Bot />} title="員工狀態" description="暫停會阻止新的工作執行，但保留所有配置與版本。"><StatusBadge status={agent.status} /></SettingRow><SettingRow icon={<Workflow />} title="工作資產" description="已掛載的 Skill 與 Workflow。"><div className="inline-counts"><span>{agent.skills?.length ?? 0} Skills</span><span>{agent.workflows?.length ?? 0} Workflows</span></div></SettingRow><Disclosure title="角色指令" description="只有需要調整 Agent 核心行為時才展開。"><pre className="prompt-preview">{agent.rolePrompt}</pre></Disclosure></Section><Section title="治理摘要" description="這些限制由程式碼與審核閘執行。"><div className="guard-list"><div><ShieldCheck /><span><strong>跨模型驗證</strong>{engineLabel(agent.engineExecute)} → {engineLabel(agent.engineVerify)}</span><Check /></div><div><Code2 /><span><strong>Shell</strong>{agent.restrictions?.shell ? '已允許（高風險）' : '預設禁止'}</span><StatusBadge status={agent.restrictions?.shell ? 'WARNING' : 'ACTIVE'} /></div><div><BookOpen /><span><strong>版本與稽核</strong>不可變版本與 Audit Log</span><Check /></div></div></Section></div>}
  {active === 'models' && <Section title="模型配置" description="執行與驗證必須使用不同模型家族。"><GateNotice><strong>跨模型驗證不可弱化。</strong><span> 如果選擇相同模型，Studio 會在送出前拒絕。</span></GateNotice><SettingRow icon={<BrainCircuit />} title="執行模型" description="負責完成工作與工具編排。"><select value={execute} disabled={!canEdit} onChange={(event) => setExecute(event.target.value)}><option value="CLAUDE_CODE">Claude Code</option><option value="CODEX">Codex</option><option value="GROK">Grok</option></select></SettingRow><SettingRow icon={<ShieldCheck />} title="驗證模型" description="獨立檢查輸出；自動配置會選擇與執行模型不同的家族。"><select value={verify ?? ''} disabled={!canEdit} onChange={(event) => setVerify(event.target.value || null)}><option value="">自動配置</option><option value="CLAUDE_CODE">Claude Code</option><option value="CODEX">Codex</option><option value="GROK">Grok</option></select></SettingRow>{!canSaveEnginePair(execute, verify) && <ErrorState message="執行模型與驗證模型不可相同。" />}{canEdit && <div className="form-actions"><button className="primary-button" disabled={!canSaveEnginePair(execute, verify) || update.isPending} onClick={() => update.mutate({ engineExecute: execute, engineVerify: verify })}><Save size={16} />{update.isPending ? '儲存中…' : '儲存模型配置'}</button></div>}</Section>}
  {active === 'tools' && <Section title="Tool 與 MCP" description="先設定能力邊界，再由 FDE 核准實際連線。"><GateNotice><strong>Agent 不會自行取得工具權限。</strong><span> MCP Registry、allowlist、風險分級與核准政策由控制平面管理。</span></GateNotice><div className="feature-cards"><div><Network /><h3>已註冊的 MCP</h3><p>在共用 Registry 選擇此 Agent 可使用的伺服器與工具。</p><Link href="/studio/tools">開啟 Tool Registry</Link></div><div><ShieldCheck /><h3>權限邊界</h3><p>Cloud write、寄信、電腦操作與不可逆動作需人工核准。</p><span>Fail-closed</span></div></div><Disclosure title="目前限制" description="展開查看 Agent 的程式碼層能力限制。" defaultOpen><div className="restriction-grid">{Object.entries(agent.restrictions ?? {}).map(([key, value]) => <div key={key}><span>{key}</span><StatusBadge status={value === true ? 'ACTIVE' : 'BLOCKED'} /></div>)}</div></Disclosure></Section>}
  {active === 'knowledge' && <Section title="Knowledge 配置" description="將來源、範圍與讀寫權限綁定到這位 Agent。"><GateNotice><strong>Runtime 不會直接連接向量資料庫。</strong><span> 檢索需經 AIOS Knowledge Gateway 與 Agent scope 檢查。</span></GateNotice>{agent.fileTargets?.length ? <div className="entity-list">{agent.fileTargets.map((target) => <div className="entity-row" key={target.id}><div className="entity-icon"><Database size={18} /></div><div className="entity-main"><strong>{target.cloudFileRef?.name || target.cloudFileRef?.path || '知識來源'}</strong><span>{target.purpose || 'Agent context'}</span></div><StatusBadge status="READ" /></div>)}</div> : <div className="empty-inline"><Database /><div><strong>尚未綁定知識來源</strong><p>可在 FDE 核准後加入檔案、Knowledge Base 或受限檢索能力。</p></div></div>}<Disclosure title="知識安全策略" description="分類、引用與寫入政策。"><ul className="check-list"><li>每個查詢必須綁定 Agent 與 deployment</li><li>敏感內容在落地前永遠經過 redactor</li><li>寫入與刪除必須採用獨立能力與核准</li></ul></Disclosure></Section>}
  {active === 'skills' && <Section title="Skill 配置" description="Skill 是可版本化資產，不是單一 Prompt。"><div className="entity-list">{agent.skills?.map(({ skill }) => <Link className="entity-row" href="/studio/skills" key={skill.id}><div className="entity-icon"><Puzzle size={18} /></div><div className="entity-main"><strong>{skill.name}</strong><span>{skill.kind} · {skill.executionEnv}</span></div><StatusBadge status={skill.reviewStatus} /></Link>)}</div>{!agent.skills?.length && <div className="empty-inline"><Puzzle /><div><strong>尚未掛載 Skill</strong><p>新 Skill 必須停在待確認狀態，直到 FDE 完成審核。</p></div></div>}</Section>}
  {active === 'deployment' && <Section title="Deployment" description="Native 與 Langflow 都只是執行 Runtime；AIOS 仍是唯一控制平面。"><div className="deployment-choice"><div className="runtime-option selected"><span className="radio-selected" /><div><strong>Native Runtime</strong><p>使用 AIOS 本機 CLI 引擎，適合完整 Agent 能力。</p></div><StatusBadge status="ACTIVE" /></div><div className="runtime-option"><span className="radio-empty" /><div><strong>Langflow Runtime</strong><p>適合 FDE 視覺化除錯與受限制的 Flow 執行。</p></div><StatusBadge status="FDE GATED" /></div></div><GateNotice><strong>部署不是儲存按鈕。</strong><span> Artifact 驗證、Skill 確認、Eval、跨模型與 FDE 八道檢查全部通過後才能啟用。</span></GateNotice><Link className="secondary-button inline-button" href="/studio/runtime"><Rocket size={16} />開啟 Runtime 工作區</Link></Section>}
  </>;
}
