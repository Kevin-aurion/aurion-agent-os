import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { prisma } from './db.js';

/** Advisory lock key: serializes all audit chain writers to prevent forks. */
const AUDIT_ADVISORY_LOCK_KEY = 4242424242;

export interface AuditRowLite {
  id: string;
  prevHash: string | null;
  hash: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string;
  detail: unknown;
  createdAt: Date;
}

/** Recursively sort object keys so JSON.stringify is deterministic. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeysDeep(obj[k]);
    }
    return out;
  }
  return value;
}

function toIso(createdAt: Date | string): string {
  if (typeof createdAt === 'string') {
    // Normalize to the same form Date#toISOString produces when parseable.
    const d = new Date(createdAt);
    return Number.isNaN(d.getTime()) ? createdAt : d.toISOString();
  }
  return createdAt.toISOString();
}

/**
 * Pure: hash = sha256(canonical(prevHash + row fields)).
 * Field order is fixed; detail is JSON with sorted keys.
 */
export function computeAuditHash(row: {
  prevHash: string | null;
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string;
  detail: unknown;
  createdAt: Date | string;
}): string {
  const payload = [
    row.prevHash ?? '',
    row.id,
    row.userId ?? '',
    row.action,
    row.entity,
    row.entityId,
    JSON.stringify(sortKeysDeep(row.detail ?? null)),
    toIso(row.createdAt),
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Pure: verify a pre-sorted chain segment (createdAt asc, id asc).
 * First row may have prevHash null; each subsequent prevHash must equal previous hash.
 */
export function verifyChain(rows: AuditRowLite[]): {
  valid: boolean;
  brokenAt?: string;
  reason?: string;
} {
  let expectedPrev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prevHash !== expectedPrev) {
      return {
        valid: false,
        brokenAt: row.id,
        reason: `prevHash mismatch at index ${i}: expected ${expectedPrev ?? 'null'}, got ${row.prevHash ?? 'null'}`,
      };
    }
    const expectedHash = computeAuditHash({
      prevHash: row.prevHash,
      id: row.id,
      userId: row.userId,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      detail: row.detail,
      createdAt: row.createdAt,
    });
    if (row.hash !== expectedHash) {
      return {
        valid: false,
        brokenAt: row.id,
        reason: `hash mismatch at index ${i}`,
      };
    }
    expectedPrev = row.hash;
  }
  return { valid: true };
}

export async function audit(
  userId: string | null,
  action: string,
  entity: string,
  entityId: string,
  detail?: unknown,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_ADVISORY_LOCK_KEY})`;
      const last = await tx.auditLog.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { hash: true },
      });
      const id = ulid();
      const createdAt = new Date();
      const prevHash = last?.hash ?? null;
      const detailValue = detail === undefined ? undefined : (detail as object);
      const hash = computeAuditHash({
        prevHash,
        id,
        userId,
        action,
        entity,
        entityId,
        detail: detailValue ?? null,
        createdAt,
      });
      await tx.auditLog.create({
        data: {
          id,
          userId,
          action,
          entity,
          entityId,
          detail: detailValue,
          prevHash,
          hash,
          createdAt,
        },
      });
    });
  } catch {
    // auditing must never break the request path
  }
}

const VERIFY_BATCH = 500;

/** Load all audit rows in chain order and verify the hash chain. */
export async function verifyAuditChain(): Promise<{
  valid: boolean;
  brokenAt?: string;
  reason?: string;
  count: number;
}> {
  const all: AuditRowLite[] = [];
  let skip = 0;
  for (;;) {
    const batch = await prisma.auditLog.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip,
      take: VERIFY_BATCH,
      select: {
        id: true,
        prevHash: true,
        hash: true,
        userId: true,
        action: true,
        entity: true,
        entityId: true,
        detail: true,
        createdAt: true,
      },
    });
    if (batch.length === 0) break;
    for (const r of batch) {
      all.push({
        id: r.id,
        prevHash: r.prevHash,
        hash: r.hash,
        userId: r.userId,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        detail: r.detail,
        createdAt: r.createdAt,
      });
    }
    if (batch.length < VERIFY_BATCH) break;
    skip += batch.length;
  }

  const result = verifyChain(all);
  return { ...result, count: all.length };
}

/**
 * Recompute prevHash/hash for every existing row in total order.
 * Idempotent: re-running yields the same hashes.
 */
export async function backfillAuditChain(): Promise<{ updated: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_ADVISORY_LOCK_KEY})`;
    const rows = await tx.auditLog.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let prevHash: string | null = null;
    let updated = 0;
    for (const row of rows) {
      const hash = computeAuditHash({
        prevHash,
        id: row.id,
        userId: row.userId,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        detail: row.detail,
        createdAt: row.createdAt,
      });
      if (row.prevHash !== prevHash || row.hash !== hash) {
        await tx.auditLog.update({
          where: { id: row.id },
          data: { prevHash, hash },
        });
        updated += 1;
      }
      prevHash = hash;
    }
    return { updated };
  });
}

/**
 * Append current chain-head hash + ISO timestamp to a local anchor log
 * (external anchoring sketch for L0).
 */
export async function anchorAuditRoot(): Promise<void> {
  const last = await prisma.auditLog.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { hash: true },
  });
  const dataDir = config.dataDir || process.cwd();
  await mkdir(dataDir, { recursive: true });
  const anchorPath = path.join(dataDir, 'audit-anchor.log');
  const line = `${new Date().toISOString()} ${last?.hash ?? 'null'}\n`;
  await appendFile(anchorPath, line, 'utf8');
}
