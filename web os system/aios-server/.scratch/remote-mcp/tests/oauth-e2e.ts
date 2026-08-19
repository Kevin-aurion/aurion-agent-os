import { createHash } from 'node:crypto';
import { prisma } from '../../../src/lib/db.js';
import { sha256 } from '../../../src/lib/crypto.js';
import { signAccess, verifyAccess } from '../../../src/lib/auth.js';

const BASE = 'http://127.0.0.1:8700';
const email = process.env.AIOS_MCP_EMAIL;
const password = process.env.AIOS_MCP_PASSWORD;
if (!email || !password) throw new Error('AIOS_MCP_EMAIL/AIOS_MCP_PASSWORD are required');

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

const callback = 'http://127.0.0.1/callback';
const verifier = 'A'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
let createdBuilderSessionId: string | null = null;

try {
  const invalid = await json(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'evil', redirect_uris: ['https://evil.example/callback'] }),
  });
  check(invalid.response.status === 400, 'unapproved redirect URI must be rejected');

  const chatGptRegistration = await json(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT OAuth compatibility',
      redirect_uris: ['https://chatgpt.com/connector/oauth/plugin_asdk_app_test123'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });
  check(chatGptRegistration.response.status === 201, 'ChatGPT hosted callback must be accepted');

  const registration = await json(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'AIOS OAuth E2E',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });
  check(registration.response.status === 201, 'DCR registration failed');
  const clientId = String((registration.body as any).client_id ?? '');
  check(clientId, 'DCR did not return client_id');

  const overScopedUrl = new URL(`${BASE}/oauth/authorize`);
  overScopedUrl.searchParams.set('response_type', 'code');
  overScopedUrl.searchParams.set('client_id', clientId);
  overScopedUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:43123/callback');
  overScopedUrl.searchParams.set('code_challenge', challenge);
  overScopedUrl.searchParams.set('code_challenge_method', 'S256');
  overScopedUrl.searchParams.set('scope', 'aios:agent-builder aios:admin');
  const overScoped = await json(overScopedUrl.toString());
  check(overScoped.response.status === 400, 'unknown OAuth scope must be rejected fail-closed');

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:43123/callback');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', 'aios:agent-builder');
  authorizeUrl.searchParams.set('state', 'state-e2e');
  authorizeUrl.searchParams.set('resource', 'https://aios-mcp.lazyoffice.app/mcp');
  const authorize = await fetch(authorizeUrl);
  check(authorize.status === 200, 'authorize page failed');
  const html = await authorize.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  check(ticket, 'authorize page did not contain signed ticket');

  const consent = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ ticket, email, password }),
  });
  check(consent.status === 302, `consent did not redirect (HTTP ${consent.status}: ${await consent.text()})`);
  const location = consent.headers.get('location');
  check(location, 'consent redirect missing location');
  const redirected = new URL(location);
  const code = redirected.searchParams.get('code');
  check(code, 'consent redirect missing code');
  check(redirected.searchParams.get('state') === 'state-e2e', 'OAuth state was not preserved');

  const wrongPkce = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:43123/callback',
      code_verifier: 'B'.repeat(43),
    }),
  });
  check(wrongPkce.response.status === 400 && (wrongPkce.body as any).error === 'invalid_grant', 'bad PKCE must fail');

  const wrongResource = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:43123/callback',
      code_verifier: verifier,
      resource: 'https://evil.example/mcp',
    }),
  });
  check(wrongResource.response.status === 400, 'token exchange for a different resource must fail');

  const token = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:43123/callback',
      code_verifier: verifier,
      resource: 'https://aios-mcp.lazyoffice.app/mcp',
    }),
  });
  check(token.response.status === 200, 'authorization code exchange failed');
  const access = String((token.body as any).access_token ?? '');
  const refresh = String((token.body as any).refresh_token ?? '');
  check(access && refresh, 'token response incomplete');
  const verified = await verifyAccess(access);
  check(
    verified.audience === 'https://aios-mcp.lazyoffice.app/mcp',
    'access token is not audience-bound to the Remote MCP resource',
  );

  const oauthUser = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  check(oauthUser, 'OAuth test user disappeared');
  const missingAudienceToken = await signAccess({
    sub: oauthUser.id,
    email: oauthUser.email,
    role: 'MEMBER',
    scope: 'aios:agent-builder',
  });
  const missingAudienceMe = await fetch(`${BASE}/api/auth/me`, {
    headers: { authorization: `Bearer ${missingAudienceToken}` },
  });
  check(missingAudienceMe.status === 401, 'scoped access token without MCP audience must fail closed');

  const replay = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1:43123/callback',
      code_verifier: verifier,
    }),
  });
  check(replay.response.status === 400, 'authorization code replay must fail');

  const me = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${access}` } });
  check(me.status === 200, 'issued access token cannot reach AIOS');
  const meBody = await me.json();
  check((meBody as any).data?.role === 'MEMBER', 'Remote MCP OAuth token must have MEMBER-effective role');

  const builderApi = await fetch(`${BASE}/api/agent-builder/sessions`, {
    headers: { authorization: `Bearer ${access}` },
  });
  check(builderApi.status === 200, 'Builder-scoped token cannot reach Agent Builder API');

  const startBuild = await json(`${BASE}/api/agent-builder/external/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'CHATGPT',
      initialRequest: '建立一位測試用新聞摘要 AI 員工，只產生草稿。',
      externalConversationId: `oauth-e2e-${Date.now()}`,
      requestedAgentName: 'OAuth E2E 新聞員工',
    }),
  });
  check(startBuild.response.status === 200, 'ChatGPT source could not start a Builder session');
  createdBuilderSessionId = String((startBuild.body as any).data?.session?.id ?? '');
  check(createdBuilderSessionId, 'Builder start did not return a session id');

  const snapshotBody = {
    source: 'CHATGPT',
    externalEventId: 'chatgpt-turn-001',
    turns: [{ role: 'assistant', content: '我會先確認新聞來源與可接受的發布延遲。' }],
    summary: '建立第一版新聞摘要員工草稿',
    artifact: {
      identity: { name: 'OAuth E2E 新聞員工', purpose: '整理可查證的 AI 新聞並產生內部摘要。' },
      skills: [{ name: 'AI 新聞摘要', purpose: '整理新聞', instructions: ['保留來源'], inputs: ['公開新聞'], outputs: ['內部摘要'] }],
      memory: { facts: ['測試密鑰 sk-test-12345678901234567890 不得落地'] },
      tools: [{ name: 'Web Search', purpose: '找來源', status: 'AVAILABLE' }],
      policies: { requiresApproval: ['對外發布'] },
      tests: [{ name: '保留來源', input: '一則新聞', expected: '摘要包含來源' }],
    },
  };
  const snapshot = await json(`${BASE}/api/agent-builder/sessions/${createdBuilderSessionId}/external-snapshot`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify(snapshotBody),
  });
  check(snapshot.response.status === 200, 'ChatGPT snapshot sync failed');
  check((snapshot.body as any).data?.turn?.deduplicated === false, 'first snapshot turn was unexpectedly deduplicated');
  check((snapshot.body as any).data?.artifact?.deduplicated === false, 'first snapshot artifact was unexpectedly deduplicated');

  const snapshotRetry = await json(`${BASE}/api/agent-builder/sessions/${createdBuilderSessionId}/external-snapshot`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify(snapshotBody),
  });
  check(snapshotRetry.response.status === 200, 'snapshot retry failed');
  check((snapshotRetry.body as any).data?.turn?.deduplicated === true, 'snapshot turn retry was not idempotent');
  check((snapshotRetry.body as any).data?.artifact?.deduplicated === true, 'snapshot artifact retry was not idempotent');

  const latestSnapshot = await prisma.agentBuildIteration.findFirst({
    where: { sessionId: createdBuilderSessionId, status: 'READY' },
    orderBy: { sequence: 'desc' },
  });
  const persistedSnapshot = JSON.stringify(latestSnapshot?.artifactSnapshot ?? {});
  check(!persistedSnapshot.includes('sk-test-12345678901234567890'), 'snapshot secret was persisted without redaction');
  check(persistedSnapshot.includes('NEEDS_FDE'), 'external AVAILABLE tool assertion was not downgraded');

  const nonBuilderApi = await fetch(`${BASE}/api/agents`, {
    headers: { authorization: `Bearer ${access}` },
  });
  check(nonBuilderApi.status === 403, 'Builder-scoped token must be rejected by non-Builder APIs');

  const trainerApi = await fetch(`${BASE}/api/agent-builder/review-queue`, {
    headers: { authorization: `Bearer ${access}` },
  });
  check(trainerApi.status === 403, 'Builder-scoped token must never perform an FDE action');

  const rotated = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refresh,
      resource: 'https://aios-mcp.lazyoffice.app/mcp',
    }),
  });
  check(rotated.response.status === 200 && (rotated.body as any).refresh_token !== refresh, 'refresh rotation failed');

  const oldRefreshReplay = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh }),
  });
  check(oldRefreshReplay.response.status === 400, 'old refresh token replay must fail');

  const latestRefresh = String((rotated.body as any).refresh_token);
  await fetch(`${BASE}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: latestRefresh }),
  });
  await prisma.mcpOAuthCode.deleteMany({ where: { codeHash: sha256(code) } });

  console.log(JSON.stringify({ ok: true, dcr: true, chatGptCallback: true, scopeFailClosed: true, resourceAudienceBound: true, snapshotIdempotent: true, secretsRedacted: true, toolClaimsDowngraded: true, tokenRouteRestricted: true, tokenRoleDowngraded: true, pkce: true, codeReplayRejected: true, refreshRotated: true }));
} finally {
  if (createdBuilderSessionId) {
    await prisma.agentBuildSession.delete({ where: { id: createdBuilderSessionId } }).catch(() => {});
  }
  await prisma.$disconnect();
}
