/**
 * Ticket 22 — FDE Registry API Prefix Contract (MCP / A2A panels 404).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t22-fde-registry-api-prefix.test.ts
 *
 * Proves MCP + A2A FDE registry routes are reachable under `/api/*` (the web
 * client + Next rewrite contract) with the same auth/guard behaviour as the
 * bare `/mcp/*` and `/a2a/*` paths. Bare paths must remain byte-for-byte
 * unchanged. Zero DB drift on forbidden writes.
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { hashPassword, signAccess } from '../../../src/lib/auth.js';
import { config } from '../../../src/config.js';

const BASE = 'http://127.0.0.1:8700';
const MEMBER_EMAIL = 'member@aios.test';
const MEMBER_PASSWORD = 'aios-spike-01!';
const OWNER_EMAIL = 'fde@aios.test';
const OWNER_PASSWORD = 'aios-spike-01!';
const RESOURCE = config.remoteMcp.resourceUrl;
const MCP_BUILDER_SCOPE = 'aios:agent-builder';
const MCP_SERVER_ID = 't22-fixture-mcp';
const A2A_PEER_ID = 't22-fixture-peer';

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
  return Boolean(
    body &&
      typeof body === 'object' &&
      (body as { success?: unknown }).success === true &&
      'data' in (body as object),
  );
}

function isArrayData(body: unknown): boolean {
  if (!hasSuccessData(body)) return false;
  return Array.isArray((body as { data: unknown }).data);
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
      displayName: 'T22 Spike Member',
      passwordHash: await hashPassword(MEMBER_PASSWORD),
      role: 'MEMBER',
    },
  });
  return { id, email: MEMBER_EMAIL };
}

async function login(email: string, password: string): Promise<string> {
  const res = await json(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.response.status !== 200) {
    throw new Error(`login failed for ${email}: HTTP ${res.response.status}`);
  }
  const access = String((res.body as { data?: { access?: string } })?.data?.access ?? '');
  if (!access) throw new Error(`login empty access for ${email}`);
  return access;
}

async function cleanupFixtures(): Promise<void> {
  await prisma.mcpServerRegistry
    .deleteMany({ where: { serverId: MCP_SERVER_ID } })
    .catch(() => {});
  await prisma.a2APeer.deleteMany({ where: { peerId: A2A_PEER_ID } }).catch(() => {});
}

async function assertStatus(
  label: string,
  method: string,
  path: string,
  expected: number,
  token?: string,
  body?: unknown,
): Promise<{ response: Response; body: unknown }> {
  const res = await json(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const status = res.response.status;
  if (status === expected) {
    pass(label, `HTTP ${status}`);
  } else {
    fail(label, `expected HTTP ${expected}, got ${status} body=${JSON.stringify(res.body)}`);
  }
  return res;
}

async function main() {
  console.log('── T22 FDE Registry API Prefix Contract (live HTTP + DB) ──');
  console.log(`BASE=${BASE} resource=${RESOURCE}`);

  // Pre-clean any leftover fixtures from prior aborted runs.
  await cleanupFixtures();

  const owner = await prisma.user.findFirst({
    where: { email: OWNER_EMAIL, deletedAt: null },
  });
  if (!owner) throw new Error(`OWNER ${OWNER_EMAIL} not found — seed required`);
  pass('OWNER account exists', owner.id);

  const member = await ensureMember();
  pass('MEMBER ensure member@aios.test', member.id);

  const fdeToken = await login(OWNER_EMAIL, OWNER_PASSWORD);
  pass('FDE (OWNER) login');
  const memberToken = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
  pass('MEMBER plain login');

  const builderToken = await signAccess({
    sub: member.id,
    email: member.email,
    role: 'MEMBER',
    scope: MCP_BUILDER_SCOPE,
    audience: RESOURCE,
  });
  pass('builder-scoped token minted', 'signAccess aios:agent-builder');

  // ── A) Three-state matrix on acceptance routes ───────────────────────────
  console.log('\n── A) three-state matrix ──');

  // GET /api/mcp/servers
  await assertStatus('A no-token GET /api/mcp/servers → 401', 'GET', '/api/mcp/servers', 401);
  {
    const res = await assertStatus(
      'A FDE GET /api/mcp/servers → 200',
      'GET',
      '/api/mcp/servers',
      200,
      fdeToken,
    );
    check(isArrayData(res.body), 'A FDE GET /api/mcp/servers success+array', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'A builder GET /api/mcp/servers → 403',
      'GET',
      '/api/mcp/servers',
      403,
      builderToken,
    );
    check(!hasSuccessData(res.body), 'A builder GET /api/mcp/servers no success data', JSON.stringify(res.body));
  }

  // GET /api/a2a/peers
  await assertStatus('A no-token GET /api/a2a/peers → 401', 'GET', '/api/a2a/peers', 401);
  {
    const res = await assertStatus(
      'A FDE GET /api/a2a/peers → 200',
      'GET',
      '/api/a2a/peers',
      200,
      fdeToken,
    );
    check(isArrayData(res.body), 'A FDE GET /api/a2a/peers success+array', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'A builder GET /api/a2a/peers → 403',
      'GET',
      '/api/a2a/peers',
      403,
      builderToken,
    );
    check(!hasSuccessData(res.body), 'A builder GET /api/a2a/peers no success data', JSON.stringify(res.body));
  }

  // ── B) Frontend-path integration (exact panel paths) ─────────────────────
  console.log('\n── B) frontend-path integration ──');

  let mcpId = '';
  {
    const res = await assertStatus(
      'B POST /api/mcp/servers → 201',
      'POST',
      '/api/mcp/servers',
      201,
      fdeToken,
      {
        serverId: MCP_SERVER_ID,
        name: 'T22 Fixture MCP',
        transport: 'LOOPBACK_HTTP',
        url: 'http://127.0.0.1:39997/mcp',
        enabled: false,
      },
    );
    mcpId = String((res.body as { data?: { id?: string } })?.data?.id ?? '');
    check(Boolean(mcpId), 'B POST /api/mcp/servers data.id', 'missing id');
  }

  if (mcpId) {
    await assertStatus(
      'B GET /api/mcp/servers/:id → 200',
      'GET',
      `/api/mcp/servers/${mcpId}`,
      200,
      fdeToken,
    );

    {
      const health = await assertStatus(
        'B GET /api/mcp/servers/:id/health → 200 (fail-safe)',
        'GET',
        `/api/mcp/servers/${mcpId}/health`,
        200,
        fdeToken,
      );
      const statusField = (health.body as { data?: { status?: string } })?.data?.status;
      check(
        typeof statusField === 'string' && statusField.length > 0,
        'B health has status field (not requiring healthy)',
        `status=${String(statusField)}`,
      );
    }

    await assertStatus(
      'B POST /api/mcp/servers/:id/enable → 200',
      'POST',
      `/api/mcp/servers/${mcpId}/enable`,
      200,
      fdeToken,
    );
    await assertStatus(
      'B POST /api/mcp/servers/:id/disable → 200',
      'POST',
      `/api/mcp/servers/${mcpId}/disable`,
      200,
      fdeToken,
    );
    await assertStatus(
      'B DELETE /api/mcp/servers/:id → 200',
      'DELETE',
      `/api/mcp/servers/${mcpId}`,
      200,
      fdeToken,
    );
    mcpId = ''; // cleaned via API
  }

  {
    const res = await assertStatus(
      'B POST /api/a2a/peers → 201',
      'POST',
      '/api/a2a/peers',
      201,
      fdeToken,
      {
        peerId: A2A_PEER_ID,
        name: 'T22 Fixture Peer',
        baseUrl: 'http://127.0.0.1:39996',
        enabled: false,
      },
    );
    check(hasSuccessData(res.body), 'B POST /api/a2a/peers success envelope', JSON.stringify(res.body));
  }

  await assertStatus(
    'B PATCH /api/a2a/peers/:peerId/enabled → 200',
    'PATCH',
    `/api/a2a/peers/${A2A_PEER_ID}/enabled`,
    200,
    fdeToken,
    { enabled: false },
  );
  await assertStatus(
    'B DELETE /api/a2a/peers/:peerId → 200',
    'DELETE',
    `/api/a2a/peers/${A2A_PEER_ID}`,
    200,
    fdeToken,
  );

  // ── C) Fail-closed write negatives + zero DB drift ───────────────────────
  console.log('\n── C) fail-closed write negatives + zero DB drift ──');
  const countBefore = {
    mcp: await prisma.mcpServerRegistry.count(),
    a2a: await prisma.a2APeer.count(),
  };
  console.log(`counts BEFORE: mcp=${countBefore.mcp} a2a=${countBefore.a2a}`);

  {
    const res = await assertStatus(
      'C builder POST /api/mcp/servers → 403',
      'POST',
      '/api/mcp/servers',
      403,
      builderToken,
      {
        serverId: `t22-blocked-mcp-${ulid()}`,
        name: 'blocked',
        transport: 'LOOPBACK_HTTP',
        url: 'http://127.0.0.1:39997/mcp',
      },
    );
    check(!hasSuccessData(res.body), 'C builder POST mcp no success data', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'C builder POST /api/a2a/peers → 403',
      'POST',
      '/api/a2a/peers',
      403,
      builderToken,
      {
        peerId: `t22-blocked-peer-${ulid()}`,
        name: 'blocked',
        baseUrl: 'http://127.0.0.1:39996',
      },
    );
    check(!hasSuccessData(res.body), 'C builder POST a2a no success data', JSON.stringify(res.body));
  }

  {
    const res = await assertStatus(
      'C MEMBER POST /api/mcp/servers → 403',
      'POST',
      '/api/mcp/servers',
      403,
      memberToken,
      {
        serverId: `t22-blocked-mcp-m-${ulid()}`,
        name: 'blocked',
        transport: 'LOOPBACK_HTTP',
        url: 'http://127.0.0.1:39997/mcp',
      },
    );
    check(!hasSuccessData(res.body), 'C MEMBER POST mcp no success data', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'C MEMBER GET /api/a2a/peers → 403',
      'GET',
      '/api/a2a/peers',
      403,
      memberToken,
    );
    check(!hasSuccessData(res.body), 'C MEMBER GET a2a no success data', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'C MEMBER POST /api/a2a/peers → 403',
      'POST',
      '/api/a2a/peers',
      403,
      memberToken,
      {
        peerId: `t22-blocked-peer-m-${ulid()}`,
        name: 'blocked',
        baseUrl: 'http://127.0.0.1:39996',
      },
    );
    check(!hasSuccessData(res.body), 'C MEMBER POST a2a no success data', JSON.stringify(res.body));
  }

  const countAfter = {
    mcp: await prisma.mcpServerRegistry.count(),
    a2a: await prisma.a2APeer.count(),
  };
  console.log(`counts AFTER:  mcp=${countAfter.mcp} a2a=${countAfter.a2a}`);
  check(
    countAfter.mcp === countBefore.mcp,
    'C mcpServerRegistry.count unchanged',
    `${countBefore.mcp} → ${countAfter.mcp}`,
  );
  check(
    countAfter.a2a === countBefore.a2a,
    'C a2APeer.count unchanged',
    `${countBefore.a2a} → ${countAfter.a2a}`,
  );

  // ── D) Bare-path parity (regression) ─────────────────────────────────────
  console.log('\n── D) bare-path parity ──');

  await assertStatus('D no-token GET /mcp/servers → 401', 'GET', '/mcp/servers', 401);
  {
    const res = await assertStatus('D FDE GET /mcp/servers → 200', 'GET', '/mcp/servers', 200, fdeToken);
    check(isArrayData(res.body), 'D FDE GET /mcp/servers success+array', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'D builder GET /mcp/servers → 403',
      'GET',
      '/mcp/servers',
      403,
      builderToken,
    );
    check(!hasSuccessData(res.body), 'D builder GET /mcp/servers no success data', JSON.stringify(res.body));
  }

  await assertStatus('D no-token GET /a2a/peers → 401', 'GET', '/a2a/peers', 401);
  {
    const res = await assertStatus('D FDE GET /a2a/peers → 200', 'GET', '/a2a/peers', 200, fdeToken);
    check(isArrayData(res.body), 'D FDE GET /a2a/peers success+array', JSON.stringify(res.body));
  }
  {
    const res = await assertStatus(
      'D MEMBER GET /a2a/peers → 403',
      'GET',
      '/a2a/peers',
      403,
      memberToken,
    );
    check(!hasSuccessData(res.body), 'D MEMBER GET /a2a/peers no success data', JSON.stringify(res.body));
  }

  console.log(`\n── summary: ${failed === 0 ? 'ALL PASS' : `${failed} FAIL`} ──`);
  if (failed > 0) throw new Error(`T22 finished with ${failed} failure(s)`);
}

main()
  .catch((err) => {
    process.exitCode = 1;
    console.error('FATAL:', err instanceof Error ? err.message : err);
  })
  .finally(async () => {
    await cleanupFixtures();
    pass('cleanup fixtures (t22-fixture-mcp / t22-fixture-peer only)');
    await prisma.$disconnect().catch(() => {});
  });
