import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VINCENT_CALLBACK_PORT,
  VINCENT_CLIENT_ID,
  VINCENT_KEYCHAIN_SERVICE,
  VINCENT_MCP_URL,
  buildProxyArgs,
} from '../../../scripts/vincent-mcp-bridge.mjs';

test('Vincent bridge pins endpoint, callback, transport, and file-based credentials', () => {
  const args = buildProxyArgs('/private/tmp/oauth-client.json');
  assert.equal(VINCENT_MCP_URL, 'https://vincent.pinnovabiotech.com.tw/api/mcp');
  assert.equal(VINCENT_CALLBACK_PORT, 3335);
  assert.equal(VINCENT_CLIENT_ID, '7a23acfa-a548-48ca-a280-f2b2a9566031');
  assert.equal(VINCENT_KEYCHAIN_SERVICE, 'app.aurion.aios.vincent.read');
  assert.deepEqual(args.slice(1), [
    VINCENT_MCP_URL,
    '3335',
    '--host',
    'localhost',
    '--callback-path',
    '/oauth/callback',
    '--transport',
    'http-only',
    '--static-oauth-client-info',
    '@/private/tmp/oauth-client.json',
    '--silent',
  ]);
  assert.equal(args.some((arg) => arg.includes('client_secret')), false);
});
