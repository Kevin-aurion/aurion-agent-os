import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { openSession } from '../lib/mcpclient.js';
import {
  createServer,
  getServerByServerId,
  setEnabled,
  toTransportConfig,
  updateHealthFields,
  updateServer,
} from '../lib/mcpregistry.js';

const SERVER_ID = 'vincent-knowledge-read';
const KEYCHAIN_ACCOUNT = 'aios-employee:vincent-query-consultant';
const KEYCHAIN_SERVICE = 'app.aurion.aios.vincent.hs256';
const TOKEN_ISSUER = 'https://aurion-aios.lazyoffice.app';
const TOKEN_AUDIENCE = 'https://vincent.pinnovabiotech.com.tw/api/mcp';
const QUERY_AGENT_NAME = 'Vincent 知識庫查詢顧問';
const QUERY_AGENT_OWNER = 'hank@aurion-group.com';
const FDE_EMAIL = 'kevin@aurion-group.com';
const EXPECTED_TOOLS = ['get_status', 'list_spaces', 'search_knowledge'];
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bridgePath = path.join(serverRoot, 'scripts', 'vincent-mcp-bridge.mjs');

type JsonSchema = {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
};

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function assertCredentialInstalled(): void {
  try {
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE],
      { stdio: 'ignore' },
    );
  } catch {
    throw new Error(
      'Vincent HS256 shared secret 尚未安全匯入 macOS Keychain；請執行 scripts/install-vincent-mcp-credential.command。',
    );
  }
}

function exactTools(actual: string[]): boolean {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(EXPECTED_TOOLS));
}

