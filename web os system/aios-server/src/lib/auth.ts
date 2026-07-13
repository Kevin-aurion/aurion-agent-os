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
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessClaims {
  sub: string;
  email: string;
  role: string;
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
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(JWT_SECRET);
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return { sub: String(payload.sub), email: String(payload.email), role: String(payload.role) };
  } catch {
    throw errors.unauthorized('Invalid or expired token');
  }
}

/** Issue a refresh session; returns the raw refresh token (only shown once). */
export async function createSession(userId: string, client: string): Promise<string> {
  const raw = randomToken(48);
  await prisma.session.create({
    data: {
      id: ulid(),
      userId,
      tokenHash: sha256(raw),
      client,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return raw;
}

/** Rotate a refresh token: validate old, revoke it, issue a new one. */
export async function rotateSession(raw: string, client: string): Promise<{ userId: string; refresh: string }> {
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!s || s.revokedAt || s.expiresAt < new Date()) throw errors.unauthorized('Invalid session');
  await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  const refresh = await createSession(s.userId, client);
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
