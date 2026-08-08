/**
 * Ticket 03 — registry validation + broker fail-closed negatives.
 * Run: npx tsx .scratch/skill-production-platform/tests/t03-registry-neg.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import {
  assertLoopbackUrl,
  createServer,
  setEnabled,
  toSafeDto,
  validateRegistryInput,
  getServer,
} from '../../../src/lib/mcpregistry.js';
import { brokerDispatch, BrokerDeniedError } from '../../../src/lib/mcpbroker.js';
import { mcpSessions } from '../../../src/lib/mcpclient.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown> | unknown, label: string): Promise<unknown> {
  try {
    await fn();
    throw new Error(`ASSERT FAIL: expected throw for ${label}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ASSERT FAIL: expected throw')) throw e;
    return e;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/echo-mcp-server.mjs');

async function main() {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const createdIds: string[] = [];
  const agentIds: string[] = [];

  console.log('── validateRegistryInput negatives ──');
  await expectThrow(() => validateRegistryInput({} as never), 'missing transport');
  await expectThrow(
    () => validateRegistryInput({ transport: 'REMOTE_HTTP' }),
    'REMOTE_HTTP',
  );
  await expectThrow(
    () =>
      validateRegistryInput({
        transport: 'LOOPBACK_HTTP',
        url: 'http://10.0.0.5',
      }),
    'non-loopback 10.0.0.5',
  );
  await expectThrow(
    () =>
      validateRegistryInput({
        transport: 'LOOPBACK_HTTP',
        url: 'http://127.0.0.1.evil.com',
      }),
    'prefix bypass 127.0.0.1.evil.com',
  );
  await expectThrow(
    () => validateRegistryInput({ transport: 'STDIO' }),
    'STDIO without command',
  );
  await expectThrow(
    () =>
      validateRegistryInput({
        transport: 'STDIO',
        command: '/bin/true',
        credentialRef: 'sk-live-ABCDEF1234567890',
      }),
    'plaintext credentialRef',
  );

  console.log('── assertLoopbackUrl ──');
  const okUrl = assertLoopbackUrl('http://127.0.0.1:5001');
  assert(okUrl.hostname === '127.0.0.1', 'loopback parse ok');
  const eHost = await expectThrow(() => assertLoopbackUrl('http://10.0.0.5'), '10.0.0.5');
  assert(eHost instanceof ApiError, 'assertLoopbackUrl throws ApiError');

  console.log('── broker gates before dispatch ──');
  // Bogus command that would fail to spawn — gates must fire first.
  const bogussServerId = `t03-neg-bogus-${tag}`;
  const realAgentId = ulid();
  const otherAgentId = ulid();

  await prisma.agent.create({
    data: {
      id: realAgentId,
      slug: `t03-neg-a-${tag}`,
      name: 'T03 Neg Agent',
      description: 'test',
      rolePrompt: 'test',
      restrictions: { computerUse: true },
      riskTier: 'low',
      createdBy: user.id,
    },
  });
  agentIds.push(realAgentId);

  // Unauthorized agent entry: only realAgentId allowed
  const dto = await createServer(
    {
      serverId: bogussServerId,
      name: 'T03 Neg Bogus',
      transport: 'STDIO',
      command: '/nonexistent/bogus-mcp-binary-t03',
      commandArgs: [],
      enabled: false,
      allowedAgentIds: [realAgentId],
      toolAllowlist: ['echo'],
      requiredRestrictions: ['computerUse'],
      riskTier: 'low',
      approvalRequired: false,
    },
    user.id,
  );
  createdIds.push(dto.id);
  await setEnabled(dto.id, true, user.id);

  // unauthorized agent
  const eUnauth = await expectThrow(
    () =>
      brokerDispatch({
        agentId: otherAgentId,
        serverId: bogussServerId,
        tool: 'echo',
        args: {},
      }),
    'unauthorized agent',
  );
  assert(
    eUnauth instanceof BrokerDeniedError || eUnauth instanceof ApiError,
    'unauth should be BrokerDeniedError',
  );
  assert(
    String((eUnauth as Error).message).includes('agent') ||
      String((eUnauth as Error).message).includes('not found') ||
      String((eUnauth as Error).message).includes('not permitted'),
    `unauth message: ${(eUnauth as Error).message}`,
  );

  // tool not in allowlist (use real agent, still bogus binary — gate must win)
  const eTool = await expectThrow(
    () =>
      brokerDispatch({
        agentId: realAgentId,
        serverId: bogussServerId,
        tool: 'not_a_tool',
        args: {},
      }),
    'tool not allowlisted',
  );
  assert(
    eTool instanceof BrokerDeniedError,
    `tool gate should be BrokerDeniedError, got ${eTool}`,
  );
  assert(
    String((eTool as Error).message).includes('allowlist'),
    `tool message: ${(eTool as Error).message}`,
  );

  // disabled server
  await setEnabled(dto.id, false, user.id);
  const eDis = await expectThrow(
    () =>
      brokerDispatch({
        agentId: realAgentId,
        serverId: bogussServerId,
        tool: 'echo',
        args: {},
      }),
    'disabled server',
  );
  assert(eDis instanceof BrokerDeniedError, 'disabled should be BrokerDeniedError');
  assert(
    String((eDis as Error).message).includes('disabled'),
    `disabled message: ${(eDis as Error).message}`,
  );

  console.log('── secret non-leak in SafeDto ──');
  const secretServerId = `t03-neg-sec-${tag}`;
  const secDto = await createServer(
    {
      serverId: secretServerId,
      name: 'T03 Secret Ref',
      transport: 'STDIO',
      command: process.execPath,
      commandArgs: [FIXTURE],
      credentialRef: 'env:T03_FAKE_TOKEN_NAME',
      enabled: false,
      allowedAgentIds: [realAgentId],
      toolAllowlist: ['echo'],
    },
    user.id,
  );
  createdIds.push(secDto.id);
  const entry = await getServer(secDto.id);
  assert(entry, 'entry exists');
  const safe = toSafeDto(entry!);
  const dumped = JSON.stringify(safe);
  assert(!dumped.includes('sk-live'), 'SafeDto must not contain sk-live plaintext');
  assert(
    safe.credentialRef === 'env:T03_FAKE_TOKEN_NAME',
    'SafeDto keeps credentialRef as reference only',
  );
  // Ensure we never leak a resolved env value into the DTO
  assert(
    !('credential' in safe) && !('resolvedCredential' in (safe as object)),
    'no resolved credential field',
  );

  console.log('T03 REGISTRY-NEG OK');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      mcpSessions.closeAll();
    } catch {
      // ignore
    }
    // cleanup — best effort
    try {
      const user = await prisma.user.findFirst({
        where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
      });
      // Re-find created rows by serverId prefix if needed; use known ids from closure is hard in finally.
      // Delete by pattern:
      await prisma.mcpServerRegistry.deleteMany({
        where: { serverId: { startsWith: 't03-neg-' } },
      });
      await prisma.agent.deleteMany({
        where: { slug: { startsWith: 't03-neg-' } },
      });
      void user;
    } catch (e) {
      console.warn('cleanup warn', e);
    }
    await prisma.$disconnect();
    if (!process.exitCode) process.exit(0);
  });
