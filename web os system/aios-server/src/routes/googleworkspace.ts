// Governed Google Workspace REST facade used by the AIOS MCP provider.
// OAuth tokens never leave aios-server. Reads are user-scoped; every external
// write requires an FDE, a real approved Run, and the matching Agent restriction.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { parseRestrictions } from '../engine/restrictions.js';
import * as cloud from '../integrations/cloud.js';
import { isRunApproved } from '../lib/approval.js';
import { rejectUnreleasedBuilderAgents } from '../lib/builderrelease.js';
import { prisma } from '../lib/db.js';
import { requireAuth, requireTrainer } from '../lib/guard.js';
import { errors, ok, sendError } from '../lib/http.js';
import {
  createServer,
  getServerByServerId,
  updateServer,
  type RegistryInput,
} from '../lib/mcpregistry.js';

const accountSchema = z.object({ accountId: z.string().min(1).optional() });
const readCap = z.number().int().min(1_000).max(100_000).optional();

async function resolveGoogleAccount(userId: string, accountId?: string) {
  const account = accountId
    ? await prisma.connectedAccount.findFirst({
        where: { id: accountId, userId, provider: 'GOOGLE', status: 'CONNECTED' },
      })
    : await prisma.connectedAccount.findFirst({
        where: { userId, provider: 'GOOGLE', status: 'CONNECTED' },
        orderBy: { createdAt: 'asc' },
      });
  if (!account) throw errors.notConfigured('No connected Google Workspace account');
  return account;
}

async function requireApprovedWrite(
  req: FastifyRequest,
  runId: string,
  restriction: 'cloudWrite' | 'sendEmail',
): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { agent: { select: { createdBy: true, restrictions: true } } },
  });
  if (!run || !run.agent) throw errors.notFound('Approved run not found');
  // FDEs may operate across a workspace, but a plain account can never reach
  // these routes because requireTrainer runs first.
  if (req.user!.role !== 'OWNER' && req.user!.role !== 'TRAINER') {
    throw errors.forbidden('FDE authorization required');
  }
  const restrictions = parseRestrictions(run.agent.restrictions);
  if (restrictions[restriction] !== true) {
    throw errors.forbidden(`Agent restriction ${restriction} is not granted`);
  }
  if (!(await isRunApproved(runId))) {
    throw errors.forbidden('A real approved run is required for this external write');
  }
}

