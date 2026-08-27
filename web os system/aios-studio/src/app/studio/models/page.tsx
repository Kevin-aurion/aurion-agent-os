import { Bot, BrainCircuit, CheckCircle2, Gauge, ShieldCheck, Sparkles } from 'lucide-react';
import { GateNotice, PageHeader, Section, SettingRow, StatusBadge } from '@/components/ui';

const models = [
  { name: 'Claude Code', id: 'CLAUDE_CODE', role: '主要執行與長上下文推理', icon: Sparkles, state: 'AVAILABLE' },
  { name: 'Codex', id: 'CODEX', role: '程式、電腦操控與跨模型驗證', icon: Bot, state: 'AVAILABLE' },
  { name: 'Grok', id: 'GROK', role: '快速檢索、草擬與輔助決策', icon: Gauge, state: 'AVAILABLE' },
];
export default function ModelsPage() { return <><PageHeader eyebrow="MODEL ROUTING" title="模型配置" description="模型是可替換的執行資源；Agent 只保存家族、用途與治理策略。" /><GateNotice><strong>每一次正式工作都必須跨模型驗證。</strong><span> 執行模型與驗證模型相同時，AIOS 會 fail-closed。</span></GateNotice><Section title="可用模型家族" description="這裡顯示 AIOS 主機可派工的三個本機 CLI 引擎。"><div className="provider-grid">{models.map(({ name, id, role, icon: Icon, state }) => <div className="provider-card" key={id}><div className="provider-icon"><Icon size={21} /></div><div><h3>{name}</h3><code>{id}</code><p>{role}</p></div><StatusBadge status={state} /></div>)}</div></Section><Section title="全域路由原則" description="個別 Agent 可在自己的模型頁覆寫。"><SettingRow icon={<BrainCircuit />} title="執行模型" description="依工作類型與 Agent 配置選擇最適家族。"><span className="readonly-value">Agent 層設定</span></SettingRow><SettingRow icon={<ShieldCheck />} title="驗證模型" description="永遠選擇與執行模型不同的家族。"><span className="readonly-value"><CheckCircle2 size={15} />強制啟用</span></SettingRow></Section></> }
