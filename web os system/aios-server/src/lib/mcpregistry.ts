// MCP server registry: fail-closed validation, CRUD, SafeDto, credential refs only.
import type { McpServerRegistry, McpTransport, McpTrustTier } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { ApiError, errors } from './http.js';
import { redactSecrets } from '../memory/redactor.js';
import type { McpTransportConfig } from './mcpclient.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const VALID_TRANSPORTS = new Set(['STDIO', 'LOOPBACK_HTTP', 'REMOTE_HTTP']);
const VALID_TRUST = new Set(['UNTRUSTED', 'TRUSTED', 'INTERNAL']);
const CRED_REF_RE = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^\s]+)$/;

export type RegistryEntry = McpServerRegistry;

export interface RegistryInput {
  serverId: string;
  name: string;
  transport: McpTransport | string;
  command?: string | null;
  commandArgs?: string[];
  cwd?: string | null;
  url?: string | null;
  protocolVersion?: string;
  enabled?: boolean;
  trustTier?: McpTrustTier | string;
  credentialRef?: string | null;
  allowedAgentIds?: string[];
  toolAllowlist?: string[];
  resourceAllowlist?: string[];
  readWriteClass?: string;
  requiredRestrictions?: string[];
  riskTier?: string;
  approvalRequired?: boolean;
  timeoutMs?: number;
}

export interface SafeDto {
  id: string;
  serverId: string;
  name: string;
  transport: string;
  command: string | null;
  commandArgs: string[];
  cwd: string | null;
  url: string | null;
  protocolVersion: string;
  enabled: boolean;
  trustTier: string;
  /** Reference only (e.g. "env:FOO") — never a resolved secret. */
  credentialRef: string | null;
  allowedAgentIds: string[];
  toolAllowlist: string[];
  resourceAllowlist: string[];
  readWriteClass: string;
  requiredRestrictions: string[];
  riskTier: string;
  approvalRequired: boolean;
  timeoutMs: number;
  healthStatus: string;
  lastVersion: string | null;
  lastHealthAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Strict loopback URL check — exact host match only (no prefix bypass). */
export function assertLoopbackUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Constant message — never echo untrusted URL (may contain userinfo credentials).
    throw errors.badRequest('invalid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw errors.badRequest(`url protocol must be http or https, got ${parsed.protocol}`);
  }
  // Ticket 25: reject embedded username/password (userinfo). Never reflect credentials.
  if (parsed.username !== '' || parsed.password !== '') {
    throw errors.badRequest('url must not contain username or password');
  }
  const host = parsed.hostname;
  // Exact string compare — reject 127.0.0.1.evil.com, 0.0.0.0, 10.x, etc.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw errors.badRequest(`url host must be loopback (127.0.0.1/localhost/::1), got ${host}`);
  }
  return parsed;
}

/** True only for env:NAME / keychain:… refs that are not themselves secret-looking. */
export function isCredentialRef(ref: string): boolean {
  if (typeof ref !== 'string' || !ref) return false;
  if (!CRED_REF_RE.test(ref)) return false;
  // Reject if redactor would rewrite it (detectable secret pattern inside).
  return redactSecrets(ref) === ref;
}

/** Fail-closed validation of registry create/update payloads. */
export function validateRegistryInput(input: Partial<RegistryInput> & { transport?: string }): void {
  const transport = input.transport;
  if (transport == null || transport === '') {
    throw errors.badRequest('transport is required');
  }
  if (!VALID_TRANSPORTS.has(String(transport))) {
    throw errors.badRequest(`invalid transport: ${transport}`);
  }
  if (transport === 'REMOTE_HTTP') {
    throw errors.badRequest('REMOTE_HTTP MCP is disabled by default');
  }
  if (transport === 'STDIO') {
    if (!input.command || typeof input.command !== 'string' || !input.command.trim()) {
      throw errors.badRequest('STDIO transport requires command');
    }
  }
  if (transport === 'LOOPBACK_HTTP') {
    if (!input.url || typeof input.url !== 'string') {
      throw errors.badRequest('LOOPBACK_HTTP transport requires url');
    }
    assertLoopbackUrl(input.url);
  }
  const pv = input.protocolVersion;
  if (pv !== undefined && (typeof pv !== 'string' || !pv.trim())) {
    throw errors.badRequest('protocolVersion must be a non-empty string');
  }
  if (input.credentialRef != null && input.credentialRef !== '') {
    if (!isCredentialRef(input.credentialRef)) {
      throw errors.badRequest(
        'credentialRef must be an env:NAME or keychain:… reference (plaintext secrets rejected)',
      );
    }
  }
  if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw errors.badRequest('timeoutMs must be a positive number');
    }
  }
  if (input.trustTier !== undefined && !VALID_TRUST.has(String(input.trustTier))) {
    throw errors.badRequest(`invalid trustTier: ${input.trustTier}`);
  }
  if (input.serverId !== undefined && (typeof input.serverId !== 'string' || !input.serverId.trim())) {
    throw errors.badRequest('serverId must be a non-empty string');
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) {
    throw errors.badRequest('name must be a non-empty string');
  }
}

