import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { ok, errors, sendError } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { audit } from '../lib/audit.js';
import { hub } from '../ws/hub.js';
import * as line from './line.js';

const createBindingSchema = z.object({
  channel: z.enum(['LINE', 'TELEGRAM', 'SLACK', 'DISCORD']).default('LINE'),
  kind: z.enum(['USER', 'GROUP', 'ROOM']),
  externalId: z.string().min(1),
  label: z.string().min(1),
  meta: z.unknown().optional(),
});

const pushSchema = z.object({
  bindingId: z.string().optional(),
  to: z.string().optional(),
  text: z.string().min(1),
});

export async function channelRoutes(app: FastifyInstance) {
  // ── LINE webhook (unauthenticated, signature-verified) ──────────────────
  // Scoped plugin so the raw-buffer content-type parser only affects this route.
  await app.register(async (r) => {
    r.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (e) {
        done(e as Error);
      }
    });

    r.post('/api/channels/line/webhook', async (req: FastifyRequest, reply) => {
      const rawBody: Buffer = (req as any).rawBody ?? Buffer.from('');
      const signature = (req.headers['x-line-signature'] as string | undefined) ?? undefined;

      if (!line.verifySignature(rawBody, signature)) {
        return reply.code(401).send({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid LINE signature' } });
      }

      // Always fast-ack 200, even on internal processing errors, so LINE
      // does not retry-storm us.
      try {
        const events = await line.handleWebhook(rawBody, signature);
        for (const ev of events) {
          hub.publish('chat.message', {
            channel: 'LINE',
            bindingId: ev.bindingId,
            sourceType: ev.sourceType,
            sourceId: ev.sourceId,
            text: ev.text,
            type: ev.type,
          });

          // Fire any keyword-triggered workflows for known (bound) sources.
          // Never awaited here — the ack below must not wait on workflow runs.
          if (ev.bindingId && ev.sourceId && ev.isTextMessage && ev.text) {
            const sourceId = ev.sourceId;
            import('../workflow/triggers.js')
              .then(({ fireKeywordWorkflows }) =>
                fireKeywordWorkflows(ev.text as string, {
                  source: `line:${sourceId}`,
                  onDone: (_workflowId, outcome) => {
                    if (!outcome) return;
                    const lastOk = [...outcome.results]
                      .reverse()
                      .find((r) => r.ok && typeof r.output === 'string');
                    const text = (lastOk?.output ?? outcome.results.at(-1)?.output ?? '').trim();
                    if (text) void line.pushMessage(sourceId, text);
                  },
                }),
              )
              .catch((e) => req.log?.error?.(e));
          }
        }
        return reply.code(200).send({ success: true, data: { events: events.length } });
      } catch (e) {
        req.log?.error?.(e);
        return reply.code(200).send({ success: true, data: { events: 0 } });
      }
    });
  });

  // ── Channel bindings CRUD ────────────────────────────────────────────────
  app.get('/api/channels/bindings', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const bindings = await prisma.channelBinding.findMany({ orderBy: { createdAt: 'desc' } });
      return ok(bindings);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/channels/bindings', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = createBindingSchema.parse(req.body ?? {});
      const binding = await prisma.channelBinding.create({
        data: {
          id: ulid(),
          channel: body.channel,
          kind: body.kind,
          externalId: body.externalId,
          label: body.label,
          meta: body.meta === undefined ? undefined : (body.meta as object),
        },
      });
      await audit(req.user?.sub ?? null, 'channel.binding.create', 'ChannelBinding', binding.id, body);
      return reply.code(201).send(ok(binding));
    } catch (e) {
      if (e instanceof z.ZodError) return sendError(reply, errors.badRequest('Invalid binding payload', e.issues));
      return sendError(reply, e);
    }
  });

  app.delete('/api/channels/bindings/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const existing = await prisma.channelBinding.findUnique({ where: { id } });
      if (!existing) throw errors.notFound('Channel binding not found');
      await prisma.channelBinding.delete({ where: { id } });
      await audit(req.user?.sub ?? null, 'channel.binding.delete', 'ChannelBinding', id);
      return ok({ id });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── LINE push (manual testing helper) ───────────────────────────────────
  app.post('/api/channels/line/push', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = pushSchema.parse(req.body ?? {});
      if (!body.bindingId && !body.to) {
        throw errors.badRequest('Provide either bindingId or to');
      }
      if (body.bindingId) {
        await line.pushToBinding(body.bindingId, body.text);
      } else {
        await line.pushMessage(body.to as string, body.text);
      }
      await audit(req.user?.sub ?? null, 'channel.line.push', 'ChannelBinding', body.bindingId ?? body.to ?? 'unknown', {
        text: body.text,
      });
      return ok({ sent: true });
    } catch (e) {
      if (e instanceof z.ZodError) return sendError(reply, errors.badRequest('Invalid push payload', e.issues));
      return sendError(reply, e);
    }
  });
}
