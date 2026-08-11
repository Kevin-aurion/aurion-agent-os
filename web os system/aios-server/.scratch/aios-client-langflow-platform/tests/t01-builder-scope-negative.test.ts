/**
 * Ticket 01 — builder scoped token negative matrix (live HTTP + real DB).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t01-builder-scope-negative.test.ts
 *
 * Proves Remote MCP OAuth (scope=aios:agent-builder) cannot confirm skills,
 * approve proposals, write MCP registry, or perform Agent CRUD. Also runs a
 * signAccess-minted scoped token matrix as an optional control group.
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { hashPassword, signAccess, verifyAccess } from '../../../src/lib/auth.js';
import { config } from '../../../src/config.js';

const BASE = 'http://127.0.0.1:8700';
const MEMBER_EMAIL = 'member@aios.test';
const MEMBER_PASSWORD = 'aios-spike-01!';
const OWNER_EMAIL = 'fde@aios.test';
const OWNER_PASSWORD = 'aios-spike-01!';
const RESOURCE = config.remoteMcp.resourceUrl;
const AGENT_SLUG = 't01-spike-agent';
const SKILL_SLUG = 't01-spike-skill';
const MCP_BUILDER_SCOPE = 'aios:agent-builder';

let failed = 0;

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

function hasSuccessData(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as { success?: unknown }).success === true && 'data' in (body as object));
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

async function ensureFixtures(ownerId: string) {
  let agent = await prisma.agent.findFirst({ where: { slug: AGENT_SLUG } });
  if (!agent) {
    agent = await prisma.agent.create({
      data: {
        id: ulid(),
        slug: AGENT_SLUG,
        name: 'T01 Spike Agent',
        description: 'fixture for builder scope negative matrix',
        rolePrompt: 'You are a fixture agent for ticket 01 spike tests.',
        status: 'ACTIVE',
        createdBy: ownerId,
        restrictions: {
          webSearch: false,
          computerUse: false,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
        },
      },
    });
  } else if (agent.deletedAt) {
    agent = await prisma.agent.update({
      where: { id: agent.id },
      data: { deletedAt: null, name: 'T01 Spike Agent', status: 'ACTIVE' },
    });
  }

  let skill = await prisma.skill.findFirst({ where: { slug: SKILL_SLUG } });
  if (!skill) {
    skill = await prisma.skill.create({
      data: {
        id: ulid(),
        slug: SKILL_SLUG,
        name: 'T01 Spike Skill',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# T01 Spike Skill\n\nFixture skill awaiting FDE confirm.\n',
        reviewStatus: 'AWAITING_USER_CONFIRM',
        executionEnv: 'CLI',
      },
    });
  } else {
    skill = await prisma.skill.update({
      where: { id: skill.id },
      data: {
        deletedAt: null,
        reviewStatus: 'AWAITING_USER_CONFIRM',
        confirmedAt: null,
        confirmedBy: null,
      },
    });
  }

  // One PENDING proposal for this agent (reuse if present).
  let proposal = await prisma.changeProposal.findFirst({
    where: {
      agentId: agent.id,
      status: 'PENDING',
      proposedChange: { path: ['t01Spike'], equals: true },
    },
  });
  if (!proposal) {
    proposal = await prisma.changeProposal.create({
      data: {
        id: ulid(),
        agentId: agent.id,
        source: 'OPERATOR',
        proposedBy: ownerId,
        targetType: 'RESTRICTION',
        targetId: agent.id,
        proposedChange: { t01Spike: true, note: 'fixture for ticket 01' },
        severity: 'low',
        status: 'PENDING',
      },
    });
  }

  return { agent, skill, proposal };
}

/** Full Remote MCP OAuth: DCR → authorize → consent → token (PKCE S256 + resource). */
async function obtainOAuthScopedToken(email: string, password: string): Promise<string> {
  const callback = 'http://127.0.0.1:43123/callback';
  const verifier = 'A'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const registration = await json(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'T01 Builder Scope Negative',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });
  check(registration.response.status === 201, 'OAuth DCR', `HTTP ${registration.response.status}`);
  if (registration.response.status !== 201) throw new Error('OAuth DCR failed');
  const clientId = String((registration.body as { client_id?: string })?.client_id ?? '');
  check(Boolean(clientId), 'OAuth DCR client_id', 'missing client_id');
  if (!clientId) throw new Error('OAuth DCR missing client_id');

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', callback);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', MCP_BUILDER_SCOPE);
  authorizeUrl.searchParams.set('state', 't01-neg');
  authorizeUrl.searchParams.set('resource', RESOURCE);

  const authorize = await fetch(authorizeUrl);
  check(authorize.status === 200, 'OAuth authorize page', `HTTP ${authorize.status}`);
  if (authorize.status !== 200) throw new Error('authorize page failed');
  const html = await authorize.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  check(Boolean(ticket), 'OAuth authorize ticket', 'ticket missing from HTML');
  if (!ticket) throw new Error('authorize ticket missing');

  const consent = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ ticket, email, password }),
  });
  check(consent.status === 302, 'OAuth consent redirect', `HTTP ${consent.status}`);
  if (consent.status !== 302) throw new Error(`consent failed: ${await consent.text()}`);
  const location = consent.headers.get('location');
  check(Boolean(location), 'OAuth consent location', 'missing Location header');
  if (!location) throw new Error('consent location missing');
  const code = new URL(location).searchParams.get('code');
  check(Boolean(code), 'OAuth authorization code', 'code missing');
  if (!code) throw new Error('authorization code missing');

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
  check(Boolean(access), 'OAuth access_token present', 'empty access_token');
  if (!access) throw new Error('access_token empty');
  return access;
}

