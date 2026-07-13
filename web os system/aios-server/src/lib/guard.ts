import type { FastifyRequest } from 'fastify';
import { claimsFromHeader, type AccessClaims } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

/** preHandler: require a valid bearer token; attaches request.user. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  req.user = await claimsFromHeader(req.headers.authorization);
}

/** preHandler: require training privileges (OWNER or TRAINER). MEMBERs can
 * use agents (chat, run manual workflows, view) but cannot create/modify
 * agents, skills, or workflows. */
export async function requireTrainer(req: FastifyRequest): Promise<void> {
  req.user = await claimsFromHeader(req.headers.authorization);
  if (req.user.role !== 'OWNER' && req.user.role !== 'TRAINER') {
    const { errors } = await import('./http.js');
    throw errors.forbidden('需要訓練權限（OWNER 或 TRAINER）');
  }
}
