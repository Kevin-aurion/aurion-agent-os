// Capability broker: fail-closed gates then dispatch via pooled MCP sessions.
import type { Engine } from '@prisma/client';
import { ApiError } from './http.js';
import { prisma } from './db.js';
import { parseRestrictions, type AgentRestrictions } from '../engine/restrictions.js';
import { guardBudget, recordCost } from '../engine/cost.js';
import { isRunApproved } from './approval.js';
import { audit } from './audit.js';
import { redactSecrets } from '../memory/redactor.js';
import {
  mcpSessions,
  type McpCallOptions,
  type McpSession,
  type McpTransportConfig,
} from './mcpclient.js';
import {
  assertLoopbackUrl,
  getServerByServerId,
  toTransportConfig,
} from './mcpregistry.js';
import { issueMcpCapability } from './mcpcapability.js';

/** Fail-closed gate rejection. */
export class BrokerDeniedError extends ApiError {
  constructor(code: string, message: string, detail?: unknown) {
    const status =
      code === 'not_found' || code === 'NOT_FOUND'
        ? 404
        : code === 'forbidden' || code === 'FORBIDDEN'
          ? 403
          : code === 'bad_request' || code === 'BAD_REQUEST'
            ? 400
            : 403;
    const norm = code.includes('_')
      ? code.toUpperCase()
      : code === 'forbidden'
        ? 'FORBIDDEN'
        : code === 'not_found'
          ? 'NOT_FOUND'
          : code.toUpperCase();
    super(status, norm, message, detail);
    this.name = 'BrokerDeniedError';
  }
}

export interface BrokerRequest {
  agentId: string;
  userId?: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
  idempotencyKey?: string;
  timeoutMs?: number;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: McpCallOptions['onProgress'];
}

export interface BrokerDeps {
  acquireSession?: (
    key: string,
    cfg: McpTransportConfig,
  ) => Promise<Pick<McpSession, 'call' | 'isAlive' | 'id'>>;
  now?: () => number;
}

const RESTRICTION_KEYS = new Set([
  'webSearch',
  'computerUse',
  'sendEmail',
  'cloudWrite',
  'shell',
  'cloudEmbedding',
]);

function redactValue(raw: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(raw)));
  } catch {
    return raw;
  }
}

/**
 * Governed MCP dispatch. Gates run in exact order; any uncertainty → throw
 * before the session is acquired. Cost/audit are fail-safe.
 */
export async function brokerDispatch(
  req: BrokerRequest,
  deps?: BrokerDeps,
): Promise<unknown> {
  // 1. authenticate — load agent
  const agent = await prisma.agent.findFirst({
    where: { id: req.agentId, deletedAt: null },
  });
  if (!agent || agent.status === 'ARCHIVED') {
    throw new BrokerDeniedError('forbidden', 'agent not found or inactive');
  }

  // 2. registry / agent scope
  const entry = await getServerByServerId(req.serverId);
  if (!entry) {
    throw new BrokerDeniedError('not_found', 'mcp server not registered');
  }
  if (!entry.enabled) {
    throw new BrokerDeniedError('forbidden', 'mcp server disabled');
  }
  if (entry.transport !== 'STDIO' && entry.transport !== 'LOOPBACK_HTTP') {
    throw new BrokerDeniedError('forbidden', 'mcp transport not permitted');
  }
  if (entry.transport === 'LOOPBACK_HTTP') {
    if (!entry.url) {
      throw new BrokerDeniedError('forbidden', 'loopback mcp server missing url');
    }
    try {
      assertLoopbackUrl(entry.url);
    } catch (e) {
      throw new BrokerDeniedError(
        'forbidden',
        e instanceof Error ? e.message : 'non-loopback url',
      );
    }
  }
  if (!entry.allowedAgentIds.includes(req.agentId)) {
    throw new BrokerDeniedError('forbidden', 'agent not permitted for this server');
  }
  if (!entry.toolAllowlist.includes(req.tool)) {
    throw new BrokerDeniedError('forbidden', 'tool not in allowlist');
  }

  // 3. restrictions
  const restrictions = parseRestrictions(agent.restrictions);
  for (const flag of entry.requiredRestrictions) {
    if (!RESTRICTION_KEYS.has(flag)) {
      throw new BrokerDeniedError('forbidden', `restriction ${flag} not granted`);
    }
    const key = flag as keyof AgentRestrictions;
    const val = restrictions[key];
    if (val !== true) {
      throw new BrokerDeniedError('forbidden', `restriction ${flag} not granted`);
    }
  }

  // 4. risk / HITL
  if (entry.approvalRequired || entry.riskTier === 'high') {
    if (!req.runId) {
      throw new BrokerDeniedError('forbidden', 'approval required');
    }
    const approvalRun = await prisma.run.findUnique({
      where: { id: req.runId },
      select: { agentId: true },
    });
    if (!approvalRun || approvalRun.agentId !== req.agentId) {
      throw new BrokerDeniedError('forbidden', 'approved run does not belong to this agent');
    }
    const approved = await isRunApproved(req.runId);
    if (!approved) {
      throw new BrokerDeniedError('forbidden', 'approval required');
    }
  }

  // 5. budget
  await guardBudget(req.agentId, agent.costPolicy);

  // 6. dispatch
  const cfg = toTransportConfig(entry);
  const key = `mcp:${entry.serverId}`;
  const acquire =
    deps?.acquireSession ??
    ((k: string, c: McpTransportConfig) => mcpSessions.acquire(k, c));
  const session = await acquire(key, cfg);
  const callArgs =
    entry.trustTier === 'INTERNAL'
      ? {
          ...(req.args ?? {}),
          // Always overwrite any caller-supplied value. Internal subprocesses
          // require this proof; third-party MCP schemas remain untouched.
          __aiosCapability: issueMcpCapability({
            agentId: req.agentId,
            runId: req.runId,
            serverId: entry.serverId,
            tool: req.tool,
          }),
        }
      : req.args;
  const raw = await session.call(req.tool, callArgs, {
    timeoutMs: req.timeoutMs ?? entry.timeoutMs,
    idempotencyKey: req.idempotencyKey,
    signal: req.signal,
    onProgress: req.onProgress,
  });

  // 7. redact
  const redacted = redactValue(raw);

  // 8. cost / audit (FAIL-SAFE)
  try {
    await recordCost({
      agentId: req.agentId,
      runId: req.runId ?? null,
      engine: agent.engineExecute as Engine,
      inputText: '',
      outputText: '',
      stepKey: `mcp:${entry.serverId}:${req.tool}`,
    });
  } catch (e) {
    console.warn('[mcpbroker] recordCost failed (fail-safe):', e);
  }
  try {
    const meta = redactValue({
      tool: req.tool,
      agentId: req.agentId,
      serverId: entry.serverId,
    });
    await audit(
      req.userId ?? agent.createdBy,
      'mcp_dispatch',
      'McpServerRegistry',
      entry.id,
      meta,
    );
  } catch (e) {
    console.warn('[mcpbroker] audit failed (fail-safe):', e);
  }

  return redacted;
}