type Baseline = {
  agent: number;
  skill: number;
  workflow: number;
  changeProposal: number;
  mcpServerRegistry: number;
  skillReview: string;
  proposalStatus: string;
  agentName: string;
  agentUpdatedAt: string;
  agentDeletedAt: string | null;
};

async function captureBaseline(agentId: string, skillId: string, proposalId: string): Promise<Baseline> {
  const [agent, skill, workflow, changeProposal, mcpServerRegistry, skillRow, proposalRow, agentRow] =
    await Promise.all([
      prisma.agent.count(),
      prisma.skill.count(),
      prisma.workflow.count(),
      prisma.changeProposal.count(),
      prisma.mcpServerRegistry.count(),
      prisma.skill.findUniqueOrThrow({ where: { id: skillId } }),
      prisma.changeProposal.findUniqueOrThrow({ where: { id: proposalId } }),
      prisma.agent.findUniqueOrThrow({ where: { id: agentId } }),
    ]);
  return {
    agent,
    skill,
    workflow,
    changeProposal,
    mcpServerRegistry,
    skillReview: skillRow.reviewStatus,
    proposalStatus: proposalRow.status,
    agentName: agentRow.name,
    agentUpdatedAt: agentRow.updatedAt.toISOString(),
    agentDeletedAt: agentRow.deletedAt ? agentRow.deletedAt.toISOString() : null,
  };
}