function firstValueForKeys(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstValueForKeys(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = obj[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const nested of Object.values(obj)) {
    const found = firstValueForKeys(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function parseMcpPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (structured && typeof structured === 'object') return structured;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return value;
  const text = content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'),
    )
    .map((part) => part.text)
    .join('\n');
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildSearchArgs(
  schema: JsonSchema | undefined,
  refs: { organizationRef?: string; spaceRef?: string },
): Record<string, unknown> {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const args: Record<string, unknown> = {};
  const queryKey = ['query', 'q', 'text', 'keyword', 'search'].find((key) => key in properties);
  if (!queryKey) throw new Error('search_knowledge schema has no supported query field');
  args[queryKey] = 'PK3050013';

  for (const key of Object.keys(properties)) {
    if (['organizationRef', 'organization_ref', 'organizationId', 'organization_id'].includes(key) && refs.organizationRef) {
      args[key] = refs.organizationRef;
    } else if (['space_id', 'spaceId', 'space', 'space_ref', 'spaceRef'].includes(key) && refs.spaceRef) {
      args[key] = refs.spaceRef;
    } else if (['limit', 'top_k', 'topK'].includes(key)) {
      args[key] = 5;
    }
  }
  for (const key of required) {
    if (!(key in args)) throw new Error(`search_knowledge requires unsupported field: ${key}`);
  }
  return args;
}

async function resolveContext() {
  const [fde, owner] = await Promise.all([
    prisma.user.findFirst({ where: { email: FDE_EMAIL, deletedAt: null } }),
    prisma.user.findFirst({ where: { email: QUERY_AGENT_OWNER, deletedAt: null } }),
  ]);
  if (!fde || !['OWNER', 'TRAINER'].includes(fde.role)) throw new Error('Kevin FDE account not found');
  if (!owner) throw new Error('Hank account not found');

  const agent = await prisma.agent.findFirst({
    where: {
      name: QUERY_AGENT_NAME,
      createdBy: owner.id,
      deletedAt: null,
      status: { not: 'ARCHIVED' },
    },
  });
  if (!agent) throw new Error('Hank-owned Vincent query agent not found');
  return { fde, agent };
}

async function provision() {
  const { fde, agent } = await resolveContext();
  const input = {
    serverId: SERVER_ID,
    name: 'Vincent Knowledge MCP（HS256 · read-only）',
    transport: 'STDIO' as const,
    command: process.execPath,
    commandArgs: [bridgePath],
    cwd: serverRoot,
    url: null,
    protocolVersion: '2025-11-25',
    enabled: false,
    trustTier: 'UNTRUSTED' as const,
    credentialRef: `keychain:${KEYCHAIN_SERVICE}`,
    allowedAgentIds: [agent.id],
    toolAllowlist: EXPECTED_TOOLS,
    resourceAllowlist: ['Uni-Orient / 2025 product catalog'],
    readWriteClass: 'read',
    requiredRestrictions: [],
    riskTier: 'medium',
    approvalRequired: false,
    timeoutMs: 60_000,
  };

  const existing = await getServerByServerId(SERVER_ID);
  const dto = existing
    ? await updateServer(existing.id, input, fde.id)
    : await createServer(input, fde.id);
  await updateHealthFields(dto.id, {
    healthStatus: 'waiting_credential',
    lastVersion: '2025-11-25',
    lastHealthAt: new Date(),
  });
  await audit(fde.id, existing ? 'mcp_server.update' : 'mcp_server.create', 'McpServerRegistry', dto.id, {
    serverId: SERVER_ID,
    authMode: 'HS256',
    issuer: TOKEN_ISSUER,
    subject: KEYCHAIN_ACCOUNT,
    audience: TOKEN_AUDIENCE,
    agentId: agent.id,
    account: QUERY_AGENT_OWNER,
    tools: EXPECTED_TOOLS,
  });
  console.log(JSON.stringify({
    ok: true,
    action: 'provision',
    registryId: dto.id,
    enabled: dto.enabled,
    agentId: agent.id,
    account: QUERY_AGENT_OWNER,
    authMode: 'HS256',
    issuer: TOKEN_ISSUER,
    subject: KEYCHAIN_ACCOUNT,
    audience: TOKEN_AUDIENCE,
    tools: EXPECTED_TOOLS,
  }, null, 2));
  return dto.id;
}

async function ensureQueryWorkflow(
  agentId: string,
  queryField: string,
  organizationField?: string,
  spaceField?: string,
  refs: { organizationRef?: string; spaceRef?: string } = {},
) {
  const name = 'Vincent 知識庫查詢（MCP）';
  const inputSchema = {
    type: 'object',
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        description: '要交給 Vincent 知識庫查詢顧問的原始問題或產品編號。',
      },
    },
  };
  const existing = await prisma.workflow.findFirst({ where: { agentId, name, deletedAt: null } });
  const workflow = existing
    ? await prisma.workflow.update({ where: { id: existing.id }, data: { inputSchema } })
    : await prisma.workflow.create({
        data: {
          id: ulid(),
          agentId,
          name,
          description: '透過 Vincent read-only MCP 查詢產品知識庫。',
          enabled: true,
          trigger: { type: 'keyword', keywords: ['知識庫', 'PK', '產品', '查詢'] },
          inputSchema,
        },
      });
  const args: Record<string, string> = { [queryField]: '{{input.message}}' };
  // These are opaque capability refs returned by list_spaces, not secrets.
  // Keep them in the governed workflow instead of identityCard: the identity
  // normalizer intentionally drops unknown fields before a run is compiled.
  if (organizationField && refs.organizationRef) args[organizationField] = refs.organizationRef;
  if (spaceField && refs.spaceRef) args[spaceField] = refs.spaceRef;
  await prisma.workflowStep.deleteMany({ where: { workflowId: workflow.id } });
  await prisma.workflowStep.createMany({
    data: [
      {
        id: ulid(), workflowId: workflow.id, position: 0, stepKey: 'search_vincent', type: 'TOOL',
        config: { tool: `mcp:${SERVER_ID}:search_knowledge`, args },
        verifyRubric: null,
      },
      {
        id: ulid(), workflowId: workflow.id, position: 1, stepKey: 'answer', type: 'DO',
        config: {
          instruction: '只根據 Vincent MCP 查詢結果回答使用者。保留品號、價格、容量、尺寸與文件來源；找不到時明確說找不到，不得猜測。\n\n使用者問題：{{input.message}}\n\n查詢結果：{{steps.search_vincent}}',
          permissions: 'restricted',
        },
        verifyRubric: '回答必須可由 Vincent MCP 結果核對；不得補造資料，並保留來源。',
      },
    ],
  });
  return workflow.id;
}

async function verify() {
  const { fde, agent } = await resolveContext();
  assertCredentialInstalled();
  const entry = await getServerByServerId(SERVER_ID);
  if (!entry) throw new Error('Vincent MCP is not provisioned; run --provision first');
  await setEnabled(entry.id, false, fde.id);

  const cfg = toTransportConfig(entry);
  cfg.connectTimeoutMs = 180_000;
  cfg.callTimeoutMs = 60_000;
  let session: Awaited<ReturnType<typeof openSession>> | null = null;
  try {
    session = await openSession(cfg);
    const rawList = await session.request('tools/list', {}) as {
      tools?: Array<{ name?: string; inputSchema?: JsonSchema }>;
    };
    const tools = Array.isArray(rawList.tools) ? rawList.tools : [];
    const names = tools.flatMap((tool) => typeof tool.name === 'string' ? [tool.name] : []);
    if (!exactTools(names)) {
      throw new Error(`Vincent tools/list mismatch: expected ${EXPECTED_TOOLS.join(', ')}, got ${names.join(', ')}`);
    }

    const spacesRaw = await session.call('list_spaces', {});
    const spaces = parseMcpPayload(spacesRaw);
    const organizationRef = firstValueForKeys(spaces, ['organizationRef', 'organization_ref']);
    const spaceRef = firstValueForKeys(spaces, ['spaceRef', 'space_ref', 'spaceId', 'space_id']);
    const searchTool = tools.find((tool) => tool.name === 'search_knowledge');
    const searchArgs = buildSearchArgs(searchTool?.inputSchema, { organizationRef, spaceRef });
    const queryField = Object.keys(searchArgs).find((key) => ['query', 'q', 'text', 'keyword', 'search'].includes(key));
    if (!queryField) throw new Error('Unable to determine Vincent query field');
    const organizationField = Object.keys(searchArgs).find((key) => ['organizationRef', 'organization_ref', 'organizationId', 'organization_id'].includes(key));
    const spaceField = Object.keys(searchArgs).find((key) => ['space_id', 'spaceId', 'space', 'space_ref', 'spaceRef'].includes(key));
    const searchRaw = await session.call('search_knowledge', searchArgs);
    const searchable = JSON.stringify(parseMcpPayload(searchRaw));
    for (const expected of ['PK3050013', '750', '400']) {
      if (!searchable.includes(expected)) throw new Error(`Vincent knowledge smoke test missing expected value: ${expected}`);
    }

    const workflowId = await ensureQueryWorkflow(
      agent.id,
      queryField,
      organizationField,
      spaceField,
      { organizationRef, spaceRef },
    );
    if (organizationRef || spaceRef) {
      const identity = agent.identityCard && typeof agent.identityCard === 'object'
        ? agent.identityCard as Record<string, unknown>
        : {};
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          identityCard: {
            ...identity,
            ...(organizationRef ? { vincentOrganizationRef: organizationRef } : {}),
            ...(spaceRef ? { vincentSpaceRef: spaceRef } : {}),
          },
        },
      });
    }
    await updateHealthFields(entry.id, { healthStatus: 'healthy', lastVersion: '2025-11-25', lastHealthAt: new Date() });
    await setEnabled(entry.id, true, fde.id);
    await audit(fde.id, 'mcp_server.enable', 'McpServerRegistry', entry.id, {
      serverId: SERVER_ID,
      agentId: agent.id,
      workflowId,
      tools: names,
      tests: { toolsList: true, listSpaces: true, productPK3050013: true },
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'verify-and-enable',
      agentId: agent.id,
      workflowId,
      tools: names,
      tests: { toolsList: 'passed', listSpaces: 'passed', productPK3050013: 'passed' },
    }, null, 2));
  } catch (error) {
    await updateHealthFields(entry.id, { healthStatus: 'error', lastHealthAt: new Date() }).catch(() => {});
    await setEnabled(entry.id, false, fde.id).catch(() => {});
    throw error;
  } finally {
    session?.close();
  }
}

async function main() {
  if (process.argv.includes('--verify')) await verify();
  else await provision();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
