/**
 * Ticket 03 — positive broker + session manager (real stdio fixture).
 * Run: npx tsx .scratch/skill-production-platform/tests/t03-broker.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import {
  createServer,
  setEnabled,
  toTransportConfig,
  getServerByServerId,
} from '../../../src/lib/mcpregistry.js';
import { brokerDispatch } from '../../../src/lib/mcpbroker.js';
import { mcpSessions, McpError } from '../../../src/lib/mcpclient.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<unknown> {
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
  const agentId = ulid();
  const serverId = `t03-broker-${tag}`;
  let registryRowId: string | undefined;

  console.log('── setup agent + registry ──');
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `t03-broker-${tag}`,
      name: 'T03 Broker Agent',
      description: 'broker test',
      rolePrompt: 'test',
      restrictions: {
        webSearch: false,
        computerUse: true,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
        cloudEmbedding: false,
      },
      // no costPolicy → no budget limit
      riskTier: 'low',
      createdBy: user.id,
    },
  });

  const dto = await createServer(
    {
      serverId,
      name: `T03 Echo MCP ${tag}`,
      transport: 'STDIO',
      command: process.execPath,
      commandArgs: [FIXTURE],
      enabled: false,
      allowedAgentIds: [agentId],
      toolAllowlist: ['echo', 'sleep', 'crash'],
      requiredRestrictions: ['computerUse'],
      riskTier: 'low',
      approvalRequired: false,
      timeoutMs: 12_000,
    },
    user.id,
  );
  registryRowId = dto.id;
  await setEnabled(dto.id, true, user.id);

  const entry = await getServerByServerId(serverId);
  assert(entry, 'registry entry exists');
  const cfg = toTransportConfig(entry!);
  const poolKey = `mcp:${serverId}`;

  // ── echo ──
  console.log('── brokerDispatch echo ──');
  const result = await brokerDispatch({
    agentId,
    userId: user.id,
    serverId,
    tool: 'echo',
    args: { hi: 1 },
  });
  // result is MCP content object; text is JSON of args
  assert(result && typeof result === 'object', 'echo result is object');
  const content = (result as { content?: Array<{ text?: string }> }).content;
  assert(Array.isArray(content) && content[0]?.text, 'echo has text content');
  const echoed = JSON.parse(content![0]!.text!);
  assert(echoed.hi === 1, `echoed args hi===1, got ${JSON.stringify(echoed)}`);

  // ── REUSE ──
  console.log('── session REUSE ──');
  const s1 = await mcpSessions.acquire(poolKey, cfg);
  const id1 = s1.id;
  const s2 = await mcpSessions.acquire(poolKey, cfg);
  assert(s1.id === s2.id, `REUSE: session id stable ${s1.id} vs ${s2.id}`);
  assert(s1 === s2, 'REUSE: same session object');

  // ── DEDUPE ──
  console.log('── session DEDUPE ──');
  // Drop and reconnect with concurrent acquires
  mcpSessions.drop(poolKey);
  const [a, b] = await Promise.all([
    mcpSessions.acquire(poolKey, cfg),
    mcpSessions.acquire(poolKey, cfg),
  ]);
  assert(a === b, 'DEDUPE: concurrent acquire returns same session');
  assert(a.id === b.id, 'DEDUPE: same id');
  const preCrashId = a.id;

  // ── CRASH + bounded reconnect ──
  console.log('── crash + reconnect ──');
  const crashErr = await expectThrow(
    () =>
      brokerDispatch({
        agentId,
        userId: user.id,
        serverId,
        tool: 'crash',
        args: {},
      }),
    'crash tool',
  );
  assert(crashErr instanceof Error, 'crash rejects');
  // Brief wait so process exit is observed
  await new Promise((r) => setTimeout(r, 300));

  const after = await brokerDispatch({
    agentId,
    userId: user.id,
    serverId,
    tool: 'echo',
    args: { after: 'crash' },
  });
  assert(after && typeof after === 'object', 'echo after crash works');
  const sAfter = await mcpSessions.acquire(poolKey, cfg);
  assert(sAfter.id !== preCrashId, `NEW session id after crash: ${sAfter.id} vs ${preCrashId}`);
  assert(sAfter.isAlive(), 'new session alive');
  void id1;

  // ── TIMEOUT ──
  console.log('── timeout ──');
  const tErr = await expectThrow(
    () =>
      brokerDispatch({
        agentId,
        userId: user.id,
        serverId,
        tool: 'sleep',
        args: {},
        timeoutMs: 800,
      }),
    'sleep timeout',
  );
  assert(tErr instanceof McpError, `timeout should be McpError, got ${tErr}`);
  assert((tErr as McpError).code === 'timeout', `code===timeout, got ${(tErr as McpError).code}`);

  console.log('T03 BROKER OK');
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
    try {
      await prisma.mcpServerRegistry.deleteMany({
        where: { serverId: { startsWith: 't03-broker-' } },
      });
      await prisma.agent.deleteMany({
        where: { slug: { startsWith: 't03-broker-' } },
      });
    } catch (e) {
      console.warn('cleanup warn', e);
    }
    await prisma.$disconnect();
    if (!process.exitCode) process.exit(0);
  });
