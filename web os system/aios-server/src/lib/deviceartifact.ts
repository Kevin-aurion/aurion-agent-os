/**
 * DeviceArtifact: durable binary uploads outside WebSocket.
 * Paths are always under the project data root via safepath.
 *
 * Redaction policy:
 * - text/* / JSON / LOG (UTF-8 parseable, not magic image/PDF): server runs permanent
 *   redactor on bytes before hash/write; redacted=true means server-processed.
 * - image / PDF / opaque binary: no local OCR/content redactor → require
 *   clientDeclaredRedacted=true; meta.redactionMode='client-attested'.
 * Magic-byte detection prevents mimeType spoofing.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { errors } from './http.js';
import { paths } from '../config.js';
import { assertInsideRoot, safeJoin, sanitizeSegment } from './safepath.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import { getTaskForDeviceOrThrow } from './devicetask.js';
import type { DeviceArtifact, DeviceArtifactKind, Prisma } from '@prisma/client';

/** Default artifact TTL (7 days). */
export const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max TTL (30 days) — enforced in lib and routes. */
export const MAX_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Max upload size (aligned with Fastify multipart default in index). */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export function artifactsRoot(): string {
  return paths.deviceArtifacts;
}

export function computeSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type MagicKind = 'png' | 'jpeg' | 'gif' | 'pdf' | null;

/** Detect common binary types by magic bytes (cannot trust client mimeType). */
export function detectMagic(bytes: Buffer): MagicKind {
  if (bytes.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'png';
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif';
  }
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'pdf';
  }
  return null;
}

function isProbablyUtf8Text(bytes: Buffer): boolean {
  // Reject if NUL bytes (common binary marker).
  if (bytes.includes(0)) return false;
  try {
    const s = bytes.toString('utf8');
    // Round-trip check for invalid sequences replaced with U+FFFD heavily.
    const re = Buffer.from(s, 'utf8');
    if (re.length !== bytes.length) return false;
    // If many replacement chars, treat as binary.
    const replacements = (s.match(/\uFFFD/g) ?? []).length;
    if (replacements > 0 && replacements / Math.max(s.length, 1) > 0.01) return false;
    return true;
  } catch {
    return false;
  }
}

export type RedactionMode = 'server' | 'client-attested';

/**
 * Decide storage bytes + redaction mode.
 * Server-processed text: redacted=true means server actually redacted.
 * Client-attested binary: redacted=true only with attestation; meta.redactionMode clarifies.
 */
export function prepareArtifactBytes(opts: {
  kind: DeviceArtifactKind;
  mimeType: string;
  bytes: Buffer;
  clientDeclaredRedacted: boolean;
}): {
  storeBytes: Buffer;
  mimeType: string;
  redacted: boolean;
  redactionMode: RedactionMode;
  serverProcessed: boolean;
} {
  const mimeType = String(opts.mimeType || 'application/octet-stream').slice(0, 200).toLowerCase();
  const magic = detectMagic(opts.bytes);
  const isImageOrPdf =
    magic === 'png' ||
    magic === 'jpeg' ||
    magic === 'gif' ||
    magic === 'pdf' ||
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf';

  // Magic wins over spoofed mime: treat as opaque binary.
  if (isImageOrPdf || magic) {
    if (!opts.clientDeclaredRedacted) {
      throw errors.badRequest(
        'Binary/image/PDF artifacts require clientDeclaredRedacted=true (no server OCR/content redactor; fail-closed)',
      );
    }
    const effectiveMime =
      magic === 'png'
        ? 'image/png'
        : magic === 'jpeg'
          ? 'image/jpeg'
          : magic === 'gif'
            ? 'image/gif'
            : magic === 'pdf'
              ? 'application/pdf'
              : mimeType;
    return {
      storeBytes: opts.bytes,
      mimeType: effectiveMime,
      redacted: true, // attestation accepted; NOT server-confirmed content scrub
      redactionMode: 'client-attested',
      serverProcessed: false,
    };
  }

  const wantsText =
    opts.kind === 'LOG' ||
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/jsonl' ||
    mimeType.endsWith('+json');

  if (wantsText || isProbablyUtf8Text(opts.bytes)) {
    const rawText = opts.bytes.toString('utf8');
    let redactedText: string;
    if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
      try {
        const parsed = JSON.parse(rawText) as unknown;
        redactedText = JSON.stringify(deepRedactSecrets(parsed));
      } catch {
        redactedText = redactSecrets(rawText);
      }
    } else {
      redactedText = redactSecrets(rawText);
    }
    return {
      storeBytes: Buffer.from(redactedText, 'utf8'),
      mimeType: mimeType.startsWith('text/') || mimeType.includes('json') ? mimeType : 'text/plain',
      redacted: true,
      redactionMode: 'server',
      serverProcessed: true,
    };
  }

  // Opaque binary without magic — still require client attestation.
  if (!opts.clientDeclaredRedacted) {
    throw errors.badRequest(
      'Opaque binary artifacts require clientDeclaredRedacted=true (fail-closed)',
    );
  }
  return {
    storeBytes: opts.bytes,
    mimeType,
    redacted: true,
    redactionMode: 'client-attested',
    serverProcessed: false,
  };
}