async function assertForbidden(
  label: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<number> {
  const res = await json(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const status = res.response.status;
  const ok403 = status === 403 && !hasSuccessData(res.body);
  if (ok403) {
    const msg =
      res.body && typeof res.body === 'object'
        ? String((res.body as { error?: { message?: string } }).error?.message ?? '')
        : '';
    pass(label, `HTTP ${status}${msg ? ` (${msg})` : ''}`);
  } else {
    fail(label, `expected 403 without success data, got HTTP ${status} body=${JSON.stringify(res.body)}`);
  }
  return status;
}

async function runNegativeMatrix(
  matrixLabel: string,
  token: string,
  fixture: { agentId: string; skillId: string; proposalId: string },
): Promise<void> {
  console.log(`\n── negative matrix: ${matrixLabel} ──`);
  await assertForbidden(
    `${matrixLabel} POST /api/skills/:id/confirm`,
    token,
    'POST',
    `/api/skills/${fixture.skillId}/confirm`,
  );
  await assertForbidden(
    `${matrixLabel} POST /api/proposals/:id/approve`,
    token,
    'POST',
    `/api/proposals/${fixture.proposalId}/approve`,
  );
  await assertForbidden(`${matrixLabel} POST /mcp/servers`, token, 'POST', '/mcp/servers', {
    serverId: `t01-spike-mcp-${Date.now()}`,
    name: 'T01 Spike MCP',
    transport: 'LOOPBACK_HTTP',
    url: 'http://127.0.0.1:39999/mcp',
  });
  await assertForbidden(`${matrixLabel} POST /api/agents`, token, 'POST', '/api/agents', {
    name: 'T01 Should Not Create',
    description: 'must be blocked by scoped token',
    rolePrompt: 'blocked',
  });
  await assertForbidden(
    `${matrixLabel} PATCH /api/agents/:id`,
    token,
    'PATCH',
    `/api/agents/${fixture.agentId}`,
    { name: 'T01 Renamed By Scoped Token' },
  );
  await assertForbidden(
    `${matrixLabel} DELETE /api/agents/:id`,
    token,
    'DELETE',
    `/api/agents/${fixture.agentId}`,
  );
  await assertForbidden(`${matrixLabel} GET /api/agents`, token, 'GET', '/api/agents');
  await assertForbidden(`${matrixLabel} POST /api/skills`, token, 'POST', '/api/skills', {
    name: 'T01 Should Not Create Skill',
    kind: 'PROMPT_MANUAL',
    contentMd: '# blocked\n',
  });
}

async function cleanupFixtures(): Promise<void> {
  const agent = await prisma.agent.findFirst({ where: { slug: AGENT_SLUG } });
  if (agent) {
    await prisma.changeProposal.deleteMany({
      where: {
        agentId: agent.id,
        proposedChange: { path: ['t01Spike'], equals: true },
      },
    });
    await prisma.agent.delete({ where: { id: agent.id } }).catch(async () => {
      await prisma.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    });
  }
  const skill = await prisma.skill.findFirst({ where: { slug: SKILL_SLUG } });
  if (skill) {
    await prisma.skill.delete({ where: { id: skill.id } }).catch(async () => {
      await prisma.skill.update({ where: { id: skill.id }, data: { deletedAt: new Date() } });
    });
  }
}

async function main() {
  console.log('── T01 builder scope NEGATIVE (live HTTP + DB) ──');
  console.log(`BASE=${BASE} resource=${RESOURCE}`);

  const owner = await prisma.user.findFirst({
    where: { email: OWNER_EMAIL, deletedAt: null },
  });
  if (!owner) throw new Error(`OWNER ${OWNER_EMAIL} not found — seed required`);
  pass('OWNER account exists', owner.id);

  const member = await ensureMember();
  pass('MEMBER ensure member@aios.test', member.id);

  const fixtures = await ensureFixtures(owner.id);
  pass(
    'fixtures ready',
    `agent=${fixtures.agent.id} skill=${fixtures.skill.id} proposal=${fixtures.proposal.id}`,
  );

  // ── True OAuth scoped token ─────────────────────────────────────────────
  console.log('\n── obtain true Remote MCP OAuth scoped token ──');
  const oauthToken = await obtainOAuthScopedToken(MEMBER_EMAIL, MEMBER_PASSWORD);
  const oauthClaims = await verifyAccess(oauthToken);
  check(oauthClaims.scope === MCP_BUILDER_SCOPE, 'OAuth token scope', `got scope=${oauthClaims.scope}`);
  check(
    oauthClaims.audience === RESOURCE,
    'OAuth token audience',
    `got audience=${oauthClaims.audience}`,
  );
  check(oauthClaims.sub === member.id, 'OAuth token subject is member', `sub=${oauthClaims.sub}`);

  // ── signAccess control-group scoped token ───────────────────────────────
  const signedToken = await signAccess({
    sub: member.id,
    email: member.email,
    role: 'MEMBER',
    scope: MCP_BUILDER_SCOPE,
    audience: RESOURCE,
  });
  const signedClaims = await verifyAccess(signedToken);
  check(signedClaims.scope === MCP_BUILDER_SCOPE, 'signAccess scoped token scope', `got ${signedClaims.scope}`);

  const fixtureIds = {
    agentId: fixtures.agent.id,
    skillId: fixtures.skill.id,
    proposalId: fixtures.proposal.id,
  };

  const baseline = await captureBaseline(fixtureIds.agentId, fixtureIds.skillId, fixtureIds.proposalId);
  console.log('\n── DB baseline ──');
  console.log(JSON.stringify(baseline, null, 2));

  await runNegativeMatrix('oauth', oauthToken, fixtureIds);
  await runNegativeMatrix('signAccess', signedToken, fixtureIds);

  // ── zero mutation ───────────────────────────────────────────────────────
  console.log('\n── zero mutation check ──');
  const after = await captureBaseline(fixtureIds.agentId, fixtureIds.skillId, fixtureIds.proposalId);
  console.log(JSON.stringify(after, null, 2));
  check(after.agent === baseline.agent, 'agent.count unchanged', `${baseline.agent} → ${after.agent}`);
  check(after.skill === baseline.skill, 'skill.count unchanged', `${baseline.skill} → ${after.skill}`);
  check(
    after.workflow === baseline.workflow,
    'workflow.count unchanged',
    `${baseline.workflow} → ${after.workflow}`,
  );
  check(
    after.changeProposal === baseline.changeProposal,
    'changeProposal.count unchanged',
    `${baseline.changeProposal} → ${after.changeProposal}`,
  );
  check(
    after.mcpServerRegistry === baseline.mcpServerRegistry,
    'mcpServerRegistry.count unchanged',
    `${baseline.mcpServerRegistry} → ${after.mcpServerRegistry}`,
  );
  check(
    after.skillReview === 'AWAITING_USER_CONFIRM',
    'fixture skill still AWAITING_USER_CONFIRM',
    after.skillReview,
  );
  check(after.proposalStatus === 'PENDING', 'fixture proposal still PENDING', after.proposalStatus);
  check(after.agentName === baseline.agentName, 'fixture agent name unchanged', after.agentName);
  check(after.agentDeletedAt === null, 'fixture agent not deleted', String(after.agentDeletedAt));
  check(
    after.agentUpdatedAt === baseline.agentUpdatedAt,
    'fixture agent updatedAt unchanged',
    `${baseline.agentUpdatedAt} → ${after.agentUpdatedAt}`,
  );

  // ── positive controls (scope discrimination) ────────────────────────────
  console.log('\n── positive controls ──');
  const ownerLogin = await json(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  check(ownerLogin.response.status === 200, 'OWNER login', `HTTP ${ownerLogin.response.status}`);
  const ownerAccess = String((ownerLogin.body as { data?: { access?: string } })?.data?.access ?? '');
  check(Boolean(ownerAccess), 'OWNER access token', 'empty');

  const ownerAgents = await json(`${BASE}/api/agents`, {
    headers: { authorization: `Bearer ${ownerAccess}` },
  });
  check(ownerAgents.response.status === 200, 'OWNER GET /api/agents → 200', `HTTP ${ownerAgents.response.status}`);

  const me = await json(`${BASE}/api/auth/me`, {
    headers: { authorization: `Bearer ${oauthToken}` },
  });
  check(me.response.status === 200, 'scoped GET /api/auth/me → 200', `HTTP ${me.response.status}`);

  // cleanup fixtures only
  await cleanupFixtures();
  pass('cleanup fixtures (proposal/skill/agent by slug)');

  console.log(`\n── summary: ${failed === 0 ? 'ALL PASS' : `${failed} FAIL`} ──`);
  if (failed > 0) throw new Error(`T01 negative matrix finished with ${failed} failure(s)`);
}

main()
  .catch((err) => {
    process.exitCode = 1;
    console.error('FATAL:', err instanceof Error ? err.message : err);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
