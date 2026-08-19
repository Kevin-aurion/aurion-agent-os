// Immutable, content-addressed FlowArtifact (Runtime product).
// Runtime ≠ Engine: LANGFLOW is RuntimeKind only — never an Engine enum value.
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { FlowArtifact, FlowArtifactStatus, RuntimeKind } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';

const MAX_DEPTH = 64;
const ALLOWED_RUNTIME_KINDS = new Set<string>(['NATIVE', 'LANGFLOW']);

export type FlowArtifactErrorCode = 'INVALID_INPUT' | 'DIGEST_MISMATCH' | 'NOT_FOUND';

export class FlowArtifactError extends Error {
  readonly code: FlowArtifactErrorCode;

  constructor(code: FlowArtifactErrorCode, message: string) {
    super(redactSecrets(message));
    this.name = 'FlowArtifactError';
    this.code = code;
  }
}

function invalid(msg: string): never {
  throw new FlowArtifactError('INVALID_INPUT', msg);
}

/**
 * Recursive key-sorted JSON string for deterministic digests.
 * Fail-closed on undefined (top-level), function, symbol, bigint, non-finite numbers,
 * circular refs, and depth > 64. Object keys with undefined values are omitted
 * (JSON.stringify-compatible). Date → ISO string.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) invalid('canonicalJson: max depth exceeded');

    if (v === undefined) invalid('canonicalJson: undefined is not allowed');
    if (v === null) return null;

    const t = typeof v;
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      invalid(`canonicalJson: ${t} is not allowed`);
    }
    if (t === 'number') {
      if (!Number.isFinite(v as number)) {
        invalid('canonicalJson: non-finite number is not allowed');
      }
      return v;
    }
    if (t === 'string' || t === 'boolean') return v;

    if (v instanceof Date) {
      return v.toISOString();
    }

    if (t !== 'object') invalid(`canonicalJson: unsupported type ${t}`);

    const obj = v as object;
    if (seen.has(obj)) invalid('canonicalJson: circular reference');
    seen.add(obj);

    if (Array.isArray(v)) {
      return v.map((item) => {
        if (item === undefined) invalid('canonicalJson: undefined array element');
        return walk(item, depth + 1);
      });
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[key];
      // Skip undefined values (matches JSON.stringify)
      if (child === undefined) continue;
      out[key] = walk(child, depth + 1);
    }
    return out;
  }

  // Top-level undefined is rejected inside walk
  return JSON.stringify(walk(value, 0));
}

/** SHA-256 hex of canonicalJson(value). Matches runtime/adapter computeArtifactDigest for plain JSON. */
export function computeFlowArtifactDigest(value: unknown): string {
  const canonical = canonicalJson(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Fail-closed digest check. */
export function verifyArtifactDigest(artifactJson: unknown, digest: string): void {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new FlowArtifactError('DIGEST_MISMATCH', 'digest mismatch: invalid digest format');
  }
  const actual = computeFlowArtifactDigest(artifactJson);
  if (actual !== digest) {
    throw new FlowArtifactError(
      'DIGEST_MISMATCH',
      `digest mismatch: expected ${digest}, got ${actual}`,
    );
  }
}

export interface CreateFlowArtifactInput {
  skillVersionId?: string | null;
  workflowId?: string | null;
  runtimeKind: RuntimeKind | string;
  template: string;
  templateVersion?: string | null;
  compilerVersion: string;
  artifactJson: unknown;
  metadata?: unknown;
  createdBy?: string | null;
}

export interface CreateFlowArtifactResult {
  id: string;
  digest: string;
  status: FlowArtifactStatus;
  reused: boolean;
}

function isPlainObjectOrArray(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  return v !== null && typeof v === 'object' && !(v instanceof Date);
}

/**
 * Create a content-addressed FlowArtifact (or return existing on same digest key).
 * Secrets are deep-redacted before digest and persistence.
 */
export async function createFlowArtifact(
  input: CreateFlowArtifactInput,
): Promise<CreateFlowArtifactResult> {
  const runtimeKind = input.runtimeKind;
  if (typeof runtimeKind !== 'string' || !ALLOWED_RUNTIME_KINDS.has(runtimeKind)) {
    throw new FlowArtifactError(
      'INVALID_INPUT',
      `invalid runtimeKind: expected NATIVE|LANGFLOW, got ${String(runtimeKind)}`,
    );
  }

  if (typeof input.template !== 'string' || input.template.trim() === '') {
    throw new FlowArtifactError('INVALID_INPUT', 'template must be a non-empty string');
  }
  if (typeof input.compilerVersion !== 'string' || input.compilerVersion.trim() === '') {
    throw new FlowArtifactError('INVALID_INPUT', 'compilerVersion must be a non-empty string');
  }
  if (!isPlainObjectOrArray(input.artifactJson)) {
    throw new FlowArtifactError(
      'INVALID_INPUT',
      'artifactJson must be a plain object or array',
    );
  }

  const skillVersionId =
    input.skillVersionId === undefined || input.skillVersionId === null || input.skillVersionId === ''
      ? null
      : input.skillVersionId;
  const workflowId =
    input.workflowId === undefined || input.workflowId === null || input.workflowId === ''
      ? null
      : input.workflowId;

  if (skillVersionId) {
    const sv = await prisma.skillVersion.findUnique({
      where: { id: skillVersionId },
      select: { id: true },
    });
    if (!sv) {
      throw new FlowArtifactError('NOT_FOUND', `skillVersion not found: ${skillVersionId}`);
    }
  }

  const redactedJson = deepRedactSecrets(input.artifactJson);
  // Re-validate after redact (still must be serializable canonical JSON)
  const digest = computeFlowArtifactDigest(redactedJson);

  const redactedMeta =
    input.metadata === undefined || input.metadata === null
      ? null
      : deepRedactSecrets(input.metadata);

  const existing = await prisma.flowArtifact.findFirst({
    where: {
      skillVersionId,
      workflowId,
      template: input.template,
      compilerVersion: input.compilerVersion,
      digest,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    return {
      id: existing.id,
      digest: existing.digest,
      status: existing.status,
      reused: true,
    };
  }

  const id = ulid();
  const row = await prisma.flowArtifact.create({
    data: {
      id,
      skillVersionId,
      workflowId,
      runtimeKind: runtimeKind as RuntimeKind,
      template: input.template,
      templateVersion: input.templateVersion ?? null,
      compilerVersion: input.compilerVersion,
      artifactJson: redactedJson as Prisma.InputJsonValue,
      digest,
      status: 'COMPILED',
      metadata:
        redactedMeta === null ? Prisma.JsonNull : (redactedMeta as Prisma.InputJsonValue),
      createdBy: input.createdBy ?? null,
    },
  });

  return {
    id: row.id,
    digest: row.digest,
    status: row.status,
    reused: false,
  };
}

/** Load by id and verify digest (fail-closed on drift). */
export async function getVerifiedFlowArtifact(id: string): Promise<FlowArtifact> {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new FlowArtifactError('INVALID_INPUT', 'id must be a non-empty string');
  }
  const row = await prisma.flowArtifact.findUnique({ where: { id } });
  if (!row) {
    throw new FlowArtifactError('NOT_FOUND', `FlowArtifact not found: ${id}`);
  }
  verifyArtifactDigest(row.artifactJson, row.digest);
  return row;
}