function validateTtlMs(ttlMs?: number): number {
  const ttl = ttlMs ?? DEFAULT_ARTIFACT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw errors.badRequest('ttlMs must be a positive number');
  }
  if (ttl > MAX_ARTIFACT_TTL_MS) {
    throw errors.badRequest(`ttlMs exceeds maximum of ${MAX_ARTIFACT_TTL_MS}ms (30 days)`);
  }
  return ttl;
}

/**
 * Persist artifact bytes under data/device-artifacts/<deviceId>/<taskId>/<id>.
 * Never accepts external absolute paths into DB.
 */
export async function uploadDeviceArtifact(opts: {
  taskId: string;
  deviceId: string;
  seq: number;
  kind: DeviceArtifactKind;
  mimeType: string;
  bytes: Buffer;
  clientDeclaredRedacted: boolean;
  ttlMs?: number;
  meta?: unknown;
}): Promise<DeviceArtifact> {
  if (!Number.isInteger(opts.seq) || opts.seq < 0) {
    throw errors.badRequest('seq must be a non-negative integer');
  }
  if (!opts.bytes || opts.bytes.length === 0) {
    throw errors.badRequest('empty artifact body');
  }
  if (opts.bytes.length > MAX_ARTIFACT_BYTES) {
    throw errors.badRequest(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }

  const ttl = validateTtlMs(opts.ttlMs);

  await getTaskForDeviceOrThrow(opts.taskId, opts.deviceId);

  const prepared = prepareArtifactBytes({
    kind: opts.kind,
    mimeType: opts.mimeType,
    bytes: opts.bytes,
    clientDeclaredRedacted: !!opts.clientDeclaredRedacted,
  });

  const existing = await prisma.deviceArtifact.findUnique({
    where: { taskId_seq: { taskId: opts.taskId, seq: opts.seq } },
  });
  if (existing) {
    const dig = computeSha256(prepared.storeBytes);
    if (existing.sha256 === dig) return existing;
    throw errors.conflict(`Artifact seq ${opts.seq} already exists for this task`);
  }

  const id = ulid();
  const sha = computeSha256(prepared.storeBytes);
  const safeDevice = sanitizeSegment(opts.deviceId, 'unknown');
  const safeTask = sanitizeSegment(opts.taskId, 'unknown');
  const filename = `${sanitizeSegment(id, 'art')}.bin`;

  const root = artifactsRoot();
  await mkdir(root, { recursive: true });
  const absPath = safeJoin(root, safeDevice, safeTask, filename);
  await mkdir(path.dirname(absPath), { recursive: true });
  assertInsideRoot(root, absPath);
  await writeFile(absPath, prepared.storeBytes);

  const storageRelPath = path.relative(root, absPath);
  if (storageRelPath.startsWith('..') || path.isAbsolute(storageRelPath)) {
    try {
      await unlink(absPath);
    } catch {
      /* ignore */
    }
    throw errors.internal('refusing to store artifact outside data root');
  }

  const expiresAt = new Date(Date.now() + ttl);
  const baseMeta =
    opts.meta === undefined || opts.meta === null
      ? {}
      : typeof opts.meta === 'object' && !Array.isArray(opts.meta)
        ? { ...(opts.meta as Record<string, unknown>) }
        : { value: opts.meta };

  const meta = deepRedactSecrets({
    ...baseMeta,
    redactionMode: prepared.redactionMode,
    serverProcessed: prepared.serverProcessed,
  }) as Prisma.InputJsonValue;

  try {
    return await prisma.deviceArtifact.create({
      data: {
        id,
        taskId: opts.taskId,
        deviceId: opts.deviceId,
        seq: opts.seq,
        kind: opts.kind,
        sha256: sha,
        sizeBytes: prepared.storeBytes.length,
        mimeType: prepared.mimeType,
        storageRelPath,
        redacted: prepared.redacted,
        clientDeclaredRedacted: !!opts.clientDeclaredRedacted,
        expiresAt,
        meta,
      },
    });
  } catch (e: unknown) {
    try {
      await unlink(absPath);
    } catch {
      /* ignore */
    }
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      const again = await prisma.deviceArtifact.findUnique({
        where: { taskId_seq: { taskId: opts.taskId, seq: opts.seq } },
      });
      if (again) return again;
    }
    throw e;
  }
}

