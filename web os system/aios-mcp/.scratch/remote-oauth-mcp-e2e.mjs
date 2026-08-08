import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = process.env.TEST_MCP_URL || 'https://aurion-aios-mcp.lazyoffice.app/mcp';
const OAUTH_ORIGIN = process.env.TEST_OAUTH_ORIGIN || 'https://aurion-aios-mcp.lazyoffice.app';
const email = process.env.AIOS_MCP_EMAIL;
const password = process.env.AIOS_MCP_PASSWORD;
if (!email || !password) throw new Error('AIOS_MCP_EMAIL/AIOS_MCP_PASSWORD are required');

function check(value, message) {
  if (!value) throw new Error(message);
}

async function asJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

const callback = 'http://127.0.0.1/callback';
const verifier = 'R'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const chatGptRegistration = await asJson(`${OAUTH_ORIGIN}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'ChatGPT public callback E2E',
    redirect_uris: ['https://chatgpt.com/connector/oauth/plugin_asdk_app_test123'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  }),
});
check(chatGptRegistration.response.status === 201, `ChatGPT DCR callback failed: ${JSON.stringify(chatGptRegistration.body)}`);

const registration = await asJson(`${OAUTH_ORIGIN}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Aurion Remote MCP E2E',
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  }),
});
check(registration.response.status === 201, `DCR failed: ${JSON.stringify(registration.body)}`);
const clientId = registration.body.client_id;

const authorizeUrl = new URL(`${OAUTH_ORIGIN}/oauth/authorize`);
for (const [key, value] of Object.entries({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: 'http://127.0.0.1:43991/callback',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'aios:agent-builder',
  state: 'remote-e2e',
  resource: MCP_URL,
})) authorizeUrl.searchParams.set(key, value);
const authorize = await fetch(authorizeUrl);
check(authorize.status === 200, `authorize failed: ${authorize.status}`);
const ticket = (await authorize.text()).match(/name="ticket" value="([^"]+)"/)?.[1];
check(ticket, 'authorize ticket missing');

const consent = await fetch(`${OAUTH_ORIGIN}/oauth/authorize`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  redirect: 'manual',
  body: new URLSearchParams({ ticket, email, password }),
});
check(consent.status === 302, `consent failed: ${consent.status}`);
const redirect = new URL(consent.headers.get('location'));
const code = redirect.searchParams.get('code');
check(code, 'authorization code missing');

const token = await asJson(`${OAUTH_ORIGIN}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: 'http://127.0.0.1:43991/callback',
    code_verifier: verifier,
    resource: MCP_URL,
  }),
});
check(token.response.status === 200, `token exchange failed: ${JSON.stringify(token.body)}`);

const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { authorization: `Bearer ${token.body.access_token}` } },
});
const mcp = new Client({ name: 'aurion-remote-e2e', version: '1.0.0' });
await mcp.connect(transport);
const tools = await mcp.listTools();
check(tools.tools.length === 12, `expected 12 builder tools, received ${tools.tools.length}`);
check(tools.tools.some((tool) => tool.name === 'upsert_agent_build_snapshot'), 'snapshot tool is missing');
check(
  tools.tools.every((tool) => tool.title && tool.description && tool.annotations),
  'one or more public tools are missing ChatGPT metadata or annotations',
);

const externalConversationId = `remote-e2e-${randomUUID()}`;
const started = await mcp.callTool({
  name: 'start_agent_build',
  arguments: {
    initialRequest: '建立一位 Remote MCP E2E 測試員工，只整理三則客服回饋並提出有證據的改善建議，不寄信、不寫入外部系統。',
    source: 'CHATGPT',
    externalConversationId,
    externalConversationTitle: 'Remote MCP 公開網域端到端測試',
    requestedAgentName: 'Remote MCP E2E 測試員工',
  },
});
const startText = started.content?.find((item) => item.type === 'text')?.text || '';
const startPayload = JSON.parse(startText);
const sessionId = startPayload.session?.id;
check(sessionId, `start_agent_build did not return a session: ${startText}`);

const snapshot = await mcp.callTool({
  name: 'upsert_agent_build_snapshot',
  arguments: {
    sessionId,
    source: 'CHATGPT',
    externalEventId: `${externalConversationId}:turn:1`,
    turns: [
      { role: 'assistant', content: '了解，我會保留回饋證據並把不確定項目標記給人工確認。下一個問題：您希望輸出每天一次還是手動執行？' },
    ],
    summary: '建立第一版客服回饋分析草稿',
    artifact: {
      identity: {
        name: 'Remote MCP E2E 測試員工',
        purpose: '整理客服回饋並提出附證據、可人工覆核的改善建議。',
        workingStyle: ['資料不足時明確說明，不自行猜測'],
      },
      skills: [{
        name: '客服回饋分析',
        purpose: '把回饋整理成可追溯的改善建議',
        instructions: ['每項建議引用原始回饋', '不確定內容標記人工確認'],
        inputs: ['客服回饋'],
        outputs: ['附證據的改善建議'],
      }],
      tools: [{ name: '外部客服系統', purpose: '讀取回饋', status: 'AVAILABLE' }],
      policies: { requiresApproval: ['任何外部寫入'] },
      tests: [{ name: '資料不足不猜測', input: '只有一則模糊回饋', expected: '標記資料不足並要求人工確認' }],
      understanding: {
        northStar: '提高客服改善建議的可追溯性',
        decisions: [{ topic: '證據', decision: '每項建議引用原始回饋', status: 'confirmed' }],
        openBranches: [{ topic: '執行頻率', whyItMatters: '影響觸發方式', recommendation: '先採手動執行' }],
      },
    },
  },
});
check(!snapshot.isError, 'public snapshot tool returned an MCP error');
const listed = await mcp.callTool({ name: 'list_agent_builds', arguments: {} });
const listText = listed.content?.find((item) => item.type === 'text')?.text || '';
check(listText.includes(sessionId), 'new build is not visible through the same remote MCP account');

await mcp.close();
await fetch(`${OAUTH_ORIGIN}/oauth/revoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: token.body.refresh_token }),
});

console.log(JSON.stringify({
  ok: true,
  mcpUrl: MCP_URL,
  tools: tools.tools.length,
  chatGptCallback: true,
  snapshot: true,
  sessionId,
  externalConversationId,
}));