function requireCreateFields(input: RegistryInput): void {
  if (!input.serverId || typeof input.serverId !== 'string' || !input.serverId.trim()) {
    throw errors.badRequest('serverId is required');
  }
  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
    throw errors.badRequest('name is required');
  }
  validateRegistryInput(input);
}

/** Safe public DTO — redacts any accidental secret-looking content; never resolves credentials. */
export function toSafeDto(entry: RegistryEntry): SafeDto {
  const raw: SafeDto = {
    id: entry.id,
    serverId: entry.serverId,
    name: entry.name,
    transport: entry.transport,
    command: entry.command,
    commandArgs: entry.commandArgs ?? [],
    cwd: entry.cwd,
    url: entry.url,
    protocolVersion: entry.protocolVersion,
    enabled: entry.enabled,
    trustTier: entry.trustTier,
    credentialRef: entry.credentialRef,
    allowedAgentIds: entry.allowedAgentIds ?? [],
    toolAllowlist: entry.toolAllowlist ?? [],
    resourceAllowlist: entry.resourceAllowlist ?? [],
    readWriteClass: entry.readWriteClass,
    requiredRestrictions: entry.requiredRestrictions ?? [],
    riskTier: entry.riskTier,
    approvalRequired: entry.approvalRequired,
    timeoutMs: entry.timeoutMs,
    healthStatus: entry.healthStatus,
    lastVersion: entry.lastVersion,
    lastHealthAt: entry.lastHealthAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  try {
    return JSON.parse(redactSecrets(JSON.stringify(raw))) as SafeDto;
  } catch {
    return raw;
  }
}

/** Resolve env:NAME → process.env[NAME]; keychain is a documented no-op placeholder. */
export function resolveCredential(entry: Pick<RegistryEntry, 'credentialRef'>): string | undefined {
  const ref = entry.credentialRef;
  if (!ref) return undefined;
  if (!isCredentialRef(ref)) return undefined;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = process.env[name];
    return typeof v === 'string' ? v : undefined;
  }
  // keychain:… — placeholder; not resolved in-process yet
  return undefined;
}

/** Map registry entry → transport config for openSession / mcpSessions. */
export function toTransportConfig(entry: RegistryEntry): McpTransportConfig {
  const kind = entry.transport === 'LOOPBACK_HTTP' ? 'loopback-http' : 'stdio';
  const cfg: McpTransportConfig = {
    kind,
    label: entry.name,
    protocolVersion: entry.protocolVersion || '2024-11-05',
    callTimeoutMs: entry.timeoutMs,
  };
  if (kind === 'stdio') {
    cfg.command = entry.command ?? undefined;
    cfg.args = entry.commandArgs ?? [];
    cfg.cwd = entry.cwd ?? undefined;
  } else {
    cfg.url = entry.url ?? undefined;
  }
  const resolved = resolveCredential(entry);
  if (resolved != null && entry.credentialRef?.startsWith('env:')) {
    const envName = entry.credentialRef.slice(4);
    cfg.env = { [envName]: resolved };
  }
  return cfg;
}

export async function createServer(input: RegistryInput, actorUserId: string): Promise<SafeDto> {
  requireCreateFields(input);
  const id = ulid();
  const row = await prisma.mcpServerRegistry.create({
    data: {
      id,
      serverId: input.serverId.trim(),
      name: input.name.trim(),
      transport: input.transport as McpTransport,
      command: input.command ?? null,
      commandArgs: input.commandArgs ?? [],
      cwd: input.cwd ?? null,
      url: input.url ?? null,
      protocolVersion: input.protocolVersion?.trim() || '2024-11-05',
      enabled: input.enabled ?? false,
      trustTier: (input.trustTier as McpTrustTier) ?? 'UNTRUSTED',
      credentialRef: input.credentialRef ?? null,
      allowedAgentIds: input.allowedAgentIds ?? [],
      toolAllowlist: input.toolAllowlist ?? [],
      resourceAllowlist: input.resourceAllowlist ?? [],
      readWriteClass: input.readWriteClass ?? 'read',
      requiredRestrictions: input.requiredRestrictions ?? [],
      riskTier: input.riskTier ?? 'medium',
      approvalRequired: input.approvalRequired ?? false,
      timeoutMs: input.timeoutMs ?? 12_000,
      createdBy: actorUserId,
    },
  });
  return toSafeDto(row);
}