export async function getArtifactMeta(opts: {
  artifactId: string;
  deviceId?: string;
}): Promise<DeviceArtifact> {
  const art = await prisma.deviceArtifact.findUnique({ where: { id: opts.artifactId } });
  if (!art) throw errors.notFound('Artifact not found');
  if (opts.deviceId && art.deviceId !== opts.deviceId) {
    throw errors.notFound('Artifact not found');
  }
  if (art.expiresAt.getTime() <= Date.now()) {
    throw errors.notFound('Artifact expired');
  }
  return art;
}

export async function resolveArtifactPath(art: DeviceArtifact): Promise<string> {
  const root = artifactsRoot();
  const parts = art.storageRelPath.split(/[/\\]/).filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) {
    throw errors.internal('corrupt artifact path');
  }
  const abs = safeJoin(root, ...parts.map((p) => sanitizeSegment(p, '_')));
  assertInsideRoot(root, abs);
  try {
    await stat(abs);
  } catch {
    throw errors.notFound('Artifact file missing');
  }
  return abs;
}

export async function readArtifactBytes(art: DeviceArtifact): Promise<Buffer> {
  const abs = await resolveArtifactPath(art);
  return readFile(abs);
}

export async function cleanupExpiredArtifacts(limit = 200): Promise<{
  deleted: number;
  filesRemoved: number;
}> {
  const now = new Date();
  const expired = await prisma.deviceArtifact.findMany({
    where: { expiresAt: { lte: now } },
    take: limit,
  });
  let filesRemoved = 0;
  const root = artifactsRoot();
  for (const art of expired) {
    try {
      const parts = art.storageRelPath.split(/[/\\]/).filter(Boolean);
      if (!parts.some((p) => p === '..')) {
        const abs = safeJoin(root, ...parts.map((p) => sanitizeSegment(p, '_')));
        await unlink(abs);
        filesRemoved += 1;
      }
    } catch {
      // missing file is fine
    }
  }
  if (expired.length > 0) {
    await prisma.deviceArtifact.deleteMany({
      where: { id: { in: expired.map((a) => a.id) } },
    });
  }
  return { deleted: expired.length, filesRemoved };
}

export type { DeviceArtifact, DeviceArtifactKind };
