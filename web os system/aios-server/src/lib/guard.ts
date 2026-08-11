import type { FastifyRequest } from 'fastify';
import { claimsFromHeader, type AccessClaims } from './auth.js';
import { errors } from './http.js';

const MCP_BUILDER_SCOPE = 'aios:agent-builder';

function assertScopedRoute(req: FastifyRequest, claims: AccessClaims): void {
  if (!claims.scope) return;
  const route = req.routeOptions.url ?? '';
  const allowed =
    claims.scope === MCP_BUILDER_SCOPE &&
    (route === '/api/auth/me' ||
      route.startsWith('/api/agent-builder/') ||
      route.startsWith('/api/agent-runtime/'));
  if (!allowed) throw errors.forbidden('This OAuth token is restricted to Agent Builder APIs');
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

/** preHandler: require a valid bearer token; attaches request.user. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  req.user = await claimsFromHeader(req.headers.authorization);
  assertScopedRoute(req, req.user);
}

/** preHandler: require training privileges (OWNER or TRAINER). MEMBERs can
 * use agents (chat, run manual workflows, view) but cannot create/modify
 * agents, skills, or workflows. */
export async function requireTrainer(req: FastifyRequest): Promise<void> {
  req.user = await claimsFromHeader(req.headers.authorization);
  if (req.user.scope) {
    throw errors.forbidden('Scoped OAuth tokens cannot perform FDE actions');
  }
  if (req.user.role !== 'OWNER' && req.user.role !== 'TRAINER') {
    throw errors.forbidden('需要訓練權限（OWNER 或 TRAINER）');
  }
}
