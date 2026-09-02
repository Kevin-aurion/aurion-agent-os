import assert from 'node:assert/strict';
import test from 'node:test';
import { jwtVerify } from 'jose';
import {
  VINCENT_ISSUER,
  VINCENT_KEYCHAIN_SERVICE,
  VINCENT_MCP_URL,
  VINCENT_SCOPE,
  VINCENT_SUBJECT,
  VINCENT_TOKEN_TTL_SECONDS,
  buildProxyArgs,
  signVincentToken,
} from '../../../scripts/vincent-mcp-bridge.mjs';

test('Vincent bridge uses a private header file and no OAuth callback', () => {
  const args = buildProxyArgs('/private/tmp/authorization.headers');
  assert.deepEqual(args.slice(1), [
    VINCENT_MCP_URL,
    '--transport',
    'http-only',
    '--header-file',
    '/private/tmp/authorization.headers',
    '--silent',
  ]);
  assert.equal(args.some((arg) => /oauth|client_secret|3335/i.test(arg)), false);
  assert.equal(VINCENT_KEYCHAIN_SERVICE, 'app.aurion.aios.vincent.hs256');
});

test('Vincent token is HS256, audience-bound and no longer than ten minutes', async () => {
  const secret = 'unit-test-shared-secret-not-production';
  const now = 1_800_000_000;
  const token = await signVincentToken(secret, now);
  const { payload, protectedHeader } = await jwtVerify(
    token,
    new TextEncoder().encode(secret),
    { issuer: VINCENT_ISSUER, audience: VINCENT_MCP_URL, subject: VINCENT_SUBJECT },
  );
  assert.equal(protectedHeader.alg, 'HS256');
  assert.equal(protectedHeader.typ, 'JWT');
  assert.equal(payload.mcp_scope, VINCENT_SCOPE);
  assert.equal(Number(payload.exp) - Number(payload.iat), VINCENT_TOKEN_TTL_SECONDS);
  assert.ok(VINCENT_TOKEN_TTL_SECONDS <= 10 * 60);
});