export async function getServer(id: string): Promise<RegistryEntry | null> {
  return prisma.mcpServerRegistry.findUnique({ where: { id } });
}

export async function getServerByServerId(serverId: string): Promise<RegistryEntry | null> {
  return prisma.mcpServerRegistry.findUnique({ where: { serverId } });
}

export async function listServers(): Promise<SafeDto[]> {
  const rows = await prisma.mcpServerRegistry.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toSafeDto);
}

export async function updateServer(
  id: string,
  patch: Partial<RegistryInput>,
  _actorUserId: string,
): Promise<SafeDto> {
  const existing = await getServer(id);
  if (!existing) throw errors.notFound('mcp server not found');

  const merged: RegistryInput = {
    serverId: patch.serverId ?? existing.serverId,
    name: patch.name ?? existing.name,
    transport: (patch.transport ?? existing.transport) as McpTransport,
    command: patch.command !== undefined ? patch.command : existing.command,
    commandArgs: patch.commandArgs ?? existing.commandArgs,
    cwd: patch.cwd !== undefined ? patch.cwd : existing.cwd,
    url: patch.url !== undefined ? patch.url : existing.url,
    protocolVersion: patch.protocolVersion ?? existing.protocolVersion,
    enabled: patch.enabled ?? existing.enabled,
    trustTier: (patch.trustTier ?? existing.trustTier) as McpTrustTier,
    credentialRef:
      patch.credentialRef !== undefined ? patch.credentialRef : existing.credentialRef,
    allowedAgentIds: patch.allowedAgentIds ?? existing.allowedAgentIds,
    toolAllowlist: patch.toolAllowlist ?? existing.toolAllowlist,
    resourceAllowlist: patch.resourceAllowlist ?? existing.resourceAllowlist,
    readWriteClass: patch.readWriteClass ?? existing.readWriteClass,
    requiredRestrictions: patch.requiredRestrictions ?? existing.requiredRestrictions,
    riskTier: patch.riskTier ?? existing.riskTier,
    approvalRequired: patch.approvalRequired ?? existing.approvalRequired,
    timeoutMs: patch.timeoutMs ?? existing.timeoutMs,
  };
  validateRegistryInput(merged);

  const row = await prisma.mcpServerRegistry.update({
    where: { id },
    data: {
      serverId: merged.serverId.trim(),
      name: merged.name.trim(),
      transport: merged.transport as McpTransport,
      command: merged.command ?? null,
      commandArgs: merged.commandArgs ?? [],
      cwd: merged.cwd ?? null,
      url: merged.url ?? null,
      protocolVersion: merged.protocolVersion?.trim() || '2024-11-05',
      enabled: merged.enabled ?? false,
      trustTier: (merged.trustTier as McpTrustTier) ?? 'UNTRUSTED',
      credentialRef: merged.credentialRef ?? null,
      allowedAgentIds: merged.allowedAgentIds ?? [],
      toolAllowlist: merged.toolAllowlist ?? [],
      resourceAllowlist: merged.resourceAllowlist ?? [],
      readWriteClass: merged.readWriteClass ?? 'read',
      requiredRestrictions: merged.requiredRestrictions ?? [],
      riskTier: merged.riskTier ?? 'medium',
      approvalRequired: merged.approvalRequired ?? false,
      timeoutMs: merged.timeoutMs ?? 12_000,
    },
  });
  return toSafeDto(row);
}

export async function setEnabled(
  id: string,
  enabled: boolean,
  _actorUserId: string,
): Promise<SafeDto> {
  const existing = await getServer(id);
  if (!existing) throw errors.notFound('mcp server not found');
  const row = await prisma.mcpServerRegistry.update({
    where: { id },
    data: { enabled },
  });
  return toSafeDto(row);
}

export async function deleteServer(id: string, _actorUserId: string): Promise<void> {
  const existing = await getServer(id);
  if (!existing) throw errors.notFound('mcp server not found');
  await prisma.mcpServerRegistry.delete({ where: { id } });
}

/** Persist health probe fields (best-effort callers). */
export async function updateHealthFields(
  id: string,
  fields: { healthStatus: string; lastVersion?: string | null; lastHealthAt?: Date },
): Promise<void> {
  await prisma.mcpServerRegistry.update({
    where: { id },
    data: {
      healthStatus: fields.healthStatus,
      lastVersion: fields.lastVersion === undefined ? undefined : fields.lastVersion,
      lastHealthAt: fields.lastHealthAt ?? new Date(),
    },
  });
}

// Re-export ApiError path used by callers that catch validation errors
export { ApiError };
