import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import {
  hashPassword,
  verifyPassword,
  signAccess,
  createSession,
  rotateSession,
  revokeSession,
} from '../lib/auth.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { audit } from '../lib/audit.js';

export async function authRoutes(app: FastifyInstance) {
  // Whether an owner exists yet (drives first-run registration UI).
  app.get('/api/auth/status', async () => {
    const count = await prisma.user.count({ where: { deletedAt: null } });
    return ok({ initialized: count > 0 });
  });

  // First user becomes OWNER. Further registrations only allowed by an owner.
  app.post('/api/auth/register', async (req, reply) => {
    try {
      const body = z
        .object({ email: z.string().email(), displayName: z.string().min(1), password: z.string().min(8) })
        .parse(req.body);
      const existing = await prisma.user.count({ where: { deletedAt: null } });
      if (existing > 0) throw errors.forbidden('An owner already exists; ask them to invite you');
      const user = await prisma.user.create({
        data: {
          id: ulid(),
          email: body.email,
          displayName: body.displayName,
          passwordHash: await hashPassword(body.password),
          role: 'OWNER',
        },
      });
      await audit(user.id, 'user.registered', 'User', user.id);
      const access = await signAccess({ sub: user.id, email: user.email, role: user.role });
      const refresh = await createSession(user.id, 'web');
      return ok({ access, refresh, user: publicUser(user) });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    try {
      const body = z.object({ email: z.string().email(), password: z.string(), client: z.string().default('web') }).parse(req.body);
      const user = await prisma.user.findFirst({ where: { email: body.email, deletedAt: null } });
      if (!user || !(await verifyPassword(user.passwordHash, body.password))) throw errors.unauthorized('Bad credentials');
      const access = await signAccess({ sub: user.id, email: user.email, role: user.role });
      const refresh = await createSession(user.id, body.client);
      return ok({ access, refresh, user: publicUser(user) });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    try {
      const body = z.object({ refresh: z.string(), client: z.string().default('web') }).parse(req.body);
      const { userId, refresh } = await rotateSession(body.refresh, body.client);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const access = await signAccess({ sub: user.id, email: user.email, role: user.role });
      return ok({ access, refresh, user: publicUser(user) });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    try {
      const body = z.object({ refresh: z.string() }).parse(req.body);
      await revokeSession(body.refresh);
      return ok({ ok: true });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
      return ok(publicUser(user));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}

function publicUser(u: { id: string; email: string; displayName: string; role: string }) {
  return { id: u.id, email: u.email, displayName: u.displayName, role: u.role };
}
