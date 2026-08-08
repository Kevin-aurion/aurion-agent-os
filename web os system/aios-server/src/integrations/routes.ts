// Integration routes: connect/list/disconnect Microsoft & Google accounts,
// browse cloud files for the file-picker, and register CloudFileRefs so they
// can be attached as AgentFileTargets.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { integrationsReady } from '../config.js';
import { prisma } from '../lib/db.js';
import { randomToken, decrypt } from '../lib/crypto.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { verifyAccess } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { hub } from '../ws/hub.js';
import * as microsoft from './microsoft.js';
import * as google from './google.js';
import * as tokenstore from './tokenstore.js';
import * as cloud from './cloud.js';

const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingState {
  userId: string;
  pkceVerifier?: string;
  expiresAt: number;
}

// Module-level in-memory OAuth state store (state -> {userId, pkceVerifier}).
const pendingStates = new Map<string, PendingState>();

function putState(userId: string, pkceVerifier?: string): string {
  const state = randomToken(24);
  pendingStates.set(state, { userId, pkceVerifier, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

function takeState(state: string): PendingState | undefined {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) return undefined;
  return entry;
}

// Periodically sweep expired states so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}, 60_000);

const CONNECTED_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;text-align:center">
<h2>Connected</h2><p>You can close this tab.</p>
<script>setTimeout(()=>window.close(), 1500)</script>
</body></html>`;

function errorHtml(message: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;text-align:center">
<h2>Connection failed</h2><p>${message}</p>
</body></html>`;
}

// OAuth "start" is triggered by a top-level browser navigation (window.location),
// which cannot send an Authorization header. So accept the access token via the
// `?token=` query param (same pattern as the WebSocket endpoint), falling back to
// the header for programmatic callers. Returns the authenticated user id.
async function resolveUserId(req: import('fastify').FastifyRequest): Promise<string> {
  const q = (req.query as { token?: string })?.token;
  const h = req.headers.authorization;
  const token = q || (h?.startsWith('Bearer ') ? h.slice(7) : undefined);
  if (!token) throw errors.unauthorized('Missing token');
  const claims = await verifyAccess(token);
  if (claims.scope) throw errors.forbidden('Scoped OAuth tokens cannot authorize integrations');
  return claims.sub;
}

export async function integrationRoutes(app: FastifyInstance) {
  // ── List connected accounts + which providers are configured ────────────────
  app.get('/api/integrations', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const accounts = await prisma.connectedAccount.findMany({
        where: { userId: req.user!.sub },
        orderBy: { createdAt: 'asc' },
      });
      return ok({
        accounts: accounts.map((a) => ({
          id: a.id,
          provider: a.provider,
          email: a.email,
          status: a.status,
          scopes: a.scopes,
          lastSyncAt: a.lastSyncAt,
        })),
        configured: {
          microsoft: integrationsReady.microsoft(),
          google: integrationsReady.google(),
          line: integrationsReady.line(),
        },
      });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Microsoft OAuth ──────────────────────────────────────────────────────────
  app.get('/api/integrations/microsoft/start', async (req, reply) => {
    try {
      const userId = await resolveUserId(req);
      if (!integrationsReady.microsoft()) throw errors.notConfigured('Microsoft integration not configured');
      const state = randomToken(24);
      const { url, pkceVerifier } = await microsoft.getAuthUrl({ state });
      pendingStates.set(state, { userId, pkceVerifier, expiresAt: Date.now() + STATE_TTL_MS });
      return reply.redirect(url, 302);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/integrations/microsoft/callback', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    try {
      if (query.error) throw errors.badRequest(query.error_description ?? query.error);
      const code = query.code;
      const state = query.state;
      if (!code || !state) throw errors.badRequest('Missing code/state');
      const pending = takeState(state);
      if (!pending) throw errors.badRequest('Invalid or expired OAuth state');

      const tokenResult = await microsoft.exchangeCode({ code, pkceVerifier: pending.pkceVerifier });
      const account = await tokenstore.saveAccount({
        userId: pending.userId,
        provider: 'MICROSOFT',
        providerAccountId: tokenResult.accountId,
        email: tokenResult.email,
        scopes: tokenResult.scopes,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        accessTokenExpires: tokenResult.expiresAt,
      });
      await audit(pending.userId, 'integration.connected', 'ConnectedAccount', account.id, { provider: 'MICROSOFT' });
      hub.publish('integration.status', { accountId: account.id, provider: 'MICROSOFT', userId: pending.userId, status: account.status });
      return reply.type('text/html').send(CONNECTED_HTML);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.type('text/html').code(400).send(errorHtml(message));
    }
  });

  // ── Google OAuth ─────────────────────────────────────────────────────────────
  app.get('/api/integrations/google/start', async (req, reply) => {
    try {
      const userId = await resolveUserId(req);
      if (!integrationsReady.google()) throw errors.notConfigured('Google integration not configured');
      const state = putState(userId);
      const url = google.getAuthUrl({ state });
      return reply.redirect(url, 302);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/integrations/google/callback', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    try {
      if (query.error) throw errors.badRequest(query.error_description ?? query.error);
      const code = query.code;
      const state = query.state;
      if (!code || !state) throw errors.badRequest('Missing code/state');
      const pending = takeState(state);
      if (!pending) throw errors.badRequest('Invalid or expired OAuth state');

      const tokenResult = await google.exchangeCode(code);
      const account = await tokenstore.saveAccount({
        userId: pending.userId,
        provider: 'GOOGLE',
        providerAccountId: tokenResult.accountId,
        email: tokenResult.email,
        scopes: tokenResult.scopes,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        accessTokenExpires: tokenResult.expiresAt,
      });
      await audit(pending.userId, 'integration.connected', 'ConnectedAccount', account.id, { provider: 'GOOGLE' });
      hub.publish('integration.status', { accountId: account.id, provider: 'GOOGLE', userId: pending.userId, status: account.status });
      return reply.type('text/html').send(CONNECTED_HTML);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.type('text/html').code(400).send(errorHtml(message));
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  app.delete('/api/integrations/:accountId', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { accountId } = z.object({ accountId: z.string() }).parse(req.params);
      const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== req.user!.sub) throw errors.notFound('Connected account not found');

      if (account.provider === 'GOOGLE' && account.accessTokenEnc) {
        try {
          const accessToken = decrypt(account.accessTokenEnc);
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, { method: 'POST' });
        } catch {
          // best-effort revoke; proceed with local disconnect regardless
        }
      }

      const updated = await prisma.connectedAccount.update({
        where: { id: accountId },
        data: {
          accessTokenEnc: '',
          refreshTokenEnc: '',
          status: 'DISCONNECTED',
        },
      });
      await audit(req.user!.sub, 'integration.disconnected', 'ConnectedAccount', accountId, { provider: account.provider });
      hub.publish('integration.status', { accountId, provider: account.provider, userId: req.user!.sub, status: 'DISCONNECTED' });
      return ok({ id: updated.id, status: updated.status });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── File picker ──────────────────────────────────────────────────────────────
  app.get('/api/integrations/:accountId/files', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { accountId } = z.object({ accountId: z.string() }).parse(req.params);
      const { folderId } = z.object({ folderId: z.string().optional() }).parse(req.query);
      const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== req.user!.sub) throw errors.notFound('Connected account not found');
      const entries = await cloud.listChildren(accountId, folderId);
      return ok({ entries });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Register a CloudFileRef (for AgentFileTarget attachment) ────────────────
  app.post('/api/integrations/:accountId/files/register', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { accountId } = z.object({ accountId: z.string() }).parse(req.params);
      const body = z
        .object({
          externalId: z.string(),
          name: z.string(),
          path: z.string(),
          mimeType: z.string().optional(),
          kind: z.enum(['FILE', 'FOLDER']),
          webUrl: z.string().optional(),
        })
        .parse(req.body);

      const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== req.user!.sub) throw errors.notFound('Connected account not found');

      const ref = await prisma.cloudFileRef.upsert({
        where: { accountId_externalId: { accountId, externalId: body.externalId } },
        create: {
          id: ulid(),
          accountId,
          provider: account.provider,
          externalId: body.externalId,
          name: body.name,
          path: body.path,
          mimeType: body.mimeType,
          kind: body.kind,
          webUrl: body.webUrl,
        },
        update: {
          name: body.name,
          path: body.path,
          mimeType: body.mimeType,
          kind: body.kind,
          webUrl: body.webUrl,
        },
      });

      await audit(req.user!.sub, 'integration.file_registered', 'CloudFileRef', ref.id, { accountId, externalId: body.externalId });
      return ok(ref);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Create an 應收應付 AR/AP spreadsheet template in the user's cloud drive ──
  app.post('/api/integrations/:accountId/arap-template', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { accountId } = z.object({ accountId: z.string() }).parse(req.params);
      const { name } = z.object({ name: z.string().optional() }).parse(req.body ?? {});

      const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== req.user!.sub) throw errors.notFound('Connected account not found');

      const file = await cloud.createSpreadsheet(accountId, name ?? `應收應付帳款_${new Date().toISOString().slice(0, 10)}`);

      const ref = await prisma.cloudFileRef.upsert({
        where: { accountId_externalId: { accountId, externalId: file.externalId } },
        create: {
          id: ulid(),
          accountId,
          provider: account.provider,
          externalId: file.externalId,
          name: file.name,
          path: file.path,
          mimeType: file.mimeType,
          kind: file.kind,
          webUrl: file.webUrl,
        },
        update: {
          name: file.name,
          path: file.path,
          mimeType: file.mimeType,
          kind: file.kind,
          webUrl: file.webUrl,
        },
      });

      await audit(req.user!.sub, 'integration.arap_template_created', 'CloudFileRef', ref.id, { accountId, externalId: file.externalId });
      return ok(ref);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Create a sample workbook (AR/AP, revenue, or finance analysis) ─────────
  app.post('/api/integrations/:accountId/sample-file', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { accountId } = z.object({ accountId: z.string() }).parse(req.params);
      const { kind, name } = z
        .object({
          kind: z.enum(['arap', 'revenue', 'finance']),
          name: z.string().optional(),
        })
        .parse(req.body ?? {});

      const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== req.user!.sub) throw errors.notFound('Connected account not found');

      const file = await cloud.createSampleFile(accountId, kind, name);

      const ref = await prisma.cloudFileRef.upsert({
        where: { accountId_externalId: { accountId, externalId: file.externalId } },
        create: {
          id: ulid(),
          accountId,
          provider: account.provider,
          externalId: file.externalId,
          name: file.name,
          path: file.path,
          mimeType: file.mimeType,
          kind: file.kind,
          webUrl: file.webUrl,
        },
        update: {
          name: file.name,
          path: file.path,
          mimeType: file.mimeType,
          kind: file.kind,
          webUrl: file.webUrl,
        },
      });

      await audit(req.user!.sub, 'integration.sample_file_created', 'CloudFileRef', ref.id, { accountId, kind, externalId: file.externalId });
      return ok(ref);
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
