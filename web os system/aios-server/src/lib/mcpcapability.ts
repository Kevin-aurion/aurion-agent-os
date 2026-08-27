// Short-lived, broker-only capability passed to internal MCP subprocesses.
// It proves every tools/call passed AIOS policy gates; direct subprocess calls fail closed.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export type McpCapability = {
  agentId: string;
  runId?: string;
  serverId: string;
  tool: string;
  jti: string;
  exp: number;
};

function sign(encoded: string): string {
  return createHmac('sha256', config.jwtSecret).update(`aios-mcp-capability:${encoded}`).digest('base64url');
}

export function issueMcpCapability(input: Omit<McpCapability, 'exp' | 'jti'>): string {
  const payload: McpCapability = { ...input, jti: randomUUID(), exp: Date.now() + 30_000 };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifyMcpCapability(
  token: string,
  expected: { serverId: string; tool: string },
): McpCapability {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('invalid MCP capability');
  const actual = Buffer.from(signature, 'base64url');
  const wanted = Buffer.from(sign(encoded), 'base64url');
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new Error('invalid MCP capability');
  }
  let payload: McpCapability;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as McpCapability;
  } catch {
    throw new Error('invalid MCP capability');
  }
  if (
    payload.exp < Date.now() ||
    payload.exp > Date.now() + 60_000 ||
    payload.serverId !== expected.serverId ||
    payload.tool !== expected.tool ||
    !payload.agentId ||
    !payload.jti
  ) {
    throw new Error('expired or mismatched MCP capability');
  }
  return payload;
}