export async function googleWorkspaceRoutes(app: FastifyInstance) {
  app.post(
    '/api/google-workspace/mcp/install',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = z
          .object({
            accountId: z.string().min(1),
            agentIds: z.array(z.string().min(1)).min(1).max(100),
          })
          .parse(req.body);
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        const requestedIds = [...new Set(body.agentIds)];
        const agents = await rejectUnreleasedBuilderAgents(
          await prisma.agent.findMany({
            where: { id: { in: requestedIds }, deletedAt: null },
            select: { id: true },
          }),
        );
        if (agents.length !== requestedIds.length) {
          throw errors.badRequest('One or more Agent ids are invalid');
        }

        const suffix = createHash('sha256').update(account.id).digest('hex').slice(0, 10);
        const command = process.execPath;
        const serverScript = path.resolve(process.cwd(), 'src/mcp/googleworkspace-server.ts');
        const common = {
          transport: 'STDIO' as const,
          command,
          cwd: process.cwd(),
          protocolVersion: '2024-11-05',
          enabled: true,
          trustTier: 'INTERNAL' as const,
          allowedAgentIds: agents.map((agent) => agent.id),
          resourceAllowlist: [],
          timeoutMs: 30_000,
        };
        const specs: RegistryInput[] = [
          {
            ...common,
            serverId: `google-gmail-read-${suffix}`,
            name: 'Google Gmail（唯讀）',
            commandArgs: ['--import', 'tsx', serverScript, '--account-id', account.id, '--server-id', `google-gmail-read-${suffix}`],
            toolAllowlist: ['gmail_search', 'gmail_get_message'],
            readWriteClass: 'read',
            requiredRestrictions: [],
            riskTier: 'low',
            approvalRequired: false,
          },
          {
            ...common,
            serverId: `google-drive-read-${suffix}`,
            name: 'Google Drive（唯讀）',
            commandArgs: ['--import', 'tsx', serverScript, '--account-id', account.id, '--server-id', `google-drive-read-${suffix}`],
            toolAllowlist: ['drive_search', 'drive_read_text'],
            readWriteClass: 'read',
            requiredRestrictions: [],
            riskTier: 'low',
            approvalRequired: false,
          },
          {
            ...common,
            serverId: `google-gmail-draft-${suffix}`,
            name: 'Google Gmail（建立草稿）',
            commandArgs: ['--import', 'tsx', serverScript, '--account-id', account.id, '--server-id', `google-gmail-draft-${suffix}`],
            toolAllowlist: ['gmail_create_draft'],
            readWriteClass: 'write',
            requiredRestrictions: ['cloudWrite'],
            riskTier: 'high',
            approvalRequired: true,
          },
          {
            ...common,
            serverId: `google-gmail-send-${suffix}`,
            name: 'Google Gmail（寄信）',
            commandArgs: ['--import', 'tsx', serverScript, '--account-id', account.id, '--server-id', `google-gmail-send-${suffix}`],
            toolAllowlist: ['gmail_send'],
            readWriteClass: 'write',
            requiredRestrictions: ['sendEmail'],
            riskTier: 'high',
            approvalRequired: true,
          },
          {
            ...common,
            serverId: `google-drive-write-${suffix}`,
            name: 'Google Drive（寫入文字檔）',
            commandArgs: ['--import', 'tsx', serverScript, '--account-id', account.id, '--server-id', `google-drive-write-${suffix}`],
            toolAllowlist: ['drive_create_text_file'],
            readWriteClass: 'write',
            requiredRestrictions: ['cloudWrite'],
            riskTier: 'high',
            approvalRequired: true,
          },
        ];

        const installed = [];
        for (const spec of specs) {
          const existing = await getServerByServerId(spec.serverId);
          installed.push(
            existing
              ? await updateServer(existing.id, spec, req.user!.sub)
              : await createServer(spec, req.user!.sub),
          );
        }
        return reply.send(ok({ installed, note: 'Read and write capabilities are intentionally split; write servers remain approval-gated.' }));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.get(
    '/api/google-workspace/status',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const accounts = await prisma.connectedAccount.findMany({
          where: { userId: req.user!.sub, provider: 'GOOGLE' },
          select: { id: true, email: true, status: true, scopes: true, lastSyncAt: true },
          orderBy: { createdAt: 'asc' },
        });
        return reply.send(
          ok({
            connected: accounts.some((account) => account.status === 'CONNECTED'),
            accounts,
            tools: {
              read: ['gmail_search', 'gmail_get_message', 'drive_search', 'drive_read_text'],
              write: ['gmail_create_draft', 'gmail_send', 'drive_create_text_file'],
            },
          }),
        );
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/gmail/search',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({ query: z.string().max(500).optional() })
          .parse(req.body ?? {});
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(ok(await cloud.listMessages(account.id, body.query)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/gmail/message',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({ messageId: z.string().min(1).max(300), maxChars: readCap })
          .parse(req.body);
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(
          ok(await cloud.getGoogleMessage(account.id, body.messageId, body.maxChars)),
        );
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/drive/search',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({ query: z.string().max(500).default(''), limit: z.number().int().min(1).max(50).optional() })
          .parse(req.body ?? {});
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(ok(await cloud.searchGoogleDrive(account.id, body.query, body.limit)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/drive/read-text',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({ fileId: z.string().min(1).max(500), maxChars: readCap })
          .parse(req.body);
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(
          ok(await cloud.readGoogleDriveText(account.id, body.fileId, body.maxChars)),
        );
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/gmail/draft',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({
            runId: z.string().min(1),
            to: z.string().email(),
            cc: z.string().email().optional(),
            subject: z.string().min(1).max(500),
            body: z.string().min(1).max(500_000),
          })
          .parse(req.body);
        await requireApprovedWrite(req, body.runId, 'cloudWrite');
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(ok(await cloud.createGoogleMailDraft(account.id, body)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/gmail/send',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({
            runId: z.string().min(1),
            to: z.string().email(),
            subject: z.string().min(1).max(500),
            body: z.string().min(1).max(500_000),
          })
          .parse(req.body);
        await requireApprovedWrite(req, body.runId, 'sendEmail');
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(ok(await cloud.sendMail(account.id, body)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );

  app.post(
    '/api/google-workspace/drive/create-text',
    { preHandler: requireTrainer },
    async (req, reply) => {
      try {
        const body = accountSchema
          .extend({
            runId: z.string().min(1),
            name: z.string().min(1).max(240),
            content: z.string().max(2_000_000),
            folderId: z.string().min(1).max(500).optional(),
            mimeType: z.enum(['text/plain', 'text/markdown']).optional(),
          })
          .parse(req.body);
        await requireApprovedWrite(req, body.runId, 'cloudWrite');
        const account = await resolveGoogleAccount(req.user!.sub, body.accountId);
        return reply.send(ok(await cloud.createGoogleDriveTextFile(account.id, body)));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  );
}
