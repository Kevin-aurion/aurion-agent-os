// Local auth: Argon2id password hashing, short-lived JWT access tokens, and
// rotating refresh-token sessions persisted (hashed) in Postgres.
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { prisma } from './db.js';
import { sha256, randomToken } from './crypto.js';
import { ApiError, errors } from './http.js';

const JWT_SECRET = new TextEncoder().encode(config.jwtSecret);
const ACCESS_TTL = '15m';
/** Absolute signed-in lifetime. Access JWTs remain short-lived and refresh
 * rotation never extends this original deadline. */
export const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export interface AccessClaims {
  sub: string;
  email: string;
  role: string;
  /** Optional constrained access boundary. Scoped tokens are never equivalent to web login tokens. */
  scope?: string;
  /** OAuth resource audience. Required for every scoped Remote MCP token. */
  audience?: string;
}

export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

export async function signAccess(claims: AccessClaims): Promise<string> {
  let jwt = new SignJWT({ email: claims.email, role: claims.role, ...(claims.scope ? { scope: claims.scope } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL);
  if (claims.audience) jwt = jwt.setAudience(claims.audience);
  return jwt.sign(JWT_SECRET);
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
    const audience = typeof payload.aud === 'string'
      ? payload.aud
      : Array.isArray(payload.aud) && payload.aud.length === 1 && typeof payload.aud[0] === 'string'
        ? payload.aud[0]
        : undefined;
    // Web access tokens intentionally have no audience. Any constrained OAuth
    // token must be cryptographically bound to this exact MCP resource.
    if (scope && audience !== config.remoteMcp.resourceUrl) {
      throw new Error('Scoped token has an invalid resource audience');
    }
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      role: String(payload.role),
      scope,
      audience,
    };
  } catch {
    throw errors.unauthorized('Invalid or expired token');
  }
}

/** Issue a refresh session; returns the raw refresh token (only shown once). */
export async function createSession(
  userId: string,
  client: string,
  absoluteExpiresAt = new Date(Date.now() + SESSION_TTL_MS),
): Promise<string> {
  const raw = randomToken(48);
  await prisma.session.create({
    data: {
      id: ulid(),
      userId,
      tokenHash: sha256(raw),
      client,
      expiresAt: absoluteExpiresAt,
    },
  });
  return raw;
}

/** Rotate a refresh token: validate old, revoke it, issue a new one. */
export async function rotateSession(raw: string, client: string): Promise<{ userId: string; refresh: string }> {
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) } });
  const now = new Date();
  // Older sessions may have been issued under the previous 30-day policy.
  // Cap them at three days from their original login instead of allowing a
  // refresh rotation to silently extend the old deadline.
  const absoluteExpiresAt = new Date(
    Math.min(s?.expiresAt.getTime() ?? 0, (s?.createdAt.getTime() ?? 0) + SESSION_TTL_MS),
  );
  if (!s || s.revokedAt || absoluteExpiresAt <= now) {
    throw errors.unauthorized('Invalid or expired session');
  }

  const refresh = randomToken(48);
  await prisma.$transaction(async (tx) => {
    // Claim the old refresh token once. Concurrent refreshes fail closed;
    // clients serialize refresh across tabs before calling this endpoint.
    const claimed = await tx.session.updateMany({
      where: { id: s.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (claimed.count !== 1) throw errors.unauthorized('Invalid session');
    await tx.session.create({
      data: {
        id: ulid(),
        userId: s.userId,
        tokenHash: sha256(refresh),
        client,
        expiresAt: absoluteExpiresAt,
      },
    });
  });
  return { userId: s.userId, refresh };
}

export async function revokeSession(raw: string): Promise<void> {
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) } });
  if (s && !s.revokedAt) await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
}

/** Extract & verify the bearer token from an Authorization header value. */
export async function claimsFromHeader(header?: string): Promise<AccessClaims> {
  if (!header?.startsWith('Bearer ')) throw errors.unauthorized('Missing bearer token');
  return verifyAccess(header.slice(7));
}

export { ApiError };
