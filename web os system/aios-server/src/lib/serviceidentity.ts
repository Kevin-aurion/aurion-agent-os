// Rotatable service identity + environment binding (Phase 6 / Ticket 21).
// Fail-closed for /internal/* gateways. Env is read at verify-time (never
// module-load cached) so tests can inject AIOS_SERVICE_IDENTITY_KEYS.
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { errors } from './http.js';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export type ServiceEnvironment = 'SANDBOX' | 'STAGING' | 'PRODUCTION';

export type ServiceIdentity =
  | { kind: 'legacy' }
  | { kind: 'keyed'; kid: string; environment: ServiceEnvironment };

const keyEntrySchema = z
  .object({
    kid: z.string().min(1),
    secret: z.string().min(1),
    environment: z.enum(['SANDBOX', 'STAGING', 'PRODUCTION']),
    expiresAt: z
      .string()
      .refine(
        (s) => Number.isFinite(Date.parse(s)),
        'expiresAt must be ISO8601',
      )
      .optional(),
  })
  .strict();

const keysSchema = z.array(keyEntrySchema);

type KeyEntry = z.infer<typeof keyEntrySchema>;

function sha256(buf: string): Buffer {
  return createHash('sha256').update(buf, 'utf8').digest();
}

function timingSafeStrEq(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

/**
 * Parse AIOS_SERVICE_IDENTITY_KEYS at call time.
 * - unset / empty string → null (legacy mode)
 * - invalid JSON / zod fail → null + console.warn (legacy fallback)
 * - valid array (incl. empty) → keyed mode
 */
export function loadServiceIdentityKeys(): KeyEntry[] | null {
  const raw = process.env.AIOS_SERVICE_IDENTITY_KEYS;
  if (raw == null || raw.trim() === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = keysSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(
        '[serviceidentity] AIOS_SERVICE_IDENTITY_KEYS zod parse failed; falling back to legacy token mode:',
        result.error.message,
      );
      return null;
    }
    return result.data;
  } catch (e) {
    console.warn(
      '[serviceidentity] AIOS_SERVICE_IDENTITY_KEYS JSON parse failed; falling back to legacy token mode:',
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

function assertLoopback(remoteAddress?: string): void {
  const remote = remoteAddress ?? '';
  if (!LOOPBACK_ADDRS.has(remote)) {
    throw errors.forbidden('Service identity 僅接受 loopback 來源');
  }
}

function verifyLegacy(authorization?: string): ServiceIdentity {
  const token = (process.env.AIOS_MODEL_GATEWAY_TOKEN ?? '').trim();
  if (!token) {
    throw errors.forbidden('Model Gateway service token 未設定，fail-closed 拒絕');
  }
  if (authorization == null || authorization === '') {
    throw errors.unauthorized('缺少 Authorization');
  }
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    throw errors.forbidden('Authorization 必須為 Bearer service token');
  }
  const provided = authorization.slice(prefix.length);
  if (!timingSafeStrEq(token, provided)) {
    throw errors.forbidden('Model Gateway service token 不符');
  }
  return { kind: 'legacy' };
}

function verifyKeyed(
  keys: KeyEntry[],
  authorization?: string,
): ServiceIdentity {
  if (keys.length === 0) {
    throw errors.forbidden('Service identity keys 未設定，fail-closed 拒絕');
  }
  if (authorization == null || authorization === '') {
    throw errors.unauthorized('缺少 Authorization');
  }
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    throw errors.forbidden('Authorization 必須為 Bearer kid.secret');
  }
  const provided = authorization.slice(prefix.length);
  const dot = provided.indexOf('.');
  if (dot <= 0 || dot === provided.length - 1) {
    // KEYS set → legacy single-token form is rejected (not kid.secret).
    throw errors.forbidden('Service identity 必須為 Bearer kid.secret（keyed 模式）');
  }
  const kid = provided.slice(0, dot);
  const secret = provided.slice(dot + 1);

  const entry = keys.find((k) => k.kid === kid);
  if (!entry) {
    throw errors.forbidden('Service identity unknown kid');
  }
  if (!timingSafeStrEq(entry.secret, secret)) {
    throw errors.forbidden('Service identity secret 不符');
  }
  if (entry.expiresAt) {
    const exp = Date.parse(entry.expiresAt);
    if (!Number.isFinite(exp) || exp <= Date.now()) {
      throw errors.forbidden('Service identity 已過期');
    }
  }
  return {
    kind: 'keyed',
    kid: entry.kid,
    environment: entry.environment,
  };
}

/**
 * Fail-closed service-to-service auth:
 * - loopback only
 * - keyed mode when AIOS_SERVICE_IDENTITY_KEYS is valid JSON array
 * - legacy AIOS_MODEL_GATEWAY_TOKEN when KEYS unset / unparseable
 */
export function verifyServiceIdentity(args: {
  authorization?: string;
  remoteAddress?: string;
}): ServiceIdentity {
  assertLoopback(args.remoteAddress);
  const keys = loadServiceIdentityKeys();
  if (keys == null) {
    return verifyLegacy(args.authorization);
  }
  return verifyKeyed(keys, args.authorization);
}

/**
 * keyed identity must match deployment.environment; legacy is unbound (compat).
 */
export function assertEnvironmentBinding(
  identity: ServiceIdentity | undefined | null,
  deploymentEnvironment: string,
): void {
  if (identity == null || identity.kind === 'legacy') {
    return;
  }
  if (identity.environment !== deploymentEnvironment) {
    throw errors.forbidden(
      `Service identity environment ${identity.environment} 與 deployment ${deploymentEnvironment} 不符`,
    );
  }
}
