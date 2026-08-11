import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import {
  createSession,
  revokeSession,
  rotateSession,
  signAccess,
  verifyPassword,
} from '../lib/auth.js';
import {
  MCP_BUILDER_SCOPE,
  assertAllowedMcpRedirectUri,
  assertBuilderScope,
  assertMcpResource,
  buildOAuthRedirect,
  mcpClientIdHash,
  pkceS256,
  redirectUriMatches,
  signMcpAuthorizationRequest,
  signMcpClient,
  verifyMcpAuthorizationRequest,
  verifyMcpClient,
} from '../lib/mcpoauth.js';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

function noStore(reply: FastifyReply): FastifyReply {
  return reply.headers({
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function loginPage(opts: { ticket: string; clientName: string; error?: string }): string {
  const error = opts.error
    ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>`
    : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>連接 Lazyoffice AIOS</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d15;color:#e8ecf6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(440px,calc(100vw - 32px));padding:32px;border:1px solid #293246;border-radius:18px;background:#121824;box-shadow:0 24px 80px #0008}.brand{display:flex;gap:12px;align-items:center;margin-bottom:24px}.logo{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:#7b83ff;font-weight:800}.muted{color:#9aa5ba;line-height:1.55}h1{font-size:24px;margin:0 0 8px}label{display:block;margin:18px 0 7px;font-size:14px;color:#cbd3e2}input{width:100%;padding:13px 14px;border:1px solid #354057;border-radius:10px;background:#0b1019;color:#fff;font-size:16px}button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:10px;background:#7b83ff;color:#fff;font-size:16px;font-weight:700;cursor:pointer}.notice{margin-top:18px;padding:12px 14px;border-radius:10px;background:#182132;color:#b8c3d8;font-size:13px;line-height:1.5}.error{margin:16px 0 0;padding:11px 13px;border:1px solid #8b3141;border-radius:10px;background:#371923;color:#ffb3c0}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand"><div class="logo">L</div><div><strong>Lazyoffice AIOS</strong><div class="muted">Remote MCP Connector</div></div></div>
    <h1>授權 AI 助理建置 AI 員工</h1>
    <p class="muted">「${escapeHtml(opts.clientName)}」要求把 Agent 建置對話、Skill 草稿與測試資料同步到您的 AIOS 帳號。</p>
    ${error}
    <form method="post" action="/oauth/authorize" autocomplete="on">
      <input type="hidden" name="ticket" value="${escapeHtml(opts.ticket)}" />
      <label for="email">AIOS 帳號</label>
      <input id="email" name="email" type="email" required autocomplete="username" />
      <label for="password">密碼</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" />
      <button type="submit">同意並連接</button>
    </form>
    <div class="notice">此連線只提供 Agent Builder 草稿工具。Claude 無法自行核准、確認 Skill 或啟用 Agent；正式生效仍需 FDE。</div>
  </main>
</body>
</html>`;
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return noStore(reply).code(status).send({ error, error_description: description });
}

export async function mcpOAuthRoutes(app: FastifyInstance) {
  const issuer = config.remoteMcp.issuer;
  const resource = config.remoteMcp.resourceUrl;
  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_BUILDER_SCOPE],
  };
  const protectedResourceMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [MCP_BUILDER_SCOPE],
    bearer_methods_supported: ['header'],
  };

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    noStore(reply).send(authorizationServerMetadata),
  );
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) =>
    noStore(reply).send(protectedResourceMetadata),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', async (_req, reply) =>
    noStore(reply).send(protectedResourceMetadata),
  );

  app.post('/oauth/register', async (req, reply) => {
    try {
      const body = z.object({
        client_name: z.string().min(1).max(120).default('MCP Client'),
        redirect_uris: z.array(z.string().url()).min(1).max(8),
        grant_types: z.array(z.string()).default(['authorization_code', 'refresh_token']),
        token_endpoint_auth_method: z.literal('none').default('none'),
      }).parse(req.body);
      body.redirect_uris.forEach(assertAllowedMcpRedirectUri);
      if (!body.grant_types.includes('authorization_code')) {
        return oauthError(reply, 400, 'invalid_client_metadata', 'authorization_code grant is required');
      }
      const clientId = await signMcpClient({
        clientName: body.client_name,
        redirectUris: body.redirect_uris,
        grantTypes: body.grant_types,
        tokenEndpointAuthMethod: 'none',
      });
      return noStore(reply).code(201).send({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        grant_types: body.grant_types,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    } catch (error) {
      return oauthError(reply, 400, 'invalid_client_metadata', error instanceof Error ? error.message : 'Invalid client metadata');
    }
  });

  app.get('/oauth/authorize', async (req, reply) => {
    try {
      const query = z.object({
        response_type: z.literal('code'),
        client_id: z.string().min(1),
        redirect_uri: z.string().url(),
        code_challenge: z.string().min(43).max(128),
        code_challenge_method: z.literal('S256'),
        scope: z.string().default(MCP_BUILDER_SCOPE),
        state: z.string().max(2048).optional(),
        resource: z.string().url().optional(),
      }).parse(req.query);
      const requestedResource = assertMcpResource(query.resource);
      const client = await verifyMcpClient(query.client_id);
      if (!client.redirectUris.some((uri) => redirectUriMatches(uri, query.redirect_uri))) {
        return oauthError(reply, 400, 'invalid_request', 'Redirect URI does not match the registered client');
      }
      const scope = assertBuilderScope(query.scope);
      const ticket = await signMcpAuthorizationRequest({
        clientId: query.client_id,
        clientName: client.clientName,
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge,
        scope,
        resource: requestedResource,
        state: query.state,
      });
      return noStore(reply).type('text/html; charset=utf-8').send(loginPage({ ticket, clientName: client.clientName }));
    } catch (error) {
      return oauthError(reply, 400, 'invalid_request', error instanceof Error ? error.message : 'Invalid authorization request');
    }
  });

  app.post('/oauth/authorize', async (req, reply) => {
    let request: Awaited<ReturnType<typeof verifyMcpAuthorizationRequest>>;
    try {
      const body = z.object({
        ticket: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(1),
      }).parse(req.body);
      request = await verifyMcpAuthorizationRequest(body.ticket);
      const client = await verifyMcpClient(request.clientId);
      if (!client.redirectUris.some((uri) => redirectUriMatches(uri, request.redirectUri))) {
        return oauthError(reply, 400, 'invalid_request', 'Redirect URI no longer matches the client');
      }
      const user = await prisma.user.findFirst({ where: { email: body.email, deletedAt: null } });
      if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
        return noStore(reply)
          .code(401)
          .type('text/html; charset=utf-8')
          .send(loginPage({ ticket: body.ticket, clientName: request.clientName, error: '帳號或密碼錯誤' }));
      }
      const code = randomToken(32);
      await prisma.mcpOAuthCode.create({
        data: {
          id: ulid(),
          codeHash: sha256(code),
          userId: user.id,
          clientIdHash: mcpClientIdHash(request.clientId),
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          scope: request.scope,
          expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
        },
      });
      await audit(user.id, 'mcp.oauth.authorized', 'User', user.id, {
        clientName: request.clientName.slice(0, 120),
        scope: request.scope,
      });
      return reply.redirect(
        buildOAuthRedirect(request.redirectUri, { code, state: request.state }),
        302,
      );
    } catch (error) {
      return oauthError(reply, 400, 'access_denied', error instanceof Error ? error.message : 'Authorization failed');
    }
  });

  app.post('/oauth/token', async (req, reply) => {
    try {
      const body = z.object({
        grant_type: z.enum(['authorization_code', 'refresh_token']),
        client_id: z.string().min(1),
        code: z.string().optional(),
        redirect_uri: z.string().url().optional(),
        code_verifier: z.string().min(43).max(128).optional(),
        refresh_token: z.string().optional(),
        resource: z.string().url().optional(),
      }).parse(req.body);
      await verifyMcpClient(body.client_id);
      const requestedResource = assertMcpResource(body.resource);
      const clientHash = mcpClientIdHash(body.client_id);

      if (body.grant_type === 'authorization_code') {
        if (!body.code || !body.redirect_uri || !body.code_verifier) {
          return oauthError(reply, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
        }
        const codeRow = await prisma.mcpOAuthCode.findUnique({ where: { codeHash: sha256(body.code) } });
        const now = new Date();
        if (
          !codeRow ||
          codeRow.consumedAt ||
          codeRow.expiresAt <= now ||
          codeRow.clientIdHash !== clientHash ||
          !redirectUriMatches(codeRow.redirectUri, body.redirect_uri) ||
          pkceS256(body.code_verifier) !== codeRow.codeChallenge
        ) {
          return oauthError(reply, 400, 'invalid_grant', 'Authorization code is invalid, expired or PKCE verification failed');
        }
        const claimed = await prisma.mcpOAuthCode.updateMany({
          where: { id: codeRow.id, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (claimed.count !== 1) return oauthError(reply, 400, 'invalid_grant', 'Authorization code was already used');
        const user = await prisma.user.findFirst({ where: { id: codeRow.userId, deletedAt: null } });
        if (!user) return oauthError(reply, 400, 'invalid_grant', 'User account is unavailable');
        const accessToken = await signAccess({
          sub: user.id,
          email: user.email,
          role: 'MEMBER',
          scope: MCP_BUILDER_SCOPE,
          audience: requestedResource,
        });
        const refreshToken = await createSession(user.id, `mcp-oauth:${clientHash}`);
        return noStore(reply).send({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: refreshToken,
          scope: codeRow.scope,
        });
      }

      if (!body.refresh_token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');
      const persisted = await prisma.session.findUnique({ where: { tokenHash: sha256(body.refresh_token) } });
      if (!persisted || persisted.client !== `mcp-oauth:${clientHash}`) {
        return oauthError(reply, 400, 'invalid_grant', 'Refresh token does not belong to this OAuth client');
      }
      const rotated = await rotateSession(body.refresh_token, `mcp-oauth:${clientHash}`);
      const user = await prisma.user.findFirst({ where: { id: rotated.userId, deletedAt: null } });
      if (!user) return oauthError(reply, 400, 'invalid_grant', 'User account is unavailable');
      return noStore(reply).send({
        access_token: await signAccess({
          sub: user.id,
          email: user.email,
          role: 'MEMBER',
          scope: MCP_BUILDER_SCOPE,
          audience: requestedResource,
        }),
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: rotated.refresh,
        scope: MCP_BUILDER_SCOPE,
      });
    } catch (error) {
      return oauthError(reply, 400, 'invalid_grant', error instanceof Error ? error.message : 'Token exchange failed');
    }
  });

  app.post('/oauth/revoke', async (req, reply) => {
    try {
      const body = z.object({ token: z.string().min(1) }).parse(req.body);
      await revokeSession(body.token);
      return noStore(reply).code(200).send({});
    } catch {
      // RFC 7009 requires a successful response even for an unknown token.
      return noStore(reply).code(200).send({});
    }
  });
}
