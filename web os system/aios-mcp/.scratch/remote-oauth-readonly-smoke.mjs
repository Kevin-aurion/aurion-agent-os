import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'https://aurion-aios-mcp.lazyoffice.app';
const resource = `${origin}/mcp`;
const callback = 'http://127.0.0.1:43991/callback';
const email = process.env.AIOS_MCP_EMAIL;
const password = process.env.AIOS_MCP_PASSWORD;
if (!email || !password) throw new Error('Missing test account credentials');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

const health = await json(`${origin}/healthz`);
assert(health.response.status === 200 && health.body?.ok === true, 'public MCP health failed');

const discovery = await json(`${origin}/.well-known/oauth-authorization-server`);
assert(discovery.response.status === 200, 'OAuth discovery failed');
assert(discovery.body?.issuer === origin, 'OAuth issuer is not canonical');
assert(discovery.body?.authorization_endpoint === `${origin}/oauth/authorize`, 'authorization endpoint mismatch');
assert(discovery.body?.token_endpoint === `${origin}/oauth/token`, 'token endpoint mismatch');

const protectedResource = await json(`${origin}/.well-known/oauth-protected-resource/mcp`);
assert(protectedResource.response.status === 200, 'protected-resource discovery failed');
assert(protectedResource.body?.resource === resource, 'protected resource URL mismatch');
assert(protectedResource.body?.authorization_servers?.includes(origin), 'authorization server mismatch');

const registration = await json(`${origin}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: `Aurion read-only smoke ${randomUUID()}`,
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  }),
});
assert(registration.response.status === 201, 'dynamic client registration failed');

const verifier = 'S'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorizeUrl = new URL(`${origin}/oauth/authorize`);
for (const [key, value] of Object.entries({
  response_type: 'code',
  client_id: registration.body.client_id,
  redirect_uri: callback,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'aios:agent-builder',
  state: 'readonly-smoke',
  resource,
})) authorizeUrl.searchParams.set(key, value);

const authorize = await fetch(authorizeUrl);
assert(authorize.status === 200, 'authorization page failed');
const ticket = (await authorize.text()).match(/name="ticket" value="([^"]+)"/)?.[1];
assert(ticket, 'authorization ticket missing');

const consent = await fetch(`${origin}/oauth/authorize`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  redirect: 'manual',
  body: new URLSearchParams({ ticket, email, password }),
});
assert(consent.status === 302, 'AIOS account authorization failed');
const code = new URL(consent.headers.get('location')).searchParams.get('code');
assert(code, 'authorization code missing');

const token = await json(`${origin}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: registration.body.client_id,
    code,
    redirect_uri: callback,
    code_verifier: verifier,
    resource,
  }),
});
assert(token.response.status === 200, 'token exchange failed');

const transport = new StreamableHTTPClientTransport(new URL(resource), {
  requestInit: { headers: { authorization: `Bearer ${token.body.access_token}` } },
});
const client = new Client({ name: 'aurion-readonly-smoke', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
const names = new Set(tools.tools.map((tool) => tool.name));
for (const required of ['start_agent_build', 'list_agent_builds', 'list_testable_agents', 'list_available_agents', 'invoke_agent', 'request_agent_archive']) {
  assert(names.has(required), `missing MCP tool: ${required}`);
}
assert(tools.tools.length === 22, `expected 22 builder tools, received ${tools.tools.length}`);
await client.close();

await fetch(`${origin}/oauth/revoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: token.body.refresh_token }),
});

console.log(JSON.stringify({
  ok: true,
  origin,
  resource,
  oauth: true,
  tools: tools.tools.length,
  accountScoped: true,
}));
