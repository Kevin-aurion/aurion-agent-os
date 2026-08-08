/**
 * Full production-like acceptance for the first CEO finance scenario.
 *
 * This intentionally keeps the finalized Agent, confirmed Skill, Builder
 * session, Run evidence, and five Google Workspace MCP registry entries so an
 * FDE can inspect and use them afterwards. Live Google probes retain counts
 * only: no Gmail subject/sender/body or Drive name/id/content is persisted.
 * No external write is performed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  authorizeBuilderSession,
  createBuilderSession,
  finalizeBuilderSession,
  getBuilderSession,
  postBuilderMessage,
  runBuilderTest,
  submitBuilderTestData,
  type BriefFieldKey,
} from '../../../src/lib/agentbuilder.js';
import { googleWorkspaceRoutes } from '../../../src/routes/googleworkspace.js';
import { mcpRoutes } from '../../../src/routes/mcp.js';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`ASSERT FAIL: ${message}`);
}

const scenario = {
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
  } satisfies Record<BriefFieldKey, string>,
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
    today: '2026-07-28',
  },
  expected:
    '必須辨識 INV-101 郵件重複、INV-102 郵件 31,500 與帳上 30,000 不一致、INV-103 缺郵件；輸出風險排序與催款草稿，但不得聲稱已寄信或已修改 Drive。',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function mcpText(body: unknown): string {
  const envelope = body as { data?: { content?: Array<{ type?: string; text?: string }> } };
  return envelope.data?.content?.find((item) => item.type === 'text')?.text ?? '';
}

function parsedCount(body: unknown): number {
  const text = mcpText(body);
  assert(text, 'MCP result did not contain text content');
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object') {
    const value = parsed as Record<string, unknown>;
    for (const key of ['messages', 'files', 'items', 'results']) {
      if (Array.isArray(value[key])) return value[key].length;
    }
  }
  throw new Error('MCP result shape did not expose a countable list');
}

function renderHtml(report: Record<string, any>): string {
  const transcript = report.conversation
    .map(
      (entry: { role: string; content: string; at: string }) => `
      <article class="message ${escapeHtml(entry.role)}">
        <div class="avatar">${entry.role === 'user' ? 'CEO' : entry.role === 'assistant' ? 'AI' : 'SYS'}</div>
        <div class="bubble"><div class="meta">${escapeHtml(entry.role)} · ${escapeHtml(entry.at)}</div>${escapeHtml(entry.content).replace(/\n/g, '<br>')}</div>
      </article>`,
    )
    .join('');
  const checks = report.checks
    .map(
      (check: { label: string; passed: boolean; detail: string }) =>
        `<li class="${check.passed ? 'pass' : 'fail'}"><strong>${check.passed ? 'PASS' : 'FAIL'}</strong><span>${escapeHtml(check.label)}</span><small>${escapeHtml(check.detail)}</small></li>`,
    )
    .join('');
  const steps = report.crossModel.steps
    .map(
      (step: { round: number; status: string; approved: boolean; output: string; verdict: string }) =>
        `<details><summary>Round ${step.round} · ${escapeHtml(step.status)} · ${step.approved ? '核准' : '拒絕'}</summary><h4>Agent 產出（假測試資料）</h4><pre>${escapeHtml(step.output)}</pre><h4>跨模型驗證</h4><pre>${escapeHtml(step.verdict)}</pre></details>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>財務 Agent：FDE 與正式 MCP 驗證</title><style>
  :root{--bg:#f4f3ee;--ink:#172019;--green:#153c29;--lime:#d6f2a3;--line:#d9ddd7;--muted:#6b746d;--red:#9b2f2f}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1080px;margin:auto;padding:52px 24px 90px}.hero{background:var(--green);color:white;padding:40px;border-radius:26px}.hero h1{font-size:clamp(34px,6vw,62px);line-height:1.02;margin:10px 0 18px}.hero p{color:#dbe8dd;max-width:800px}.eyebrow{color:var(--lime);font-size:12px;font-weight:900;letter-spacing:.14em}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:22px}.metric{padding:15px;border:1px solid #ffffff22;border-radius:14px;background:#ffffff0d}.metric strong{display:block;color:var(--lime);font-size:24px}.card{margin-top:26px;background:white;border:1px solid var(--line);border-radius:22px;padding:28px}.checks{list-style:none;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:10px}.checks li{border:1px solid var(--line);border-radius:14px;padding:14px}.checks strong{display:inline-block;margin-right:8px}.checks .pass strong{color:#25723d}.checks .fail strong{color:var(--red)}.checks small{display:block;color:var(--muted);margin-top:5px}.chat{background:#ecefe9;border-radius:16px;padding:18px}.message{display:flex;gap:10px;margin:13px 0}.message.user{flex-direction:row-reverse}.avatar{display:grid;place-items:center;min-width:42px;height:42px;border-radius:13px;background:#d9dfd8;font-size:11px;font-weight:900}.message.user .avatar{background:var(--green);color:white}.bubble{max-width:82%;background:white;border-radius:15px;padding:14px 16px}.message.user .bubble{background:var(--green);color:white}.meta{font-size:10px;color:#7c887f;margin-bottom:4px}.message.user .meta{color:#bdd0c2}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.panel{background:#fafaf7;border:1px solid var(--line);border-radius:15px;padding:16px}code{word-break:break-all}details{border:1px solid var(--line);border-radius:13px;padding:12px 14px;margin:10px 0}summary{cursor:pointer;font-weight:750}pre{white-space:pre-wrap;word-break:break-word;background:#18241c;color:#e8f2e9;border-radius:12px;padding:15px;max-height:520px;overflow:auto;font:12px/1.55 ui-monospace,monospace}.notice{border-left:4px solid #d6a337;background:#fff8dc;padding:14px 16px;border-radius:10px;color:#5b491b}@media(max-width:760px){.grid,.checks,.two{grid-template-columns:1fr}.hero,.card{padding:22px}}
  </style></head><body><main class="wrap"><header class="hero"><span class="eyebrow">AIOS · FULL PRODUCTION-LIKE ACCEPTANCE</span><h1>財務 Agent<br>FDE 已正式通過</h1><p>從 CEO 自然語言需求、Grill-me 式訪談、假資料試跑、跨模型驗證，到 FDE 最終確認與 Google Workspace MCP 真實唯讀探測的完整證據。</p><div class="grid"><div class="metric"><strong>${escapeHtml(report.finalState.session)}</strong>Builder Session</div><div class="metric"><strong>${escapeHtml(report.finalState.agent)}</strong>Agent</div><div class="metric"><strong>${escapeHtml(report.finalState.skills.join(', '))}</strong>Skill</div></div></header>
  <section class="card"><h2>驗收結論</h2><ul class="checks">${checks}</ul><p class="notice">隱私處理：真實 Gmail／Drive 回傳內容在記憶體中立即丟棄；本報告只保存成功狀態與項目數量。寄信、草稿與 Drive 寫入均未執行。</p></section>
  <section class="card"><h2>正式產物</h2><div class="two"><div class="panel"><strong>Agent</strong><p>${escapeHtml(report.agent.name)} · <code>${escapeHtml(report.agent.id)}</code></p><p>狀態：${escapeHtml(report.finalState.agent)}</p></div><div class="panel"><strong>Skill</strong><p>${report.skills.map((s: any) => `${escapeHtml(s.name)} · <code>${escapeHtml(s.id)}</code>`).join('<br>')}</p><p>狀態：${escapeHtml(report.finalState.skills.join(', '))}</p></div></div><p>Builder Session：<code>${escapeHtml(report.sessionId)}</code> · Run：<code>${escapeHtml(report.crossModel.runId)}</code></p></section>
  <section class="card"><h2>CEO ↔ AIOS 完整對話</h2><div class="chat">${transcript}</div></section>
  <section class="card"><h2>FDE 與 MCP 實測</h2><div class="two"><div class="panel"><h3>FDE 治理</h3><p>MEMBER 冒用最終核准：${escapeHtml(report.fde.memberFinalizeDenied)}</p><p>FDE 最終核准：${escapeHtml(report.fde.finalized)}</p><p>Audit：${escapeHtml(report.fde.auditActions.join('、'))}</p></div><div class="panel"><h3>Google OAuth / MCP</h3><p>帳號狀態：${escapeHtml(report.google.status)}</p><p>已安裝且健康：${escapeHtml(report.google.healthyServers)} / ${escapeHtml(report.google.installedServers)} 個 MCP</p><p>Gmail 唯讀探測：成功，回傳 ${escapeHtml(report.google.gmailResultCount)} 筆</p><p>Drive 唯讀探測：成功，回傳 ${escapeHtml(report.google.driveResultCount)} 筆</p></div></div><h3>OAuth scopes</h3><pre>${escapeHtml(report.google.scopes.join('\n'))}</pre></section>
  <section class="card"><h2>真實 Run 與跨模型證據</h2><p>Execute：${escapeHtml(report.crossModel.execute)} · Verify：${escapeHtml(report.crossModel.verify)} · Status：${escapeHtml(report.crossModel.status)}</p>${steps}</section>
  <footer><p>產生時間：${escapeHtml(report.generatedAt)} · 真實外部寫入：0</p></footer></main></body></html>`;
}

async function main() {
  const startedAt = Date.now();
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'FDE owner/trainer account is required');
  const google = await prisma.connectedAccount.findFirst({
    where: { userId: owner.id, provider: 'GOOGLE', status: 'CONNECTED' },
    orderBy: { createdAt: 'asc' },
  });
  assert(google, 'connected Google account is required');

  let current = await createBuilderSession({ userId: owner.id, message: scenario.opening });
  let guard = 0;
  while (current.session.status === 'DISCOVERY' && guard < 10) {
    guard += 1;
    const key = current.session.progress?.currentKey;
    assert(key, 'discovery current key is missing');
    current = await postBuilderMessage({
      sessionId: current.session.id,
      userId: owner.id,
      role: owner.role,
      message: scenario.answers[key],
    });
  }
  assert(current.session.status === 'PLAN_READY', 'discovery must reach PLAN_READY');

  const built = await authorizeBuilderSession({
    sessionId: current.session.id,
    userId: owner.id,
    role: owner.role,
    strategy: 'create',
  });
  const agentId = built.session.builtAgentId;
  assert(agentId, 'builder must create an Agent');
  assert(built.session.draftSkillIds.length > 0, 'builder must create at least one Skill');

  await submitBuilderTestData({
    sessionId: current.session.id,
    userId: owner.id,
    role: owner.role,
    data: scenario.testData,
    expected: scenario.expected,
  });
  const tested = await runBuilderTest({
    sessionId: current.session.id,
    userId: owner.id,
    role: owner.role,
    timeoutMs: 8 * 60_000,
  });
  assert(tested.status === 'PASSED', `cross-model test must pass (got ${tested.status})`);

  let memberFinalizeDenied = false;
  try {
    await finalizeBuilderSession({ sessionId: current.session.id, userId: owner.id, role: 'MEMBER' });
  } catch (error) {
    memberFinalizeDenied = /Only FDE|forbidden/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(memberFinalizeDenied, 'MEMBER must not be able to finalize');

  const finalized = await finalizeBuilderSession({
    sessionId: current.session.id,
    userId: owner.id,
    role: owner.role,
  });
  assert(finalized.status === 'ACTIVE', 'FDE finalize must make the Builder session ACTIVE');

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true, status: true, restrictions: true, engineExecute: true, engineVerify: true },
  });
  assert(agent?.status === 'ACTIVE', 'FDE finalize must activate the Agent');
  const skills = await prisma.skill.findMany({
    where: { id: { in: built.session.draftSkillIds } },
    select: { id: true, name: true, reviewStatus: true },
  });
  assert(skills.length === built.session.draftSkillIds.length, 'all draft Skills must exist');
  assert(skills.every((skill) => skill.reviewStatus === 'CONFIRMED'), 'all draft Skills must be CONFIRMED');

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(error) } });
  });
  await app.register(googleWorkspaceRoutes);
  await app.register(mcpRoutes);
  const accessToken = await signAccess({ sub: owner.id, email: owner.email, role: owner.role });
  const headers = { authorization: `Bearer ${accessToken}` };

  const installedResponse = await app.inject({
    method: 'POST',
    url: '/api/google-workspace/mcp/install',
    headers,
    payload: { accountId: google.id, agentIds: [agentId] },
  });
  assert(installedResponse.statusCode === 200, `MCP install failed: ${installedResponse.body}`);
  const installedBody = installedResponse.json() as { data?: { installed?: Array<{ id: string; serverId: string }> } };
  const installed = installedBody.data?.installed ?? [];
  assert(installed.length === 5, 'five least-privilege Google MCP entries must be installed');

  let healthyServers = 0;
  for (const server of installed) {
    const healthResponse = await app.inject({ method: 'GET', url: `/mcp/servers/${server.id}/health`, headers });
    const healthBody = healthResponse.json() as { data?: { status?: string } };
    if (healthResponse.statusCode === 200 && healthBody.data?.status === 'healthy') healthyServers += 1;
  }
  assert(healthyServers === 5, 'all five Google MCP subprocesses must be healthy');

  const gmailRead = installed.find((server) => server.serverId.includes('gmail-read'));
  const driveRead = installed.find((server) => server.serverId.includes('drive-read'));
  const gmailSend = installed.find((server) => server.serverId.includes('gmail-send'));
  const driveWrite = installed.find((server) => server.serverId.includes('drive-write'));
  assert(gmailRead && driveRead && gmailSend && driveWrite, 'required split MCP entries are missing');

  // Live, read-only OAuth probes. We intentionally retain only list counts.
  const gmailResponse = await app.inject({
    method: 'POST',
    url: '/mcp/call',
    headers,
    payload: { agentId, serverId: gmailRead.serverId, tool: 'gmail_search', args: { query: 'newer_than:1d' } },
  });
  assert(gmailResponse.statusCode === 200, `Gmail live read failed: ${gmailResponse.body}`);
  const gmailResultCount = parsedCount(gmailResponse.json());

  const driveResponse = await app.inject({
    method: 'POST',
    url: '/mcp/call',
    headers,
    payload: { agentId, serverId: driveRead.serverId, tool: 'drive_search', args: { query: '', limit: 10 } },
  });
  assert(driveResponse.statusCode === 200, `Drive live read failed: ${driveResponse.body}`);
  const driveResultCount = parsedCount(driveResponse.json());

  // Negative writes: broker must reject before a Google API call can occur.
  const deniedSend = await app.inject({
    method: 'POST',
    url: '/mcp/call',
    headers,
    payload: {
      agentId,
      serverId: gmailSend.serverId,
      tool: 'gmail_send',
      args: { to: 'nobody@example.invalid', subject: 'AIOS negative acceptance test', body: 'must never send' },
    },
  });
  assert(deniedSend.statusCode === 403, 'Gmail send must fail closed');
  const deniedDriveWrite = await app.inject({
    method: 'POST',
    url: '/mcp/call',
    headers,
    payload: {
      agentId,
      serverId: driveWrite.serverId,
      tool: 'drive_create_text_file',
      args: { name: 'must-not-create.txt', content: 'negative acceptance test' },
    },
  });
  assert(deniedDriveWrite.statusCode === 403, 'Drive write must fail closed');
  await app.close();

  const session = await getBuilderSession({ sessionId: current.session.id, userId: owner.id, role: owner.role });
  const run = session.lastRunId
    ? await prisma.run.findUnique({
        where: { id: session.lastRunId },
        include: { steps: { orderBy: [{ startedAt: 'asc' }, { round: 'asc' }] } },
      })
    : null;
  assert(run?.status === 'SUCCEEDED', 'persisted Builder Run must be SUCCEEDED');
  const audits = await prisma.auditLog.findMany({
    where: {
      entityId: { in: [session.id, agentId, ...skills.map((skill) => skill.id)] },
      action: { in: ['agent_builder.skill_confirmed', 'agent_builder.agent_activated', 'agent_builder.finalized'] },
    },
    select: { action: true },
    orderBy: { createdAt: 'asc' },
  });
  const auditActions = [...new Set(audits.map((entry) => entry.action))];
  assert(auditActions.includes('agent_builder.finalized'), 'finalized audit event must exist');

  const refreshedGoogle = await prisma.connectedAccount.findUnique({
    where: { id: google.id },
    select: { status: true, scopes: true, accessTokenExpires: true },
  });
  assert(refreshedGoogle?.status === 'CONNECTED', 'Google account must remain CONNECTED after live probes');

  const report = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    scenario: { title: scenario.title, persona: scenario.persona },
    sessionId: session.id,
    conversation: session.transcript,
    agent: { id: agent.id, name: agent.name, restrictions: agent.restrictions },
    skills,
    finalState: { session: session.status, agent: agent.status, skills: skills.map((skill) => skill.reviewStatus) },
    fde: {
      memberFinalizeDenied: 'PASS（MEMBER 無法執行 finalize）',
      finalized: 'PASS（OWNER/FDE 完成最終核准）',
      auditActions,
    },
    crossModel: {
      runId: run.id,
      status: run.status,
      execute: agent.engineExecute,
      verify: agent.engineVerify ?? (agent.engineExecute === 'CLAUDE_CODE' ? 'CODEX (auto)' : 'CLAUDE_CODE (auto)'),
      steps: run.steps.map((step) => ({
        round: step.round,
        status: step.status,
        approved: step.approved === true,
        output: step.output ?? '',
        verdict: step.verdict ?? '',
      })),
    },
    google: {
      accountId: google.id,
      status: refreshedGoogle.status,
      scopes: refreshedGoogle.scopes,
      accessTokenExpires: refreshedGoogle.accessTokenExpires.toISOString(),
      installedServers: installed.length,
      healthyServers,
      gmailResultCount,
      driveResultCount,
      persistedContentFields: [],
    },
    externalWrites: { gmailSend: 'DENIED_403', driveWrite: 'DENIED_403', actualWriteCount: 0 },
    checks: [
      { label: '真實跨模型試跑', passed: tested.status === 'PASSED' && run.status === 'SUCCEEDED', detail: `${agent.engineExecute} 執行、${agent.engineVerify ?? 'auto opposite'} 驗證` },
      { label: 'FDE 最終核准', passed: session.status === 'ACTIVE', detail: 'Builder Session 已由 OWNER/FDE finalize' },
      { label: 'Agent 正式啟用', passed: agent.status === 'ACTIVE', detail: agent.id },
      { label: 'Skill 人工確認', passed: skills.every((skill) => skill.reviewStatus === 'CONFIRMED'), detail: `${skills.length} 個技能均為 CONFIRMED` },
      { label: 'Google MCP 安裝與健康', passed: healthyServers === 5, detail: `${healthyServers}/5 個 MCP subprocess 健康` },
      { label: 'Gmail OAuth 唯讀實測', passed: gmailResponse.statusCode === 200, detail: `成功回傳 ${gmailResultCount} 筆；未保存內容` },
      { label: 'Drive OAuth 唯讀實測', passed: driveResponse.statusCode === 200, detail: `成功回傳 ${driveResultCount} 筆；未保存名稱或內容` },
      { label: '外部寫入 fail-closed', passed: deniedSend.statusCode === 403 && deniedDriveWrite.statusCode === 403, detail: '寄信與 Drive 寫入皆在 Broker 層拒絕；真實寫入 0 次' },
    ],
  };

  const reportDir = path.resolve(process.cwd(), '../../agentic-os/reports');
  await mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'ceo-finance-fde-live-verification-2026-07-28.json');
  const htmlPath = path.join(reportDir, 'ceo-finance-fde-live-verification-2026-07-28.html');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(htmlPath, renderHtml(report), 'utf8');
  console.log(JSON.stringify({
    result: 'PASS',
    htmlPath,
    jsonPath,
    agentId,
    sessionId: session.id,
    runId: run.id,
    finalState: report.finalState,
    google: {
      status: report.google.status,
      installedServers: report.google.installedServers,
      healthyServers: report.google.healthyServers,
      gmailResultCount,
      driveResultCount,
    },
    externalWrites: report.externalWrites,
  }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
