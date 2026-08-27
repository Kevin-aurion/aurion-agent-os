/**
 * Device registry, one-time enrollment, and device bearer tokens.
 * Plaintext secrets are returned once; only SHA-256 hashes + safe prefixes are stored.
 * Device tokens are independent of user JWT (raw random secrets, not JWTs).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { prisma } from './db.js';
import { sha256, randomToken } from './crypto.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import type {
  Device,
  DeviceEnrollment,
  DevicePlatform,
  DeviceStatus,
  Prisma,
} from '@prisma/client';

/** Safe prefix length for display / lookup (never enough to reconstruct the secret). */
export const SECRET_PREFIX_LEN = 8;

/** Default enrollment code TTL. */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** Heartbeat freshness window for "online" calculation (REST lastSeen + WS). */
export const HEARTBEAT_FRESH_MS = 90_000;

export const DeviceCapabilitiesSchema = z
  .object({
    platform: z.enum(['MACOS', 'WINDOWS', 'LINUX']),
    osVersion: z.string().min(1).max(128),
    appVersion: z.string().min(1).max(128),
    features: z
      .object({
        computerUse: z.boolean(),
        screenRecording: z.boolean(),
        accessibility: z.boolean(),
        screenshot: z.boolean(),
        /// Codex App installed / Computer Use host present (not generic computerUse alone).
        codexApp: z.boolean().default(false),
        /// Codex CLI available on device.
        codexCli: z.boolean().default(false),
        /// LINE Desktop app present for line-desktop-mcp.
        lineDesktop: z.boolean().default(false),
      })
      .strict(),
    mcpServers: z
      .array(
        z.object({
          name: z.string().min(1).max(128),
          version: z.string().min(1).max(128),
          sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
          tools: z.array(z.string().min(1).max(128)).max(256),
        }),
      )
      .max(64)
      .default([]),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

export type SafeDevice = Omit<Device, 'tokenHash'> & {
  tokenHash: undefined;
  online?: boolean;
};

function hashSecret(raw: string): string {
  return sha256(raw);
}

function prefixOf(raw: string): string {
  return raw.slice(0, SECRET_PREFIX_LEN);
}

/** Constant-time hex/string equality (same length required). */
export function safeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) {
      // Still touch both buffers to reduce length-oracle noise.
      const pad = createHash('sha256').update(a).digest();
      timingSafeEqual(pad, pad);
      return false;
    }
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function stripToken(d: Device): SafeDevice {
  const { tokenHash: _t, ...rest } = d;
  return { ...rest, tokenHash: undefined };
}

export function toSafeDevice(d: Device, online?: boolean): SafeDevice {
  return { ...stripToken(d), online };
}

// ── FDE: create / list / get ────────────────────────────────────────────────

export async function createDevice(opts: {
  ownerUserId: string;
  name: string;
  platform: DevicePlatform;
}): Promise<SafeDevice> {
  const name = opts.name.trim();
  if (!name) throw errors.badRequest('name required');
  const device = await prisma.device.create({
    data: {
      id: ulid(),
      ownerUserId: opts.ownerUserId,
      name,
      platform: opts.platform,
      status: 'PENDING_ENROLLMENT',
    },
  });
  await audit(opts.ownerUserId, 'device.create', 'Device', device.id, {
    name: device.name,
    platform: device.platform,
  });
  return toSafeDevice(device);
}

export async function listDevices(): Promise<SafeDevice[]> {
  const rows = await prisma.device.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map((d) => toSafeDevice(d));
}

export async function getDeviceOrThrow(id: string): Promise<Device> {
  const d = await prisma.device.findUnique({ where: { id } });
  if (!d) throw errors.notFound('Device not found');
  return d;
}

export async function getSafeDevice(id: string): Promise<SafeDevice> {
  return toSafeDevice(await getDeviceOrThrow(id));
}

// ── Enrollment codes ────────────────────────────────────────────────────────

export async function issueEnrollmentCode(opts: {
  deviceId: string;
  createdBy: string;
  ttlMs?: number;
}): Promise<{ enrollmentId: string; code: string; expiresAt: Date; codePrefix: string }> {
  // Cheap precheck (not authoritative) — status is re-checked under FOR UPDATE.
  const device = await getDeviceOrThrow(opts.deviceId);
  if (device.status === 'REVOKED') {
    throw errors.forbidden('Device is revoked');
  }
  if (device.status === 'DISABLED') {
    throw errors.forbidden('Device is disabled');
  }

  const code = randomToken(24);
  const codeHash = hashSecret(code);
  const codePrefix = prefixOf(code);
  const enrollmentId = ulid();
  const ttlMs = opts.ttlMs ?? ENROLLMENT_TTL_MS;

  // Serialize concurrent issuers per device: lock Device row, invalidate older
  // unconsumed codes, then insert. Without FOR UPDATE two concurrent txs can both
  // invalidate-then-insert and leave two simultaneously valid codes.
  const expiresAt = await prisma.$transaction(async (tx) => {
    // Safe parameterized lock (Prisma tagged template → bound params).
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status::text AS status
      FROM "Device"
      WHERE id = ${device.id}
      FOR UPDATE
    `;
    if (!locked.length) {
      throw errors.notFound('Device not found');
    }
    const status = locked[0]!.status as DeviceStatus;
    if (status === 'REVOKED') {
      throw errors.forbidden('Device is revoked');
    }
    if (status === 'DISABLED') {
      throw errors.forbidden('Device is disabled');
    }

    const now = new Date();
    const exp = new Date(now.getTime() + ttlMs);

    await tx.deviceEnrollment.updateMany({
      where: {
        deviceId: device.id,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        // Expire immediately so concurrent consumers fail-closed.
        expiresAt: now,
      },
    });
    await tx.deviceEnrollment.create({
      data: {
        id: enrollmentId,
        deviceId: device.id,
        codeHash,
        codePrefix,
        expiresAt: exp,
        createdBy: opts.createdBy,
      },
    });
    return exp;
  });

  // If device was ACTIVE with a prior token, re-enroll requires a new code but
  // does not auto-activate until consume; keep status unless PENDING.
  if (device.status === 'PENDING_ENROLLMENT' || device.status === 'ACTIVE') {
    // leave status; enroll will re-issue token
  }

  await audit(opts.createdBy, 'device.enroll_code', 'Device', device.id, {
    enrollmentId,
    codePrefix,
    expiresAt: expiresAt.toISOString(),
  });

  // Plaintext code returned once — never persisted.
  return { enrollmentId, code, expiresAt, codePrefix };
}

/**
 * Consume a one-time enrollment code → issue device bearer token.
 * Fail-closed on expiry, reuse, missing, or revoked device.
 * Atomic consume: conditional updateMany where consumedAt=null AND expiresAt>now;
 * only count===1 may proceed (concurrent dual-consume is fail-closed for losers).
 */
export async function enrollWithCode(opts: {
  code: string;
  platform?: DevicePlatform;
  osVersion?: string;
  appVersion?: string;
}): Promise<{ deviceId: string; token: string; device: SafeDevice }> {
  const code = String(opts.code ?? '').trim();
  if (!code || code.length < 16) throw errors.badRequest('Invalid enrollment code');

  const codeHash = hashSecret(code);
  const enrollment = await prisma.deviceEnrollment.findUnique({
    where: { codeHash },
    include: { device: true },
  });

  // Constant-time-ish reject path for missing / wrong codes.
  if (!enrollment || !safeEqualStr(enrollment.codeHash, codeHash)) {
    throw errors.unauthorized('Invalid or expired enrollment code');
  }
  if (enrollment.consumedAt) {
    throw errors.forbidden('Enrollment code already used');
  }
  if (enrollment.expiresAt.getTime() <= Date.now()) {
    throw errors.unauthorized('Enrollment code expired');
  }

  const device = enrollment.device;
  if (device.status === 'REVOKED') {
    throw errors.forbidden('Device is revoked');
  }
  if (device.status === 'DISABLED') {
    throw errors.forbidden('Device is disabled');
  }

  const token = randomToken(32);
  const tokenHash = hashSecret(token);
  const tokenPrefix = prefixOf(token);
  const now = new Date();

  // Redact textual version fields before persistence (same discipline as
  // updateDeviceCapabilities). Platform is a validated enum — no secret redaction.
  const { redactSecrets } = await import('../memory/redactor.js');
  const redactedOs =
    opts.osVersion !== undefined && opts.osVersion !== null
      ? redactSecrets(String(opts.osVersion)).slice(0, 128)
      : undefined;
  const redactedApp =
    opts.appVersion !== undefined && opts.appVersion !== null
      ? redactSecrets(String(opts.appVersion)).slice(0, 128)
      : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    // Atomic one-time claim — no TOCTOU between read and write.
    const claim = await tx.deviceEnrollment.updateMany({
      where: {
        id: enrollment.id,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (claim.count !== 1) {
      const fresh = await tx.deviceEnrollment.findUnique({ where: { id: enrollment.id } });
      if (fresh?.consumedAt) {
        throw errors.forbidden('Enrollment code already used');
      }
      throw errors.unauthorized('Enrollment code expired');
    }

    // Device must still be enrollable at claim time.
    const dev = await tx.device.findUnique({ where: { id: device.id } });
    if (!dev || dev.status === 'REVOKED') {
      throw errors.forbidden('Device is revoked');
    }
    if (dev.status === 'DISABLED') {
      throw errors.forbidden('Device is disabled');
    }

    return tx.device.update({
      where: { id: device.id },
      data: {
        status: 'ACTIVE',
        tokenHash,
        tokenPrefix,
        enrolledAt: dev.enrolledAt ?? now,
        revokedAt: null,
        lastSeenAt: now,
        platform: opts.platform ?? dev.platform,
        osVersion: redactedOs !== undefined ? redactedOs : dev.osVersion,
        appVersion: redactedApp !== undefined ? redactedApp : dev.appVersion,
      },
    });
  });

  await audit(null, 'device.enroll', 'Device', updated.id, {
    enrollmentId: enrollment.id,
    tokenPrefix,
    platform: updated.platform,
  });

  return { deviceId: updated.id, token, device: toSafeDevice(updated) };
}

// ── Device token auth ───────────────────────────────────────────────────────

/**
 * Verify device bearer token (constant-time hash compare after unique lookup).
 * Rejects revoked/disabled/missing tokens fail-closed.
 */
export async function authenticateDeviceToken(rawToken: string): Promise<Device> {
  const token = String(rawToken ?? '').trim();
  if (!token || token.length < 16) throw errors.unauthorized('Invalid device token');

  const tokenHash = hashSecret(token);
  const device = await prisma.device.findUnique({ where: { tokenHash } });

  // Dummy compare path when missing to keep failure modes similar.
  if (!device || !device.tokenHash || !safeEqualStr(device.tokenHash, tokenHash)) {
    throw errors.unauthorized('Invalid device token');
  }
  if (device.status === 'REVOKED') {
    throw errors.forbidden('Device is revoked');
  }
  if (device.status === 'DISABLED') {
    throw errors.forbidden('Device is disabled');
  }
  if (device.status !== 'ACTIVE') {
    throw errors.forbidden('Device is not active');
  }
  return device;
}

/**
 * Extract device token from Authorization Bearer header only.
 * Query-string tokens are intentionally unsupported (fail-closed).
 */
export function deviceTokenFromAuthHeader(header?: string): string {
  if (!header?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing bearer device token');
  }
  const token = header.slice(7).trim();
  if (!token) throw errors.unauthorized('Missing bearer device token');
  return token;
}

export async function touchDeviceLastSeen(deviceId: string): Promise<void> {
  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // best-effort
  }
}

// ── Revoke / rotate ─────────────────────────────────────────────────────────

export async function revokeDevice(opts: {
  deviceId: string;
  actorUserId: string;
}): Promise<SafeDevice> {
  const device = await getDeviceOrThrow(opts.deviceId);
  if (device.status === 'REVOKED') {
    return toSafeDevice(device);
  }
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      status: 'REVOKED',
      tokenHash: null,
      tokenPrefix: null,
      revokedAt: new Date(),
    },
  });
  await audit(opts.actorUserId, 'device.revoke', 'Device', device.id, {});
  return toSafeDevice(updated);
}

/**
 * Rotate device token: invalidates previous token, returns new plaintext once.
 * Device must be ACTIVE (or re-activated from DISABLED is out of scope — only ACTIVE).
 */
export async function rotateDeviceToken(opts: {
  deviceId: string;
  actorUserId: string;
}): Promise<{ device: SafeDevice; token: string }> {
  const device = await getDeviceOrThrow(opts.deviceId);
  if (device.status === 'REVOKED') {
    throw errors.forbidden('Device is revoked; issue a new enrollment code instead');
  }
  if (device.status === 'PENDING_ENROLLMENT') {
    throw errors.badRequest('Device not enrolled yet');
  }
  if (device.status === 'DISABLED') {
    throw errors.forbidden('Device is disabled');
  }

  const token = randomToken(32);
  const tokenHash = hashSecret(token);
  const tokenPrefix = prefixOf(token);
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      status: 'ACTIVE',
      tokenHash,
      tokenPrefix,
      lastSeenAt: new Date(),
    },
  });
  await audit(opts.actorUserId, 'device.rotate', 'Device', device.id, { tokenPrefix });
  return { device: toSafeDevice(updated), token };
}

// ── Capabilities ────────────────────────────────────────────────────────────

export async function updateDeviceCapabilities(
  deviceId: string,
  raw: unknown,
): Promise<SafeDevice> {
  // Field-by-field: redact textual names/versions/tools via permanent redactor,
  // but preserve only schema-validated SHA-256 digests (never run redactor on them —
  // 64-hex would false-positive as long base64 secrets).
  const parsed = DeviceCapabilitiesSchema.parse(raw);
  const { redactSecrets } = await import('../memory/redactor.js');
  const DIGEST_RE = /^[a-fA-F0-9]{64}$/;
  const normalized: DeviceCapabilities = {
    platform: parsed.platform,
    osVersion: redactSecrets(parsed.osVersion).slice(0, 128),
    appVersion: redactSecrets(parsed.appVersion).slice(0, 128),
    features: {
      computerUse: !!parsed.features.computerUse,
      screenRecording: !!parsed.features.screenRecording,
      accessibility: !!parsed.features.accessibility,
      screenshot: !!parsed.features.screenshot,
      codexApp: !!parsed.features.codexApp,
      codexCli: !!parsed.features.codexCli,
      lineDesktop: !!parsed.features.lineDesktop,
    },
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    mcpServers: parsed.mcpServers.map((s) => {
      const dig =
        typeof s.sha256 === 'string' && DIGEST_RE.test(s.sha256)
          ? s.sha256.toLowerCase()
          : undefined;
      return {
        name: redactSecrets(s.name).slice(0, 128),
        version: redactSecrets(s.version).slice(0, 128),
        sha256: dig,
        tools: s.tools.map((t) => redactSecrets(t).slice(0, 128)),
      };
    }),
  };

  const device = await getDeviceOrThrow(deviceId);
  if (device.status !== 'ACTIVE') {
    throw errors.forbidden('Device is not active');
  }

  const updated = await prisma.device.update({
    where: { id: deviceId },
    data: {
      capabilities: normalized as Prisma.InputJsonValue,
      osVersion: normalized.osVersion,
      appVersion: normalized.appVersion,
      platform: normalized.platform,
      lastSeenAt: new Date(),
    },
  });
  // Reconcile pinned LINE MCP READY/ERROR from capability document (fail-safe).
  try {
    const { reconcileDeviceMcpFromCapabilities } = await import('./devicemcp.js');
    await reconcileDeviceMcpFromCapabilities(deviceId, normalized);
  } catch {
    /* never break capability path */
  }
  return toSafeDevice(updated);
}

// ── Agent ↔ Device bindings ─────────────────────────────────────────────────

export async function bindAgentDevice(opts: {
  agentId: string;
  deviceId: string;
  boundBy: string;
}): Promise<{ agentId: string; deviceId: string; boundAt: Date }> {
  const agent = await prisma.agent.findFirst({
    where: { id: opts.agentId, deletedAt: null },
  });
  if (!agent) throw errors.notFound('Agent not found');

  const device = await getDeviceOrThrow(opts.deviceId);
  if (device.status !== 'ACTIVE') {
    throw errors.badRequest('Only ACTIVE devices can be bound to an agent');
  }

  const row = await prisma.agentDevice.upsert({
    where: {
      agentId_deviceId: { agentId: opts.agentId, deviceId: opts.deviceId },
    },
    create: {
      agentId: opts.agentId,
      deviceId: opts.deviceId,
      boundBy: opts.boundBy,
    },
    update: {
      boundBy: opts.boundBy,
      boundAt: new Date(),
    },
  });

  await audit(opts.boundBy, 'device.bind_agent', 'AgentDevice', `${opts.agentId}:${opts.deviceId}`, {
    agentId: opts.agentId,
    deviceId: opts.deviceId,
  });

  return { agentId: row.agentId, deviceId: row.deviceId, boundAt: row.boundAt };
}

export async function unbindAgentDevice(opts: {
  agentId: string;
  deviceId: string;
  actorUserId: string;
}): Promise<void> {
  const existing = await prisma.agentDevice.findUnique({
    where: {
      agentId_deviceId: { agentId: opts.agentId, deviceId: opts.deviceId },
    },
  });
  if (!existing) throw errors.notFound('Binding not found');
  await prisma.agentDevice.delete({
    where: {
      agentId_deviceId: { agentId: opts.agentId, deviceId: opts.deviceId },
    },
  });
  await audit(opts.actorUserId, 'device.unbind_agent', 'AgentDevice', `${opts.agentId}:${opts.deviceId}`, {
    agentId: opts.agentId,
    deviceId: opts.deviceId,
  });
}

export async function listAgentDevices(agentId: string) {
  return prisma.agentDevice.findMany({
    where: { agentId },
    include: { device: true },
    orderBy: { boundAt: 'desc' },
  });
}

/** Assert no plaintext secrets leaked into DB columns (test helper / defensive). */
export function assertNoPlainSecretsInRow(row: {
  tokenHash?: string | null;
  tokenPrefix?: string | null;
  codeHash?: string | null;
  codePrefix?: string | null;
}, rawSecrets: string[]): void {
  const serialized = JSON.stringify(row);
  for (const s of rawSecrets) {
    if (s && serialized.includes(s)) {
      throw new Error('plaintext secret found in persisted row');
    }
  }
}

export type { Device, DeviceEnrollment, DeviceStatus, DevicePlatform };
