import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { errors } from './http.js';
import { sha256 } from './crypto.js';

const SIGNING_KEY = new TextEncoder().encode(config.jwtSecret);
const CLIENT_AUDIENCE = 'aios-remote-mcp-client';
const REQUEST_AUDIENCE = 'aios-remote-mcp-authorization';
export const MCP_BUILDER_SCOPE = 'aios:agent-builder';

export interface McpClientMetadata {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: 'none';
}

export interface McpAuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state?: string;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw errors.badRequest('Invalid redirect URI');
  }
}

function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** Hosted Claude/ChatGPT callbacks or RFC 8252 loopback redirects only. */
export function assertAllowedMcpRedirectUri(value: string): void {
  const url = parseUrl(value);
  const hostedClaude =
    url.protocol === 'https:' &&
    url.hostname === 'claude.ai' &&
    url.pathname === '/api/mcp/auth_callback';
  const hostedChatGpt =
    url.protocol === 'https:' &&
    url.hostname === 'chatgpt.com' &&
    (
      /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
      url.pathname === '/connector_platform_oauth_redirect'
    );
  if (!hostedClaude && !hostedChatGpt && !isLoopbackRedirect(url)) {
    throw errors.badRequest('Redirect URI is not an approved MCP client callback');
  }
  if (url.username || url.password || url.hash) {
    throw errors.badRequest('Redirect URI contains forbidden credentials or fragment');
  }
}

/** RFC 8252 loopback redirect ports vary per authorization attempt. */
export function redirectUriMatches(registered: string, actual: string): boolean {
  const expected = parseUrl(registered);
  const candidate = parseUrl(actual);
  if (isLoopbackRedirect(expected) && isLoopbackRedirect(candidate)) {
    return (
      expected.protocol === candidate.protocol &&
      expected.hostname === candidate.hostname &&
      expected.pathname === candidate.pathname &&
      expected.search === candidate.search
    );
  }
  return expected.toString() === candidate.toString();
}

export async function signMcpClient(metadata: McpClientMetadata): Promise<string> {
  return new SignJWT({
    client_name: metadata.clientName.slice(0, 120),
    redirect_uris: metadata.redirectUris,
    grant_types: metadata.grantTypes,
    token_endpoint_auth_method: metadata.tokenEndpointAuthMethod,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'aios-mcp-client+jwt' })
    .setIssuer(config.remoteMcp.issuer)
    .setAudience(CLIENT_AUDIENCE)
    .setIssuedAt()
    .sign(SIGNING_KEY);
}

export async function verifyMcpClient(clientId: string): Promise<McpClientMetadata> {
  try {
    const { payload } = await jwtVerify(clientId, SIGNING_KEY, {
      issuer: config.remoteMcp.issuer,
      audience: CLIENT_AUDIENCE,
    });
    const redirectUris = Array.isArray(payload.redirect_uris)
      ? payload.redirect_uris.filter((value): value is string => typeof value === 'string')
      : [];
    if (!redirectUris.length) throw new Error('missing redirect URIs');
    redirectUris.forEach(assertAllowedMcpRedirectUri);
    return {
      clientName: typeof payload.client_name === 'string' ? payload.client_name : 'Claude',
      redirectUris,
      grantTypes: Array.isArray(payload.grant_types)
        ? payload.grant_types.filter((value): value is string => typeof value === 'string')
        : ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
    };
  } catch {
    throw errors.unauthorized('Invalid OAuth client');
  }
}

export async function signMcpAuthorizationRequest(request: McpAuthorizationRequest): Promise<string> {
  return new SignJWT({
    client_id: request.clientId,
    client_name: request.clientName,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    state: request.state,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'aios-mcp-request+jwt' })
    .setIssuer(config.remoteMcp.issuer)
    .setAudience(REQUEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(SIGNING_KEY);
}

export async function verifyMcpAuthorizationRequest(ticket: string): Promise<McpAuthorizationRequest> {
  try {
    const { payload } = await jwtVerify(ticket, SIGNING_KEY, {
      issuer: config.remoteMcp.issuer,
      audience: REQUEST_AUDIENCE,
    });
    const request: McpAuthorizationRequest = {
      clientId: String(payload.client_id ?? ''),
      clientName: String(payload.client_name ?? 'Claude'),
      redirectUri: String(payload.redirect_uri ?? ''),
      codeChallenge: String(payload.code_challenge ?? ''),
      scope: String(payload.scope ?? MCP_BUILDER_SCOPE),
      resource: String(payload.resource ?? ''),
      state: typeof payload.state === 'string' ? payload.state : undefined,
    };
    if (!request.clientId || !request.redirectUri || !request.codeChallenge || !request.resource) {
      throw new Error('incomplete ticket');
    }
    assertMcpResource(request.resource);
    return request;
  } catch {
    throw errors.unauthorized('Authorization request expired or invalid');
  }
}

export function assertBuilderScope(scope: string): string {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  if (scopes.size !== 1 || !scopes.has(MCP_BUILDER_SCOPE)) {
    throw errors.badRequest(`Only scope ${MCP_BUILDER_SCOPE} is allowed`);
  }
  return MCP_BUILDER_SCOPE;
}

/** RFC 8707 resource indicator: one exact configured MCP audience only. */
export function assertMcpResource(resource?: string): string {
  const expected = config.remoteMcp.resourceUrl;
  if (!resource) return expected; // Backward compatible with already-installed Claude connectors.
  let normalized: string;
  try {
    normalized = new URL(resource).toString().replace(/\/+$/, '');
  } catch {
    throw errors.badRequest('Invalid OAuth resource');
  }
  if (normalized !== expected) throw errors.badRequest('Requested resource does not match the AIOS MCP');
  return expected;
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function mcpClientIdHash(clientId: string): string {
  return sha256(clientId);
}

export function buildOAuthRedirect(redirectUri: string, values: Record<string, string | undefined>): string {
  const url = parseUrl(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
