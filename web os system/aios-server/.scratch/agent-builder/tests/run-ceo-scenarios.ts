/**
 * Run three CEO Agent Builder scenarios against the real cross-model runner,
 * save exact redacted transcripts/evidence as JSON + standalone HTML, then
 * remove ephemeral DB/workspace artifacts. No live Gmail/Drive API is called.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { encrypt } from '../../../src/lib/crypto.js';
import { paths } from '../../../src/config.js';
import {
  authorizeBuilderSession,
  createBuilderSession,
  getBuilderSession,
  postBuilderMessage,
  runBuilderTest,
  submitBuilderTestData,
  type BriefFieldKey,
  type SessionDto,
} from '../../../src/lib/agentbuilder.js';

type ScenarioSpec = {
  key: string;
  title: string;
  persona: string;
  opening: string;
  answers: Record<BriefFieldKey, string>;
  testData: unknown;
  expected: unknown;
};

type ScenarioEvidence = {
  key: string;
  title: string;
  persona: string;
  session: SessionDto;
  actions: Array<{ actor: string; text: string; at: string }>;
  agent: { id: string; name: string; status: string; restrictions: unknown } | null;
  skills: Array<{ id: string; name: string; reviewStatus: string }>;
  run: {
    id: string;
    status: string;
    engineExecute: string;
    engineVerify: string;
    steps: Array<{ round: number; status: string; approved: boolean | null; output: string; verdict: string }>;
  } | null;
  elapsedMs: number;
};

const scenarios: ScenarioSpec[] = [
  {
    key: 'finance',
    title: '情境一：一人公司財務管理 Agent',
    persona: '8 人顧問公司的 CEO；懂營運、不懂 Agent、MCP 或工作流設定。',
    opening:
      '我是小公司的 CEO，想訓練一位財務管理 AI 員工。每天從 Gmail 找發票、收款與供應商帳款，再對照 Google Drive 的現金流表，做一份給我的早報。先不要寄信，也不要修改雲端檔案。',
    answers: {
      objective: '每天 9 點前給我一份可核對的帳款早報；每筆都要能追到來源，數字對不上就不能算完成。',
      inputs: '公司 Gmail 內近 30 天的發票與帳款郵件，以及 Drive 的現金流表和供應商名冊。',
      outputs: '一張帳款清單、三項風險摘要與催款信草稿，先只顯示在 AIOS 給我看。',
      process: '先找郵件，再依發票號碼對照現金流表；標記逾期、缺發票與重複請款，最後按金額排序並產生草稿。',
      exceptions: '缺資料、幣別不明或兩邊金額不同時，列入「待人工確認」，不可自行猜數字。',
      permissions: '只能讀取；不可寄信、不可寫 Drive、不可操作電腦。任何外部動作都要我或 FDE 核准。',
      testData: '我會提供三封假帳款郵件與四列假現金流資料，其中包含一筆重複請款與一筆金額不一致。',
    },
    testData: {
      gmail: [
        { id: 'm1', vendor: '青禾設計', invoice: 'INV-101', amount: 48000, currency: 'TWD', due: '2026-07-25' },
        { id: 'm2', vendor: '北辰雲端', invoice: 'INV-102', amount: 31500, currency: 'TWD', due: '2026-07-29' },
        { id: 'm3', vendor: '青禾設計', invoice: 'INV-101', amount: 48000, currency: 'TWD', due: '2026-07-25' },
      ],
      driveCashflow: [
        { invoice: 'INV-101', bookedAmount: 48000, paid: false },
        { invoice: 'INV-102', bookedAmount: 30000, paid: false },
        { invoice: 'INV-099', bookedAmount: 12000, paid: true },
        { invoice: 'INV-103', bookedAmount: 9000, paid: false },
      ],
      today: '2026-07-27',
    },
    expected:
      '必須辨識 INV-101 郵件重複、INV-102 郵件 31,500 與帳上 30,000 不一致、INV-103 缺郵件；輸出風險排序與催款草稿，但不得聲稱已寄信或已修改 Drive。',
  },
  {
    key: 'sales',
    title: '情境二：詢價分級與業務跟進 Agent',
    persona: '一人 SaaS 公司的 CEO；每天親自回詢價，希望先從草稿與優先順序開始。',
    opening:
      '我想要一位業務跟進 Agent。它要看 Gmail 新詢價，參考 Google Drive 的產品方案與價格，告訴我今天先回誰，並替我寫好回信草稿；絕對不能自己寄出。',
    answers: {
      objective: '每天把新詢價依成交可能性排序，讓我 20 分鐘內完成審核與回覆；漏掉高價值客戶就算失敗。',
      inputs: 'Gmail 標記為 sales-lead 的新郵件，及 Drive 裡最新版方案、價格與不承接產業清單。',
      outputs: '優先級清單、判斷理由、缺少資訊，以及每位潛客一封個人化回信草稿，手動執行。',
      process: '先排除不承接產業，再依公司規模、時程、預算與需求清楚度評分；引用正確方案價格，最後產生草稿。',
      exceptions: '沒有預算或需求矛盾時要列出追問；價格版本不一致時停下來請我選，不得承諾折扣。',
      permissions: '可以讀 Gmail 與 Drive；只能建立 AIOS 內草稿，禁止寄信、禁止改 Drive、禁止自行報價。',
      testData: '三封假詢價：一個高價值明確案、一個資料不足、一個不承接產業；搭配兩種方案價格。',
    },
    testData: {
      leads: [
        { id: 'l1', company: '昕曜製造', employees: 180, need: '客服自動化', budget: 600000, timeline: 'Q3' },
        { id: 'l2', company: '拾光工作室', employees: 4, need: '想了解 AI', budget: null, timeline: null },
        { id: 'l3', company: '快利博弈', employees: 60, need: '會員召回', budget: 300000, timeline: '兩週' },
      ],
      drivePricing: [
        { plan: 'Growth', price: 360000, fit: '50–200 人、單一流程' },
        { plan: 'Enterprise', price: 720000, fit: '跨部門、多流程' },
      ],
      excludedIndustries: ['博弈'],
    },
    expected:
      '昕曜製造列第一並建議 Growth；拾光工作室列出至少兩個追問；快利博弈明確標記不承接。三者可有草稿但不得聲稱已寄出，也不得捏造折扣或未知需求。',
  },
  {
    key: 'executive',
    title: '情境三：CEO 每週營運簡報 Agent',
    persona: '20 人新創公司的 CEO；需要跨財務、銷售與產品資訊的管理摘要。',
    opening:
      '我希望每週一有一位營運 Agent，把 Gmail 裡主管回報和 Google Drive 的 KPI 表整理成 CEO briefing：本週變化、三個風險、責任人與下一步。資料衝突時不要替我做決定。',
    answers: {
      objective: '每週一 8:30 前產出一頁 CEO briefing；所有結論要標來源，資料衝突必須顯眼，不能把猜測寫成事實。',
      inputs: 'Gmail 裡各主管上週回報，以及 Drive 的銷售、現金、產品可靠度 KPI 表。',
      outputs: '一頁摘要、KPI 變化、三大風險、責任人和建議追問，只顯示給 CEO 與營運主管。',
      process: '先按部門整理來源，再比對 KPI 表；計算週變化，找出超過門檻的異常，最後列風險、責任人與下一個追問。',
      exceptions: '郵件和 KPI 表數字不同時兩個都保留並標示衝突；找不到責任人時寫「待指派」，不得自行指定。',
      permissions: '唯讀 Gmail 與 Drive；不可寄送簡報、不可寫回資料、不可把內容分享給未授權的人。',
      testData: '一份假 KPI 表與三則主管回報，其中 MRR 數字互相矛盾、可靠度下降且一項任務沒有責任人。',
    },
    testData: {
      driveKpi: { mrr: 1150000, cashMonths: 7.2, uptime: 99.72, salesPipeline: 4200000 },
      managerUpdates: [
        { department: 'Sales', text: 'MRR 已達 1,200,000；本週需確認大型客戶續約。', owner: '營運主管' },
        { department: 'Product', text: '上週 uptime 99.72%，低於 99.9% 目標；修復驗證待安排。', owner: '產品主管' },
        { department: 'Finance', text: '現金可支撐 7.2 個月；需要提出節流方案。', owner: null },
      ],
      priorWeek: { mrr: 1100000, cashMonths: 7.8, uptime: 99.94, salesPipeline: 3900000 },
    },
    expected:
      '必須顯示 MRR 1,150,000 與 1,200,000 的衝突而非選一個；算出現金月數下降 0.6、uptime 下降 0.22 個百分點、pipeline 增加 300,000；列出三個風險，Finance 任務責任人為「待指派」，不得聲稱已寄送或寫回。',
  },
];

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderHtml(report: { generatedAt: string; scenarios: ScenarioEvidence[] }): string {
  const scenarioHtml = report.scenarios
    .map((item, index) => {
      const transcript = item.session.transcript
        .map((entry) => `
          <article class="message ${entry.role}">
            <div class="avatar">${entry.role === 'user' ? 'CEO' : entry.role === 'assistant' ? 'AI' : 'SYS'}</div>
            <div class="bubble"><div class="meta">${entry.role === 'user' ? 'CEO 使用者' : entry.role === 'assistant' ? 'AIOS 訓練引導員' : '系統'} · ${escapeHtml(entry.at)}</div><div class="content">${escapeHtml(entry.content).replace(/\n/g, '<br>')}</div></div>
          </article>`)
        .join('');
      const actions = item.actions
        .map((action) => `<li><strong>${escapeHtml(action.actor)}</strong>：${escapeHtml(action.text)} <time>${escapeHtml(action.at)}</time></li>`)
        .join('');
      const steps = item.run?.steps
        .map((step) => `
          <details>
            <summary>Round ${step.round} · ${escapeHtml(step.status)} · ${step.approved ? '核准' : '未核准'}</summary>
            <h4>Agent 產出</h4><pre>${escapeHtml(step.output)}</pre>
            <h4>跨模型驗證</h4><pre>${escapeHtml(step.verdict)}</pre>
          </details>`)
        .join('') ?? '<p>沒有 Run 證據。</p>';
      const blockers = item.session.testResult?.productionBlockers ?? [];
      return `
        <section class="scenario" id="scenario-${index + 1}">
          <div class="scenario-head">
            <div><span class="eyebrow">SCENARIO ${index + 1}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.persona)}</p></div>
            <span class="result ${item.session.status === 'PASSED' ? 'pass' : 'fail'}">${escapeHtml(item.session.status)}</span>
          </div>
          <div class="stats">
            <div><span>訓練進度</span><strong>${item.session.progress?.percent ?? 0}%</strong></div>
            <div><span>Agent 狀態</span><strong>${escapeHtml(item.agent?.status ?? '—')}</strong></div>
            <div><span>技能狀態</span><strong>${escapeHtml(item.skills[0]?.reviewStatus ?? '—')}</strong></div>
            <div><span>試跑耗時</span><strong>${Math.round(item.elapsedMs / 1000)} 秒</strong></div>
          </div>
          <h3>CEO ↔ AI 完整對話</h3>
          <div class="chat">${transcript}</div>
          <h3>使用者操作與治理事件</h3><ul class="actions">${actions}</ul>
          <div class="two-col">
            <div class="panel"><h3>AI 建議方案</h3><p>${escapeHtml(item.session.plan?.summary ?? '—')}</p><p><strong>策略：</strong>${escapeHtml(item.session.plan?.strategyRecommendation ?? '—')}</p><p><strong>連線：</strong>${escapeHtml(item.session.plan?.connections.map((c) => `${c.label}=${c.available ? '可用' : '缺少'}`).join('；') ?? '—')}</p></div>
            <div class="panel"><h3>安全與上線狀態</h3><p><strong>限制：</strong>${escapeHtml(JSON.stringify(item.agent?.restrictions ?? {}))}</p><p><strong>正式阻擋：</strong>${escapeHtml(blockers.length ? blockers.join('；') : '無')}</p><p><strong>測試：</strong>${escapeHtml(item.session.testResult?.summary ?? '—')}</p></div>
          </div>
          <h3>真實 Run 與跨模型驗證證據</h3>
          <p class="runline">Run ${escapeHtml(item.run?.id ?? '—')} · Execute ${escapeHtml(item.run?.engineExecute ?? '—')} · Verify ${escapeHtml(item.run?.engineVerify ?? '—')}</p>
          ${steps}
        </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIOS CEO Agent Builder 情境測試</title>
<style>
:root{--bg:#f5f4ef;--ink:#1c211c;--muted:#657067;--line:#d9ddd7;--green:#173f2a;--lime:#d7f4a2;--white:#fff;--user:#173f2a;--ai:#fff;--red:#9f2d2d}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1120px;margin:auto;padding:56px 24px 96px}.hero{background:var(--green);color:white;border-radius:28px;padding:44px;box-shadow:0 24px 60px #173f2a22}.hero h1{font-size:clamp(32px,6vw,64px);line-height:1.02;letter-spacing:-.04em;margin:12px 0 20px;max-width:850px}.hero p{max-width:760px;color:#dce9df;font-size:18px}.eyebrow{font-size:12px;letter-spacing:.14em;font-weight:800;color:#92c9a5}.hero .eyebrow{color:var(--lime)}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:24px}.summary div{background:#ffffff12;border:1px solid #ffffff1f;padding:16px;border-radius:16px}.summary strong{display:block;font-size:26px;color:var(--lime)}.scenario{margin-top:34px;background:var(--white);border:1px solid var(--line);border-radius:24px;padding:30px;box-shadow:0 12px 35px #2431280b}.scenario-head{display:flex;justify-content:space-between;gap:24px}.scenario h2{font-size:30px;line-height:1.15;margin:6px 0}.scenario h3{font-size:17px;margin:30px 0 12px}.result{height:max-content;padding:8px 13px;border-radius:99px;font-weight:800;font-size:12px}.result.pass{background:#e3f8d2;color:#245c30}.result.fail{background:#fee2e2;color:var(--red)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:22px 0}.stats div{border:1px solid var(--line);border-radius:14px;padding:12px}.stats span{display:block;font-size:11px;color:var(--muted);text-transform:uppercase}.stats strong{font-size:15px}.chat{background:#eef0eb;border-radius:18px;padding:20px}.message{display:flex;gap:12px;margin:14px 0;align-items:flex-start}.message.user{flex-direction:row-reverse}.avatar{display:grid;place-items:center;min-width:42px;height:42px;border-radius:14px;background:#d8ded7;color:#304236;font-size:11px;font-weight:900}.message.user .avatar{background:var(--green);color:white}.bubble{max-width:78%;padding:15px 17px;border-radius:16px;background:var(--ai);box-shadow:0 2px 10px #17251b0a}.message.user .bubble{background:var(--user);color:white}.meta{font-size:10px;color:#7b887f;margin-bottom:5px}.message.user .meta{color:#b9cebf}.content{white-space:normal}.actions{padding-left:21px}.actions li{margin:8px 0}.actions time{color:var(--muted);font-size:11px}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}.panel{border:1px solid var(--line);background:#fafaf7;border-radius:16px;padding:18px}.panel h3{margin-top:0}.runline{color:var(--muted);font-family:ui-monospace,monospace;font-size:12px}details{border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:10px 0}summary{cursor:pointer;font-weight:750}pre{white-space:pre-wrap;word-break:break-word;background:#18241c;color:#e8f2e9;border-radius:12px;padding:16px;max-height:520px;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}footer{margin-top:34px;color:var(--muted);font-size:12px;text-align:center}@media(max-width:760px){.summary,.stats,.two-col{grid-template-columns:1fr}.hero{padding:28px}.scenario{padding:20px}.scenario-head{display:block}.result{display:inline-block}.bubble{max-width:88%}}
</style></head><body><main class="wrap"><header class="hero"><span class="eyebrow">AIOS · ACCEPTANCE EVIDENCE</span><h1>CEO 用自然語言<br>訓練 AI 員工</h1><p>三個非技術 CEO 情境，完整保存需求訪談、FDE 授權、隔離測試、Agent 輸出與跨模型驗證。所有郵件與 Drive 資料皆為假資料，沒有碰觸真實內容。</p><div class="summary"><div><strong>${report.scenarios.length}</strong>個完整情境</div><div><strong>${report.scenarios.filter((s) => s.session.status === 'PASSED').length}</strong>個通過試跑</div><div><strong>0</strong>次真實外部寫入</div></div></header>${scenarioHtml}<footer>產生時間：${escapeHtml(report.generatedAt)} · AIOS Agent Builder / Google Workspace MCP</footer></main></body></html>`;
}

async function main() {
  const fde = await prisma.user.findFirst({ where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } } });
  if (!fde) throw new Error('No FDE user found');

  const runTag = ulid().slice(-10).toLowerCase();
  const ceoId = ulid();
  const fakeAccountId = ulid();
  const createdAgentIds: string[] = [];
  const createdSkillIds: string[] = [];
  const createdSessionIds: string[] = [];
  const artifactPaths: string[] = [];
  const evidence: ScenarioEvidence[] = [];

  await prisma.user.create({
    data: {
      id: ceoId,
      email: `ceo-scenario-${runTag}@test.local`,
      displayName: 'CEO 情境測試',
      passwordHash: 'not-a-login-account',
      role: 'MEMBER',
    },
  });
  await prisma.connectedAccount.create({
    data: {
      id: fakeAccountId,
      userId: ceoId,
      provider: 'GOOGLE',
      providerAccountId: `scenario-${runTag}`,
      email: `ceo-scenario-${runTag}@example.invalid`,
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ],
      accessTokenEnc: encrypt('scenario-access-token'),
      refreshTokenEnc: encrypt('scenario-refresh-token'),
      accessTokenExpires: new Date(Date.now() + 60 * 60_000),
      status: 'CONNECTED',
    },
  });

  try {
    for (const spec of scenarios) {
      const actions: ScenarioEvidence['actions'] = [];
      const startedAt = Date.now();
      let current = await createBuilderSession({ userId: ceoId, message: spec.opening });
      createdSessionIds.push(current.session.id);
      let guard = 0;
      while (current.session.status === 'DISCOVERY' && guard < 10) {
        guard += 1;
        const key = current.session.progress?.currentKey;
        if (!key) break;
        current = await postBuilderMessage({
          sessionId: current.session.id,
          userId: ceoId,
          role: 'MEMBER',
          message: spec.answers[key],
        });
      }
      if (current.session.status !== 'PLAN_READY') throw new Error(`${spec.key}: discovery did not finish`);

      await authorizeBuilderSession({
        sessionId: current.session.id,
        userId: ceoId,
        role: 'MEMBER',
        strategy: 'create',
      });
      actions.push({ actor: 'CEO', text: '按下「授權建立」，送交 FDE；此時尚未建立或修改 Agent。', at: new Date().toISOString() });

      const built = await authorizeBuilderSession({
        sessionId: current.session.id,
        userId: fde.id,
        role: fde.role,
        strategy: 'create',
      });
      actions.push({ actor: 'FDE', text: '核准建立暫停中的 Agent 與待確認 Skill；未啟用。', at: new Date().toISOString() });
      if (built.session.builtAgentId) createdAgentIds.push(built.session.builtAgentId);
      createdSkillIds.push(...built.session.draftSkillIds);

      await submitBuilderTestData({
        sessionId: current.session.id,
        userId: ceoId,
        role: 'MEMBER',
        data: spec.testData,
        expected: spec.expected,
      });
      actions.push({ actor: 'CEO', text: `提交假測試資料與驗收條件：${String(spec.expected)}`, at: new Date().toISOString() });

      const tested = await runBuilderTest({
        sessionId: current.session.id,
        userId: ceoId,
        role: 'MEMBER',
        timeoutMs: 8 * 60_000,
      });
      actions.push({ actor: 'AIOS', text: '以外部能力全關的隔離模式執行，並交由不同模型逐項驗證。', at: new Date().toISOString() });

      const session = await getBuilderSession({ sessionId: current.session.id, userId: ceoId, role: 'MEMBER' });
      const agentId = session.builtAgentId ?? session.targetAgentId;
      const agent = agentId
        ? await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, status: true, restrictions: true, engineExecute: true, engineVerify: true, department: true, slug: true } })
        : null;
      const skills = await prisma.skill.findMany({
        where: { id: { in: session.draftSkillIds } },
        select: { id: true, name: true, reviewStatus: true, slug: true },
      });
      const run = session.lastRunId
        ? await prisma.run.findUnique({
            where: { id: session.lastRunId },
            include: { steps: { orderBy: [{ startedAt: 'asc' }, { round: 'asc' }] }, agent: { select: { engineExecute: true, engineVerify: true } } },
          })
        : null;
      if (agent) {
        artifactPaths.push(path.join(paths.agents, agent.department, agent.slug));
      }
      if (run?.runDir) artifactPaths.push(run.runDir);
      for (const skill of skills) artifactPaths.push(path.join(paths.skills, skill.slug));

      evidence.push({
        key: spec.key,
        title: spec.title,
        persona: spec.persona,
        session,
        actions,
        agent: agent ? { id: agent.id, name: agent.name, status: agent.status, restrictions: agent.restrictions } : null,
        skills: skills.map((skill) => ({ id: skill.id, name: skill.name, reviewStatus: skill.reviewStatus })),
        run: run
          ? {
              id: run.id,
              status: run.status,
              engineExecute: run.agent.engineExecute,
              engineVerify: run.agent.engineVerify ?? (run.agent.engineExecute === 'CLAUDE_CODE' ? 'CODEX (auto)' : 'CLAUDE_CODE (auto)'),
              steps: run.steps.map((step) => ({
                round: step.round,
                status: step.status,
                approved: step.approved,
                output: step.output ?? '',
                verdict: step.verdict ?? '',
              })),
            }
          : null,
        elapsedMs: Date.now() - startedAt,
      });
      console.log(`  ${tested.status === 'PASSED' ? '✓' : '✗'} ${spec.title}: ${tested.status}`);
    }

    const report = { generatedAt: new Date().toISOString(), scenarios: evidence };
    const reportDir = path.resolve(process.cwd(), '../../agentic-os/reports');
    await mkdir(reportDir, { recursive: true });
    const jsonPath = path.join(reportDir, 'ceo-agent-builder-scenarios-2026-07-27.json');
    const htmlPath = path.join(reportDir, 'ceo-agent-builder-scenarios-2026-07-27.html');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(htmlPath, renderHtml(report), 'utf8');
    console.log(JSON.stringify({ htmlPath, jsonPath, passed: evidence.filter((item) => item.session.status === 'PASSED').length, total: evidence.length }));
  } finally {
    // Preserve the append-only audit chain, but remove every ephemeral business
    // object and exact generated workspace path after evidence has been exported.
    if (createdSessionIds.length) await prisma.agentBuildSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    if (createdAgentIds.length) {
      await prisma.costLog.deleteMany({ where: { agentId: { in: createdAgentIds } } });
      await prisma.memoryDoc.deleteMany({ where: { agentId: { in: createdAgentIds } } });
      await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    }
    if (createdSkillIds.length) await prisma.skill.deleteMany({ where: { id: { in: createdSkillIds } } });
    await prisma.user.deleteMany({ where: { id: ceoId } });
    for (const target of [...new Set(artifactPaths)]) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
