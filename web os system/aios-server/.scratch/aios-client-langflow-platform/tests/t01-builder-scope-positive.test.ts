/**
 * Ticket 01 — builder scoped token positive path (live HTTP + real DB).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t01-builder-scope-positive.test.ts
 *
 * Proves scoped OAuth can create inert AgentBuildSession / Iteration /
 * submit-review → AWAITING_FDE without creating formal Agent/Skill/Workflow,
 * and that the shadow draft appears on FDE evolution-queue.
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { hashPassword, verifyAccess } from '../../../src/lib/auth.js';
import { config } from '../../../src/config.js';

const BASE = 'http://127.0.0.1:8700';
const MEMBER_EMAIL = 'member@aios.test';
const MEMBER_PASSWORD = 'aios-spike-01!';
const OWNER_EMAIL = 'fde@aios.test';
const OWNER_PASSWORD = 'aios-spike-01!';
const RESOURCE = config.remoteMcp.resourceUrl;
const MCP_BUILDER_SCOPE = 'aios:agent-builder';
const EXTERNAL_EVENT_ID = 't01-spike-snapshot-001';

let failed = 0;
let createdSessionId: string | null = null;

function pass(label: string, detail = ''): void {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function ensureMember(): Promise<{ id: string; email: string }> {
  const existing = await prisma.user.findFirst({ where: { email: MEMBER_EMAIL, deletedAt: null } });
  if (existing) {
    if (existing.role !== 'MEMBER') {
      await prisma.user.update({ where: { id: existing.id }, data: { role: 'MEMBER' } });
    }
    return { id: existing.id, email: existing.email };
  }
  const id = ulid();
  await prisma.user.create({
    data: {
      id,
      email: MEMBER_EMAIL,
      displayName: 'T01 Spike Member',
      passwordHash: await hashPassword(MEMBER_PASSWORD),
      role: 'MEMBER',
    },
  });
  return { id, email: MEMBER_EMAIL };
}

async function obtainOAuthScopedToken(email: string, password: string): Promise<string> {
  const callback = 'http://127.0.0.1:43123/callback';
  const verifier = 'B'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const registration = await json(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'T01 Builder Scope Positive',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });
  check(registration.response.status === 201, 'OAuth DCR', `HTTP ${registration.response.status}`);
  if (registration.response.status !== 201) throw new Error('OAuth DCR failed');
  const clientId = String((registration.body as { client_id?: string })?.client_id ?? '');
  if (!clientId) {
    fail('OAuth DCR client_id', 'missing');
    throw new Error('missing client_id');
  }
  pass('OAuth DCR client_id', clientId.slice(0, 24) + '…');

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', callback);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', MCP_BUILDER_SCOPE);
  authorizeUrl.searchParams.set('state', 't01-pos');
  authorizeUrl.searchParams.set('resource', RESOURCE);

  const authorize = await fetch(authorizeUrl);
  check(authorize.status === 200, 'OAuth authorize page', `HTTP ${authorize.status}`);
  if (authorize.status !== 200) throw new Error('authorize page failed');
  const html = await authorize.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) {
    fail('OAuth authorize ticket', 'missing');
    throw new Error('ticket missing');
  }
  pass('OAuth authorize ticket');

  const consent = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ ticket, email, password }),
  });
  check(consent.status === 302, 'OAuth consent redirect', `HTTP ${consent.status}`);
  if (consent.status !== 302) throw new Error(`consent failed: ${await consent.text()}`);
  const location = consent.headers.get('location');
  if (!location) {
    fail('OAuth consent location', 'missing');
    throw new Error('location missing');
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    fail('OAuth authorization code', 'missing');
    throw new Error('code missing');
  }
  pass('OAuth authorization code');

  const token = await json(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  check(token.response.status === 200, 'OAuth token exchange', `HTTP ${token.response.status}`);
  if (token.response.status !== 200) throw new Error('token exchange failed');
  const access = String((token.body as { access_token?: string })?.access_token ?? '');
  if (!access) {
    fail('OAuth access_token', 'empty');
    throw new Error('empty access_token');
  }
  pass('OAuth access_token present');
  return access;
}

async function main() {
  console.log('── T01 builder scope POSITIVE (live HTTP + DB) ──');
  console.log(`BASE=${BASE} resource=${RESOURCE}`);

  const member = await ensureMember();
  pass('MEMBER ensure member@aios.test', member.id);

  console.log('\n── obtain true Remote MCP OAuth scoped token ──');
  const oauthToken = await obtainOAuthScopedToken(MEMBER_EMAIL, MEMBER_PASSWORD);
  const claims = await verifyAccess(oauthToken);
  check(claims.scope === MCP_BUILDER_SCOPE, 'OAuth token scope', `got ${claims.scope}`);
  check(claims.audience === RESOURCE, 'OAuth token audience', `got ${claims.audience}`);
  check(claims.sub === member.id, 'OAuth token subject is member', `sub=${claims.sub}`);

  const baseline = {
    agent: await prisma.agent.count(),
    skill: await prisma.skill.count(),
    workflow: await prisma.workflow.count(),
  };
  console.log('\n── DB baseline (formal objects) ──');
  console.log(JSON.stringify(baseline));

  // ── 1. external session ─────────────────────────────────────────────────
  console.log('\n── external session ──');
  const start = await json(`${BASE}/api/agent-builder/external/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${oauthToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'CHATGPT',
      initialRequest: '建立一位測試用新聞摘要 AI 員工，只產生草稿，不要直接上線。',
      externalConversationId: `t01-pos-${Date.now()}`,
      requestedAgentName: 'T01 新聞摘要員工',
    }),
  });
  check(start.response.status === 200, 'POST external/sessions → 200', `HTTP ${start.response.status} body=${JSON.stringify(start.body)}`);
  if (start.response.status !== 200) throw new Error('external/sessions failed');

  const sessionId = String(
    (start.body as { data?: { session?: { id?: string } } })?.data?.session?.id ??
      (start.body as { data?: { id?: string } })?.data?.id ??
      '',
  );
  check(Boolean(sessionId), 'sessionId returned', JSON.stringify(start.body));
  if (!sessionId) throw new Error('no sessionId');
  createdSessionId = sessionId;

  const sessionRow = await prisma.agentBuildSession.findUnique({ where: { id: sessionId } });
  check(Boolean(sessionRow), 'AgentBuildSession row exists', 'missing');
  check(sessionRow?.userId === member.id, 'session.userId === member', `userId=${sessionRow?.userId}`);
  pass('session status', sessionRow?.status ?? 'n/a');

  // ── 2. external snapshot ────────────────────────────────────────────────
  console.log('\n── external snapshot ──');
  const snapshot = await json(`${BASE}/api/agent-builder/sessions/${sessionId}/external-snapshot`, {
    method: 'POST',
    headers: { authorization: `Bearer ${oauthToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'CHATGPT',
      externalEventId: EXTERNAL_EVENT_ID,
      turns: [
        {
          role: 'assistant',
          content: '我會先整理新聞來源與摘要格式，只產出影子草稿。',
        },
      ],
      summary: 'T01 spike 影子草稿',
      artifact: {
        identity: {
          name: 'T01 新聞摘要員工',
          purpose: '整理可查證的 AI 新聞並產生內部摘要草稿。',
        },
        skills: [
          {
            name: 'AI 新聞摘要',
            purpose: '整理公開新聞為內部摘要',
            instructions: ['保留來源連結', '不對外發布'],
            inputs: ['公開新聞 URL'],
            outputs: ['內部摘要 Markdown'],
          },
        ],
        userSummary: '已產出新聞摘要員工的影子草稿，待 FDE 審查。',
      },
    }),
  });
  check(
    snapshot.response.status === 200,
    'POST external-snapshot → 200',
    `HTTP ${snapshot.response.status} body=${JSON.stringify(snapshot.body)}`,
  );
  if (snapshot.response.status !== 200) throw new Error('external-snapshot failed');

  const iterationCount = await prisma.agentBuildIteration.count({ where: { sessionId } });
  check(iterationCount >= 1, 'AgentBuildIteration created', `count=${iterationCount}`);

  // ── 3. submit-review → AWAITING_FDE ─────────────────────────────────────
  console.log('\n── submit-review ──');
  const review = await json(`${BASE}/api/agent-builder/sessions/${sessionId}/submit-review`, {
    method: 'POST',
    headers: { authorization: `Bearer ${oauthToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'create' }),
  });
  check(
    review.response.status === 200,
    'POST submit-review → 200',
    `HTTP ${review.response.status} body=${JSON.stringify(review.body)}`,
  );
  if (review.response.status !== 200) throw new Error('submit-review failed');

  const afterReview = await prisma.agentBuildSession.findUnique({ where: { id: sessionId } });
  check(
    afterReview?.status === 'AWAITING_FDE',
    'session status === AWAITING_FDE',
    `status=${afterReview?.status}`,
  );

  // ── 4. formal object counts unchanged ───────────────────────────────────
  console.log('\n── formal object zero growth ──');
  const afterCounts = {
    agent: await prisma.agent.count(),
    skill: await prisma.skill.count(),
    workflow: await prisma.workflow.count(),
  };
  console.log(JSON.stringify({ baseline, afterCounts }));
  check(afterCounts.agent === baseline.agent, 'agent.count unchanged', `${baseline.agent} → ${afterCounts.agent}`);
  check(afterCounts.skill === baseline.skill, 'skill.count unchanged', `${baseline.skill} → ${afterCounts.skill}`);
  check(
    afterCounts.workflow === baseline.workflow,
    'workflow.count unchanged',
    `${baseline.workflow} → ${afterCounts.workflow}`,
  );

  // ── 5. FDE evolution-queue visibility ───────────────────────────────────
  console.log('\n── FDE evolution-queue ──');
  const ownerLogin = await json(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  check(ownerLogin.response.status === 200, 'OWNER login', `HTTP ${ownerLogin.response.status}`);
  const ownerAccess = String((ownerLogin.body as { data?: { access?: string } })?.data?.access ?? '');
  if (!ownerAccess) {
    fail('OWNER access token', 'empty');
    throw new Error('OWNER access empty');
  }

  const queue = await json(`${BASE}/api/agent-builder/evolution-queue`, {
    headers: { authorization: `Bearer ${ownerAccess}` },
  });
  check(queue.response.status === 200, 'OWNER GET evolution-queue → 200', `HTTP ${queue.response.status}`);
  const queueBody = queue.body as { data?: unknown };
  const list: unknown[] = Array.isArray(queueBody?.data)
    ? (queueBody.data as unknown[])
    : Array.isArray((queueBody?.data as { sessions?: unknown[] })?.sessions)
      ? ((queueBody.data as { sessions: unknown[] }).sessions)
      : Array.isArray((queueBody?.data as { items?: unknown[] })?.items)
        ? ((queueBody.data as { items: unknown[] }).items)
        : [];

  // Flatten possible nested shapes and match session id.
  const serialized = JSON.stringify(queueBody ?? {});
  const visible = serialized.includes(sessionId);
  check(visible, 'evolution-queue contains shadow session', `sessionId=${sessionId}; listLen=${list.length}`);

  // ── cleanup session only ────────────────────────────────────────────────
  if (createdSessionId) {
    await prisma.agentBuildSession.delete({ where: { id: createdSessionId } });
    createdSessionId = null;
    pass('cleanup AgentBuildSession (cascade iterations)');
  }

  console.log(`\n── summary: ${failed === 0 ? 'ALL PASS' : `${failed} FAIL`} ──`);
  if (failed > 0) throw new Error(`T01 positive path finished with ${failed} failure(s)`);
}

main()
  .catch((err) => {
    process.exitCode = 1;
    console.error('FATAL:', err instanceof Error ? err.message : err);
  })
  .finally(async () => {
    if (createdSessionId) {
      await prisma.agentBuildSession.delete({ where: { id: createdSessionId } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });
